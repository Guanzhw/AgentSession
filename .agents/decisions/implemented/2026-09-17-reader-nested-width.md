---
status: implemented
date: 2026-09-17
decision: Keep nested history at one reading width with ancestor return navigation
---

## Context

A real three-level Codex history at 390px renders pane widths of 314.67,
301.33, and 270px. Inline card padding and transcript indentation accumulate.
The page-owner navigation contract already preserves each mounted history and
its search, disclosures, source anchors, focus, and return position.

## Decision

At the narrow reading breakpoint, remove accumulated horizontal indentation
from inline history and conversation threads. Keep child histories in their
recorded positions, with a separating rule and an ancestor path. Each ancestor
control closes its descendants through the existing reader navigation contract
and restores that ancestor's opener. The compact path appears at each child
history's entry. Use the selected Reader colors and typography.

## Alternatives considered

A fixed overlay or reparented mobile pane would introduce another scroll and
focus owner and separate history from the surrounding passage. A smaller card
padding would still accumulate with depth.
Sticky paths were tested on the real grandchild source anchor: they covered
the assistant heading at its restored source position. Keep paths in flow.

## Consequences

Root and nested prose share the same available width. The same DOM, canonical
source URLs, cache, and history entries serve desktop and narrow layouts.
Desktop retains inline framing; both layouts expose the ancestor path.
Copied locations contain no saved reading position. Returning from them
reveals the recorded opener instead of inventing a scroll position of zero.

## Verification

- Controller/location tests: 59/59, including ancestor return, Back/Forward,
  retained disclosure state, and copied-URL return without saved position.
- Real root/child/grandchild at 390px: all three panes now 314.67px; recorded
  opener returns below the topbar. Normal return restores identical scroll
  position and focused control. Back restores all panes with unique DOM IDs.
- Desktop framing, keyboard operation, and independent source review passed.
  Reader-only legacy ToC resize handles are hidden because contents now follow
  prose width; an obsolete handle caused a measured 5px desktop overflow.
- Final desktop document/client width is 1265px at a 1280px viewport, without
  horizontal overflow. The integrated suite passed 758/758; full live E2E and
  Windows binary smoke also passed.
