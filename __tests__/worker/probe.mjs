import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRuntime } from './harness.js'

test('management requests and unrelated paths never enter the legacy Inbox', { timeout: 20000 }, () => withRuntime(async ({ mf, api }) => {
  await api('status')
  await mf.dispatchFetch('https://worker.test/api/start', { method: 'POST', headers: { Authorization: 'Bearer credential-that-must-not-be-recorded' }, body: 'private credential body' })
  await mf.dispatchFetch('https://worker.test/unrelated', { method: 'POST', body: 'unrelated' })
  const rows = await (await mf.dispatchFetch('https://worker.test/inbox/probe-test-token')).json()
  assert.deepEqual(rows, [])
}, { PROBE_TOKEN: 'probe-test-token' }))

test('legacy body capture is bounded while retaining the original byte count', { timeout: 20000 }, () => withRuntime(async ({ mf }) => {
  const bytes = new Uint8Array(70000).fill(97)
  const received = await mf.dispatchFetch('https://worker.test/push/probe-test-token', { method: 'POST', body: bytes, headers: { Authorization: 'Bearer private-secret', Cookie: 'secret=session' } })
  assert.equal(received.status, 201)
  const rows = await (await mf.dispatchFetch('https://worker.test/inbox/probe-test-token')).json()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].bodyBytes, 70000)
  assert.equal(Buffer.from(rows[0].body, 'base64').length, 65536)
  assert.equal(rows[0].headers.authorization, '[redacted]')
  assert.equal(rows[0].headers.cookie, '[redacted]')
  for (const value of ['-1', '101', 'NaN', '0', '1.5']) assert.equal((await mf.dispatchFetch(`https://worker.test/inbox/probe-test-token?limit=${value}`)).status, 400)
}, { PROBE_TOKEN: 'probe-test-token' }))

test('gone probe mode records the request and returns 410', { timeout: 20000 }, () => withRuntime(async ({ mf }) => {
  assert.equal((await mf.dispatchFetch('https://worker.test/push/probe-test-token', { method: 'POST', body: 'gone' })).status, 410)
  const rows = await (await mf.dispatchFetch('https://worker.test/inbox/probe-test-token')).json()
  assert.equal(rows.length, 1)
}, { PROBE_TOKEN: 'probe-test-token', MODE: 'gone' }))

test('missing admin secret fails closed even with a presented token', { timeout: 20000 }, () => withRuntime(async ({ api }) => {
  assert.equal((await api('status')).status, 503)
}, { ADMIN_TOKEN: '' }))

test('registered management routes reject incorrect methods and unknown routes', { timeout: 20000 }, () => withRuntime(async ({ api }) => {
  const invalid = await api('register', 'GET')
  assert.equal(invalid.status, 405)
  assert.equal(invalid.headers.get('allow'), 'POST')
  assert.equal((await api('does-not-exist')).status, 404)
  assert.equal((await api('start', 'POST')).status, 409)
}))
