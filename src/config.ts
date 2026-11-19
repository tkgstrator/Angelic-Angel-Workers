import type { Angelic } from './angelic'
import type { Inbox } from './inbox'

export type Env = {
  ANGELIC: DurableObjectNamespace<Angelic>
  INBOX: DurableObjectNamespace<Inbox>
  ADMIN_TOKEN?: string
  X_AUTH_TOKEN?: string
  X_CT0?: string
  WEBHOOK_ENDPOINT?: string
  PROBE_TOKEN?: string
  MODE?: 'record' | 'gone'
}

export const LISTENER_NAME = 'listener'
