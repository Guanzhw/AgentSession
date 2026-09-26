---
status: implemented
date: 2026-09-26
decision: Use a provider-revisioned local content index for MCP search before a native worker
---

# Provider-revisioned MCP content index

## Context

The five-provider MCP scanned Codex transcripts again for each content query. On a frozen 3.4 GB corpus, the unchanged-process search took about 12 seconds. The Viewer already had a derived session metadata database, but it did not index user, assistant, or tool-name search text.

## Decision

Use a local SQLite content index keyed by canonical provider/session/message identity. Providers own revision evidence for each searchable session; Codex child revisions include parent source evidence when it can affect owned messages. Only provider-normalized user and assistant text and tool names enter the content index. The index is a sidecar beside AgentSession metadata, separate from provider source storage and viewer metadata writes. A trigram candidate narrows longer substring queries and the existing matcher verifies every hit; short terms retain a complete scan of the derived documents. OpenCode v1 supplies its existing newest-message match order, while duplicate Codex files resolve to the same canonical source as `getSession()`. Search cursors bind to durable metadata and search-index revisions. The [performance study](../../../docs/design/mcp-search-performance-study.md) records the measured result and remaining Rust gate.

## Alternatives considered

- Repeat provider transcript scans for each query: preserves current semantics but retains the measured multi-second query cost.
- Make FTS tokenization authoritative: faster for some terms, but its short-token and matching rules differ from the current case-insensitive whitespace-term AND substring contract.
- Move all parsing and search to Rust now: the experiment must first isolate remaining Node costs after duplicate scans and the derived index are addressed.

## Consequences

The index creates a local copy of searchable text and adds initial-build time and disk usage. Provider revision contracts and atomic replacement keep it current across edits, child-parent changes, and deletions. OpenCode uses a conservative whole-database/WAL revision: one write can reindex every OpenCode session, so active-database refresh cost still needs explicit measurement. The fresh Codex index took 16.755 seconds to build on the measured corpus; unchanged queries took tens of milliseconds. The 12.802-second median startup remains a separate bottleneck.

## Verification

Focused index tests exercise unchanged revisions, source replacement and deletion, short Chinese terms, literal wildcard characters, tool-name references, excluded tool payloads, duplicate canonical Codex IDs, and OpenCode match order. Five alternating A0/A1 MCP runs on the same frozen corpus returned identical ordered first-page hashes; a two-page query returned identical 34-result page-sequence hashes. The [performance study](../../../docs/design/mcp-search-performance-study.md) records each timing, index size, RSS, and the Rust adoption boundary. `npm test` passed 1071/1071; `npm run review`, real five-provider MCP checks, and browser E2E passed on the implementation branch.
