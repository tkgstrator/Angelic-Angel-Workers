import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

const build = async (entry, output) => {
  const result = spawnSync(
    'bun',
    ['build', entry, '--target=browser', '--external=cloudflare:workers', '--outfile', output],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  return readFile(output, 'utf8')
}
export const eventually = async (get, predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout
  const result = { value: undefined }
  for (;;) {
    result.value = await get()
    if (predicate(result.value)) return result.value
    if (Date.now() >= deadline) throw new Error(`Timed out: ${JSON.stringify(result.value)}`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}
export const withRuntime = async (run, bindings = {}, fixture = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'angelic-workerd-'))
  const owned = { runtime: undefined }
  try {
    const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'))
    const [script, upstream] = await Promise.all([
      build(
        fixture.entry === undefined ? 'src/index.ts' : fixture.entry,
        join(directory, 'worker.mjs'),
      ),
      build('__tests__/worker/upstream.js', join(directory, 'upstream.mjs')),
    ])
    const options = convertV4MiniflareOptions({
      unsafeInspectDurableObjects: true,
      resourcePersistencePath: join(directory, 'storage'),
      workers: [
        {
          name: 'app',
          modules: true,
          script,
          compatibilityDate: config.compatibility_date,
          durableObjects: Object.fromEntries(
            config.durable_objects.bindings.map((b) => [
              b.name,
              {
                className:
                  b.name === 'ANGELIC' && fixture.className ? fixture.className : b.class_name,
                useSQLite: true,
              },
            ]),
          ),
          bindings: {
            ADMIN_TOKEN: 'admin-test-token',
            X_AUTH_TOKEN: 'AUTH_TEST_SECRET',
            X_CT0: 'CT0_TEST_SECRET',
            WEBHOOK_ENDPOINT: 'https://webhook.test/',
            MODE: 'record',
            ...bindings,
          },
          outboundService: 'upstream',
        },
        {
          name: 'upstream',
          modules: true,
          script: upstream,
          compatibilityDate: config.compatibility_date,
          durableObjects: { FIXTURE: { className: 'Fixture', useSQLite: true } },
        },
      ],
    })
    owned.runtime = new Miniflare(options)
    const mf = owned.runtime
    await mf.ready
    owned.upstream = await mf.getWorker('upstream')
    const api = (path, method = 'GET', extra = {}) =>
      owned.runtime.dispatchFetch(`https://worker.test/api/${path}`, {
        method,
        headers: { Authorization: 'Bearer admin-test-token', ...extra.headers },
        ...extra,
      })
    const status = async () => (await api('status')).json()
    const control = async (input) =>
      (
        await owned.upstream.fetch(
          'https://fixture.test/',
          input
            ? {
                method: 'POST',
                body: JSON.stringify(input),
                headers: { 'Content-Type': 'application/json' },
              }
            : {},
        )
      ).json()
    const namespace = await mf.getDurableObjectNamespace('ANGELIC', 'app')
    const id = namespace.idFromName('listener')
    owned.stub = namespace.get(id)
    await run({
      get mf() {
        return owned.runtime
      },
      api,
      status,
      control,
      get stub() {
        return owned.stub
      },
      id,
      storage: () =>
        owned.runtime.unsafeGetDurableObjectStorage(
          'app',
          fixture.className === undefined ? 'Angelic' : fixture.className,
          { id: id.toString() },
        ),
      restart: async () => {
        const snapshot = await control()
        await owned.runtime.dispose()
        owned.runtime = new Miniflare(options)
        await owned.runtime.ready
        owned.upstream = await owned.runtime.getWorker('upstream')
        const restoredNamespace = await owned.runtime.getDurableObjectNamespace('ANGELIC', 'app')
        owned.stub = restoredNamespace.get(restoredNamespace.idFromName('listener'))
        await control({ command: 'restore', snapshot })
      },
    })
  } finally {
    try {
      if (owned.runtime) await owned.runtime.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
export const registerAndStart = async (ctx) => {
  const registered = await ctx.api('register', 'POST')
  assert.equal(registered.status, 200, await registered.text())
  const started = await ctx.api('start', 'POST')
  assert.equal(started.status, 200, await started.text())
  await eventually(ctx.status, (s) => s.connected)
}
