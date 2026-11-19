import { DurableObject } from 'cloudflare:workers'
import type { Env } from './config'

type Received = {
  at: string
  method: string
  path: string
  headers: Record<string, string>
  body: string
  bodyBytes: number
}

type StoredReceived = Omit<Received, 'headers' | 'bodyBytes'> & {
  headers: string
  body_bytes: number
}

const MAX_BODY_BYTES = 64 * 1024

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  )
}

/** Class, table and object name are retained for the original v1 migration. */
export class Inbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS received (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, method TEXT, path TEXT, headers TEXT, body TEXT, body_bytes INTEGER)',
    )
  }

  record(received: Received): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO received (at, method, path, headers, body, body_bytes) VALUES (?, ?, ?, ?, ?, ?)',
      received.at,
      received.method,
      received.path,
      JSON.stringify(received.headers),
      received.body,
      received.bodyBytes,
    )
  }

  list(limit: number): Received[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Invalid inbox limit')
    return this.ctx.storage.sql
      .exec<StoredReceived>(
        'SELECT at, method, path, headers, body, body_bytes FROM received ORDER BY id DESC LIMIT ?',
        limit,
      )
      .toArray()
      .map((row) => {
        const headers: unknown = JSON.parse(row.headers)
        return {
          at: row.at,
          method: row.method,
          path: row.path,
          headers: isStringRecord(headers) ? headers : {},
          body: row.body,
          bodyBytes: row.body_bytes,
        }
      })
  }
}

/** Drain the body without retaining more than 64 KiB, while keeping its real byte count. */
async function probeBody(request: Request): Promise<{ body: string; bodyBytes: number }> {
  const chunks: Uint8Array[] = []
  const size = { received: 0, stored: 0 }
  if (request.body !== null) {
    for await (const chunk of request.body) {
      size.received += chunk.byteLength
      const remaining = MAX_BODY_BYTES - size.stored
      if (remaining > 0) {
        const kept = chunk.slice(0, remaining)
        chunks.push(kept)
        size.stored += kept.byteLength
      }
    }
  }
  const bytes = new Uint8Array(size.stored)
  chunks.reduce((offset, chunk) => {
    bytes.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return {
    body: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')),
    bodyBytes: size.received,
  }
}

export async function probeResponse(request: Request, env: Env): Promise<Response | undefined> {
  if (typeof env.PROBE_TOKEN !== 'string' || env.PROBE_TOKEN.length === 0) return undefined
  const url = new URL(request.url)
  if (url.pathname === `/inbox/${env.PROBE_TOKEN}`) {
    if (request.method !== 'GET')
      return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    const parameter = url.searchParams.get('limit')
    const limit = parameter === null ? 50 : Number(parameter)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return Response.json({ error: 'limit must be an integer from 1 to 100' }, { status: 400 })
    return Response.json(await env.INBOX.getByName('inbox').list(limit), {
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  if (url.pathname !== `/push/${env.PROBE_TOKEN}`) return undefined
  const headers = Object.fromEntries(
    Array.from(request.headers, ([key, value]) => [
      key,
      ['authorization', 'cookie', 'proxy-authorization', 'x-csrf-token'].includes(key.toLowerCase())
        ? '[redacted]'
        : value,
    ]),
  )
  const body = await probeBody(request)
  await env.INBOX.getByName('inbox').record({
    at: new Date(Date.now()).toISOString(),
    method: request.method,
    path: url.pathname,
    headers,
    ...body,
  })
  if (env.MODE === 'gone') return new Response(null, { status: 410 })
  return new Response(null, {
    status: 201,
    headers: { Location: `/push/${env.PROBE_TOKEN}/${crypto.randomUUID()}` },
  })
}
