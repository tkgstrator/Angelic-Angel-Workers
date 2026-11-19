import { toBase64Url } from './ece'

export const AUTOPUSH_URL = 'https://push.services.mozilla.com/'

export type Frame =
  | { type: 'hello'; status: number; uaid?: string }
  | { type: 'register'; status: number; channelId: string; endpoint?: string }
  | { type: 'unregister'; status: number; channelId: string }
  | {
      type: 'notification'
      channelId: string
      version: string
      data?: string
      headers?: Record<string, string>
    }
  | { type: 'pong' }
  | { type: 'ignore' }

// Upstream X applicationServerKey (uncompressed P-256 point).
const X_VAPID_PUBLIC_KEY = Uint8Array.from([
  4, 94, 104, 18, 141, 49, 13, 74, 96, 202, 82, 131, 78, 91, 29, 242, 150, 102, 197, 0, 53, 149,
  230, 8, 54, 38, 62, 173, 43, 28, 89, 130, 191, 222, 213, 128, 147, 62, 21, 49, 187, 95, 212, 194,
  196, 253, 140, 157, 234, 34, 8, 234, 143, 158, 221, 15, 83, 8, 222, 111, 100, 204, 213, 48, 75,
])

const bad = (what: string): never => {
  throw new Error(`malformed AutoPush frame: ${what}`)
}

const str = (value: unknown, what: string): string =>
  typeof value === 'string' ? value : bad(what)
const num = (value: unknown, what: string): number =>
  typeof value === 'number' && Number.isInteger(value) ? value : bad(what)

const readJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return bad('not JSON')
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseFrame = (text: string): Frame => {
  const o = readJson(text)
  if (!isObject(o)) return bad('not an object')
  if (!('messageType' in o)) return { type: 'pong' }
  switch (o.messageType) {
    case 'hello': {
      const status = num(o.status, 'hello status')
      if (o.uaid !== undefined && o.uaid !== null && typeof o.uaid !== 'string') bad('hello uaid')
      return typeof o.uaid === 'string'
        ? { type: 'hello', status, uaid: o.uaid }
        : { type: 'hello', status }
    }
    case 'register': {
      const status = num(o.status, 'register status')
      const channelId = str(o.channelID, 'register channelID')
      if (
        o.pushEndpoint !== undefined &&
        o.pushEndpoint !== null &&
        typeof o.pushEndpoint !== 'string'
      ) {
        bad('register pushEndpoint')
      }
      if (typeof o.pushEndpoint === 'string')
        return { type: 'register', status, channelId, endpoint: o.pushEndpoint }
      if (status === 200) bad('register pushEndpoint missing')
      return { type: 'register', status, channelId }
    }
    case 'unregister':
      return {
        type: 'unregister',
        status: num(o.status, 'unregister status'),
        channelId: str(o.channelID, 'unregister channelID'),
      }
    case 'notification': {
      const frame: Frame = {
        type: 'notification',
        channelId: str(o.channelID, 'notification channelID'),
        version: str(o.version, 'notification version'),
      }
      if (o.data !== undefined && o.data !== null) frame.data = str(o.data, 'notification data')
      if (o.headers !== undefined && o.headers !== null) {
        if (!isObject(o.headers)) return bad('notification headers')
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(o.headers))
          headers[k] = str(v, 'notification header value')
        frame.headers = headers
      }
      return frame
    }
    default:
      return { type: 'ignore' }
  }
}

export const helloFrame = (uaid: string): string =>
  JSON.stringify({ messageType: 'hello', uaid, use_webpush: true, broadcasts: {} })

export const registerFrame = (channelId: string): string =>
  JSON.stringify({
    messageType: 'register',
    channelID: channelId,
    key: toBase64Url(X_VAPID_PUBLIC_KEY),
  })

export const unregisterFrame = (channelId: string): string =>
  JSON.stringify({ messageType: 'unregister', channelID: channelId, code: 200 })

export const ackFrame = (channelId: string, version: string, code: 100 | 101 | 102): string =>
  JSON.stringify({ messageType: 'ack', updates: [{ channelID: channelId, version, code }] })

export const backoffMs = (attempt: number): number => {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1
  return Math.min(5000 * 2 ** Math.min(n - 1, 20), 300000)
}
