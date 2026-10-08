import { DurableObject } from 'cloudflare:workers'

type Env = {
  INBOX: DurableObjectNamespace<Inbox>
  PROBE_TOKEN: string
  MODE: 'record' | 'gone'
}

type Received = {
  at: string
  method: string
  path: string
  headers: Record<string, string>
  body: string
  bodyBytes: number
}

const MAX_BODY_BYTES = 64 * 1024

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** Stores every request that reaches the push endpoint, so nothing depends on being tailed live. */
export class Inbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS received (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, method TEXT, path TEXT, headers TEXT, body TEXT, body_bytes INTEGER)',
    )
  }

  record(r: Received): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO received (at, method, path, headers, body, body_bytes) VALUES (?, ?, ?, ?, ?, ?)',
      r.at,
      r.method,
      r.path,
      JSON.stringify(r.headers),
      r.body,
      r.bodyBytes,
    )
  }

  list(limit: number): Received[] {
    return this.ctx.storage.sql
      .exec<{ at: string; method: string; path: string; headers: string; body: string; body_bytes: number }>(
        'SELECT at, method, path, headers, body, body_bytes FROM received ORDER BY id DESC LIMIT ?',
        limit,
      )
      .toArray()
      .map((row) => ({
        at: row.at,
        method: row.method,
        path: row.path,
        headers: JSON.parse(row.headers) as Record<string, string>,
        body: row.body,
        bodyBytes: row.body_bytes,
      }))
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    const inbox = env.INBOX.getByName('inbox')

    if (request.method === 'GET' && url.pathname === `/inbox/${env.PROBE_TOKEN}`) {
      const limit = Number(url.searchParams.get('limit') ?? '50')
      return Response.json(await inbox.list(limit))
    }

    // Record everything else (including wrong paths) to see exactly what the sender hits.
    const raw = new Uint8Array(await request.arrayBuffer())
    await inbox.record({
      at: new Date().toISOString(),
      method: request.method,
      path: url.pathname,
      headers: Object.fromEntries(request.headers),
      body: toBase64(raw.slice(0, MAX_BODY_BYTES)),
      bodyBytes: raw.byteLength,
    })

    if (url.pathname !== `/push/${env.PROBE_TOKEN}`) {
      return new Response(null, { status: 404 })
    }
    // 410 tells a Web Push sender the subscription is gone and should be dropped.
    if (env.MODE === 'gone') {
      return new Response(null, { status: 410 })
    }
    // Push services answer 201 Created on accepted messages (RFC 8030 §5).
    return new Response(null, { status: 201, headers: { Location: `/push/${env.PROBE_TOKEN}/${crypto.randomUUID()}` } })
  },
} satisfies ExportedHandler<Env>
