# Split Large Code Implementation Plan

> **For agentic workers:** Use the established Claude Code MCP implementation route; Codex owns integration and native verification. Track steps below without committing.

**Goal:** Split the two code files exceeding 400 lines into cohesive modules while preserving behavior.

**Architecture:** Keep `Angelic` as the Durable Object coordinator. Use composition for socket management, registration, notification acceptance, and delivery; retain one state store and one alarm owner. Split unit tests by the production protocol they verify.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Bun tests, workerd integration tests.

**Spec:** Existing Workers port design at `../specs/2026-10-09-workers-port-design.md`, plus the user's request to consider splitting code exceeding 400 lines.

## Global Constraints

- Preserve `Angelic` exports, bindings, persisted `state` fields, SQL schema, API responses, and protocol behavior.
- Preserve synchronous key snapshots, write-ahead persistence, ACK ordering, socket identities, epoch fences, promise identity guards, and cleanup ownership.
- Keep alarm mutations in `Angelic`; no new features, dependencies, production test hooks, commits, or deployment.
- Continue in the existing checkout containing the uncommitted port. A new worktree would omit the implementation being refactored.
- Aim for at most 400 lines per code file after formatting, by responsibility rather than arbitrary slicing.

## Review Focus

- Concurrent callers must still share one synchronous `connecting` promise.
- Cancellation must bump the shared epoch, abort X, clear provisioning, and fail only non-unregister waiters in the original order.
- Notifications must capture ownership and keys before entering their promise queue and commit before ACK 100.
- Stopped receivers must still deliver accepted notifications and finish pending cleanup.
- Delivery's early returns, alarm scheduling, and safe error handling must retain their original semantics.

## Task 1: Receiver composition (Claude Code MCP)

**Files:** `src/angelic.ts`, new receiver modules under `src/`, and `__tests__/worker/driver.js` only if private paths change.

**Interfaces:** `StateStore` owns the unchanged persisted schema. `AutoPushLink` owns the one socket, connecting promise, waiters, heartbeat, and epoch. `Registration` uses the same link and store. `Notifications` uses synchronous capture and the existing outbox. `Delivery` exposes target validation, running/blocked state, and delivery. Narrow callbacks return control to `Angelic` for reconnect and alarm scheduling; no modules import the coordinator at runtime.

- [x] Confirm green baseline: 25 unit tests / 103 assertions and 30 workerd tests.
- [x] Save pre-refactor source/tests at `.wrangler/refactor-400-baseline-20261009` with SHA-256 manifest.
- [x] Obtain independent read-only plan review; resolve extraction ordering hazards before delegation.
- [x] Extract safe errors and state ownership, then delivery, socket, notifications, and registration. Keep the coordinator/status below 400 lines; extract status only if needed.
- [x] Verify actual edits against the saved baseline, typecheck, and execute the complete workerd suite on Codex's Mac host.

## Task 2: Unit test split (Codex)

**Files:** Replace `__tests__/core.test.ts` with `ece.test.ts`, `autopush.test.ts`, and `x.test.ts`. Add `helpers/rfc-vector.ts` for published fixture values shared by ECE and X tests.

**Interfaces:** Export `rfcKeys` and `rfcData`; keep assertion helpers and encoders local to ECE tests. Retain all test names, assertions, and independent fixture inputs.

- [x] Move the tests by protocol without changing assertions.
- [x] Verify 25 tests and 103 assertions still pass and both TypeScript projects compile.

## Task 3: Review and completion (Codex + independent Claude reviewer)

- [x] Compare current source/tests against the saved baseline, including new untracked modules.
- [x] Request a fresh read-only Claude Code review of actual files and the baseline diff.
- [x] Resolve material findings and verify the full suite, typecheck, lint, line counts, and production/staging dry-run.
- [x] Record evidence and report resulting file sizes.

## Decisions and evidence

- Plan review: Claude Sonnet `job_d5ab71bbdb33766d5107592eff9ffaef`, completed. Extraction hazards above were incorporated.
- LocalGPT status: browser disconnected, `nativeReady:false`, so no new request was dispatched; Claude is the authorized alternate review route.
- Structural refactoring continues from a green behavioral suite; no artificial behavior changes or implementation-mirroring tests are introduced.
- Separate ownership: Claude edits receiver source/driver; Codex edits unit-test split and this plan.
- Unit split: 25 tests / 103 assertions pass; each describe block is byte-identical to the baseline after trimming outer whitespace. Files are 216 / 115 / 99 lines; shared RFC vector is 22 lines.
- Receiver implementation: Claude Sonnet `job_b959a9dc782189f4882e03292f4ebba3`, completed. Native Mac verification confirms 25 unit + 30 workerd tests, both typechecks, lint (existing Date warning only), and production/staging dry-run. All other pre-existing source/tests are SHA-256 identical to the baseline, including the test-only driver.
- Fresh independent actual-file review: Claude Sonnet `job_4dbc383e028715f2f5a3332d3db051d7`, completed; no introduced behavioral regressions. Internal-only reconnect method made private; comment spacing and historical ownership wording clarified. Constructor parameter properties retained as a concise TypeScript idiom.
- Reviewer counted 62 static `expect` call sites; Bun executes 103 assertions because several sites run in loops or helper calls. Both the baseline and split run 25 tests / 103 assertions; no mismatch.
- Final native verification after review cleanups: complete suite 55/55, both typechecks, lint with the pre-existing Date warning, both deploy dry-runs, and 25 code files at or below 400 lines (maximum 328). No owned workerd processes remain.
