---
status: implemented
date: 2026-09-08
decision: Add an OpenCode provider-native Session Protocol v3 projection over the finalized v2 snapshot, with evidence-bounded todo identity, task correlation, background terminal state, coordination observations, and request usage.
---

# OpenCode native Session Protocol v3

## Evidence

The installed Windows CLI is `1.17.11`. On 2026-09-08, npm latest was
`opencode-ai@1.18.29`, release tag `v1.18.29` resolved to
`16747470f976aca3d362ad730bcd3fe82ecc2c9a`, comparison tag `v1.18.27` to
`4b7e19e315cca414121ba1d61523fef74bb3ae8b`, and upstream HEAD was
`ecbc6ccac85b3e8087b6445e584318419b9e2b34`. The official source diff is
empty for `packages/core/src/session/{sql,todo,schema}.ts`,
`packages/schema/src/v1/session.ts`, and OpenCode session/tool sources.
The 1.18.29 release note is a Codex OAuth integer-GPT model-filtering fix,
not a session-storage schema change. Both tags retain the `message`/`part`
projection, todo primary key `(session_id, position)`, `ToolPart.callID`,
`subtask` and `compaction` parts, task metadata `background`/`jobId`/child
`sessionId`, and explicit task-state result envelopes.

The local OpenCode SQLite source was inspected read-only: 131 sessions, 73
parent links, 182 todos, 2,968 messages, and 13,091 parts. No context epoch or
input rows and no background result envelope appeared in that snapshot.

## Context

OpenCode's normalized SQLite projection already supplies the v2 message/part
tree, todo rows, child-session links, and aggregate token columns. The v3 Work
Graph needs request usage and continuing coordination facts, but the provider
does not record durable goals, actors, context-result versions, or origin
slices. This stage therefore extends the provider boundary additively and
keeps all absent meanings explicit.

## Decision

`buildOpenCodeSessionProtocolV3` lives in the OpenCode provider and receives
the same tree and finalized v2 snapshot. It copies all v2 facts unchanged and
is finalized through `finalizeSessionProtocolV3` at the adapter boundary.

- Todo Task ids use a namespaced representation of the source key
  `(session_id, position)`; provenance source ids use the exact source key.
  Mutable content, priority, and timestamps do not participate in identity,
  and cross-snapshot continuity after reordering remains unknown.
- Task `toolCallId`, Task correlation, part-event correlation, and spawned
  relationship correlation use recorded `part.data.callID`; missing call ids
  remain null. `part.id` remains the event/task/run source identity.
- `background=true` proves execution mode only. Background runs become
  terminal only with an explicit `<task state="completed|error">` envelope;
  child presence, generic tool completion, and `timeEnd` do not prove a result.
- Each normalized subagent Task/Run produces one `spawn/started` observation
  only when an exact child and matching `spawned` relationship exist; otherwise
  it produces `delegate/requested` with the known task/run and no guessed
  session. A `subtask` part produces only an independent `delegate/requested`
  observation. Explicit result envelopes produce separate result-delivery
  observations, with completed delivered and error failed. Session parent ids
  remain lineage, including one incoming parent edge for a focused child.
- Goals and Actors remain empty. Context versions, transformations, and
  artifacts remain empty; a compaction event without a result has `unknown`
  context coverage, while no context evidence is `not-observed`.
- Each nonzero canonical assistant message contributes at most one request
  UsageRecord. Event-update rows and session aggregate totals are not request
  records. The raw total is retained only when it equals the five mutually
  exclusive normalized components; a mismatch becomes null with recorded
  provenance. No origin slices are inferred.

## Alternatives considered

- Keep the existing todo fingerprint. Rejected because the provider primary
  key is `(session_id, position)` and mutable content/priority/time cannot be
  treated as identity.
- Treat generic tool completion, child presence, or `timeEnd` as background
  completion. Rejected because only the explicit task result envelope carries
  terminal result semantics.
- Infer Goals, Actors, context versions, or origin slices from titles, agent
  names, compaction events, or token totals. Rejected because those records do
  not prove the corresponding protocol entities.
- Put OpenCode event interpretation in the shared runtime. Rejected because
  `callID`, task envelopes, and SQLite row semantics are provider-owned.

## Consequences

OpenCode Runtime v3 exposes observed Work/Execution/Coordination/Usage only
where the SQLite records support them, while absent Goal/Actor/Context results
remain honest. Provider storage stays read-only, and the v2 Runtime contract
is unchanged. The fixture is source-derived bounded evidence, not a copied
local transcript.

## Verification

- `test/opencode-v3.test.mjs` and
  `test/fixtures/opencode-native-v3-synthetic.jsonl` cover v2 preservation,
  source identity, callID correlation, exact/missing/mismatched children,
  structured subtasks, foreground/background status, explicit result delivery,
  incoming parent lineage, compaction coverage, usage total mismatch,
  zero-token suppression, and validator success.
- Focused OpenCode tests passed 7/7 after the source and test build.
- `npm run review`, focused OpenCode and route tests, `npm test` (467/467),
  and `git diff --check` passed.
- Three real OpenCode sessions validated as native v3 with zero diagnostics;
  all four Runtime APIs returned HTTP 200. Browser QA covered Work, Execution,
  Coordination, Context, ToC, 390/320 px layouts, and the complete E2E suite.
- The source SQLite remained 88,059,904 bytes with unchanged UTC mtime
  `2026-07-24T17:20:13.9746022Z` after the read-only checks.
