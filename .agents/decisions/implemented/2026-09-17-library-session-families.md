---
status: implemented
date: 2026-09-17
decision: Organize Library entries by recorded session families
---

## Context

The product contract requires expandable main/background session families.
Current Library queries exclude every indexed row with a parent ID. This
also hides orphaned sessions, and matching child titles cannot find their
work from the default Library. Provider metadata already records canonical
parent IDs; building the Library must not load full runtime protocols.

## Decision

Add a Library-only projection over session metadata. Resolve
visible same-provider parent relationships before filtering and paginate
families rather than individual members. Each matching member satisfies the
whole filter; unmatched ancestors remain only as navigation context. Missing
or viewer-hidden parents break the displayed tree without losing children.
Keep existing flat API/MCP query semantics unchanged.

Use the viewer index by default. Providers with cheap live metadata may expose
`getLibrarySessions()`; OpenCode reads only session table fields to preserve
its existing refresh behavior, including WAL updates, archives and deletions.
This request-local snapshot replaces that provider's indexed rows, including
when empty. It does not mutate the index or invoke scans for file providers.
Library does not calculate unused message/token/protocol summaries.

Render a familiar main entry with an expandable, connected branch outline.
Load up to 20 direct children at a time, preserving each canonical reader
link. Filtered outlines contain matching paths and identify contextual
ancestors. Preserve expansion, loaded pages and reading-return position in
the current tab. Full transcripts remain in the Reader.

## Alternatives considered

- Nest only the first flat page: splits families across pages and loses
  matches whose ancestors are elsewhere.
- Infer families from names, projects or times: invents relationships.
- Load each provider protocol: duplicates expensive transcript preparation
  for metadata navigation.
- Replace shared flat accessors: changes consumers that did not request a
  family view.

## Consequences

Library counts and pagination describe family entries and distinguish the
number of matching sessions. Child disclosures are bounded independently.
Provider scans must index actual canonical child metadata, including OpenCode.
No provider files, usage records or history content are changed.

## Verification

`npm test`: 820 passing; full E2E passed with no browser errors. Fixtures cover
identity, missing/hidden parents, filters, live WAL updates/archives, metadata-only
SQL and pagination. Seven installed providers passed live Library API/page checks.
Real Codex three-level browsing, child search, 20/40 child paging, 60 root entries
restored after reading, focus/position recovery, desktop/390px and light/dark
checks passed. DSH request failure/retry passed. See
[presentation evidence](../../../docs/design/library-session-families.md).
Minimum-version CI exposed a SQLite statement finalized between async scan
yields on Node 22.15.0. The scan now materializes its metadata query before
yielding, matching the indexer's full-batch consumption. An explicit-GC regression
reproduces the old failure and verifies the fix on the minimum runtime.
