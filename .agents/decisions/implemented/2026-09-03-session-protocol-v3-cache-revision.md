---
status: implemented
date: 2026-09-03
decision: Make the shared runtime native Session Protocol v3 cache revision contract generic: when getStatsRevision is absent or throws, derive a stable fallback revision from the canonical session (knownSession if passed, else adapter.getSession(sessionId), id-verified) via sessionRevision; and reject any native snapshot whose sessionId does not equal the requested sessionId without caching it.
---

# Shared native v3 cache revision contract

## Context

`getRuntimeProtocolV3` treated `getSessionProtocolV3` and `getStatsRevision` as
independent optionals. A provider implementing native v3 without a stats
revision produced a permanent null cache key: the first snapshot was cached
with `revision: null` and every later call matched it, so a changed session was
served stale forever. The v2 boundary already solved this:
`getRuntimeProtocol` derives its revision from `sessionRevision(adapter,
session)` (provider revision + `timeUpdated`/`messageCount`/`tokenCount`) and
returns `session_not_found` for a missing or id-mismatched reference. The
native v3 boundary also never verified that a provider-returned snapshot
belongs to the requested session, so a mismatched snapshot could be cached
under the wrong key and shadow the real session. Discovered while reviewing
the Codex native v3 cache path (LRU fix verification): the bug is in the shared
runtime boundary, not Codex-owned code.

## Decision

Own the fix at the shared runtime boundary (`src/protocol-runtime.ts`), not in
any provider adapter:

- Keep `getStatsRevision` as the primary revision. When it is absent, returns
  null, or throws (still never making the source unreadable), establish the
  canonical session at the boundary: use `knownSession` if passed, else
  `adapter.getSession(sessionId)`, and require its id to equal the requested
  sessionId exactly — otherwise `session_not_found`. Use the existing
  `sessionRevision(adapter, session)` as the fallback revision, so a change to
  the session's `timeUpdated`/`messageCount`/`tokenCount` rebuilds the
  snapshot.
- Require a native snapshot's `sessionId` to equal the requested sessionId;
  otherwise throw `protocol_invalid` ("Native session protocol does not belong
  to the requested session.") and never cache it.
- Unchanged: native LRU 256 with recency refresh on hit, providers with a stats
  revision keep their primary invalidation, `native === null` falls through to
  `getRuntimeProtocol` (session_not_found / protocol_unavailable semantics),
  the v2-to-v3 upgrade path, no provider-id branches and no compatibility
  layer.

## Alternatives considered

- Always precompute `sessionRevision(adapter, session)` even when
  `getStatsRevision` is present. Rejected: it forces an `adapter.getSession`
  call and stricter failures on the working fast path; the stats revision
  remains the primary, cheaper invalidation.
- Leave the null revision and warn on stale delivery. Rejected: the cache
  contract must not trade correctness for convenience; the fallback is free
  when the session is already loaded.
- Validate the mismatch inside the Codex adapter. Rejected: identity rules for
  a cache keyed by sessionId belong at the shared boundary, and every future
  native-v3 provider inherits them.

## Consequences

Any future native-v3 provider without a stats revision invalidates when its
canonical session metadata changes; a snapshot that does not belong to the
requested session is rejected instead of shadowing it. Codex is unaffected (it
keeps the stats-revision fast path). The Codex LRU fixture now returns an
id-matching snapshot per requested id because id verification is the validated
runtime contract; the test's LRU intent is unchanged.

## Verification

- New focused tests in `test/protocol-runtime.test.mjs`: (a) fallback revision
  invalidation on `timeUpdated`/`messageCount`/`tokenCount` change without
  `getStatsRevision`; (b) mismatched native `sessionId` is rejected with
  `protocol_invalid`, never cached, and the correct id still resolves. Both
  fail against the pre-change runtime (null-revision perma-hit / wrong-key
  caching) and pass after.
- Existing native path/LRU tests in `test/codex-v3.test.mjs` pass (fixture
  only adjusted to return id-matched snapshots).
- Run after this record: `npm run build` (clean), focused
  `test/protocol-runtime.test.mjs` + `test/codex-v3.test.mjs` (22/22 pass),
  `test/provider-removal.test.mjs` (1/1 pass), `npm test` 329/329 on
  WSL/POSIX, `npm run review` (governance + typecheck, clean), `git diff
  --check` (clean). No commit or push performed.
