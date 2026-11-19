import { describe, expect, test } from 'bun:test'
import { buildXRegistrationRequest, registerWithX } from '../src/x'
import { rfcKeys } from './helpers/rfc-vector'

describe('x registration', () => {
  const keys = rfcKeys
  test('request matches upstream exactly', async () => {
    const request = buildXRegistrationRequest(
      'AUTH',
      'CT0',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      keys,
    )
    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://x.com/i/api/1.1/notifications/settings/login.json')
    expect(request.redirect).toBe('manual')
    expect(request.headers.get('authorization')).toBe(
      'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    )
    expect(request.headers.get('x-csrf-token')).toBe('CT0')
    expect(request.headers.get('x-twitter-auth-type')).toBe('OAuth2Session')
    expect(request.headers.get('x-twitter-active-user')).toBe('yes')
    expect(request.headers.get('x-twitter-client-language')).toBe('en')
    expect(request.headers.get('content-type')).toBe('application/json')
    expect(request.headers.get('cookie')).toBe('auth_token=AUTH; ct0=CT0')
    expect(await request.json()).toEqual({
      push_device_info: {
        os_version: 'Mac/Firefox',
        udid: 'Mac/Firefox',
        env: 3,
        locale: 'en',
        protocol_version: 1,
        token: 'https://updates.push.services.mozilla.com/wpush/v2/abc',
        encryption_key1: keys.publicKey,
        encryption_key2: keys.authSecret,
      },
    })
  })

  test('rejects credentials that could inject headers', () => {
    expect(() => buildXRegistrationRequest('a\r\nX: y', 'c', 'e', keys)).toThrow()
    expect(() => buildXRegistrationRequest('a', 'c; d=e', 'e', keys)).toThrow()
  })

  test('accepts any 2xx; errors are safe', async () => {
    await registerWithX(
      'A',
      'C',
      'https://secret.example/ep',
      keys,
      async () => new Response('{}', { status: 204 }),
    )
    await registerWithX(
      'A',
      'C',
      'https://secret.example/ep',
      keys,
      async () => new Response('x', { status: 200 }),
    )
    const err = await registerWithX(
      'AUTHSECRET',
      'CT0SECRET',
      'https://secret.example/ep',
      keys,
      async () =>
        new Response('body-leak AUTHSECRET', { status: 403, headers: { 'set-cookie': 'z=1' } }),
    ).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(err?.message).toBe('X registration failed: HTTP 403')
    const net = await registerWithX(
      'AUTHSECRET',
      'CT0SECRET',
      'https://secret.example/ep',
      keys,
      async () => {
        throw new Error('connect to https://secret.example/ep with AUTHSECRET failed')
      },
    ).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(net?.message).toBe('X registration failed: request')
    for (const status of [301, 500]) {
      const e = await registerWithX(
        'A',
        'C',
        'e',
        keys,
        async () => new Response('', { status }),
      ).then(
        () => undefined,
        (x: Error) => x,
      )
      expect(e?.message).toBe(`X registration failed: HTTP ${status}`)
    }
  })
})
