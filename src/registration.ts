import { backoffMs, registerFrame, unregisterFrame } from './autopush'
import type { AutoPushLink, Conn } from './autopush-link'
import type { Env } from './config'
import type { WebPushKeys } from './ece'
import { generateKeys } from './ece'
import { cancelled, isCode, SafeError, safeMessage } from './safe-error'
import type { StateStore, Sub } from './state'
import { registerWithX } from './x'

/** Provisions the AutoPush/X subscription and tears it down again on unregistration. */
export class Registration {
  private pending?: Promise<void>
  private cleaning?: Promise<void>
  private xAbort?: AbortController

  constructor(
    private readonly store: StateStore,
    private readonly link: AutoPushLink,
    private readonly env: () => Env,
  ) {}

  get provisioning(): Promise<void> | undefined {
    return this.pending
  }

  get cleanupRunning(): boolean {
    return this.cleaning !== undefined
  }

  /** Abandons in-flight provisioning; the caller has already bumped the link epoch. */
  abort(): void {
    this.xAbort?.abort()
    this.xAbort = undefined
    this.pending = undefined
  }

  closeIdle(): void {
    const idle =
      !this.store.state.run &&
      this.cleaning === undefined &&
      this.pending === undefined &&
      this.link.connecting === undefined
    if (idle) this.link.close()
  }

  provisionNeeded(conn: Conn): boolean {
    const { sub, unregistering } = this.store.state
    return sub !== undefined && !unregistering && (!sub.xDone || sub.uaid !== conn.uaid)
  }

  credentials(): { token: string; ct0: string } | undefined {
    const { X_AUTH_TOKEN: token, X_CT0: ct0 } = this.env()
    return typeof token === 'string' && token !== '' && typeof ct0 === 'string' && ct0 !== ''
      ? { token, ct0 }
      : undefined
  }

  provision(): Promise<void> {
    if (this.pending !== undefined) return this.pending
    const promise = this.runProvision()
      .catch((error: unknown) => {
        if (!isCode(error, 'cancelled')) {
          const fails = this.store.state.provisionFails + 1
          this.store.update({
            provisionFails: fails,
            provisionAt: Date.now() + backoffMs(fails),
            lastError: safeMessage(error),
          })
        }
        throw error
      })
      .finally(() => {
        if (this.pending === promise) this.pending = undefined
      })
    this.pending = promise
    return promise
  }

  private async runProvision(): Promise<void> {
    const { store, link } = this
    const epoch = link.epoch
    const live = (channelId?: string): void => {
      const { sub, unregistering } = store.state
      if (link.epoch !== epoch || unregistering) throw cancelled()
      if (channelId !== undefined && sub?.channelId !== channelId) throw cancelled()
    }
    if (store.state.unregistering) throw new SafeError(409, 'Unregistration is in progress')

    // Keys and channel are durable before any remote effect can reference them.
    if (store.state.sub === undefined) {
      const keys = await generateKeys()
      live()
      await store.save({ sub: { channelId: crypto.randomUUID(), keys, xDone: false } })
    }
    const conn = await link.acquire()
    live()
    const uaid = conn.uaid
    const current = store.state.sub
    if (uaid === undefined || current === undefined) throw cancelled()
    if (current.uaid === undefined) {
      await store.save({ sub: { ...current, uaid } })
    } else if (current.uaid !== uaid) {
      // The server invalidated our UAID: nothing from the old identity can be reused.
      const keys = await generateKeys()
      live()
      await store.save({ sub: { channelId: crypto.randomUUID(), keys, uaid, xDone: false } })
    }
    live()
    const sub = store.state.sub
    if (sub === undefined) throw cancelled()

    if (sub.endpoint === undefined) {
      const answer = await link.request(
        conn,
        'register',
        sub.channelId,
        registerFrame(sub.channelId),
      )
      live(sub.channelId)
      if (answer.type !== 'register' || answer.status !== 200 || answer.endpoint === undefined) {
        throw new SafeError(502, 'AutoPush register failed')
      }
      // The endpoint is durable before X is told about it.
      await store.save({ sub: { ...sub, endpoint: answer.endpoint } })
      live(sub.channelId)
    }
    const latest = store.state.sub
    if (latest === undefined || latest.endpoint === undefined) throw cancelled()
    await this.registerX(latest.endpoint, latest.keys, live, sub.channelId)
    live(sub.channelId)
    const done = store.state.sub
    if (done === undefined) throw cancelled()
    await store.save({
      sub: { ...done, xDone: true },
      provisionFails: 0,
      provisionAt: 0,
      lastError: undefined,
    })
  }

  private async registerX(
    endpoint: string,
    keys: WebPushKeys,
    live: (channelId?: string) => void,
    channelId: string,
  ): Promise<void> {
    const credentials = this.credentials()
    if (credentials === undefined) throw new SafeError(503, 'X credentials are not configured')
    const controller = new AbortController()
    this.xAbort = controller
    const fetcher = (request: Request): Promise<Response> =>
      fetch(new Request(request, { signal: AbortSignal.any([request.signal, controller.signal]) }))
    try {
      await registerWithX(credentials.token, credentials.ct0, endpoint, keys, fetcher)
    } catch (error) {
      live(channelId)
      const message = error instanceof Error ? error.message : ''
      const timedOut = message.endsWith('timeout')
      // The candidate stays persisted: the outcome of a timed-out call is unknown.
      throw new SafeError(
        timedOut ? 504 : 502,
        message.startsWith('X registration failed') ? message : 'X registration failed',
      )
    } finally {
      if (this.xAbort === controller) this.xAbort = undefined
    }
  }

  cleanup(): Promise<void> {
    if (this.cleaning !== undefined) return this.cleaning
    const promise = this.runCleanup().finally(() => {
      if (this.cleaning === promise) this.cleaning = undefined
      this.closeIdle()
    })
    this.cleaning = promise
    return promise
  }

  private async runCleanup(): Promise<void> {
    const { store, link } = this
    const sub = store.state.sub
    if (!store.state.unregistering || sub === undefined || sub.uaid === undefined) return
    try {
      const conn = await link.acquire()
      // Cleanup only ever talks to the stored identity; a new UAID is never subscribed.
      if (conn.uaid !== sub.uaid) {
        // A successful hello replacing the UAID confirms the old identity and
        // its channels are gone. Clear local state without registering a new one.
        await this.finishCleanup(sub)
        return
      }
      const answer = await link.request(
        conn,
        'unregister',
        sub.channelId,
        unregisterFrame(sub.channelId),
      )
      if (answer.type !== 'unregister' || answer.status !== 200) {
        throw new SafeError(502, 'AutoPush unregister failed')
      }
      await this.finishCleanup(sub)
    } catch (error) {
      if (!isCode(error, 'backoff') && !isCode(error, 'cancelled')) {
        const fails = store.state.failCount + 1
        store.update({
          failCount: fails,
          cleanupAt: Date.now() + backoffMs(fails),
          lastError: safeMessage(error),
        })
      }
      throw error
    }
  }

  private async finishCleanup(sub: Sub): Promise<void> {
    if (!this.store.state.unregistering || this.store.state.sub?.channelId !== sub.channelId) return
    await this.store.save({
      sub: undefined,
      unregistering: false,
      cleanupAt: 0,
      failCount: 0,
      provisionFails: 0,
      lastError: undefined,
    })
  }
}
