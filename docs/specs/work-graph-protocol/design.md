# Session Protocol v3 Work Graph design

Status: v3 foundation and bounded projections implemented; provider mappings pending

Date: 2026-09-02

## Boundary

Session Protocol v3 extends the finalized v2 session snapshot. It does not
replace provider-owned session identity, ordered events, tasks, runs,
relationships, artifacts, or branches. A v3 snapshot therefore remains rooted
at one canonical `(provider, sessionId)` and adds facts needed by work-first
consumers.

Providers may eventually construct native v3 snapshots. During migration,
`upgradeSessionProtocolV2()` creates a v3 snapshot that preserves v2 facts and
leaves every new domain unknown and empty unless explicit coverage is supplied.
The upgrader never converts session lineage into coordination, compaction into
a context transformation, or message token totals into request usage.

Invalid v2 snapshots cannot be upgraded. Partial source diagnostics survive
the upgrade. Finalization owns and freezes a cloned snapshot, so later changes
to provider drafts cannot invalidate cached validation.

## Bounded projection API

The first v3 consumer stage exposes four explicit, provider-neutral runtime
projections. Existing v2 Runtime routes remain unchanged:

```text
GET /api/:provider/session/:id/runtime/work
GET /api/:provider/session/:id/runtime/execution
GET /api/:provider/session/:id/runtime/coordination
GET /api/:provider/session/:id/runtime/context
```

Each response is versioned (`version: 3`) and contains the canonical `focus`
session reference, selected-domain `coverage`, protocol completeness, bounded
diagnostics, `maxItems`, and `truncated`. `maxItems` defaults to 100 and
accepts 1..300. Invalid bounds return HTTP 400. Invalid v2 snapshots that
cannot be upgraded return HTTP 422 with `code: "protocol_invalid"`.
The current bounded snapshots do not paginate; a later paged contract must
bind cursors to its complete filter identity.

The response shapes are typed rather than a generic node and edge bag. Work
returns goals, tasks, goal membership, dependencies, and task/run relations.
Execution returns actors, runs, additive request usage, usage coverage, and
actor membership/run relations. Coordination returns explicit observations
plus existing session lineage. Context returns metadata-first artifacts,
versions, transformations, usage-origin records, and typed lineage/source
relations. Every observed fact retains its recorded/derived provenance.

Public entities omit nested relation arrays such as task dependencies, actor
members, context-version parents, artifact source sessions, and usage origin
slices. Those relations are emitted as separately typed collections under the
same strict construction/output budget. Execution usage aggregates preserve
authoritative totals when present, use null for unavailable components, and
mark `complete: false` for unknown/unsupported coverage, missing components,
or bounded omission. An explicit `not-observed` usage domain with no records
is the only empty aggregate reported as complete zero.

## Evidence coverage

Every graph domain carries coverage independent of entity provenance:

```text
observed | not-observed | unknown | unsupported
```

- `observed` means the snapshot contains typed facts for that domain.
- `not-observed` means the provider can expose the domain but this source
  snapshot contains no matching fact.
- `unknown` means the available evidence cannot decide the requested meaning.
- `unsupported` means the provider contract has no evidence boundary for the
  domain.

An observed fact separately carries `recorded | derived` provenance. Empty
arrays do not select a coverage state. `observed` with no facts and
`not-observed`/`unsupported` with facts are validation errors; `unknown` may
retain compatible v2 facts whose new-domain completeness is indeterminate.

## Work

`Goal` is an optional work root over existing `Task` records. It has stable
session-local identity, status, parent goal, owner actor, task membership,
timestamps, and provenance. Goal parents must be acyclic and every referenced
task/actor must exist locally.

Task and AgentRun retain the v2 separation:

- Task is requested work and owns dependency/status/outcome semantics.
- AgentRun is one execution attempt and owns mode, actor/model linkage, child
  session, schedule, timing, and terminal state.

The protocol does not derive goals from session titles or user prose.

## Execution actors

`Actor` identifies a human, agent, team, or system independently of a session.
It can link to a canonical session, executed runs, provider-native identity,
and optional team membership. Only a team actor may list members, and
`teamId` must reference a team actor. The two directions are not required to be
simultaneously recorded because providers may expose only one.

Execution projections combine Actor, AgentRun, and existing task/run anchors.
They do not infer background, async, scheduled, team, or retry semantics from
the mere existence of a child session.

## Coordination

`CoordinationObservation` records continuing multi-actor interaction:

```text
spawn | delegate | follow-up | message | mailbox-delivery | wait |
interrupt | handoff | result-delivery | result-acknowledgement
```

Each observation has stable identity, state, timestamp, optional sender and
recipient actors, canonical source/target sessions, task/run/event/turn/
correlation anchors, and provenance. Existing v2 session relationships remain
lineage. A v2 `spawned`, `forked`, `continued`, or `compacted-into` edge is not
upgraded into a coordination observation without separate provider evidence.

Launch, delivery, acknowledgement, completion, and interruption are distinct
states. A tool call result that only acknowledges launch cannot complete a run.

## Context

Context has three layers:

- `ContextArtifact` is scoped information such as memory, experience,
  user-info, instruction, skill, rule, or summary. Existing scopes remain
  session, agent, project, user, and organization.
- `ContextVersion` is a session execution context with parent versions and
  included artifacts.
- `ContextTransformation` links recorded source versions/artifacts to an
  observed result version or artifact.

Transformation kinds include compaction, merge, load, reinjection, memory,
experience, and dream. A recorded operation without an observed result remains
an event and is not promoted to a transformation. This lets the primary UI show
what context became after compact while keeping start/prune/end lifecycle
events in the evidence view.

Artifact content remains metadata-first and respects `ContentAccess`. Optional
memory, experience, or user-info support is expressed through coverage and
content access, never inferred from tool names or an empty count.

## Request usage

`UsageRecord` is one canonical additive model request. Turn and session totals
are projections over request records, not additional records, so generic
consumers cannot count the same request twice.

A usage record carries:

- stable provider request/usage identity;
- owning canonical session and optional Run/Event/turn anchors;
- timestamp and model;
- mutually exclusive input, cache-read, cache-write, output, reasoning, and
  authoritative total components;
- recorded/derived provenance;
- optional input/cache context-origin slices.

Origin slices are multi-valued per component:

```text
direct | inherited | shared
```

Their sum cannot exceed the owning request component, and they may cite source
sessions. Output and reasoning cannot have a context origin. `direct usage`
means request records owned by the selected session/execution. Inherited copied
history is not a request; inherited or shared input used by a real model request
is still counted once. Cache reads remain usage and are never deduplicated
across distinct requests merely because the underlying context was shared.

## Validation and bounds

The v3 validator first revalidates the v2-compatible base, then checks:

- stable unique identities and canonical session ownership;
- goal, actor/team, task, run, event, artifact, context, and usage references;
- goal and context lineage cycles;
- coordination and transformation vocabulary;
- required transformation results;
- request-only usage scope, known nonnegative integer token components,
  authoritative-total lower bounds, and context-origin bounds;
- coverage/fact contradictions;
- bounded diagnostics.

This stage adds bounded Work, Execution, Coordination, and Context projections
over this contract. Summary and Events remain cross-cutting inspection
utilities. The next stage maps provider-native evidence into the four domains.
