import type { WebPushKeys } from './ece'

const URL_LOGIN = 'https://x.com/i/api/1.1/notifications/settings/login.json'
const BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const DEVICE_ID = 'Mac/Firefox'
const TIMEOUT_MS = 10_000
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/

export const buildXRegistrationRequest = (
  authToken: string,
  ct0: string,
  endpoint: string,
  keys: WebPushKeys,
): Request => {
  if (!COOKIE_VALUE.test(authToken) || !COOKIE_VALUE.test(ct0))
    throw new Error('X credentials are invalid')
  const body = {
    push_device_info: {
      os_version: DEVICE_ID,
      udid: DEVICE_ID,
      env: 3,
      locale: 'en',
      protocol_version: 1,
      token: endpoint,
      encryption_key1: keys.publicKey,
      encryption_key2: keys.authSecret,
    },
  }
  return new Request(URL_LOGIN, {
    method: 'POST',
    headers: {
      Authorization: BEARER,
      'x-csrf-token': ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'Content-Type': 'application/json',
      Cookie: `auth_token=${authToken}; ct0=${ct0}`,
    },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

export const registerWithX = async (
  authToken: string,
  ct0: string,
  endpoint: string,
  keys: WebPushKeys,
  fetcher: (request: Request) => Promise<Response> = (request) => fetch(request),
): Promise<void> => {
  const request = buildXRegistrationRequest(authToken, ct0, endpoint, keys)
  const timer: { id?: ReturnType<typeof setTimeout> } = {}
  const response = await (async (): Promise<Response> => {
    try {
      return await Promise.race([
        fetcher(request),
        new Promise<never>((_, reject) => {
          timer.id = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      const stage = error instanceof Error && error.message === 'timeout' ? 'timeout' : 'request'
      throw new Error(`X registration failed: ${stage}`)
    } finally {
      if (timer.id !== undefined) clearTimeout(timer.id)
    }
  })()
  await response.body?.cancel().catch(() => {})
  if (response.status < 200 || response.status > 299) {
    throw new Error(`X registration failed: HTTP ${response.status}`)
  }
}
