import { ackFrame } from './autopush'
import type { AutoPushLink, Conn, Notification } from './autopush-link'
import type { WebPushKeys } from './ece'
import { DecryptionError, decryptNotification, payloadBody } from './ece'
import type { Outbox } from './outbox'
import { normalizeChannel } from './outbox'
import type { StateStore } from './state'

type Decoded = { kind: 'ok'; body: string } | { kind: 'invalid' } | { kind: 'unavailable' }

/** Decrypts notifications and commits them to the outbox before acknowledging. */
export class Notifications {
  constructor(
    private readonly store: StateStore,
    private readonly link: AutoPushLink,
    private readonly outbox: Outbox,
    private readonly reschedule: () => Promise<void>,
  ) {}

  /** Queues a notification behind the connection's earlier ones, snapshotting ownership now. */
  enqueue(conn: Conn, frame: Notification): void {
    // Capture the key material now: the registration may rotate while this is queued.
    const keys = this.keysFor(frame.channelId)
    const ownedChannel =
      this.store.state.sub !== undefined &&
      normalizeChannel(this.store.state.sub.channelId) === normalizeChannel(frame.channelId)
    conn.queue = conn.queue
      .then(() => this.receive(conn, frame, keys, ownedChannel))
      .catch(() => this.link.drop(conn, 'fault'))
  }

  private keysFor(channelId: string): WebPushKeys | undefined {
    const sub = this.store.state.sub
    return sub !== undefined && normalizeChannel(sub.channelId) === normalizeChannel(channelId)
      ? sub.keys
      : undefined
  }

  private async decode(frame: Notification, data: string, keys: WebPushKeys): Promise<Decoded> {
    if (data === '') return { kind: 'invalid' }
    try {
      return { kind: 'ok', body: payloadBody(await decryptNotification(data, frame.headers, keys)) }
    } catch (error) {
      return error instanceof DecryptionError ? { kind: 'invalid' } : { kind: 'unavailable' }
    }
  }

  private acknowledge(conn: Conn, frame: Notification, code: 100 | 101 | 102): void {
    try {
      conn.ws.send(ackFrame(frame.channelId, frame.version, code))
    } catch {
      this.link.drop(conn, 'fault')
    }
  }

  private fault(conn: Conn, message: string): void {
    this.store.update({ lastError: message })
    this.link.drop(conn, 'fault')
  }

  private async receive(
    conn: Conn,
    frame: Notification,
    keys: WebPushKeys | undefined,
    ownedChannel: boolean,
  ): Promise<void> {
    if (this.link.conn !== conn) return
    // This single-account receiver has no subscription for the channel. This is
    // a terminal routing rejection (102), distinct from unavailable owned keys.
    if (!ownedChannel) return this.acknowledge(conn, frame, 102)
    if (frame.data === undefined) return this.acknowledge(conn, frame, 100)
    if (keys === undefined) return this.fault(conn, 'Notification keys are unavailable')
    const decoded = await this.decode(frame, frame.data, keys)
    if (this.link.conn !== conn) return
    if (decoded.kind === 'invalid') return this.acknowledge(conn, frame, 101)
    if (decoded.kind === 'unavailable') return this.fault(conn, 'Notification keys are unavailable')
    try {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify([normalizeChannel(frame.channelId), frame.version]),
        ),
      )
      const notificationId = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('')
      const accepted = this.outbox.accept(
        normalizeChannel(frame.channelId),
        frame.version,
        notificationId,
        decoded.body,
        Date.now(),
      )
      if (accepted === 'full') return this.fault(conn, 'Outbox is full')
      await this.store.commit()
    } catch {
      return this.fault(conn, 'Outbox storage failed')
    }
    if (this.link.conn !== conn) return
    this.acknowledge(conn, frame, 100)
    if (this.store.state.failCount > 0) this.store.update({ failCount: 0 })
    await this.reschedule()
  }
}
