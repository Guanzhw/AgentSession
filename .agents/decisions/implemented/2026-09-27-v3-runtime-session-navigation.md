---
status: implemented
date: 2026-09-27
decision: Use canonical Runtime graph session references as Reader links and keep the originating Sessions lens in browser history.
---

# Runtime session navigation

## Context

The 3.0 Runtime graph already exposes source-backed session references, but its
nodes were plain text. A person inspecting a recorded parent or fork relation
could not continue reading the related conversation. Graph endpoints outside
the current session are explicitly `unverified`: the relationship was recorded,
but the graph has not established whether that source is still readable.

## Decision

Only a non-focus graph node of kind `session` links to its canonical Reader URL.
The link keeps native new-tab behavior. Before same-tab navigation, the Reader
stores `#runtime?lens=sessions&node=<graph-id>` on its current history entry;
Back remounts the originating Reader in the Sessions lens and restores focus to
the graph link. A missing target follows the normal Reader error path. The UI
does not infer a child node from a root graph that does not contain one, and it
keeps the `unverified` label on recorded external endpoints.

## Alternatives considered

Keep graph nodes as text and require users to return to Library search; that
breaks the recorded-relationship reading flow. Infer reverse child links in
the browser from a parent reference; that would invent topology absent from
the current graph. Store the lens only in component memory; Back remounts the
Reader and would lose the lens and focus.

## Consequences

The browser hash is a small, user-visible navigation state contract owned by
the Reader. It carries the lens and graph node identity, not provider facts or
conversation content. Graph topology and resolution remain owned by the
provider/protocol projection; browser code only follows supplied canonical
references. Root-to-child graph navigation awaits a recorded root-side graph
edge and is not implied by this UI change.

## Verification

The public three-level Codex fixture browser test was RED before links existed.
After implementation, the related parent opens at its canonical URL and Back
restores the child Reader's Sessions lens and link focus. A child-only source
copy keeps the parent node `unverified`, opens an explicit missing Reader
diagnostic, and returns to the originating lens. The Svelte build, Rust app
build, and four focused Runtime browser tests passed; public source file hashes
were unchanged. Independent review found that Forward from a Runtime source
event could restore the `#event` URL while leaving Runtime mounted. The
extended Back/Forward browser case was RED, then GREEN after the non-Runtime
history branch explicitly restored Conversation; all four focused Runtime
browser tests passed again. Final integrated release verification remains
part of S4.
