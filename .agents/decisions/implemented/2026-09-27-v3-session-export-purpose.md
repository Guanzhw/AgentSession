---
status: implemented
date: 2026-09-27
decision: Remove the dedicated 3.0 session download when it has no distinct user workflow; retain statistics export and complete Reader/MCP access.
---

# Purpose of 3.0 session export

## Context

The user first selected a versioned event document and explicit 410 migration
from the old export URL. That choice was implemented in the
[earlier decision](../implemented/2026-09-27-v3-versioned-session-export.md). On examining what
the download is for, the user said sharing sessions is unnecessary, provider
sessions are already local, saving the current reading might suffice, and the
feature might not be needed. The repository has Reader download links and
tests, but no identified import path or consumer of the downloaded document.

## Decision

The recommended 3.0 scope is to remove the dedicated session JSON/Markdown
download and its UI entry. Reader and MCP continue to read complete source
content with canonical references; statistics JSON/CSV export remains. The old
2.0 session-export URL returns an explicit removal response rather than a
replacement URL. The fixed 2.0 baseline keeps its historic export for direct
comparison. This reverses the earlier decision on a product-purpose basis,
not because the event document failed its current tests. The user asked what
such a file would be used for. The plausible workflows are transport to a
consumer without the original provider, a reproducible parser bug report,
and an archive before source cleanup. None has been selected as a 3.0 user
workflow; the removal remains the main agent's recommendation under the agreed
3.0 decision rule, subject to a later concrete use case.

## Alternatives considered

Keep a normalized archive for future provider cleanup, ad hoc scripts, or
notes; these are conceivable uses but no current user workflow needs them.
Offer a smaller "save current reading" action; that still needs a concrete
scope for loaded pages, child sessions, and hidden details. Neither should be
designed from an assumed sharing or backup requirement.

## Consequences

The 3.0 UI/API will no longer generate a session file. The complete session
remains readable through Reader and bounded machine interfaces; this does not
erase provider-owned files or Viewer metadata. Old provider metadata, usage,
and relationships must still be evaluated against their actual Reader,
Runtime, and MCP uses, rather than kept solely to reproduce an export shape.
HTTP acceptance must test removal diagnostics and statistics export, while
source completeness belongs to Reader/MCP acceptance.

## Verification

The new HTTP expectation first failed against the versioned-export binary
(old URL returned `legacy_export_removed`). On debug binary SHA-256
`0e549627e9f42c459df62913744678d164d27937d8113558ad3f746ea696a520`,
the focused HTTP/statistics suite passed 5 with 2 optional private skips,
and the real DSH browser suite passed 6/6. The old URL returns 410 without a
replacement, the versioned download URL returns 404, the Reader has no
download action, and statistics JSON/CSV still return 200. Rust workspace
tests passed core 105 with 12 gated ignores and app 2. The controlled full
Node suite passed 252/268 with 16 optional skips and no failures; the Svelte
build compiled 131 modules. The Windows release candidate SHA-256
`85a92b9010ce2c88d2d6a8dc6da125057fa77661be8bf40d9bc7c464516907fb`
then returned 410 `session_export_removed` at the old URL, 404 at the removed
versioned URL, and 200 for statistics JSON in a live side-by-side run. The
portable Web/MCP test passed 3/3; its full controlled Node suite passed 252/268,
with 16 opt-in skips and no failures. Frozen five-provider Reader first pages
loaded beside the fixed 2.0 baseline with eight source hashes unchanged.
Complete five-provider Reader/MCP acceptance remains a separate gate.
