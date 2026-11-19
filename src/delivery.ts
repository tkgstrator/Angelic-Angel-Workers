import type { Due, Outbox } from './outbox'
import type { StateStore } from './state'

const WEBHOOK_MS = 10_000
const WEBHOOK_BLOCKED_MS = 5 * 60_000
const BATCH = 20

/** Posts accepted notifications to the configured webhook. */
export class Delivery {
  private active = false
  private blocked = 0

  constructor(
    private readonly store: StateStore,
    private readonly outbox: Outbox,
    private readonly endpoint: () => string | undefined,
    private readonly reschedule: () => Promise<void>,
  ) {}

  get delivering(): boolean {
    return this.active
  }

  get blockedUntil(): number {
    return this.blocked
  }

  unblock(): void {
    this.blocked = 0
  }

  target(): URL | undefined {
    const raw = this.endpoint()
    if (typeof raw !== 'string') return undefined
    try {
      const url = new URL(raw)
      return url.protocol === 'https:' && url.username === '' && url.password === ''
        ? url
        : undefined
    } catch {
      return undefined
    }
  }

  private async post(target: URL, row: Due): Promise<string | undefined> {
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Angelic-Notification-ID': row.nid },
        body: row.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(WEBHOOK_MS),
      })
      await response.body?.cancel().catch(() => undefined)
      return response.ok ? undefined : `Webhook HTTP ${response.status}`
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      return timedOut ? 'Webhook timeout' : 'Webhook request failed'
    }
  }

  /** Delivery runs regardless of the stop intent: accepted notifications are never abandoned. */
  async deliver(): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      const now = Date.now()
      if (this.outbox.nextAttempt() === undefined) return
      const target = this.target()
      if (target === undefined) {
        this.blocked = now + WEBHOOK_BLOCKED_MS
        return
      }
      this.blocked = 0
      for (const row of this.outbox.due(now, BATCH)) {
        const failure = await this.post(target, row)
        if (failure === undefined) this.outbox.complete(row.id, Date.now())
        else this.outbox.fail(row.id, row.attempts, failure, Date.now())
      }
      await this.store.commit()
    } finally {
      this.active = false
    }
    await this.reschedule()
  }
}
