import type { WebPushKeys } from './ece'

export type Sub = {
  channelId: string
  keys: WebPushKeys
  uaid?: string
  endpoint?: string
  xDone: boolean
}

export type State = {
  run: boolean
  sub?: Sub
  unregistering: boolean
  backoffUntil: number
  reconnectAt: number
  cleanupAt: number
  provisionAt: number
  failCount: number
  provisionFails: number
  lastError?: string
}

const INITIAL: State = {
  run: false,
  unregistering: false,
  backoffUntil: 0,
  reconnectAt: 0,
  cleanupAt: 0,
  provisionAt: 0,
  failCount: 0,
  provisionFails: 0,
}

/** The single owner of the persisted receiver state. */
export class StateStore {
  private current: State

  constructor(private readonly storage: DurableObjectStorage) {
    this.current = { ...INITIAL, ...storage.kv.get<State>('state') }
  }

  get state(): State {
    return this.current
  }

  update(patch: Partial<State>): void {
    this.current = { ...this.current, ...patch }
    this.storage.kv.put('state', this.current)
  }

  commit(): Promise<void> {
    return this.storage.sync()
  }

  async save(patch: Partial<State>): Promise<void> {
    this.update(patch)
    await this.commit()
  }
}
