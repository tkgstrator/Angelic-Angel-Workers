import type { Frame } from './autopush'
import { AUTOPUSH_URL, backoffMs, helloFrame, parseFrame } from './autopush'
import { normalizeChannel } from './outbox'
import { cancelled, isCode, SafeError } from './safe-error'
import type { StateStore } from './state'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:134.0) Gecko/20100101 Firefox/134.0'
const ORIGIN = 'https://x.com'
const BACKOFF_CODE = 4774
const BACKOFF_MS = 30 * 60_000
const PING_MS = 5 * 60_000
const PONG_MS = 10_000
const REQUEST_MS = 10_000
const CLOSED_RETRY_MS = 1_000

export type Waiter = {
  kind: 'hello' | 'register' | 'unregister'
  channel: string
  resolve: (frame: Frame) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type Conn = {
  ws: WebSocket
  ready: boolean
  uaid?: string
  waiters: Set<Waiter>
  queue: Promise<void>
  pingAt: number
  pongBy?: number
}

export type DropKind = 'closed' | 'fault' | 'intentional'
export type Notification = Extract<Frame, { type: 'notification' }>

/** Narrow callbacks back to the coordinator; the link never imports it. */
export type LinkPorts = {
  reschedule: () => Promise<void>
  notification: (conn: Conn, frame: Notification) => void
}

const timeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SafeError(504, message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

const discardSocket = (response: Response): void => {
  const ws = response.webSocket
  if (ws === null || ws === undefined) return
  try {
    ws.accept()
    ws.close(1000, 'discarded')
  } catch {
    // The socket is already unusable; nothing else to release.
  }
}

const parse = (text: string): Frame | undefined => {
  try {
    return parseFrame(text)
  } catch {
    return undefined
  }
}

/** Owns the one AutoPush socket, its waiters, heartbeat and the cancellation epoch. */
export class AutoPushLink {
  private socket?: Conn
  private dialing?: Promise<Conn>
  private generation = 0

  constructor(
    private readonly store: StateStore,
    private readonly ports: LinkPorts,
  ) {}

  get conn(): Conn | undefined {
    return this.socket
  }

  get connecting(): Promise<Conn> | undefined {
    return this.dialing
  }

  get epoch(): number {
    return this.generation
  }

  bumpEpoch(): void {
    this.generation += 1
  }

  /** Fails every waiter except a pending unregistration's. */
  failCancellable(): void {
    const conn = this.socket
    if (conn === undefined) return
    for (const waiter of [...conn.waiters]) {
      if (waiter.kind !== 'unregister') this.failWaiter(conn, waiter, cancelled())
    }
  }

  close(): void {
    if (this.socket !== undefined) this.drop(this.socket, 'intentional')
  }

  checkPing(): void {
    const conn = this.socket
    if (conn === undefined || !conn.ready) return
    const now = Date.now()
    if (conn.pongBy !== undefined) {
      if (now >= conn.pongBy) this.drop(conn, 'closed')
      return
    }
    if (now < conn.pingAt) return
    try {
      conn.ws.send('{}')
      conn.pongBy = now + PONG_MS
    } catch {
      this.drop(conn, 'closed')
    }
  }

  /** Schedules the next listen attempt for an enabled, registered receiver. */
  private scheduleReconnect(kind: 'fail' | 'closed' | 'backoff'): void {
    const { run, sub, unregistering, failCount, backoffUntil } = this.store.state
    if (!run || sub === undefined || unregistering) return
    const now = Date.now()
    if (kind === 'backoff') this.store.update({ reconnectAt: backoffUntil })
    else if (kind === 'closed')
      this.store.update({ failCount: 0, reconnectAt: now + CLOSED_RETRY_MS })
    else
      this.store.update({ failCount: failCount + 1, reconnectAt: now + backoffMs(failCount + 1) })
  }

  private failWaiter(conn: Conn, waiter: Waiter, error: Error): void {
    clearTimeout(waiter.timer)
    conn.waiters.delete(waiter)
    waiter.reject(error)
  }

  drop(conn: Conn, kind: DropKind, code?: number): void {
    if (this.socket !== conn) return
    this.socket = undefined
    const wasReady = conn.ready
    conn.ready = false
    for (const waiter of [...conn.waiters]) {
      this.failWaiter(conn, waiter, new SafeError(502, 'AutoPush connection closed'))
    }
    try {
      conn.ws.close(1000, 'closing')
    } catch {
      // Already closed by the peer.
    }
    if (code === BACKOFF_CODE) {
      this.store.update({ backoffUntil: Date.now() + BACKOFF_MS })
      this.scheduleReconnect('backoff')
    } else if (kind !== 'intentional') {
      this.scheduleReconnect(!wasReady || kind === 'fault' ? 'fail' : 'closed')
    }
    void this.ports.reschedule()
  }

  /** The single outbound connection; concurrent callers share one dial. */
  acquire(): Promise<Conn> {
    const live = this.socket
    if (live?.ready) return Promise.resolve(live)
    if (this.dialing !== undefined) return this.dialing
    const promise = this.dial()
      .catch((error: unknown) => {
        if (
          !isCode(error, 'cancelled') &&
          !isCode(error, 'backoff') &&
          this.store.state.reconnectAt <= Date.now()
        ) {
          this.scheduleReconnect('fail')
        }
        throw error
      })
      .finally(() => {
        if (this.dialing === promise) this.dialing = undefined
      })
    this.dialing = promise
    return promise
  }

  private async dial(): Promise<Conn> {
    const epoch = this.generation
    if (this.store.state.backoffUntil > Date.now()) {
      throw new SafeError(503, 'AutoPush backoff is in effect', 'backoff')
    }
    const pending = fetch(AUTOPUSH_URL, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN, 'User-Agent': USER_AGENT },
    })
    const response = await timeout(pending, REQUEST_MS, 'AutoPush connection timed out').catch(
      (error: unknown) => {
        // A late upgrade must not leave a stray socket behind.
        void pending.then(discardSocket, () => undefined)
        throw error instanceof SafeError ? error : new SafeError(502, 'AutoPush connection failed')
      },
    )
    if (this.generation !== epoch) {
      discardSocket(response)
      throw cancelled()
    }
    const ws = response.webSocket
    if (ws === null || ws === undefined)
      throw new SafeError(502, 'AutoPush did not upgrade the connection')
    const conn: Conn = { ws, ready: false, waiters: new Set(), queue: Promise.resolve(), pingAt: 0 }
    this.socket = conn
    ws.addEventListener('message', (event) => this.onMessage(conn, event.data))
    ws.addEventListener('close', (event) => this.drop(conn, 'closed', event.code))
    ws.addEventListener('error', () => this.drop(conn, 'fault'))
    ws.accept()
    try {
      const uaid = this.store.state.sub?.uaid
      const hello = await this.request(
        conn,
        'hello',
        '',
        helloFrame(uaid === undefined ? '' : uaid),
      )
      if (hello.type !== 'hello' || hello.status !== 200 || hello.uaid === undefined) {
        throw new SafeError(502, 'AutoPush hello failed')
      }
      if (this.socket !== conn || this.generation !== epoch) throw cancelled()
      conn.uaid = hello.uaid
      conn.ready = true
      conn.pingAt = Date.now() + PING_MS
      return conn
    } catch (error) {
      this.drop(conn, isCode(error, 'cancelled') ? 'intentional' : 'fault')
      throw error
    }
  }

  /** Registers the waiter before sending so a fast reply cannot be missed. */
  request(conn: Conn, kind: Waiter['kind'], channelId: string, text: string): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        channel: normalizeChannel(channelId),
        resolve,
        reject,
        timer: setTimeout(
          () => this.failWaiter(conn, waiter, new SafeError(504, `AutoPush ${kind} timed out`)),
          REQUEST_MS,
        ),
      }
      conn.waiters.add(waiter)
      try {
        conn.ws.send(text)
      } catch {
        this.failWaiter(conn, waiter, new SafeError(502, 'AutoPush connection failed'))
      }
    })
  }

  private resolveWaiter(conn: Conn, kind: Waiter['kind'], channelId: string, frame: Frame): void {
    const channel = normalizeChannel(channelId)
    for (const waiter of conn.waiters) {
      if (waiter.kind === kind && waiter.channel === channel) {
        clearTimeout(waiter.timer)
        conn.waiters.delete(waiter)
        waiter.resolve(frame)
        return
      }
    }
  }

  private onMessage(conn: Conn, data: unknown): void {
    if (this.socket !== conn || typeof data !== 'string') return
    conn.pingAt = Date.now() + PING_MS
    conn.pongBy = undefined
    const frame = parse(data)
    if (frame === undefined) {
      this.store.update({ lastError: 'Malformed AutoPush frame' })
      this.drop(conn, 'fault')
      return
    }
    switch (frame.type) {
      case 'hello':
        this.resolveWaiter(conn, 'hello', '', frame)
        return
      case 'register':
      case 'unregister':
        this.resolveWaiter(conn, frame.type, frame.channelId, frame)
        return
      case 'notification':
        this.ports.notification(conn, frame)
        return
      default:
        return
    }
  }
}
