---
status: implemented
date: 2026-09-22
decision: Add member-side rails to the continuous Reader using normalized identities and exact message pairing.
---

## Context

The user approved the real-history side-rail prototype after clarifying that prose itself is the main Agent line.
Separate text strips did not make creation, peer communication and asynchronous returns clear enough.

## Decision

Resolve directional endpoints and exact send/receipt pairing on the server from Session Protocol actors,
session references and correlation IDs. Keep the existing complete Reader content and source anchors.
The browser only lays out colored member rails beside the document, with no main-Agent column.
Bound visible lanes and edges around the current reading region; all recorded members remain selectable.

## Alternatives considered

Retaining only previous/next text strips preserves navigation but does not meet the approved visual direction.
A permanent lane per member consumes unbounded width. Browser inference from task labels loses identity and meaning.

## Consequences

Missing endpoints retain their ordinary readable records. Unknown delivery is not drawn as confirmed receipt.
Idle and single-turn completion do not terminate member rails. Nested/lazy history uses existing pane-owned anchors.

The follow-up `2026-09-23-reader-continuity-and-navigation` decision changes the visual extent to the last
recorded interaction and stabilizes lane slots and card geometry. Recorded Agent status is unchanged.

## Verification

`npm test`: 1,033/1,033; `npm run review` and `git diff --check` passed.
Desktop `qa:e2e` passed with a 60-second action timeout after full-library Usage exceeded the default wait.
Real DSH creation, peer delivery, root receipt, original text, keyboard and child return were checked in dark/light.
Real Codex nine-member cross-turn history retained standalone result arrows and original results.
The synthetic 60-member fixture verified all-member selection, four visible lanes and a 20,000-pixel paired edge.
Detailed scope and release status are kept in `docs/design/runtime-acceptance-evidence.md`.
