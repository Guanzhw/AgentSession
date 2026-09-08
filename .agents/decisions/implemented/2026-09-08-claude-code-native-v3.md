---
status: implemented
date: 2026-09-08
decision: Add a Claude Code provider-native Session Protocol v3 projection over the same finalized v2 snapshot, with canonical response-deduplicated request Usage and evidence-bounded current transcript compatibility.
---

# Claude Code native Session Protocol v3

## Evidence

The installed Claude Code CLI is 2.1.207. On 2026-09-08, npm `latest` and
`next` resolve to 2.1.263, `stable` resolves to 2.1.236, and the official
`v2.1.263` tag and upstream HEAD resolve to
`ab9b2cf7bb9e4f98ff264c07a22e46d83c29c558`. The local project snapshot has 11
transcripts, 132 records, 21 assistant fragments, and 14 distinct response
ids. It has no sidechains, task notifications, or compaction boundaries; no
live 2.1.263 transcript was available.

## Context

Claude transcript records are linear assistant fragments with repeated usage
payloads, optional task notification fields, sidechain lineage, and compact
operation metadata. The v3 work-graph contract requires request identity while
preserving the already-finalized v2 event/task/run facts and keeping unrecorded
coordination or context-result semantics unknown.

## Decision

Claude's adapter constructs v3 from the same cached entry/child input and
finalized v2 snapshot used by `getSessionProtocol()`. Every v2 fact is copied
unchanged and finalized through the shared v3 validator.

- Goals, Actors, Coordination, ContextVersions, and ContextTransformations stay
  empty. Sidechain `spawned` relationships remain lineage only.
- Work and Execution coverage are derived only from finalized-v2 Tasks and
  AgentRuns. Compaction evidence yields `unknown` Context coverage without a
  fabricated result version.
- One nonzero UsageRecord is emitted per canonical assistant response. Repeated
  thinking/tool/text fragments share one response id and are counted once;
  adjacent no-id fragments use the bounded normalized-usage fallback. Usage is
  request-scoped, owned by the canonical session, never bound to a run, and has
  no origin slices. An explicit total is retained only when it equals the
  normalized input/cache/visible-output/reasoning components; contradictions
  remain null.
- Task notifications remain Tasks when `<tool-use-id>` is absent, with null
  correlation/toolCallId. `completed`, `failed`, and `stopped` are supported;
  `stopped` maps to cancelled, while unknown or missing status remains running.
  No parser support is added for unverified SDK-only snake_case or task event
  records.

Provider transcript files remain read-only.

## Alternatives considered

- Count every assistant fragment as a request. Rejected because fragments for
  one canonical response repeat the same billable usage.
- Treat sidechain lineage or compact operation metadata as coordination or a
  resulting context version. Rejected because those records do not prove
  message delivery, acknowledgement, or a result context identity.
- Drop task notifications without `tool-use-id`. Rejected because task id is
  still recorded identity and the optional correlation field can remain null.

## Consequences

Runtime v3 exposes Claude request usage without fragment double counting and
keeps unknown ownership/context semantics explicit. Current 2.1.263 support is
official-source/docs verified only; local live data remains 2.1.207.

## Verification

- `npm run review` and `git diff --check` passed.
- `npm run build` plus the focused Claude/protocol/file-cache suite passed
  (52/52); full `npm test` passed (476/476).
- The real local Claude adapter/API smoke read all 11 project transcripts
  without changing their size or mtime. Session
  `fc2b5510-5a53-4f54-9fba-500d73717c9f` exposed two canonical request usage
  records totaling input 63460 and output 30; total and input origin ownership
  stayed incomplete, Work/Execution/Coordination/Context coverage stayed
  `not-observed`, and every projection had zero diagnostics.
- Browser QA on the same real session covered Work, Execution, Coordination,
  Context, the conversation ToC, 390 px and 320 px viewports. It found no
  horizontal overflow or console errors.
