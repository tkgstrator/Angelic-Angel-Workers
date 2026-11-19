import { DurableObject } from 'cloudflare:workers'
import { b64u, encryptAes128gcm, encryptAesgcm, unb64u } from '../helpers/ece-encrypt'

const createState = () => ({
  uaid: '9c9742ccce004df8a4edf2f232835811',
  connections: 0,
  socket: undefined,
  frames: [],
  registrations: [],
  xRequests: [],
  deliveries: [],
  pending: new Map(),
  options: { xFailures: 0, webhookFailures: 0, ignoreUnregister: false, holdX: false },
  version: 0,
})
const normalized = (id) => id.replaceAll('-', '').toLowerCase()
const notify = async (state, input) => {
  const info = state.xRequests.at(-1)?.body.push_device_info
  if (!info || !state.socket) throw new Error('Not registered/connected')
  const channel = state.registrations.at(-1).channelID
  const frame = {
    messageType: 'notification',
    channelID: input.channelID || channel,
    version: input.version || `v/${++state.version}`,
  }
  if (input.emptyData) frame.data = ''
  else if (!input.noData) {
    const pub = unb64u(info.encryption_key1)
    const auth = input.badAuth ? new Uint8Array(16) : unb64u(info.encryption_key2)
    const bytes = input.invalidUtf8
      ? Uint8Array.of(255, 254)
      : new TextEncoder().encode(input.text || '{"title":"通知","id":9007199254740993}')
    if (input.encoding === 'aesgcm') {
      const encrypted = await encryptAesgcm(bytes, pub, auth)
      frame.data = b64u(encrypted.data)
      frame.headers = encrypted.headers
    } else {
      frame.data = b64u(await encryptAes128gcm(bytes, pub, auth, { rs: 128 }))
      frame.headers = { encoding: 'aes128gcm' }
    }
  }
  state.pending.set(`${normalized(frame.channelID)}:${frame.version}`, frame)
  state.socket.send(JSON.stringify(frame))
  return frame
}

export class Fixture extends DurableObject {
  state = createState()

  async fetch(request) {
    const state = this.state
    const url = new URL(request.url)
    if (url.hostname === 'fixture.test') {
      if (request.method === 'GET')
        return Response.json({
          ...state,
          socket: Boolean(state.socket),
          pending: state.pending.size,
        })
      const input = await request.json()
      if (input.command === 'restore') {
        for (const key of [
          'uaid',
          'connections',
          'frames',
          'registrations',
          'xRequests',
          'deliveries',
          'options',
          'version',
        ])
          state[key] = input.snapshot[key]
        return Response.json({ ok: true })
      }
      if (input.command === 'options') Object.assign(state.options, input.options)
      else if (input.command === 'notify') return Response.json(await notify(state, input))
      else if (input.command === 'close') state.socket?.close(input.code || 1000, 'fixture close')
      else if (input.command === 'invalidate') state.uaid = crypto.randomUUID().replaceAll('-', '')
      return Response.json({ ok: true })
    }
    if (url.hostname === 'push.services.mozilla.com') {
      const pair = new WebSocketPair()
      const server = pair[1]
      state.connections++
      state.socket = server
      server.accept()
      server.addEventListener('close', () => {
        if (state.socket === server) state.socket = undefined
      })
      server.addEventListener('message', async (event) => {
        const frame = JSON.parse(event.data)
        state.frames.push(frame)
        if (!frame.messageType) {
          if (!state.options.ignorePong) server.send('{}')
          return
        }
        if (frame.messageType === 'hello') {
          server.send(
            JSON.stringify({
              messageType: 'hello',
              status: 200,
              uaid: state.uaid,
              use_webpush: true,
            }),
          )
          for (const item of state.pending.values()) server.send(JSON.stringify(item))
        } else if (frame.messageType === 'register') {
          state.registrations.push(frame)
          server.send(
            JSON.stringify({
              messageType: 'register',
              status: 200,
              channelID: frame.channelID,
              pushEndpoint: `https://updates.push.services.mozilla.com/wpush/v2/${frame.channelID}`,
            }),
          )
        } else if (frame.messageType === 'unregister') {
          if (state.options.cleanupBackoff) {
            server.close(4774, 'cleanup backoff')
            return
          }
          if (!state.options.ignoreUnregister)
            server.send(
              JSON.stringify({
                messageType: 'unregister',
                status: 200,
                channelID: frame.channelID,
              }),
            )
        } else if (frame.messageType === 'ack') {
          for (const update of frame.updates)
            state.pending.delete(`${normalized(update.channelID)}:${update.version}`)
        }
      })
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    if (url.hostname === 'x.com') {
      state.xRequests.push({
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.json(),
      })
      if (state.options.holdX) await new Promise((resolve) => setTimeout(resolve, 500))
      if (state.options.xFailures > 0) {
        state.options.xFailures--
        return new Response('upstream secret body', { status: 503 })
      }
      return new Response(null, { status: 204 })
    }
    if (url.hostname === 'webhook.test') {
      const status = state.options.webhookFailures > 0 ? 503 : 200
      if (state.options.webhookFailures > 0) state.options.webhookFailures--
      state.deliveries.push({
        body: await request.text(),
        headers: Object.fromEntries(request.headers),
        status,
      })
      return new Response(null, { status })
    }
    return new Response('Unexpected outbound request', { status: 500 })
  }
}

export default {
  fetch(request, env) {
    return env.FIXTURE.getByName('fixture').fetch(request)
  },
}
