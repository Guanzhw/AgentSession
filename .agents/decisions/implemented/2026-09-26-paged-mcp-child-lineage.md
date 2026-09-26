---
status: implemented
date: 2026-09-26
decision: Page MCP direct-child summaries instead of silently truncating them
---

# Paged MCP child lineage

## Context

`session_get` returned at most 50 direct child sessions with no truncation
signal. A real Codex parent had 172 recorded direct children, so 122 were
invisible in the MCP overview even though the index retained them.

## Decision

Keep the five-tool MCP boundary and page `session_get` children separately from
its first/last message previews. `childLimit` defaults to 50 and is capped at
100. `childrenTruncated` and `childrenNextCursor` state whether another indexed
candidate page exists; callers pass that cursor as `childCursor`. The cursor is
tied to the canonical parent reference. Each returned candidate is checked
against the provider's current session ID and parent relation before its
summary is exposed. Missing or reparented index rows are skipped without
deleting them. The index queries one extra row to determine whether a
continuation is needed without loading the entire child list.

## Alternatives considered

- Increase the fixed limit: another large parent would still be cut off.
- Return every child in one call: unbounded MCP results violate the local
  history tool's bounded-output contract.
- Add a sixth MCP tool: unnecessary for direct children already owned by
  `session_get`.

## Consequences

Existing clients still receive up to 50 summaries by default, but can now
traverse all indexed candidates. Child pages remain bounded to at most 100
provider lookups. A stale-only page can contain no children yet carry a
continuation cursor; clients should follow it until it is null. As with the
existing timeline cursor, updates to the underlying index during traversal can
shift an offset-based page; the cursor does not claim a frozen snapshot.

## Verification

`test/mcp.test.mjs` traverses 172 indexed children through real MCP tool calls
in pages of 50, 50, 50, and 22, checks cursor/limit bounds, and verifies that
missing, reparented, and mismatched-ID candidates do not appear while later
live children remain reachable. The newly packed and installed 2.0 MCP is also
exercised against the real 172-child Codex parent and recorded OpenCode and
DeepSeek Harness pairs. A single matched old/new 172-child comparison found no
meaningful aggregate page-time difference; see the
[2.0 delivery evidence](../../../docs/design/agentsession-v2-provider-scope.md).
