---
status: implemented
date: 2026-09-14
decision: preserve readable collaboration source bindings and child-owned lifecycle observations for the unified history reader
---

## Context

The [Stage 3C reading case](../../../docs/design/runtime-reader-coordination.md)
shows repeated follow-ups to one child and separate child-turn completions.
The earlier bounded channel dropped dispatch/follow-up kinds and source
bindings, leaving readers unable to follow those interactions or reach their
exact content. The implemented reader keeps these facts attached to their
canonical sources without promoting them into a global graph.

## Decision

Keep source interpretation at the provider boundary. Add normalized optional
message/tool bindings to session events and a typed cross-session event source
for child lifecycle evidence. Child completion and result delivery remain
different recorded facts. Preserve the child's canonical event identity and
owned-record boundary.

The shared reader resolves existing message/part anchors, uses the existing
event-evidence rendering for events with no readable body, and visualizes
distinct observations without inferring causal pairings. The implemented
reader keeps those observations in local prose inserts and an on-demand Tasks
& collaboration panel, rather than a permanent global lane graph. Continue
bounded channels from the finalized coordination collection through a
reader-specific cursor bound to its canonical owner and exact run/task filter.
Preserve the existing runtime coordination API's projection semantics.

The current v2 Events API and bounded embedded Workbench evidence cannot load
an arbitrary v3-only child lifecycle event. A reader-owned exact-event source
response supplies only the requested normalized scalar evidence in its owning
reader; it does not expose all v3 events or provider-private payloads.

For cross-round orientation, the main-agent lane marks normalized lifecycle
events bound to `session-turn` runs and opens their own exact event sources.
The real parent orchestration turns have no corresponding owned user input.
Execution and reading turns are distinct: user-message anchors must not be
inferred from a nearby dispatch, completion or lifecycle timestamp.

## Alternatives considered

- A single latest-status interval cannot identify repeated interactions.
- Opening only Work metadata discards an already available readable source.
- Inferring delivery from a child's terminal event changes the recorded meaning.
- Mirroring full transcripts into a second graph/store duplicates content that
  the existing canonical reader already owns.

## Consequences

Readers can open the exact text behind recorded follow-ups and distinguish it
from child lifecycle evidence. Protocol consumers gain optional source fields
without large transcript payloads. One child history remains the navigation
unit; its individual observations remain distinct. Missing sources and clocks
stay explicit.

## Verification

Require provider fixtures and real child protocol ID equality, inherited-record
exclusion, normalized validation, exact readable anchor tests, bounded cursor
identity and continuation tests, and dense/narrow browser reading acceptance.
The current implementation has 704/704 local tests passing. The latest complete
real-API validation across seven providers finished with 0 errors; whole-site
`qa:e2e` exited 0 with `ok:true` and no browser errors, and the Windows final
binary build and smoke check passed. Real desktop and mobile checks confirmed
child-history open, refresh, close and return to the canonical sidebar entry
with focus restored and both nested details expanded. The reader preserves
distinct recorded follow-ups, child completion and delivery sources; ordinary
main turns do not construct a collaboration panel. Visual acceptance remains
stage-gated around compact task purpose/return presentation, metadata density,
and the follow-up Library work.
