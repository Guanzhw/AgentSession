---
status: implemented
date: 2026-09-13
decision: retain complete work history as the primary reading experience with on-demand task collaboration sources
---

## Context

The user rejected the shipped Work/Conversation experience on a real session.
Work foregrounds protocol categories and missing goals; Conversation remains
a grouped transcript with task/session duplication. Engineering validation of
the [previous design](../implemented/2026-09-10-unified-visual-runtime-workbench.md)
did not establish user comprehension.

The subsequent execution-graph prototype also failed product review because
it removed complete conversation history. The user confirmed the work-history
reader positioning and delegated staged delivery on 2026-09-13.
On 2026-09-16 the user also rejected the later inline-lane presentation as
unattractive. Exact relationship placement remains useful evidence, but the
reading composition needed revision. The user subsequently approved and the
source now implements a prose-first, local-collaboration-insert reader.
Live product and visual acceptance remain open.
On 2026-09-17 the user requested a reference-grounded visual/interaction redesign
and a written specification of both content selection and presentation. The
[product presentation contract](../../../docs/design/runtime-presentation-contract.md)
now owns those requirements; the
[visual direction](../../../docs/design/runtime-visual-direction.md) records
candidate tokens, reference sources and design-selection gates. These records
separate the implemented source direction from open product acceptance.
The user subsequently selected displayed visual option 3: continuous prose
with top navigation and an on-demand right-hand Tasks & collaboration panel.
The panel links real dispatches, exchanges and individual returns to their
source and complete child history. The sample task title is illustrative,
not a new product feature. This resolves the source direction; product-wide
and user visual acceptance remain open.

## Decision

Make complete recorded history the primary reading surface, with intermediate
execution collapsed rather than omitted. Runtime branches persist across
parent turns, and selecting a child opens its own readable history while
preserving parent position. The implemented reader uses continuous prose with
an on-demand Tasks & collaboration panel for recorded dispatches, exchanges,
returns and exact sources; ordinary main-agent turns do not construct that
panel. Surface material product choices for feedback while product-wide and
user visual acceptance remain open.

The panel now uses a compact canonical task map and selected-task excerpts.
`src/reader-preview.ts` and `src/routes/reader-preview.ts` serve the first owned
request and latest recorded final/otherwise latest reply from one normalized
session document on demand. Source links resolve exact text-part anchors;
absence remains explicit. The projection never reinterprets provider payloads
or loads a whole child family. Full child history remains a separate reading
action. Model/usage metadata moves into a native message disclosure. Library
title presentation preserves custom-title provenance and uses a short-ID
untitled label only when no readable provider title is available.
The [reading-model plan](../../../docs/design/runtime-reading-model.md) defines
the intended identity, evidence and acceptance boundaries.

Inline relationships use source-ordered part positions, not execution turn
IDs as message IDs. A real Codex case has 20 parent deliveries without native
message bodies; 11 occur between parts of grouped assistant messages. The
shared reading projection places recorded milestones in those gaps and joins
their canonical child identities through adjacent lanes. Exact-source detail
stays available at each milestone. The browser owns geometry only; see the
[inline relationship plan](../../../docs/design/runtime-inline-relations.md).

OpenCode's native messages contain several independently identified text,
reasoning and tool parts. Its protocol now preserves the real `messageId`,
optional exact `partId`, and recorded tool `callID` as `toolCallId`, rather than
overloading a message identity with a part identity. The optional part anchor
is validated at the shared event boundary and survives v2/v3 finalization;
both inline placement and exact-source navigation consume it. The selected
real OpenCode history had 13 events and two coordination observations but no
normalized readable anchors, so both observations were previously unplaced.

Inherited background is complete at the provider accessor and paginated by the
shared reader in 40-message pages through `/inherited-context?offset=`. The
existing inherited content scope resolves long fields beyond the first page;
neither paging nor continuation depends on a readable parent file. This follows
the observed 51-message fixture, whose last 11 records had no reading path.
Messages are normalized before slicing so source identities stay stable.
Inherited pages remain outside owned search, ToC and usage.

## Alternatives considered

Adding more labels, folds or node cards to the existing two views retains the
same message/category-centric reading model. An execution-only graph loses the
history the reader came to understand. A fresh backend protocol would
expand the change before the UI has shown a concrete missing consumer fact.

## Consequences

The existing provider/runtime substrate and its engineering checks remain
useful. Independently verifiable prerequisites repaired lost content during
implementation; the unified production reader follows the reading-model
check. Private real-case records stay in ignored local artifacts. Product-wide
and user visual acceptance remain a separate open gate.

## Verification

The [Reader validation checkpoint](../../../docs/design/runtime-reader-slice.md#current-validation-checkpoint)
records the current test, seven-provider API, live browser and Windows binary
results. Real desktop and narrow checks confirm child-history open, refresh,
close, exact source navigation and restoration of the selected canonical task
and trigger focus. Independent review corrections preserve separate run states
and prevent overlapping nested panels. Selected excerpts, folded metadata and
Library title presentation are implemented; complete history remains primary.
The product presentation contract owns the current acceptance work and open
user visual acceptance. On 2026-09-20 the user clarified that human reading,
progressive disclosure, complete collaboration, and asynchronous work are the
product outcome. The updated contract records that clarification, the desktop
scope, and P13/P14 for teams/background work; those presentation outcomes are
still pending, not implied by the earlier engineering checks.
