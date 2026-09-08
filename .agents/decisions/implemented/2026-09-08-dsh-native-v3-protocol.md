---
status: implemented
date: 2026-09-08
decision: Expose DeepSeek Harness alpha.2 native Session Protocol v3 facts as a provider-owned additive projection over the finalized v2 snapshot.
---

# DSH native Session Protocol v3

## Context

The official `dsh-v0.1.3-alpha.2` session format keeps v0/v1 historical
generations readable and defines current v2 event envelopes. Its durable event
catalog contains goal snapshots/tombstones, Agent Teams membership/tasks and
mailbox lifecycle, workflow agent start/end, request context, compaction
summaries, seed boundaries, and per-request assistant usage. These records are
provider evidence, not a license to infer async modes, token ownership, or
memory domains.

## Decision

`buildDshSessionProtocolV3` remains in the DeepSeek Harness provider and copies
the validated v2 facts before adding native v3 entities. It strictly replays
the released goal fold; invalid transitions produce no normalized goal and a
bounded Work diagnostic. A valid replay folds the latest
recorded non-clear goal snapshot; a clear tombstone removes the normalized goal
while remaining in the v2 event evidence. It preserves explicit team/member
actors and task fields, emits exact queued/delivered and workflow observations,
and creates a compaction transformation only when a readable summary result is
present. Workflow and child/session references are bound only when the exact
recorded child session is available; dangling evidence remains recorded and
unbound.

Usage is produced from the parser's single DSH usage projection: `data.usage`
or the final embedded stream usage, with last-wins turn/step retry slots. It
never reads an envelope-level usage field and emits no context-origin slices.
The human transcript remains the v2 append-origin projection; model-surface
replacement is retained only in v2 evidence and validation. No migration or
write-back to provider-owned files is performed.

## Alternatives considered

- Put DSH event semantics in the shared protocol runtime. Rejected because the
  event vocabulary and payload facts are provider-owned.
- Treat the v3 layer as a replacement transcript or infer ownership from seed
  lengths and counts. Rejected because replacement records are model evidence
  and alpha.2 provides no token-origin slices.
- Manufacture child runs or context transformations for lifecycle-only and
  dangling records. Rejected because missing durable evidence must remain
  explicit.

## Consequences

The adapter supplies a native v3 snapshot while preserving all v2 events,
relationships, messages, and context artifacts. Unknown domains remain
truthfully unknown, and downstream projections can distinguish recorded facts
from unavailable associations. Goal revision, phase, blocked reason, and clear
tombstone fields remain provider-owned v2 event evidence rather than new shared
protocol fields.

## Verification

- `test/deepseek-harness-protocol-v3.test.mjs` covers goals, teams/tasks,
  mailbox lifecycle, workflow bindings, compaction result gating, seed
  boundaries, usage retry dedupe, context association, and dangling children.
- `npm run typecheck`, `npm run build`, and focused DSH v2/v3 tests pass.
- Credentialed live alpha.2 persisted sessions and provider-side future event
  variants remain outside this local verification.
