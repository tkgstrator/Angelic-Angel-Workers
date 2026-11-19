import { DurableObject } from 'cloudflare:workers'
import type { Conn } from './autopush-link'
import { AutoPushLink } from './autopush-link'
import type { Env } from './config'
import { Delivery } from './delivery'
import { Notifications } from './notifications'
import { MAX_QUEUE, Outbox } from './outbox'
import { Registration } from './registration'
import { SafeError } from './safe-error'
import type { State } from './state'
import { StateStore } from './state'

const MIN_ALARM_MS = 50

const METHODS: Record<string, string> = {
  '/api/register': 'POST',
  '/api/start': 'POST',
  '/api/stop': 'POST',
  '/api/unregister': 'POST',
  '/api/status': 'GET',
  '/api/deadletters': 'GET',
  '/api/retry-deadletters': 'POST',
}

type Result = { status: number; body: unknown }

const reply = (result: Result, headers: Record<string, string> = {}): Response =>
  Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  })

export class Angelic extends DurableObject<Env> {
  private readonly store: StateStore
  private readonly outbox: Outbox
  private readonly link: AutoPushLink
  private readonly registration: Registration
  private readonly notifications: Notifications
  private readonly delivery: Delivery

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new StateStore(ctx.storage)
    this.outbox = new Outbox(ctx.storage)
    const reschedule = (): Promise<void> => this.reschedule()
    this.link = new AutoPushLink(this.store, {
      reschedule,
      notification: (conn, frame) => this.notifications.enqueue(conn, frame),
    })
    this.registration = new Registration(this.store, this.link, () => this.env)
    this.notifications = new Notifications(this.store, this.link, this.outbox, reschedule)
    this.delivery = new Delivery(
      this.store,
      this.outbox,
      () => this.env.WEBHOOK_ENDPOINT,
      reschedule,
    )
  }

  private get state(): State {
    return this.store.state
  }

  private get conn(): Conn | undefined {
    return this.link.conn
  }

  // ---- entry points -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const method = METHODS[path]
    if (method === undefined) return reply({ status: 404, body: { error: 'Not found' } })
    if (request.method !== method) {
      return reply({ status: 405, body: { error: 'Method not allowed' } }, { Allow: method })
    }
    try {
      return reply(await this.route(path))
    } catch (error) {
      if (error instanceof SafeError) {
        const body =
          error.code === 'backoff'
            ? { error: error.message, retryAt: this.state.backoffUntil }
            : { error: error.message }
        return reply({ status: error.status, body })
      }
      console.error('angelic request failed')
      return reply({ status: 500, body: { error: 'Internal error' } })
    }
  }

  /** Cron reconciliation: recovers an enabled socket, pending cleanup and outbox delivery. */
  async ensure(): Promise<void> {
    try {
      await this.reconcile()
    } catch {
      console.error('angelic ensure failed')
    }
    await this.reschedule()
  }

  override async alarm(): Promise<void> {
    try {
      this.link.checkPing()
      await this.reconcile()
    } catch {
      console.error('angelic alarm failed')
    }
    await this.reschedule()
  }

  private route(path: string): Promise<Result> {
    switch (path) {
      case '/api/register':
        return this.register()
      case '/api/start':
        return this.start()
      case '/api/stop':
        return this.stop()
      case '/api/unregister':
        return this.unregister()
      case '/api/status':
        return Promise.resolve({ status: 200, body: this.status() })
      case '/api/deadletters':
        return Promise.resolve({
          status: 200,
          body: { deadLetters: this.outbox.deadLetters(100), outbox: this.outbox.counts() },
        })
      case '/api/retry-deadletters':
        return this.retryDeadLetters()
      default:
        return Promise.resolve({ status: 404, body: { error: 'Not found' } })
    }
  }

  // ---- controls -----------------------------------------------------------------------------

  private async register(): Promise<Result> {
    if (this.state.unregistering) throw new SafeError(409, 'Unregistration is in progress')
    if (this.state.sub?.xDone !== true) {
      if (this.registration.credentials() === undefined)
        throw new SafeError(503, 'X credentials are not configured')
      try {
        await this.registration.provision()
      } finally {
        this.registration.closeIdle()
      }
    }
    return { status: 200, body: this.status() }
  }

  private async start(): Promise<Result> {
    const { sub, run, unregistering } = this.state
    if (unregistering) throw new SafeError(409, 'Unregistration is in progress')
    if (sub === undefined) throw new SafeError(409, 'Not registered; register first')
    if (!run && !sub.xDone) throw new SafeError(409, 'Registration is incomplete; register again')
    if (!run) await this.store.save({ run: true, reconnectAt: 0, failCount: 0 })
    await this.recover()
    await this.reschedule()
    return { status: 200, body: this.status() }
  }

  private async stop(): Promise<Result> {
    this.store.update({ run: false, reconnectAt: 0, failCount: 0 })
    // A pending unregistration owns the connection; stop must not cancel its cleanup.
    if (!this.state.unregistering) {
      this.cancel()
      this.link.close()
    }
    await this.store.commit()
    await this.reschedule()
    return { status: 200, body: this.status() }
  }

  private async unregister(): Promise<Result> {
    const { sub, unregistering } = this.state
    if (sub === undefined && !unregistering) {
      this.store.update({ run: false, reconnectAt: 0 })
      this.cancel()
      this.link.close()
      await this.store.commit()
      return { status: 200, body: { ...this.status(), unregistered: true } }
    }
    this.store.update({ run: false, unregistering: true, reconnectAt: 0 })
    this.cancel()
    if (sub !== undefined && sub.uaid === undefined) {
      // No AutoPush identity was ever persisted, so no remote subscription can exist.
      this.store.update({
        sub: undefined,
        unregistering: false,
        cleanupAt: 0,
        lastError: undefined,
      })
      this.link.close()
      await this.store.commit()
      return { status: 200, body: { ...this.status(), unregistered: true } }
    }
    await this.store.commit()
    await this.registration.cleanup().catch(() => undefined)
    await this.reschedule()
    const done = this.state.sub === undefined
    return { status: done ? 200 : 202, body: { ...this.status(), unregistered: done } }
  }

  private async retryDeadLetters(): Promise<Result> {
    const retried = this.outbox.retryDead(Date.now())
    this.delivery.unblock()
    await this.ctx.storage.sync()
    await this.reschedule()
    return { status: 200, body: { retried } }
  }

  private status(): Record<string, unknown> {
    const { sub, run, unregistering, backoffUntil, reconnectAt, failCount, lastError } = this.state
    const now = Date.now()
    const registration =
      sub === undefined
        ? 'none'
        : unregistering
          ? 'unregistering'
          : sub.xDone
            ? 'registered'
            : 'pending'
    const phase =
      sub === undefined || sub.xDone
        ? null
        : sub.uaid === undefined
          ? 'keys'
          : sub.endpoint === undefined
            ? 'subscribing'
            : 'endpoint'
    const target = this.env.WEBHOOK_ENDPOINT
    const counts = this.outbox.counts()
    return {
      registration,
      phase,
      running: run,
      connected: this.conn?.ready === true,
      connecting: this.link.connecting !== undefined,
      backoffUntil: backoffUntil > now ? backoffUntil : null,
      reconnectAt: reconnectAt > now ? reconnectAt : null,
      failCount,
      lastError: lastError === undefined ? null : lastError,
      credentials: this.registration.credentials() !== undefined,
      webhook:
        target === undefined || target === ''
          ? 'missing'
          : this.delivery.target() === undefined
            ? 'invalid'
            : 'configured',
      outbox: counts,
      queueFull: counts.pending + counts.dead >= MAX_QUEUE,
    }
  }

  // ---- scheduling ---------------------------------------------------------------------------

  private async reschedule(): Promise<void> {
    try {
      const { run, sub, unregistering, reconnectAt, backoffUntil, cleanupAt, provisionAt } =
        this.state
      const conn = this.conn
      const times: number[] = []
      const next = this.outbox.nextAttempt()
      if (next !== undefined && !this.delivery.delivering)
        times.push(Math.max(next, this.delivery.blockedUntil))
      if (conn?.ready) times.push(conn.pongBy === undefined ? conn.pingAt : conn.pongBy)
      if (unregistering) {
        if (!this.registration.cleanupRunning)
          times.push(conn?.ready ? cleanupAt : Math.max(cleanupAt, backoffUntil))
      } else if (run && sub !== undefined) {
        if (conn === undefined && this.link.connecting === undefined)
          times.push(Math.max(reconnectAt, backoffUntil))
        if (
          conn?.ready &&
          this.registration.provisionNeeded(conn) &&
          this.registration.provisioning === undefined
        )
          times.push(provisionAt)
      }
      const earliest = times.length === 0 ? undefined : Math.min(...times)
      if (earliest === undefined) await this.ctx.storage.deleteAlarm()
      else await this.ctx.storage.setAlarm(Math.max(earliest, Date.now() + MIN_ALARM_MS))
    } catch {
      console.error('angelic reschedule failed')
    }
  }

  private async reconcile(): Promise<void> {
    await Promise.all([this.delivery.deliver(), this.recover()])
  }

  /** Brings the socket and any pending cleanup/provisioning back to the desired state. */
  private async recover(): Promise<void> {
    const { run, sub, unregistering, reconnectAt, backoffUntil, cleanupAt, provisionAt } =
      this.state
    const now = Date.now()
    if (unregistering) {
      if (!this.registration.cleanupRunning && now >= cleanupAt)
        await this.registration.cleanup().catch(() => undefined)
      return
    }
    if (!run || sub === undefined) return
    if (
      this.conn === undefined &&
      this.link.connecting === undefined &&
      now >= Math.max(reconnectAt, backoffUntil)
    ) {
      await this.link.acquire().catch(() => undefined)
    }
    const conn = this.conn
    if (
      conn?.ready &&
      this.registration.provisionNeeded(conn) &&
      this.registration.provisioning === undefined &&
      now >= provisionAt
    ) {
      await this.registration.provision().catch(() => undefined)
    }
  }

  /** Invalidates in-flight work: bump epoch, abort X, clear provisioning, fail waiters. */
  private cancel(): void {
    this.link.bumpEpoch()
    this.registration.abort()
    this.link.failCancellable()
  }
}
