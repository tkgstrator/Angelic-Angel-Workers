import { describe, expect, test } from 'bun:test'
import {
  AUTOPUSH_URL,
  ackFrame,
  backoffMs,
  helloFrame,
  parseFrame,
  registerFrame,
  unregisterFrame,
} from '../src/autopush'

describe('autopush', () => {
  test('constants and outbound frames', () => {
    expect(AUTOPUSH_URL).toBe('https://push.services.mozilla.com/')
    expect(JSON.parse(helloFrame('u-1'))).toEqual({
      messageType: 'hello',
      uaid: 'u-1',
      use_webpush: true,
      broadcasts: {},
    })
    expect(JSON.parse(helloFrame(''))).toEqual({
      messageType: 'hello',
      uaid: '',
      use_webpush: true,
      broadcasts: {},
    })
    const reg = JSON.parse(registerFrame('c-1'))
    expect(reg.messageType).toBe('register')
    expect(reg.channelID).toBe('c-1')
    expect(reg.key).toBe(
      'BF5oEo0xDUpgylKDTlsd8pZmxQA1leYINiY-rSscWYK_3tWAkz4VMbtf1MLE_Yyd6iII6o-e3Q9TCN5vZMzVMEs',
    )
    expect(JSON.parse(unregisterFrame('c-1'))).toEqual({
      messageType: 'unregister',
      channelID: 'c-1',
      code: 200,
    })
    expect(JSON.parse(ackFrame('C-1', 'v/opaque', 101))).toEqual({
      messageType: 'ack',
      updates: [{ channelID: 'C-1', version: 'v/opaque', code: 101 }],
    })
  })

  test('parseFrame', () => {
    expect(parseFrame('{"messageType":"hello","status":200,"uaid":"u"}')).toEqual({
      type: 'hello',
      status: 200,
      uaid: 'u',
    })
    expect(
      parseFrame(
        '{"messageType":"register","status":200,"channelID":"c","pushEndpoint":"https://e"}',
      ),
    ).toEqual({ type: 'register', status: 200, channelId: 'c', endpoint: 'https://e' })
    expect(parseFrame('{"messageType":"register","status":409,"channelID":"c"}')).toEqual({
      type: 'register',
      status: 409,
      channelId: 'c',
    })
    expect(parseFrame('{"messageType":"unregister","status":200,"channelID":"c"}')).toEqual({
      type: 'unregister',
      status: 200,
      channelId: 'c',
    })
    expect(parseFrame('{}')).toEqual({ type: 'pong' })
    expect(parseFrame('{"x":1}')).toEqual({ type: 'pong' })
    expect(parseFrame('{"messageType":"broadcast","broadcasts":{}}')).toEqual({ type: 'ignore' })
    expect(parseFrame('{"messageType":"notification","channelID":"c","version":"v1"}')).toEqual({
      type: 'notification',
      channelId: 'c',
      version: 'v1',
    })
    expect(
      parseFrame('{"messageType":"notification","channelID":"c","version":"v1","data":null}'),
    ).toEqual({ type: 'notification', channelId: 'c', version: 'v1' })
    expect(
      parseFrame(
        '{"messageType":"notification","channelID":"c","version":"v1","data":"","headers":{"encoding":"aesgcm"}}',
      ),
    ).toEqual({
      type: 'notification',
      channelId: 'c',
      version: 'v1',
      data: '',
      headers: { encoding: 'aesgcm' },
    })
  })

  test('parseFrame rejects malformed known frames', () => {
    for (const text of [
      'nope',
      '[]',
      '"x"',
      '{"messageType":"hello"}',
      '{"messageType":"hello","status":"200"}',
      '{"messageType":"register","status":200,"channelID":"c"}',
      '{"messageType":"register","status":200,"pushEndpoint":"e"}',
      '{"messageType":"unregister","status":200}',
      '{"messageType":"notification","version":"v"}',
      '{"messageType":"notification","channelID":"c","version":5}',
      '{"messageType":"notification","channelID":"c","version":"v","data":5}',
      '{"messageType":"notification","channelID":"c","version":"v","headers":{"a":1}}',
    ]) {
      expect(() => parseFrame(text)).toThrow()
    }
  })

  test('backoffMs', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 100].map(backoffMs)).toEqual([
      5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000,
    ])
    expect(backoffMs(0)).toBe(5000)
    expect(backoffMs(Number.NaN)).toBe(5000)
  })
})
