import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

let runtime
let directory

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'angelic-routing-'))
  const output = join(directory, 'worker.mjs')
  const build = spawnSync('bun', ['build', 'src/index.ts', '--target=browser', '--external=cloudflare:workers', '--outfile', output], { encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr)
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'))
  const durableObjects = Object.fromEntries(config.durable_objects.bindings.map((binding) => [binding.name, { className: binding.class_name, useSQLite: true }]))
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: await readFile(output, 'utf8'),
    compatibilityDate: config.compatibility_date,
    durableObjects,
    bindings: { ADMIN_TOKEN: 'admin-test-token', MODE: 'record' },
  }))
  await runtime.ready
})

after(async () => {
  try { if (runtime) await runtime.dispose() } finally { if (directory) await rm(directory, { recursive: true, force: true }) }
})

test('unauthenticated status fails closed before accessing a receiver', async () => {
  const response = await runtime.dispatchFetch('https://worker.test/api/status')
  assert.equal(response.status, 401)
})

test('invalid bearer token cannot start the listener', async () => {
  const response = await runtime.dispatchFetch('https://worker.test/api/start', { method: 'POST', headers: { Authorization: 'Bearer wrong-token' } })
  assert.equal(response.status, 401)
})

test('missing probe secret never enables the literal undefined path', async () => {
  const response = await runtime.dispatchFetch('https://worker.test/push/undefined', { method: 'POST', body: 'private request' })
  assert.equal(response.status, 404)
})
