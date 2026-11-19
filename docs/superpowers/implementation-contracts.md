# Parallel implementation contracts

The initial broad Claude implementation job was explicitly cancelled after test-runtime setup became the dominant work. Only the independent test encryptor was added; no application source was changed. The Linux toolchain in `/tmp/lx` belongs to the MCP host and must not overwrite shared Darwin dependencies.

Original implementation ownership: Codex owned routing, legacy Inbox, typed Env, Wrangler/package/lockfile, Node/workerd integration tests, docs and CI. The Claude pure-module worker owned `src/ece.ts`, `src/autopush.ts`, `src/x.ts` and the original core test file. The Claude receiver worker owned `src/angelic.ts` and optionally `src/outbox.ts`. No shared file edits.

After the 400-line refactor, the original receiver implementation is composed from `angelic.ts`, `autopush-link.ts`, `registration.ts`, `notifications.ts`, `delivery.ts`, `state.ts`, and `safe-error.ts`. The original core tests live in `ece.test.ts`, `autopush.test.ts`, and `x.test.ts`, sharing the published RFC vector in `helpers/rfc-vector.ts`. The APIs below remain unchanged.

## Shared APIs

`src/ece.ts`:

```ts
export type WebPushKeys = { publicKey: string; privateKey: JsonWebKey; authSecret: string }
export class DecryptionError extends Error {}
export function generateKeys(): Promise<WebPushKeys>
export function decryptNotification(data: string, headers: Record<string, string> | undefined, keys: WebPushKeys): Promise<Uint8Array>
export function payloadBody(bytes: Uint8Array): string
export function toBase64Url(bytes: Uint8Array): string
export function fromBase64Url(text: string): Uint8Array
```

`payloadBody` uses fatal UTF-8 decoding. Valid JSON is returned verbatim; non-JSON becomes a JSON `{raw: text}` object. Decoding errors are DecryptionError. Legacy independent fixture `keys.privateKeyJwk` maps to this API's `privateKey`.

`src/autopush.ts`:

```ts
export const AUTOPUSH_URL: string // HTTPS URL for fetch Upgrade
export type Frame =
  | { type: 'hello'; status: number; uaid?: string }
  | { type: 'register'; status: number; channelId: string; endpoint?: string }
  | { type: 'unregister'; status: number; channelId: string }
  | { type: 'notification'; channelId: string; version: string; data?: string; headers?: Record<string, string> }
  | { type: 'pong' }
  | { type: 'ignore' }
export function parseFrame(text: string): Frame // reject malformed known frames
export function helloFrame(uaid: string): string
export function registerFrame(channelId: string): string // upstream static X VAPID key
export function unregisterFrame(channelId: string): string
export function ackFrame(channelId: string, version: string, code: 100 | 101 | 102): string
export function backoffMs(attempt: number): number // first attempt 5000, cap 300000
```

No-data is absent/null data; empty string data is ciphertext and must fail decryption. UUID comparisons should ignore hyphens/case; ACK uses the received channel ID. Version stays opaque.

`src/x.ts`:

```ts
export function buildXRegistrationRequest(authToken: string, ct0: string, endpoint: string, keys: WebPushKeys): Request
export function registerWithX(authToken: string, ct0: string, endpoint: string, keys: WebPushKeys, fetcher?: (request: Request) => Promise<Response>): Promise<void>
```

Use exact upstream headers/body, a 10-second timeout, manual redirects with 3xx rejected, accept any 2xx, and safe errors containing only HTTP status/stage (never remote bodies, cookies or endpoint). Workers does not support the browser-only redirect value `error`.

`src/config.ts` (Codex creates):

```ts
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
```

`src/angelic.ts`:

```ts
export class Angelic extends DurableObject<Env> {
  fetch(request: Request): Promise<Response> // full /api/* paths
  ensure(): Promise<void> // cron reconciliation, including stopped outbox/cleanup
  alarm(): Promise<void>
}
```

Routes: POST register/start/stop/unregister; GET status/deadletters; POST retry-deadletters. Register does not implicitly start. Idempotent register reuses active/pending candidate, no channel proliferation. No runtime test-only hooks in production. Public Worker authenticates all /api paths before forwarding. Unknown methods return 405 for known routes, unknown paths 404. Receiver may return structured errors/status codes directly via fetch.

The receiver retains persisted operation phases/key material before remote effects, preserves 4774 across all triggers, accepts and deduplicates notifications transactionally before ACK, schedules the earliest alarm, keeps outbox delivery active while stopped and waits for matched unregister success before deleting subscription state. See design spec for the full failure contracts.
