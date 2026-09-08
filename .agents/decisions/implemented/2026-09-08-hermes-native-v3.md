---
status: implemented
date: 2026-09-08
decision: Add Hermes-native Session Protocol v3 coordination over the finalized
  v2 snapshot and normalize async registry ownership at the read-only store boundary.
---

# Hermes native Session Protocol v3

## Context

Hermes v0.21.1 (`v2026.9.7`) declares state schema 30 and retains asynchronous
delegation rows with separate task and delivery state. The existing adapter
exposes v2 facts, but its single async event cannot distinguish dispatch,
lifecycle, and result delivery. The registry has no stable handle-to-child key;
the local installation remains v0.19.1 with schema 23.

## Decision

Hermes builds native v3 from the same cached read used to finalize v2. It
preserves every v2 field, leaves Goal/Actor/ContextVersion/Transformation and
request Usage empty, and reports work/execution/context/usage coverage from
recorded evidence. Each canonical async row produces independent dispatch,
lifecycle, and recognizable delivery observations. Unknown states remain
event-only, delivery attempts remain provider evidence, and no child run or
actor is bound to a handle. The store uses `parent_session_id` as the canonical
persisted spawner and retains `origin_session` only as the legacy CLI session-key
fallback. The current `origin_session_id` is an API completion wake target, not
ownership evidence. Provider SQLite remains read-only.

## Alternatives considered

- Treat the async row as one completed task/result event. Rejected because
  completed work and pending delivery are distinct recorded states.
- Bind the async handle to a nearby `_delegate_from` child. Rejected because
  the current registry has no correlation key and chronology is not identity.
- Convert session aggregate tokens to request UsageRecord values. Rejected
  because v3 request usage requires request-scoped evidence.

## Consequences

Runtime v3 can display completed async work with pending delivery while keeping
child AgentRuns independently terminal. Canonical parent and legacy CLI owner
evidence remain readable without treating API wake targets as provider-session
owners. Aggregate token data is
truthfully reported as unknown usage coverage, and compression remains unknown
context-result coverage because no resulting context version is recorded.

## Verification

- `npm run review` passed.
- Focused Hermes/OpenCode/provider-store tests passed: 23/23
  (`test/opencode-v3.test.mjs`, `test/hermes-v3.test.mjs`, and
  `test/provider-file-cache.test.mjs`).
- `npm test` passed: 472/472 tests; the expected malformed-fixture diagnostics
  remained explicit and did not fail the suite.
- Live read-only Hermes smoke loaded 4 local sessions and both requested
  session protocols with `validation.ok=true`; the root reported 3
  coordination observations and the child reported an unbound terminal run.
  `state.db` size (331776) and mtime were unchanged before/after.
- `git diff --check` passed.
