import type { Env } from './config'
import { LISTENER_NAME } from './config'
import { probeResponse } from './inbox'

export { Angelic } from './angelic'
export { Inbox } from './inbox'

const methods: Record<string, string> = {
  '/api/register': 'POST',
  '/api/start': 'POST',
  '/api/stop': 'POST',
  '/api/status': 'GET',
  '/api/unregister': 'POST',
  '/api/deadletters': 'GET',
  '/api/retry-deadletters': 'POST',
}

async function authorized(request: Request, token: string): Promise<boolean> {
  const authorization = request.headers.get('Authorization')
  if (authorization === null || !/^Bearer /i.test(authorization)) return false
  const encoder = new TextEncoder()
  const [supplied, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(authorization.slice(7))),
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
  ])
  const right = new Uint8Array(expected)
  // Both SHA-256 outputs have fixed length; consume every byte without an early exit.
  return (
    new Uint8Array(supplied).reduce((difference, byte, index) => {
      const expectedByte = right[index]
      return expectedByte === undefined ? 1 : difference | (byte ^ expectedByte)
    }, 0) === 0
  )
}

function apiError(error: string, status: number, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      if (typeof env.ADMIN_TOKEN !== 'string' || env.ADMIN_TOKEN.length === 0)
        return apiError('ADMIN_TOKEN is not configured', 503)
      if (!(await authorized(request, env.ADMIN_TOKEN)))
        return apiError('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer' })
      const method = methods[url.pathname]
      if (method === undefined) return apiError('Not found', 404)
      if (request.method !== method) return apiError('Method not allowed', 405, { Allow: method })
      try {
        const response = await env.ANGELIC.getByName(LISTENER_NAME).fetch(request)
        const headers = new Headers(response.headers)
        headers.set('Cache-Control', 'no-store')
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      } catch {
        return apiError('Receiver temporarily unavailable', 503)
      }
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz'))
      return Response.json({ service: 'angelic-angel-workers' })
    const probe = await probeResponse(request, env)
    return probe === undefined ? new Response(null, { status: 404 }) : probe
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(env.ANGELIC.getByName(LISTENER_NAME).ensure())
  },
} satisfies ExportedHandler<Env>
