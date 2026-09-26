---
status: implemented
date: 2026-09-26
decision: Keep MCP and Viewer search separate while making both complete across the five supported providers
---

# Complete search boundaries for AgentSession 2.0

## Context

The old MCP search asked each provider for only the first 100 title and
message matches. Viewer provider content search stopped at 500 message
matches. A cursor or load-more button over those truncated candidate sets
could silently omit later sessions. Repeated offset searches of file-backed
providers also reread the same transcript prefix. The Viewer Library search
and MCP history tools serve different users and have different metadata rules.

## Decision

MCP `session_search` traverses all selected provider matches, retains only the
bounded top candidates in its ranking order, and uses an opaque keyset cursor.
File-backed adapters may expose `iterateSearchMessages(query)` to yield a
normalized `{ session, match }` stream in one scan; SQLite adapters retain
their bounded offset search. Thinking is excluded from default previews and
requires an explicit read option.

Viewer Library search remains a session/family metadata search. Its separate
content search pages through all visible message matches, provides a bounded
excerpt and canonical message anchor, and returns to the matching card. The
global `/sessions/search` route searches message content across selected
providers; it does not treat an OpenCode title-only hit as a message hit.
OpenCode child messages participate, while archived sessions and Viewer-
excluded sessions remain outside Viewer results. The Viewer search page offset
has an explicit HTTP bound so malformed or extreme values cannot trigger an
unbounded scan.

## Alternatives considered

- Keep fixed candidate ceilings: fast initially, but later matches remain
  silently inaccessible.
- Reuse MCP results for the Viewer: loses Viewer-specific exclusion and
  navigation semantics.
- Replace current substring matching with ordinary full-text tokenization:
  changes existing Chinese, punctuation, and substring behavior without a
  demonstrated no-miss candidate strategy.
- Rewrite search in Rust first: retains repeated-scan behavior unless the
  data flow changes and adds cross-platform packaging work before profiling.

## Consequences

Search can still be expensive on a cold file-backed provider. The optional
streaming capability has two consumers, Viewer and MCP, and stays owned by the
adapter that understands its source records. The global Viewer content route
and its API are distinct from existing Library filters. Search results carry
their provider/session identity and message source; no child history is merged
into a parent by the search layer.

## Verification

`test/mcp.test.mjs` covers more than 100 qualifying candidates, late unique
matches, cursor identity, and thinking opt-in. `test/content-search.test.mjs`
covers 601 message hits, duplicate hits, OpenCode child/archived visibility,
return links, and bounded multi-term excerpts. The shared snippet helper now
shows feasible AND terms in source order, including a long exact phrase,
without changing the canonical message reference. Local 2.0 packages were
installed and called through the real MCP protocol and Viewer API. MCP
search/get/timeline/context worked across all five providers and returned six
distinct Codex sessions over two cursor pages; a real multi-term Codex query
returned five source-referenced excerpts, all within 160 characters and
showing both terms. Browser content-search results opened source anchors on all
five providers; OpenCode/Codex results, including child histories, returned to
their result cards. The full browser E2E passed on the normal-mode isolated
v2 server. See the [2.0 delivery evidence](../../../docs/design/agentsession-v2-provider-scope.md)
for sample limits and timing.

The decision is implemented in this branch. Version 2.0.0 remains unpublished
and the user's normal port-3456 service still runs the prior build.
