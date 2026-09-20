---
status: implemented
date: 2026-09-20
decision: Group response presentation and bring local collaboration into the conversation body
---

## Context

The user's four screenshots of the native DSH Teams Reader show repeated
assistant/execution shells, hidden model usage, an inline collapsed ToC, and a
separate graph plus duplicate member directory. Live desktop inspection confirms
these presentation problems. Complete content is available but scattered.

## Decision

Use a persistent left ToC and response-level reading groups with visible
model/usage metadata. Combine adjacent process-only entries, retain readable
prose and turning points, and explain relevant collaboration in the body.
The user requested further research before choosing its visual form. The research
compared conversation branches, local handoff strips and optional time lanes with
the same saved content, before the branch-based choice recorded below.
Full correspondence and child history expand locally; technical Work/Events move
under More. The [research brief](../../../docs/design/inline-collaboration-research.md)
records primary references, design hypotheses and the comparison gate.

On 2026-09-21 the user found A relatively simple and orderly but its connection
semantics unclear, B unfocused, and C hard to understand and unsuitable for
dozens of agents. Continue only the branch-based design: distinguish assignment,
peer exchange and asynchronous continuation/return, focus on work and outcomes,
and expand large groups locally.

The user subsequently approved reference choice A plus reading choice 乙:
Raycast-inspired reading focus and density, with key assignments, handoffs and
returns visible by default. The user explicitly requires AgentSession-specific
runtime design, not a replica. Work relationships determine the components and
interactions; the reference supplies visual hierarchy only. The direction is
approved. The user subsequently accepted the A-plus-乙 prototype and authorized
implementation in the production Reader.

This revises the sidebar-first presentation in the
[presentation contract](../../../docs/design/runtime-presentation-contract.md).
It retains the normalized data and complete-content navigation established by
[team collaboration](../implemented/2026-09-20-reader-team-collaboration.md).
Reading groups do not replace provider message identities or runtime turns.

## Alternatives considered

Reducing spacing alone leaves repeated shells and split navigation. Moving the
whole global sidebar into every response duplicates information and loses scope.
Hiding all but the last assistant text would discard readable unknown-phase text.

## Consequences

SSR grouping, ToC anchors, local collaboration selection and source/back restoration
must agree. Preserve original message/tool/reasoning ownership and unique request
usage; model changes and child usage remain distinguishable. Provider-owned
session files and the MCP interface remain unchanged.

The production DSH check exposed missing canonical message/tool source fields.
The DSH builder now emits those existing identifiers for durable append-origin
messages and tools. Team observations without task/run fields can use their
explicit member's canonical child lane, so dispatch and later peer messages
retain one reading identity. No task ownership is inferred from display names.

Source-only observations between two events of one coalesced tool are presented
beside that execution with an explicit “During this execution” label. This is a
recorded source-order interval, not a claim that the tool caused the observation
or that it happened before the call. Coalesced prose and reversed order remain
unplaced. Peer handoff, ordinary message and parent receipt remain distinct;
receipt alone is not relabeled as a completed result.

Inline exchanges reuse the existing lazy content and child-history paths.
DSH delivery records resolve their message body from the exact owned enqueue with
the same message ID. The delivery keeps its own source and timestamp; a missing
or ambiguous enqueue remains unavailable, rather than using a later child reply.
Already-placed observations are omitted from the initial task card channel,
while pagination and the optional complete directory remain available. Up to
three observations per source position are initially visible; larger groups
expand locally without creating a permanent lane for every member.

## Verification

The production DSH and Codex HTTP Readers were exercised with existing histories:
six adjacent process messages collapse and expand intact; desktop ToC and direct
usage are visible; peer correspondence opens in place; Codex dispatch precedes
a new user request and two later parent-side receipts; complete child history,
close/Back and canonical step navigation work without duplicate DOM IDs.
The full desktop E2E passed. Focused regressions cover 60 observations at one
source position, interval labels, ordinary-message folding, channel deduplication,
request ownership and inline-summary clicks. Final gate counts and publication
status belong in the [R1–R4 delivery queue](../../../docs/design/runtime-delivery-plan.md)
and [acceptance record](../../../docs/design/runtime-acceptance-evidence.md).
The ignored prototype's static checks remain historical design evidence; its
blocked file preview is not treated as production browser acceptance.
