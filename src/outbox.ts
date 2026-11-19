import { backoffMs } from './autopush'

export const MAX_QUEUE = 1000
export const MAX_DONE = 1000
export const MAX_ATTEMPTS = 8

export type Accept = 'accepted' | 'duplicate' | 'full'
export type Due = { id: number; nid: string; body: string; attempts: number }
export type DeadLetter = {
  id: number
  channelId: string
  version: string
  attempts: number
  error: string | null
  createdAt: number
  deadAt: number | null
}
export type Counts = { pending: number; dead: number; done: number }

type Storage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>
type DueRow = { id: number; nid: string; body: string; attempts: number }
type DeadRow = {
  id: number
  channel: string
  version: string
  attempts: number
  last_error: string | null
  created_at: number
  finished_at: number | null
}

/** UUID comparison ignores case and hyphens. */
export const normalizeChannel = (id: string): string => id.replaceAll('-', '').toLowerCase()

/**
 * Durable notification queue. A notification is only ever ACKed after `accept` has committed;
 * (channel, version) uniqueness survives sockets and is retained for the most recent MAX_DONE
 * delivered rows. Payload bodies are never returned by any listing method.
 */
export class Outbox {
  private readonly storage: Storage

  constructor(storage: Storage) {
    this.storage = storage
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        version TEXT NOT NULL,
        nid TEXT NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        last_error TEXT,
        UNIQUE (channel, version)
      )`,
    )
    storage.sql.exec('CREATE INDEX IF NOT EXISTS outbox_due ON outbox (status, next_at)')
  }

  has(channel: string, version: string): boolean {
    return (
      this.storage.sql
        .exec<{ id: number }>(
          'SELECT id FROM outbox WHERE channel = ? AND version = ?',
          channel,
          version,
        )
        .toArray().length > 0
    )
  }

  accept(channel: string, version: string, nid: string, body: string, now: number): Accept {
    return this.storage.transactionSync((): Accept => {
      if (this.has(channel, version)) return 'duplicate'
      const open = this.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending', 'dead')")
        .one().n
      if (open >= MAX_QUEUE) return 'full'
      this.storage.sql.exec(
        "INSERT INTO outbox (channel, version, nid, status, body, next_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
        channel,
        version,
        nid,
        body,
        now,
        now,
      )
      return 'accepted'
    })
  }

  due(now: number, limit: number): Due[] {
    return this.storage.sql
      .exec<DueRow>(
        "SELECT id, nid, body, attempts FROM outbox WHERE status = 'pending' AND next_at <= ? ORDER BY id LIMIT ?",
        now,
        limit,
      )
      .toArray()
  }

  /** Earliest scheduled attempt among pending rows. */
  nextAttempt(): number | undefined {
    const row = this.storage.sql
      .exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM outbox WHERE status = 'pending'")
      .one()
    return row.t === null ? undefined : row.t
  }

  complete(id: number, now: number): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "UPDATE outbox SET status = 'done', body = '', finished_at = ?, last_error = NULL WHERE id = ? AND status = 'pending'",
        now,
        id,
      )
      this.storage.sql.exec(
        `DELETE FROM outbox WHERE status = 'done' AND id NOT IN (
          SELECT id FROM outbox WHERE status = 'done' ORDER BY finished_at DESC, id DESC LIMIT ?
        )`,
        MAX_DONE,
      )
    })
  }

  /** Records a failed attempt: exponential retry, then a retained dead letter. */
  fail(id: number, attempts: number, error: string, now: number): void {
    const next = attempts + 1
    if (next >= MAX_ATTEMPTS) {
      this.storage.sql.exec(
        "UPDATE outbox SET status = 'dead', attempts = ?, finished_at = ?, last_error = ? WHERE id = ? AND status = 'pending'",
        next,
        now,
        error,
        id,
      )
      return
    }
    this.storage.sql.exec(
      "UPDATE outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ? AND status = 'pending'",
      next,
      now + backoffMs(next),
      error,
      id,
    )
  }

  counts(): Counts {
    const counts: Counts = { pending: 0, dead: 0, done: 0 }
    for (const row of this.storage.sql
      .exec<{ status: string; n: number }>(
        'SELECT status, COUNT(*) AS n FROM outbox GROUP BY status',
      )
      .toArray()) {
      if (row.status === 'pending') counts.pending = row.n
      else if (row.status === 'dead') counts.dead = row.n
      else if (row.status === 'done') counts.done = row.n
    }
    return counts
  }

  deadLetters(limit: number): DeadLetter[] {
    return this.storage.sql
      .exec<DeadRow>(
        "SELECT id, channel, version, attempts, last_error, created_at, finished_at FROM outbox WHERE status = 'dead' ORDER BY id LIMIT ?",
        limit,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        channelId: row.channel,
        version: row.version,
        attempts: row.attempts,
        error: row.last_error,
        createdAt: row.created_at,
        deadAt: row.finished_at,
      }))
  }

  retryDead(now: number): number {
    return this.storage.transactionSync(() => {
      const dead = this.counts().dead
      this.storage.sql.exec(
        "UPDATE outbox SET status = 'pending', attempts = 0, next_at = ?, last_error = NULL, finished_at = NULL WHERE status = 'dead'",
        now,
      )
      return dead
    })
  }
}
