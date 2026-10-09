---
status: implemented
date: 2026-09-27
decision: Place Codex child history only when a recorded spawn acknowledgement resolves to one verified direct child.
---

# Codex child placement

## Context

A Codex `spawn_agent` output records an actor path, while a nearby
`SubAgentActivity` can record the child thread ID. Neither field alone proves
that a readable canonical child belongs at the parent's spawn point.

## Decision

The Codex adapter resolves only a started spawn acknowledgement with an exact
call ID. A recorded activity child ID selects the candidate when present; the
selected child's primary header must have that canonical ID, the current
parent ID, and the acknowledged actor path. Without an activity ID, exactly
one selected direct-child header may match the parent and actor path. Missing,
ambiguous, or mismatched evidence leaves `toSessionRef` absent. The requested
spawn and untargeted wait remain unassigned.

Reader placement retains the acknowledgement's protocol event ID and uses its
recorded tool Reader reference as the `afterEvent` anchor. Child header checks
read only the primary metadata record. Reader anchors are indexed once while
placing children in long source streams.

## Alternatives considered

- Treat the actor path as a session ID: it is a display path, not canonical
  identity.
- Select the first matching alias when several child headers match: that
  would hide a recorded ambiguity.
- Parse complete child transcripts to confirm parentage: the primary header
  already carries the required direct-parent and actor evidence.

## Consequences

The Reader can place verified child history immediately after the recorded
spawn tool. Unresolved acknowledgements remain visible without a child link.
The current Session Protocol coordination and relationship facts do not carry
this resolved child reference; their coverage text identifies that projection
boundary. WEB-05 verifies Reader placement and inline child navigation.
On a deep child URL or Back/Forward restoration, each pane locates its recorded
`afterEvent` in that pane's revision and loads only the containing Reader page.
It does not assume that a child insertion lies in the first bootstrap page.

## Verification

The public three-level Codex HTTP case verifies two canonical child refs,
source event IDs, exact spawn tool anchors, continuation, and unchanged source
hashes. Focused Rust tests cover missing children, wrong parent or actor,
ambiguous aliases, and exact activity-ID selection. The Rust workspace and
governance checks pass.
The public three-level browser regression moved both spawn anchors beyond the
first 32 events and failed before this location-driven restoration. It now
passes direct deep links, refresh, Back/Forward, and focus with 3/3 checks.
