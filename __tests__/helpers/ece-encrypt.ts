// Independent test-side encryptors (RFC 8188/8291 aes128gcm and draft-04 aesgcm).
// Deliberately does not import anything from src/ so the production decryptor is
// checked against a separately written implementation.
const enc = new TextEncoder()

export const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

export const unb64u = (text: string): Uint8Array => {
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((offset, p) => {
    out.set(p, offset)
    return offset + p.length
  }, 0)
  return out
}

const hkdf = async (
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey('raw', ikm.slice(), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt.slice(), info: info.slice() },
      key,
      bytes * 8,
    ),
  )
}

const senderEcdh = async (uaPublic: Uint8Array) => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const peer = await crypto.subtle.importKey(
    'raw',
    uaPublic.slice(),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256),
  )
  return { asPublic, secret }
}

const nonceFor = (base: Uint8Array, index: number): Uint8Array<ArrayBuffer> => {
  const nonce = base.slice()
  const view = new DataView(nonce.buffer)
  // XOR the record counter into the low 32 bits (counters in tests stay tiny).
  view.setUint32(8, view.getUint32(8) ^ index)
  return nonce
}

const sealRecords = async (
  records: Uint8Array[],
  cek: Uint8Array,
  nonceBase: Uint8Array,
): Promise<Uint8Array[]> => {
  const key = await crypto.subtle.importKey('raw', cek.slice(), 'AES-GCM', false, ['encrypt'])
  return Promise.all(
    records.map(
      async (record, i) =>
        new Uint8Array(
          await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonceFor(nonceBase, i) },
            key,
            record.slice(),
          ),
        ),
    ),
  )
}

export type Aes128Options = {
  rs?: number
  /** zero bytes appended after the final delimiter */
  pad?: number
  salt?: Uint8Array
  /** raw plaintext records (delimiter included) overriding automatic chunking */
  rawRecords?: Uint8Array[]
  /** header keyid override (defaults to the sender public key) */
  keyId?: Uint8Array
}

export const encryptAes128gcm = async (
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  options: Aes128Options = {},
): Promise<Uint8Array> => {
  const rs = options.rs === undefined ? 4096 : options.rs
  const salt =
    options.salt === undefined ? crypto.getRandomValues(new Uint8Array(16)) : options.salt
  const { asPublic, secret } = await senderEcdh(uaPublic)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, secret, keyInfo, 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonceBase = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  const per = rs - 17
  const pieces = Array.from({ length: Math.max(1, Math.ceil(plaintext.length / per)) }, (_, i) =>
    plaintext.slice(i * per, (i + 1) * per),
  )
  const records =
    options.rawRecords === undefined
      ? pieces.map((piece, i) =>
          concat(
            piece,
            Uint8Array.of(i === pieces.length - 1 ? 2 : 1),
            new Uint8Array(i === pieces.length - 1 && options.pad !== undefined ? options.pad : 0),
          ),
        )
      : options.rawRecords
  const sealed = await sealRecords(records, cek, nonceBase)
  const keyId = options.keyId === undefined ? asPublic : options.keyId
  const header = new Uint8Array(21 + keyId.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, rs)
  header[20] = keyId.length
  header.set(keyId, 21)
  return concat(header, ...sealed)
}

export type AesgcmOptions = {
  rs?: number
  salt?: Uint8Array
  /** padding length for each record (default 0) */
  pad?: number
  /** replace the padding bytes (to build invalid non-zero padding) */
  padFill?: number
}

export const encryptAesgcm = async (
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  options: AesgcmOptions = {},
) => {
  const rs = options.rs === undefined ? 4096 : options.rs
  const salt =
    options.salt === undefined ? crypto.getRandomValues(new Uint8Array(16)) : options.salt
  const pad = options.pad === undefined ? 0 : options.pad
  const { asPublic, secret } = await senderEcdh(uaPublic)
  const ikm = await hkdf(authSecret, secret, enc.encode('Content-Encoding: auth\0'), 32)
  const u16 = (n: number) => Uint8Array.of(n >> 8, n & 0xff)
  const context = concat(
    enc.encode('P-256\0'),
    u16(uaPublic.length),
    uaPublic,
    u16(asPublic.length),
    asPublic,
  )
  const cek = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: aesgcm\0'), context), 16)
  const nonceBase = await hkdf(
    salt,
    ikm,
    concat(enc.encode('Content-Encoding: nonce\0'), context),
    12,
  )
  const per = rs - 2 - pad
  const pieces = Array.from({ length: Math.max(1, Math.ceil(plaintext.length / per)) }, (_, i) =>
    plaintext.slice(i * per, (i + 1) * per),
  )
  const records = pieces.map((piece) =>
    concat(
      u16(pad),
      new Uint8Array(pad).fill(options.padFill === undefined ? 0 : options.padFill),
      piece,
    ),
  )
  if (records.at(-1)?.byteLength === rs) records.push(Uint8Array.of(0, 0))
  const sealed = await sealRecords(records, cek, nonceBase)
  return {
    data: concat(...sealed),
    headers: {
      encoding: 'aesgcm',
      crypto_key: `dh=${b64u(asPublic)}`,
      encryption: `salt=${b64u(salt)}${options.rs === undefined ? '' : `;rs=${rs}`}`,
    },
  }
}
