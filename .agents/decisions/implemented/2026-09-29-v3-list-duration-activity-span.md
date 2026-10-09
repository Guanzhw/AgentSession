---
status: implemented
date: 2026-09-29
decision: Define 3.0 protocol list duration as the span of owned conversation and work events, excluding later source lifecycle markers.
---

# List duration measures recorded activity

## Context

The earlier [list-stat decision](2026-09-28-v3-legacy-list-stats-scope.md)
preserved the 2.0 scope for message and work counts and meaningful-event
duration. A five-source HTTP comparison exposed two cases where 2.0's generic
duration calculation includes a later lifecycle record. For an OpenCode v2
session, the first user message is at `1790337350896` and `session.idle` is at
`1790340258136`; 2.0 reports 2,907,240 ms while 3.0 reports 2,785,696 ms.
For a DeepSeek Harness session, 2.0 spans the first source event at
`1788352368498` through a later `session/end-seed` at `1788440555363` and
reports 88,186,865 ms. The 3.0 conversation/work span is 10,545,654 ms.
`session/end-seed` records an in-process construction or resume boundary, not
a conversation reply. The 3.0 protocol still exposes both source records with
their timestamps and provenance.

## Decision

For 3.0 list statistics, protocol duration is the positive timestamp span of
owned message, tool, task, run, context, control, and team events. System and
developer messages and provider lifecycle/source records do not extend that
span. When a provider has stronger evidence for its conversation boundary, it
sets the provider-owned `list_duration_range`; Codex uses this path. If no
protocol duration is available, the list retains its raw session-time fallback
with `durationSource: "raw"` or returns null when no range is recorded.

This refines the earlier decision for OpenCode and DeepSeek Harness rather than
copying 2.0's broad event span. The raw event timeline remains available for
users who need elapsed time through a lifecycle marker.

The user was offered the two duration definitions during this acceptance run.
At the time of recording, no reply had arrived; the goal's agreed fallback is
to use the recommended activity-span definition and report that choice.

## Alternatives considered

Copying 2.0's all-event timestamp span would make the OpenCode and DeepSeek
Harness numbers match, but the later idle and end-seed records would extend a
conversation's displayed duration without another conversation or work event.
Returning null would discard a source-backed activity interval.

## Consequences

The 3.0 `durationMs` field can differ from 2.0 for these sessions. The list
keeps `durationSource` so callers can distinguish a protocol activity span
from a raw session-time fallback. Acceptance comparisons must check the
underlying event kinds and timestamps rather than treating numeric equality
with 2.0 as proof of correctness.

## Verification

Fixed 2.0 and exact 3.0 Windows package `4313bfe5` used the same frozen
five-provider sources. The HTTP comparison (`../../../tmp/v3-delivery/http01-live-4313bfe5.public.json`, local evidence)
records both list values and source-stable corpus digests. Direct bounded
event-page traversal confirmed the first and latest source event kinds and
timestamps for both sessions; no provider source was changed. The 3.0
`ProtocolBundle::list_stats` filter is in
`v3/crates/core/src/protocol/observations.rs`, and the provider-specific
override boundary is `ObservationCandidates::list_duration_range`.

HTTP-01 stays open for the other list-stat differences and full filter coverage.
