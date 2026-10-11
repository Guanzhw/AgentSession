# Reader journey repair design

## Ownership

Core owns normalized search targets and Library metadata filtering. Svelte owns
navigation history, presentation and selection state. Source configuration
guidance describes the existing public CLI/config contract without changing
provider sources or adding hot path mutation.

## Search navigation

Extend the existing search-to-Reader contract with a bounded normalized target
for message-content hits. Reuse Reader's established reveal/highlight path and
content units; do not load whole long messages in the browser or search the DOM
for text that has not been loaded. Keep title/directory navigation valid.
Use one target URL builder for Library links and App navigation so modified
clicks preserve the same semantics. Preserve the current Library history state.
The target uses original normalized UTF-16 positions and the SHA-256 body
revision checked by content retrieval. See the
[implemented decision](../../../.agents/decisions/implemented/2026-10-11-reader-journey-navigation.md).
Dynamic location errors use an error presentation boundary: translate known
messages while retaining unknown diagnostics. Static UI translation keys keep
their existing strict contract.

## Library and source guidance

Carry `starredOnly` through Library filters, history and existing family API
requests. Show the actual row's star state. Keep matching parents/children under
the existing core family contract rather than filtering loaded rows in JS.

Represent Trash read errors alongside successful rows, but derive confirmed
empty/count presentation only from a complete successful load. Retry reuses the
owning refresh operation. Deletion invalidates the current read generation, so
an older in-flight empty result cannot overwrite the new unknown count.
Keep the failed-source count as a fact and translate its summary reactively, so
changing language updates an already-visible error without another read.

Link source diagnostics to provider-specific Settings anchors. Put source
guidance where the link lands, show the actual current path and the public
config key/CLI flag, and explain restart plus CLI/environment/config precedence.
Keep instructions scoped to the selected source and retain useful diagnostics.
Anchor scrolling leaves space for the sticky top bar and the focused article's
outline; English and Chinese destination headings remain visible.

## Technical-details history

Save a concrete Runtime navigation snapshot before leaving for a source event:
lens, applied filters, current cursor/page identity and scroll context. Restore
through the existing Reader history boundary; retain revision validation and
explicit stale/invalid cursor handling. Preserve Sessions-related navigation.
Choose a small typed state contract rather than a general navigation framework.

## Orchestration

The orchestrator owns this spec, shared App integration, final documentation,
integrated validation and final judgment. Search, Runtime and Library/Settings
workers have disjoint file ownership; shared-file changes are integrated by the
orchestrator after worker handoff. An independent reviewer uses the final source
and checks rather than relying on worker conclusions. No worker commits,
publishes, changes the pre-existing service or mutates provider-owned data.
