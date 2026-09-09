---
status: implemented
date: 2026-09-09
decision: Map the bounded OpenClaw v2026.9.3 SQLite evidence into native Session Protocol v3 while retaining the finalized v2 snapshot as the canonical event and lineage base.
---

# OpenClaw native Session Protocol v3 core

## Context

OpenClaw v2026.9.3 records session goals, actor/owner creation facts, spawn
metadata, lifecycle fields, swarm identifiers, and completion ownership in the
SQLite `session_nodes.entry_json` boundary; request-level token fields remain in
`transcript_events.event_json`. The audited release commit is
`1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7`;
the audited moving checkout is `0140d656b1012a3059fd8f769952485a58b8a4e5`;
agent schema 19 has SHA-256
`fe93217454642e911608f81afc53c9fb3bb7c20cc32bc73f8f6eeaaf232b91b8`. The
local OpenClaw installation is older (`2026.7.1-2`) and has no current SQLite
sample, so the mapping must remain bounded to this audited evidence.

## Decision

Normalize only documented, bounded `entry_json` fields at the SQLite adapter
boundary into provider-owned facts. Build every non-header SQLite record into
the canonical v2 event stream, using `record:<source-id>` references and a
common ancestor for multiple branch leaves; linear sessions retain a null fork
anchor. The native v3 snapshot reuses that finalized v2 snapshot.

Expose recorded goals, explicit actors/owners, and child AgentRuns only when
spawn creation evidence exists. Map OpenClaw limited goal states to the shared
`blocked` state while preserving the raw status in bounded provenance. Emit one
spawn coordination observation per recorded child and do not infer delivery,
completion, or team membership without evidence. Emit additive request Usage
for every assistant record, including abandoned branches, deduplicated by the
recorded response identity; keep contradictory totals and absent components
unknown. A non-empty recorded compaction or branch summary may create a
metadata-only ContextArtifact and ContextTransformation; lifecycle/reset
operations without a readable result remain events only. Advanced SQLite
evidence tables remain outside this core mapping.

## Alternatives considered

- Upgrade v2 snapshots generically: rejected because it would turn OpenClaw
  lineage, compaction, or cumulative token totals into facts without native
  evidence.
- Project only the active branch: rejected because stored non-header records
  and abandoned-branch request usage are recorded evidence.
- Infer AgentRuns from every child/session node or delivery result: rejected
  because session existence and launch acknowledgement do not establish the
  requested coordination semantics.
- Read advanced evidence tables now: rejected because their ownership and
  retention contract are not required for the bounded v3 core.

## Consequences

OpenClaw has a provider-owned native v3 mapping with explicit coverage and
diagnostics while preserving the existing read-only SQLite and legacy JSONL
paths. Runtime consumers can distinguish recorded work, execution, and context
facts from unknown or unsupported domains. The local installation cannot
provide a live current-format smoke sample; release/source evidence and
bounded synthetic regression fixtures cover the audited v2026.9.3 shape.

## Verification

- OpenClaw native v3 tests: 7/7, including canonical branch refs, common fork
  ancestor, limited goal status, explicit actors, spawn coordination, usage,
  compact context evidence, legacy lineage, and parent-cycle diagnostics.
- Full `npm test`: 497/497. Focused OpenClaw and Runtime Workbench regression
  tests: 42/42.
- The real local legacy session produced 11 canonical v2 events, one branch,
  zero validation diagnostics, and three request Usage records totaling 80,330
  tokens. The provider JSONL size, timestamp, and SHA-256 were unchanged after
  adapter, API, and browser reads.
- Live browser checks covered Work, Execution, Conversation/ToC, 390px and
  320px widths, plus empty console and page-error streams. A structured storage
  diagnostic coercion found by this check was fixed and regression-tested.
- `npm run review`, `npm run pre-push`, and `git diff --check` are final
  handoff checks for this change.
- The local OpenClaw 2026.7.1-2 installation was not upgraded and contains no
  current SQLite transcript; this remains an explicit evidence limitation.
