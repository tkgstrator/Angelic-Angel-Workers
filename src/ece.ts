// Web Push content decryption (RFC 8188/8291 aes128gcm and draft-04 aesgcm) on Web Crypto only.
export type WebPushKeys = { publicKey: string; privateKey: JsonWebKey; authSecret: string }

export class DecryptionError extends Error {}
export class KeyUnavailableError extends Error {}

type PreparedKeys = Omit<WebPushKeys, 'privateKey'> & { privateKey: CryptoKey }

const encoder = new TextEncoder()
const TAG = 16
const BASE64URL = /^[A-Za-z0-9_-]*$/

export const toBase64Url = (bytes: Uint8Array): string => {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const body = text.replace(/=+$/, '')
  if (!BASE64URL.test(body) || body.length % 4 === 1) throw new Error('invalid base64url')
  const padded = body
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(body.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

export const generateKeys = async (): Promise<WebPushKeys> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  if (!('privateKey' in pair)) throw new Error('Expected an ECDH key pair')
  const exportedPublic = await crypto.subtle.exportKey('raw', pair.publicKey)
  if (!(exportedPublic instanceof ArrayBuffer)) throw new Error('Expected a raw public key')
  const publicKey = toBase64Url(new Uint8Array(exportedPublic))
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey)
  if (privateKey instanceof ArrayBuffer) throw new Error('Expected a private JWK')
  const authSecret = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  return { publicKey, privateKey, authSecret }
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((offset, part) => {
    out.set(part, offset)
    return offset + part.length
  }, 0)
  return out
}

const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) => {
  const key = await crypto.subtle.importKey('raw', ikm.slice(), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt.slice(), info: info.slice() },
      key,
      bytes * 8,
    ),
  )
}

const prepareReceiver = async (keys: WebPushKeys): Promise<PreparedKeys> => {
  try {
    const publicBytes = fromBase64Url(keys.publicKey)
    const auth = fromBase64Url(keys.authSecret)
    const jwk = keys.privateKey
    if (
      publicBytes.length !== 65 ||
      publicBytes[0] !== 4 ||
      auth.length !== 16 ||
      jwk.kty !== 'EC' ||
      jwk.crv !== 'P-256' ||
      typeof jwk.d !== 'string' ||
      fromBase64Url(jwk.d).length !== 32 ||
      jwk.x !== toBase64Url(publicBytes.slice(1, 33)) ||
      jwk.y !== toBase64Url(publicBytes.slice(33, 65))
    )
      throw new Error('Invalid receiver keys')
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    )
    return { publicKey: keys.publicKey, authSecret: keys.authSecret, privateKey }
  } catch {
    throw new KeyUnavailableError('Receiver keys are unavailable')
  }
}

const ecdh = async (priv: CryptoKey, peerPublic: Uint8Array): Promise<Uint8Array> => {
  const algorithm = { name: 'ECDH', namedCurve: 'P-256' }
  const peer = await crypto.subtle.importKey('raw', peerPublic.slice(), algorithm, false, [])
  // The generated Workers declarations spell this optional field "$public";
  // the standard Web Crypto runtime property is "public".
  const derivation = { name: 'ECDH', public: peer }
  return new Uint8Array(await crypto.subtle.deriveBits(derivation, priv, 256))
}

const nonceFor = (base: Uint8Array, index: number): Uint8Array<ArrayBuffer> => {
  const nonce = base.slice()
  const view = new DataView(nonce.buffer)
  view.setUint32(8, (view.getUint32(8) ^ index) >>> 0)
  return nonce
}

const openRecord = async (
  cek: CryptoKey,
  nonceBase: Uint8Array,
  index: number,
  record: Uint8Array,
) => {
  if (record.length < TAG + 1) throw new DecryptionError('record too short')
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonceFor(nonceBase, index) },
      cek,
      record.slice(),
    ),
  )
}

const decryptAes128gcm = async (body: Uint8Array, keys: PreparedKeys): Promise<Uint8Array> => {
  if (body.length < 21) throw new DecryptionError('truncated header')
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idLen = body[20]
  if (rs < TAG + 2) throw new DecryptionError('invalid record size')
  if (idLen !== 65 || body.length < 21 + idLen) throw new DecryptionError('invalid key id')
  const asPublic = body.slice(21, 21 + idLen)
  const uaPublic = fromBase64Url(keys.publicKey)
  const secret = await ecdh(keys.privateKey, asPublic)
  const ikm = await hkdf(
    fromBase64Url(keys.authSecret),
    secret,
    concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic),
    32,
  )
  const cek = await crypto.subtle.importKey(
    'raw',
    await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const nonceBase = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)
  const content = body.subarray(21 + idLen)
  if (content.length === 0) throw new DecryptionError('no records')
  const parts: Uint8Array[] = []
  const count = Math.ceil(content.length / rs)
  for (const i of Array.from({ length: count }, (_, index) => index)) {
    const last = i === count - 1
    const plain = await openRecord(cek, nonceBase, i, content.subarray(i * rs, (i + 1) * rs))
    const end = plain.findLastIndex((byte) => byte !== 0)
    if (end < 0) throw new DecryptionError('missing delimiter')
    const delimiter = plain[end]
    if (delimiter !== (last ? 2 : 1)) throw new DecryptionError('invalid delimiter')
    parts.push(plain.subarray(0, end))
  }
  return concat(...parts)
}

const parseParams = (value: string): Map<string, string> => {
  const out = new Map<string, string>()
  for (const item of value.split(/[;,]/)) {
    const index = item.indexOf('=')
    if (index > 0)
      out.set(
        item.slice(0, index).trim(),
        item
          .slice(index + 1)
          .trim()
          .replace(/^"|"$/g, ''),
      )
  }
  return out
}

const header = (headers: Record<string, string>, ...names: string[]) => {
  for (const [key, value] of Object.entries(headers)) {
    if (names.includes(key.toLowerCase().replaceAll('_', '-'))) return value
  }
  return undefined
}

const decryptAesgcm = async (
  body: Uint8Array,
  headers: Record<string, string>,
  keys: PreparedKeys,
): Promise<Uint8Array> => {
  const cryptoKey = header(headers, 'crypto-key')
  const encryption = header(headers, 'encryption')
  if (cryptoKey === undefined || encryption === undefined)
    throw new DecryptionError('missing headers')
  const dh = parseParams(cryptoKey).get('dh')
  const saltText = parseParams(encryption).get('salt')
  if (dh === undefined || saltText === undefined) throw new DecryptionError('missing dh or salt')
  const asPublic = fromBase64Url(dh)
  const salt = fromBase64Url(saltText)
  if (asPublic.length !== 65 || salt.length !== 16) throw new DecryptionError('invalid dh or salt')
  const rsText = parseParams(encryption).get('rs')
  const rs = rsText === undefined ? 4096 : Number(rsText)
  if (!Number.isInteger(rs) || rs < 3) throw new DecryptionError('invalid record size')
  const uaPublic = fromBase64Url(keys.publicKey)
  const secret = await ecdh(keys.privateKey, asPublic)
  const ikm = await hkdf(
    fromBase64Url(keys.authSecret),
    secret,
    encoder.encode('Content-Encoding: auth\0'),
    32,
  )
  const u16 = (n: number) => Uint8Array.of(n >> 8, n & 0xff)
  const context = concat(
    encoder.encode('P-256\0'),
    u16(uaPublic.length),
    uaPublic,
    u16(65),
    asPublic,
  )
  const cek = await crypto.subtle.importKey(
    'raw',
    await hkdf(salt, ikm, concat(encoder.encode('Content-Encoding: aesgcm\0'), context), 16),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const nonceBase = await hkdf(
    salt,
    ikm,
    concat(encoder.encode('Content-Encoding: nonce\0'), context),
    12,
  )
  if (body.length === 0) throw new DecryptionError('no records')
  const size = rs + TAG
  if (body.length % size === 0) throw new DecryptionError('missing final record')
  const parts: Uint8Array[] = []
  for (const i of Array.from({ length: Math.ceil(body.length / size) }, (_, index) => index)) {
    const plain = await openRecord(cek, nonceBase, i, body.subarray(i * size, (i + 1) * size))
    if (plain.length < 2) throw new DecryptionError('missing padding length')
    const pad = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint16(0)
    if (pad > plain.length - 2) throw new DecryptionError('invalid padding length')
    if (plain.subarray(2, 2 + pad).some((byte) => byte !== 0))
      throw new DecryptionError('invalid padding')
    parts.push(plain.subarray(2 + pad))
  }
  return concat(...parts)
}

export const decryptNotification = async (
  data: string,
  headers: Record<string, string> | undefined,
  keys: WebPushKeys,
): Promise<Uint8Array> => {
  // Local key failures are retryable and must not be reclassified as bad sender data.
  const prepared = await prepareReceiver(keys)
  try {
    const body = fromBase64Url(data)
    const h = headers === undefined ? {} : headers
    const encodingHeader = header(h, 'encoding', 'content-encoding')
    const encoding = (encodingHeader === undefined ? 'aes128gcm' : encodingHeader).toLowerCase()
    if (encoding === 'aes128gcm') return await decryptAes128gcm(body, prepared)
    if (encoding === 'aesgcm') return await decryptAesgcm(body, h, prepared)
    throw new DecryptionError('unsupported encoding')
  } catch (error) {
    if (error instanceof DecryptionError) throw error
    throw new DecryptionError('decryption failed')
  }
}

const decodePayload = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new DecryptionError('payload is not valid UTF-8')
  }
}

export const payloadBody = (bytes: Uint8Array): string => {
  const text = decodePayload(bytes)
  try {
    JSON.parse(text)
    return text
  } catch {
    return JSON.stringify({ raw: text })
  }
}
