---
status: proposed
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

Before moving this record to `implemented/`, verify more than 100 MCP matches,
more than 500 Viewer message matches, a late unique match, duplicate messages,
OpenCode child and archived boundaries, cross-provider paging, default and
opted-in thinking access, and exact browser source/back navigation. Recheck
real provider data, MCP calls, long-session browser behavior, and cold/warm
latency. Source and test anchors are `src/session-history.ts`,
`src/session-queries.ts`, `src/routes/sessions.ts`,
`src/providers/shared/file-adapter-helpers.ts`, `test/mcp.test.mjs`, and
`test/content-search.test.mjs`.
