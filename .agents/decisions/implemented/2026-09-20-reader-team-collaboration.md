---
status: implemented
date: 2026-09-20
decision: Read explicit team membership, assignments and message exchanges from the existing normalized protocol
---

## Context

The v3 protocol already records DSH teams, members, assignments and queued/delivered
messages. The previous child-task view did not explain member-to-member cooperation
or expose the body of each recorded exchange.

## Decision

Use explicit team actors as the entry point to a provider-neutral Reader view.
A shared team node branches to members; directional message links select their
exchange history. Search and paged directories make every member, relationship
and assignment reachable. Selection opens complete assignment and message content,
with queued and delivered times distinguished. Child history remains the existing
Reader navigation path when a recorded session reference is available.

DSH owns exact enqueue-body lookup and its file revision, using the recorded
message ID and source sequence. The shared Reader never interprets provider raw
fields. Initial graph pages and detail continuations remain bounded; the source
records and provider storage stay read-only.

Provider-recorded Task and Actor descriptions are typed optional fields with an
actual Reader consumer. Directory and detail summaries do not copy their full
body; separate revision-bound content pages preserve complete reading. Explicit
member run IDs and member-owned task IDs suppress only the duplicate generic
task representation. Ordinary workflow tasks and positioned source messages remain.

## Alternatives considered

Ordinary parent/child sessions cannot establish team membership. Showing only
member counts or latest replies loses the cooperation history. Repeating the team
node for every row obscures the shared structure. Raising fixed limits would still
hide later assignments and exchanges.

## Consequences

The existing protocol gains a human-facing consumer and DSH gains its existing
optional coordination-content capability. Ordinary conversations have no empty
Teams panel. Tests and clearly labeled isolated fixtures cover complete navigation.
After explicit user authorization, an isolated DSH `0.1.6-alpha.2` run produced
native two-member cooperation using only `deepseek-flash`, preserving default
DSH configuration. The acceptance ledger records the native reading checks.

## Verification

Projection, route, client and DSH-content tests pass. Independent review checked
mixed Team/workflow deduplication and preservation of child links and native
anchors. An isolated native-format fixture exercises the real DSH adapter/server
and desktop browser: fifteen assignments, fifty-three exchanges, long bodies to
their final markers, missing child history, and an eleven-member paged directory.
Actual final checks and native-source availability are recorded in
[the acceptance ledger](../../../docs/design/runtime-acceptance-evidence.md).
