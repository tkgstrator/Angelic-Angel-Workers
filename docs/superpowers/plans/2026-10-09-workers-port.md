# Angelic Angel Workers Implementation Plan

> **For agentic workers:** Use the user's authorized Claude Code MCP implementation route. Codex coordinates integration and native verification. No Git commits, pushes or deployments are required by this task.

**Goal:** Port upstream notification registration, reception, decryption and forwarding to a deployable TypeScript Cloudflare Worker.

**Architecture:** A bearer-authenticated Worker routes management operations to one persistent listener Durable Object. Outbound AutoPush uses standard WebSockets; durable alarms recover connections and drain a durable outbox. Preserve existing probe storage and migrations.

**Tech Stack:** TypeScript, Cloudflare Workers/Durable Objects, Web Crypto, Bun tests, Miniflare/workerd, Wrangler.

**Spec:** `docs/superpowers/specs/2026-10-09-workers-port-design.md`

## Global Constraints

- Target workspace: `/Users/devonly/Developer/Angelic-Angel-Workers`, Mac host `studio.local`; Claude sees the same mounted workspace in its MCP Linux execution context.
- Upstream source: `/Users/devonly/Developer/Angelic-Angel-reference-20261009`, revision `169a098e2025cc6e41a50fc8d521c483e21d9b6d`.
- Use native filesystem/commands on verified workspaces. LocalGPT reads through its own LocalMCP connection to `studio.local`.
- Preserve `Inbox`, `INBOX` and migration `v1`; add migrations instead of rewriting applied history.
- Persist recoverable registration/connection state and respect 4774 backoff across all recovery triggers.
- No secrets in responses, source fixtures, logs or committed examples.
- No production deployment, real X registration, Git commit or push as part of local implementation.

## Files and responsibilities

- `src/index.ts`: Worker routing, authentication, cron entry point, class exports.
- `src/inbox.ts`: retained legacy probe storage and bounded recording.
- `src/types.ts`: typed bindings and stored registration/notification structures.
- `src/crypto.ts`: encoding, key generation and ECE decryption.
- `src/autopush.ts`: validated protocol messages and outbound connection lifecycle primitives.
- `src/twitter.ts`: upstream-compatible X registration request.
- `src/listener.ts`: Durable Object state transitions, persistence, alarms and outbox.
- `__tests__/*`: known-vector/unit and Workers runtime integration verification.
- `wrangler.jsonc`, `package.json`, lockfile and TypeScript/config files: runnable development/deployment/testing.
- `README.md`, `.dev.vars.example`, `LICENSE`: setup, API mapping, operational limits and upstream attribution.

## Review Focus

1. Notifications received during hello/register/X API calls and concurrent stop/unregister calls.
2. Object restart between registration side effects and state persistence, ACK and delivery.
3. Unknown UAID, server backoff, missing pong, malformed protocol and stale socket callbacks.
4. Encrypted record boundaries, legacy ECE derivation, invalid UTF-8 and authentication failures.
5. Queue exhaustion, repeated/non-2xx Webhook delivery, stable dedupe IDs and secret leakage.

## Tasks

### 1. Resolve independent plan reviews

- [x] Obtain LocalGPT GPT 6 Pro and Claude Sonnet read-only plan findings independently.
- [x] Check findings against upstream and current Cloudflare docs; update spec/plan for material findings (transient failures receive no ACK, write-ahead candidates, stopped delivery/cleanup, JSON precision).
- [x] Assign Claude implementation with exact ownership and acceptance criteria.

### 2. Protocol and cryptography

- [x] Write meaningful failing tests for upstream protocol shapes and independent ECE vectors.
- [x] Run them to establish missing behavior, then implement Web Crypto and protocol modules.
- [x] Test modern and legacy encodings, malformed records/headers, payload conversion and exact X request format.
- [x] Run focused tests and typecheck.

### 3. Durable receiver and management API

- [x] Add failing runtime tests for authentication, registration/start/status, upgrade and notification handling.
- [x] Implement persistent state and serialized transitions with stale callback protection.
- [x] Persist outbox before ACK; add retry, dedupe, capacity limits and dead-letter operations.
- [x] Implement stop/unregister and alarm/cron recovery with bounded backoff and persisted deadlines.
- [x] Preserve legacy probe behavior on explicit routes and prevent accidental credential/body recording by management requests.
- [x] Run runtime tests including failures, restart/retry and socket cleanup.

### 4. Deployment and user documentation

- [x] Update bindings/additive migrations, cron, scripts and lockfile.
- [x] Reconcile named deployment environments in the existing workflow.
- [x] Add Japanese setup/API examples, costs/lifecycle constraints, upstream revision/license and live verification limits.
- [x] Verify clean installation, typecheck, lint, full tests and deploy dry-run.

### 5. Independent diff reviews and integration

- [x] Ask a fresh Claude Code MCP job to review actual diff/files read-only.
- [x] Ask LocalGPT GPT 6 Pro to review actual implementation using verified file access.
- [x] Resolve material findings; rerun affected checks and request re-review when needed.
- [x] Verify actual changes are in intended workspace, tests are complete, no generated secrets/artifacts are included and test processes are closed.
- [x] Deliver concise result, commands and explicit live verification limitations.

## Execution evidence and limitations

The initial broad Claude job was explicitly cancelled after environment preparation dominated the work. The task was split with fixed interfaces and file ownership; pure modules used Claude Sonnet, the durable lifecycle used Claude Opus, and Codex implemented routing, runtime tests and integration. The initial pure-module tests were written alongside implementation, so that worker did not provide a red-first run; Codex verified real failing regression tests for the initial hello, dropped legacy record, BOM, routing, SQL, stable IDs, cleanup and ACK classification before fixes. All final native checks passed.

LocalGPT Pro completed the plan review. Its requested implementation review has an unknown outcome after browser disconnection; the authorized alternate review route was a completed independent Claude Opus whole-implementation review plus a separate Claude Sonnet fix review. See verification-notes.md for IDs and detailed evidence. No live deployment or external account registration occurred.
