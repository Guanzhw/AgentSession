# Inline runtime relationships

Status: source-binding implementation in progress; its initial visual presentation
was rejected on 2026-09-16. The user has approved implementing the subsequent
prose-first/local-insert direction for a working first version. Revised
presentation and real-history acceptance are pending.
Extends the [work-history reader](runtime-reading-model.md), not a separate page.
The [product presentation specification](runtime-presentation-contract.md)
supersedes this prototype's visual layout choices; source binding and exact
relationship semantics below remain applicable.

## Reading outcome

Readers should see an asynchronous task leave the main history at its recorded
dispatch, continue alongside later work, and reconnect at recorded result
deliveries. Repeated follow-ups and returns remain on the same canonical child
track, with separate executions distinguished where recorded. The primary
surface keeps complete conversation content; the side overview is navigation.

The vertical axis is reading position, not elapsed time. Recorded clocks and
durations belong on event labels. Expanding tools, reasoning or long content
changes layout but preserves the relationship endpoints.

## Source boundary

The server resolves normalized observation/event identities into native text or
tool-part targets, or an insertion position between source-ordered parts for a
recorded event without native text. It must not use an execution turn ID as a
message ID, channel-array position as chronology, or time proximity as proof
of causality. Several observations can fall inside one grouped assistant turn;
message-only placement is insufficient.

A return without a readable parent-owned body is its own recorded milestone
with exact evidence access. A child-local final reply can be read through its
own source; it is not substituted for an opaque parent delivery. A child-local
completion is not placed on the parent's reading axis without a parent anchor.
Unknown associations remain individually accessible rather than gaining a
speculative connecting line.

## Presentation

The following describes the implemented relationship mechanics, not an accepted
visual treatment. The next candidate groups routine execution and introduces
local collaboration inserts within a prose-first reader. Its illustrative
interaction sketch does not replace real-history acceptance. Keep exact source
anchors reusable while evaluating that composition.

- Keep dispatch, follow-up and delivery milestones visible when surrounding
  tools/reasoning are folded. Complete execution detail remains expandable.
- Draw adjacent lanes joining real DOM anchors. The browser lays out supplied
  relationships and does not infer provider semantics.
- Selecting a lane or milestone emphasizes the associated records, supports
  exact source reading and a single-action return to the prior reading place.
- Dense views emphasize a selected branch while preserving other entry points.
  Narrow layouts keep prose readable and offer local connections/expansion.
- Recompute geometry after disclosure, content continuation, resize and pane
  changes, coalescing layout work rather than polling or rescanning on scroll.

## Acceptance

Use a real case with a dispatch, two follow-ups, multiple deliveries and a
concurrent reviewer. Verify source order and exact endpoints inside grouped
assistant messages; preserve multiple returns without inventing one-to-one
follow-up/completion pairs. Exercise folding, long-content continuation,
same-pane and child navigation, Back/Forward, narrow screens and both themes.
Complete readable history and its relationships must work together.

The local interactive sketch uses explicitly illustrative content. It tests
the spatial reading idea, not source binding or production readiness.

## Implementation boundary

`src/reader-relations.ts` joins full finalized coordination to the owned
document and resolves source-order part positions. `src/views/reader-relations.ts`
renders those milestones; the normal tree and raw-message renderers insert
them beside the matching parts. Milestones keep their surrounding message
outside the outer intermediate-message fold, while tool and reasoning
disclosures remain independently collapsed. No source body is removed.

`src/static/app/reader-relations.js` draws DOM-anchored branch lines and retains
the selected task in the cached reader pane. Up to six tracks can be shown
together; dense and narrow layouts follow one selectable task while keeping
all other milestones and full prose accessible. The vertical axis remains
reading position. Repeated results share a track without fabricated pairing.

The prior turn-ID-to-message-ID reference rows are being retired: execution
identity does not establish a text position. Exact scalar source evidence
opens beside its milestone, and the reader navigation owns Back/Forward.
