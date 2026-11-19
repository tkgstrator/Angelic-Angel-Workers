import { describe, expect, test } from 'bun:test'
import {
  DecryptionError,
  decryptNotification,
  fromBase64Url,
  generateKeys,
  payloadBody,
  toBase64Url,
  type WebPushKeys,
} from '../src/ece'
import fixtures from './fixtures/legacy-ece.json'
import { encryptAes128gcm, encryptAesgcm } from './helpers/ece-encrypt'
import { rfcData, rfcKeys } from './helpers/rfc-vector'

const dec = new TextDecoder()
const enc = new TextEncoder()

const fails = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e) => e,
  )
  expect(error).toBeInstanceOf(DecryptionError)
}

describe('base64url', () => {
  test('round trips and rejects invalid input', () => {
    const bytes = Uint8Array.of(251, 255, 0, 1)
    expect(toBase64Url(bytes)).toBe('-_8AAQ')
    expect([...fromBase64Url('-_8AAQ')]).toEqual([...bytes])
    expect(() => fromBase64Url('a+b')).toThrow()
    expect(() => fromBase64Url('abcde')).toThrow()
  })
})

describe('aes128gcm', () => {
  test('our own unavailable key is distinct from invalid ciphertext', async () => {
    const error = await decryptNotification(rfcData, undefined, {
      ...rfcKeys,
      privateKey: { kty: 'EC' },
    }).then(
      () => undefined,
      (failure) => failure,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(DecryptionError)
  })
  test('RFC 8291 known vector', async () => {
    const out = await decryptNotification(rfcData, undefined, rfcKeys)
    expect(dec.decode(out)).toBe('When I grow up, I want to be a watermelon')
    const explicit = await decryptNotification(rfcData, { encoding: 'aes128gcm' }, rfcKeys)
    expect(dec.decode(explicit)).toBe(dec.decode(out))
  })

  test('bad auth secret, tag corruption and wrong key fail', async () => {
    await fails(
      decryptNotification(rfcData, undefined, {
        ...rfcKeys,
        authSecret: toBase64Url(new Uint8Array(16)),
      }),
    )
    const raw = fromBase64Url(rfcData)
    const last = raw.at(-1)
    if (last === undefined) throw new Error('Missing encrypted bytes')
    raw[raw.length - 1] = last ^ 1
    await fails(decryptNotification(toBase64Url(raw), undefined, rfcKeys))
    const other = await generateKeys()
    await fails(decryptNotification(rfcData, undefined, other))
  })

  test('truncated header, key id and body fail', async () => {
    const raw = fromBase64Url(rfcData)
    for (const n of [0, 10, 20, 50, 86])
      await fails(decryptNotification(toBase64Url(raw.slice(0, n)), undefined, rfcKeys))
    await fails(decryptNotification(toBase64Url(raw.slice(0, raw.length - 3)), undefined, rfcKeys))
    await fails(decryptNotification('', undefined, rfcKeys))
    await fails(decryptNotification('!!!', undefined, rfcKeys))
  })

  test('cold generated keys round trip, including multi-record UTF-8', async () => {
    const keys = await generateKeys()
    const pub = fromBase64Url(keys.publicKey)
    expect(pub.length).toBe(65)
    const text = JSON.stringify({ msg: '日本語の通知 '.repeat(200) })
    const body = await encryptAes128gcm(enc.encode(text), pub, fromBase64Url(keys.authSecret), {
      rs: 128,
    })
    expect(body.length).toBeGreaterThan(5 * 128)
    expect(dec.decode(await decryptNotification(toBase64Url(body), {}, keys))).toBe(text)
  })

  test('final padding is accepted', async () => {
    const keys = await generateKeys()
    const body = await encryptAes128gcm(
      enc.encode('hello'),
      fromBase64Url(keys.publicKey),
      fromBase64Url(keys.authSecret),
      { pad: 20 },
    )
    expect(dec.decode(await decryptNotification(toBase64Url(body), undefined, keys))).toBe('hello')
  })

  test('bad delimiters and padding fail', async () => {
    const keys = await generateKeys()
    const pub = fromBase64Url(keys.publicKey)
    const auth = fromBase64Url(keys.authSecret)
    // plaintext record size 16 + 16 tag => rs 32
    const go = async (rawRecords: number[][]) =>
      decryptNotification(
        toBase64Url(
          await encryptAes128gcm(new Uint8Array(), pub, auth, {
            rs: 32,
            rawRecords: rawRecords.map((r) => Uint8Array.from(r)),
          }),
        ),
        undefined,
        keys,
      )
    const full = (delim: number) => [...new Array(15).fill(0x61), delim]
    // sanity: well-formed non-final (1) then final (2)
    expect(dec.decode(await go([full(1), [0x62, 2]]))).toBe(`${'a'.repeat(15)}b`)
    await fails(go([full(2), [0x62, 2]])) // final delimiter in non-final record
    await fails(go([full(1), [0x62, 1]])) // truncated: last record not final
    await fails(go([full(1)])) // truncated: dropped final record
    await fails(go([[0x62, 2, 1]])) // non-zero padding after delimiter
    await fails(go([[0, 0, 0]])) // no delimiter
    await fails(go([[0x62, 3]])) // unknown delimiter
  })
})

describe('legacy aesgcm', () => {
  for (const [i, fx] of fixtures.entries()) {
    test(`independent http_ece fixture ${i} (${fx.plaintext.length} chars)`, async () => {
      const keys: WebPushKeys = { ...fx.keys, privateKey: fx.keys.privateKeyJwk }
      const out = await decryptNotification(fx.data, fx.headers, keys)
      expect(dec.decode(out)).toBe(fx.plaintext)
      expect(payloadBody(out)).toBe(fx.plaintext)
    })
  }

  test('header name variants, rs and multi-record', async () => {
    const keys = await generateKeys()
    const text = 'x'.repeat(500)
    const { data, headers } = await encryptAesgcm(
      enc.encode(text),
      fromBase64Url(keys.publicKey),
      fromBase64Url(keys.authSecret),
      { rs: 64, pad: 3 },
    )
    const h = {
      Encoding: 'aesgcm',
      'Crypto-Key': headers.crypto_key,
      Encryption: headers.encryption,
    }
    expect(dec.decode(await decryptNotification(toBase64Url(data), h, keys))).toBe(text)
    expect(dec.decode(await decryptNotification(toBase64Url(data), headers, keys))).toBe(text)
  })

  test('bad auth, missing headers, bad padding, truncation fail', async () => {
    const fx = fixtures[0]
    if (fx === undefined) throw new Error('Missing fixture')
    const keys: WebPushKeys = { ...fx.keys, privateKey: fx.keys.privateKeyJwk }
    await fails(
      decryptNotification(fx.data, fx.headers, {
        ...keys,
        authSecret: toBase64Url(new Uint8Array(16)),
      }),
    )
    await fails(decryptNotification(fx.data, { encoding: 'aesgcm' }, keys))
    await fails(decryptNotification(fx.data, { ...fx.headers, encryption: 'rs=4096' }, keys))
    await fails(decryptNotification(fx.data, { ...fx.headers, encoding: 'aes256gcm' }, keys))
    await fails(decryptNotification(fx.data.slice(0, 40), fx.headers, keys))
    await fails(decryptNotification('', fx.headers, keys))
    const k = await generateKeys()
    const bad = await encryptAesgcm(
      enc.encode('hi'),
      fromBase64Url(k.publicKey),
      fromBase64Url(k.authSecret),
      { pad: 2, padFill: 1 },
    )
    await fails(decryptNotification(toBase64Url(bad.data), bad.headers, k))
  })

  test('truncated final record fails', async () => {
    const fx = fixtures[1]
    if (fx === undefined) throw new Error('Missing fixture')
    const keys: WebPushKeys = { ...fx.keys, privateKey: fx.keys.privateKeyJwk }
    const raw = fromBase64Url(fx.data)
    await fails(decryptNotification(toBase64Url(raw.slice(0, raw.length - 1)), fx.headers, keys))
  })

  test('dropping an entire final legacy record is rejected', async () => {
    const fx = fixtures[1]
    if (fx === undefined) throw new Error('Missing fixture')
    const keys: WebPushKeys = { ...fx.keys, privateKey: fx.keys.privateKeyJwk }
    await fails(
      decryptNotification(toBase64Url(fromBase64Url(fx.data).slice(0, 4112)), fx.headers, keys),
    )
  })
})

describe('payloadBody', () => {
  test('a UTF-8 BOM is retained in the non-JSON raw fallback', () => {
    expect(payloadBody(Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d))).toBe('{"raw":"\ufeff{}"}')
  })
  test('JSON is verbatim, including large integers and whitespace', () => {
    const json = '{ "id": 12345678901234567890123, "n": 1.0 }'
    expect(payloadBody(enc.encode(json))).toBe(json)
    expect(payloadBody(enc.encode('"x"'))).toBe('"x"')
  })
  test('non-JSON becomes raw object; invalid UTF-8 fails', () => {
    expect(JSON.parse(payloadBody(enc.encode('こんにちは')))).toEqual({ raw: 'こんにちは' })
    expect(JSON.parse(payloadBody(new Uint8Array()))).toEqual({ raw: '' })
    expect(() => payloadBody(Uint8Array.of(0xff, 0xfe))).toThrow(DecryptionError)
  })
})
