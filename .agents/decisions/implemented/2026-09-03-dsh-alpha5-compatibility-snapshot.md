---
status: implemented
date: 2026-09-03
decision: Refresh the DSH compatibility snapshot to alpha.5 after proving the physical storage format is unchanged, and adopt the official alpha.5 checked-in web snapshot as the current fixture.
---

# DSH alpha.5 compatibility snapshot

## Context

The adapter was pinned to `dsh-v0.1.2-alpha.3` while upstream moved to
alpha.5 (`db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`) and official HEAD
`49a606bc5b5934603f22a26957a07dc799ab0291`. The previous run installed
`@deepseek-ai/dsh@0.1.2-alpha.5` globally and verified the tag/HEAD, session
format version, event catalog, header line, and the state of credentialed
live-model verification.

## Evidence

Verified against the alpha.5 checkout at `/tmp/dsh-upstream-alpha5`
(tag `dsh-v0.1.2-alpha.5`, HEAD `49a606bc…`):

- `SESSION_FORMAT_VERSION` remains `0` (`packages/core/session/src/types.ts`).
- `known-event-types.ts` (generated catalog) is the exact same 51-type set as
  alpha.3 — element-for-element comparison against the parser allowlist
  passed with no additions or removals.
- The physical header line is still `seedLength`-based:
  `session-persistence-jsonl/src/format.ts` `toHeaderLine` writes
  `seedLength` for seeded logs and `fromHeaderLine`/`isHeaderLine` read it
  back. Alpha.5 only split the in-memory `SessionHeader` into
  `isSeeded` + a separately carried inherited-event count; the persisted
  boundary did not change.
- Packed chunk rows (`text-chunks` / `reasoning-chunks` /
  `tool-call-chunks`) keep the exact same envelope and data shapes; the
  alpha.3→alpha.5 diff is `SessionSeq` branding and `-0` rejection only.
- `seq-ranges.ts` (range-encoded `sourceEventSeqs`) and the multi-frame
  Zstd reader are unchanged in behavior.
- `surfaceOp` union is still `'append' | {op:'replace',start,end}`.
- Alpha.5 ships no session-persistence SQLite plugin. The SQLite packages
  present are a storage-hub kv facet (`@deepseek-ai/dsh-storage-sqlite`) and
  an FTS5 session-query backend (`@deepseek-ai/dsh-session-query-sqlite`), so
  `sqliteSchemaVersion` stays `null` and schema 17 remains the legacy
  persistence schema behind the explicit diagnostic.
- The official checked-in web snapshot
  (`snapshots/web/fresh-round-trip/session.jsonl`) is byte-identical at the
  alpha.5 tag and at HEAD (sha256
  `0747344224d4222f861dd9692c4332badfba221afc6e686c3dee18177055d845`). It
  omits per-event `seq`/`time` envelopes; upstream replays it through
  `parseSessionLog` (`packages/test-support/llm-replay/src/index.ts`), which
  synthesizes `seq` by log order (packed rows advance by their expanded
  count) and `time` 0. The fixture regression reproduces that rule.

A credentialed live `alpha.5` model run was **not available**: the configured
API key failed authentication, so no new official live session could be
recorded this stage. Live-model re-verification remains an explicit follow-up;
nothing in this stage claims live evidence beyond the alpha.3-era local
sessions already recorded.

## Decision

Refresh the checked-in compatibility metadata to alpha.5 and adopt the
official alpha.5 web snapshot (copied byte-for-byte into
`test/fixtures/dsh-alpha5-fresh-round-trip.jsonl`) as the current fixture,
with the upstream envelope-synthesis rule documented as
`fixture.envelopeOmitted` / `upstreamReferences.fixtureEnvelopeRule`.

No parser or protocol change is made: alpha.5 proves no format change at the
provider boundary. Alpha.3- and rc.8-compatible readers remain regression-
tested because both fixture consumers still exist. Unknown required events
and non-zero session versions keep failing loud; events explicitly marked
`ignorable: true` keep passing (the upstream compatibility marker).

## Alternatives considered

- Treat alpha.5's in-memory `isSeeded`/inherited-event split as a storage
  change and rewrite the parser's seed handling. Rejected: the split is
  upstream-internal; the persisted line still carries `seedLength`, and the
  parser already exposes `seedLength`/`inheritedEventCount` as normalized
  metadata.
- Hand-edit the official snapshot to add `seq`/`time` before checking it in.
  Rejected: the file would no longer be official bytes, and the snapshot test
  could no longer pin byte-identity against upstream.
- Keep the alpha.3 fixture as the current `fixture` and only bump version
  strings. Rejected: the official alpha.5 snapshot is better evidence and is
  now checked in; alpha.3 moves to `previousSnapshot` with its derived
  fixture retained.

## Consequences

- `DSH_COMPATIBILITY_SNAPSHOT` now records `headCommit`, `previousSnapshot`
  (alpha.3 + derived fixture), and the official alpha.5 fixture with sha256.
- `protocol` revision strings follow `DSH_COMPATIBILITY_SNAPSHOT.tag` and
  now report `dsh-v0.1.2-alpha.5`.
- The alpha.3 derived fixture and the rc.8 fixture remain regression
  fixtures; removing them would now require removing their existing consumers.
- The live-run gap is recorded (key auth failure) rather than presented as
  verified success; future stages should re-run a credentialed session and
  re-check adapter/API/browser projections.

## Verification

- Focused suite: 11/11 DSH parser + protocol v2 tests pass, including the
  alpha.5 snapshot pin, the alpha.5 fixture validation, retained alpha.3/rc.8
  readability, and unknown-required/version rejection.
- `npm test`, `npm run review` (governance + typecheck), and `git diff --check`
  complete the handoff gate. No commit or push was made.
