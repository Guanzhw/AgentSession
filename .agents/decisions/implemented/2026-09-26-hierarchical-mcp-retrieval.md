---
status: implemented
date: 2026-09-26
decision: Add provider, project, session, and event-level navigation to AgentSession MCP
---

# Hierarchical MCP retrieval

## Context

The five-tool MCP can find a keyword across local histories and inspect a
known session, but it cannot browse the provider/project/session hierarchy or
ask separately for titles, user messages, and assistant messages. A search
result collapses each session to one hit, so tool-call types and message roles
are not useful discovery labels. A 3.35 GB Codex corpus also makes a full
message scan take roughly 13–15 seconds; metadata-only requests should avoid
that scan.

## Decision

Add `session_browse` for provider, project, and session levels using the
derived metadata index, with canonical references and provider-source
validation on returned session rows. Project counts are explicitly indexed
candidate counts. Keep the existing `session_search` default behavior and
add optional title/directory/user/assistant fields plus root/child scope;
metadata-only requests skip transcript search. Add a full-content query to
the existing per-session `session_timeline`, whose role, segment, tool-name,
and status filters already locate typed events. Add bounded role and tool-name
facets to `session_get`. Exact content stays behind `session_get_event`.

The MCP continues to ignore Viewer-only visibility and custom-title metadata.
Thinking requires its explicit segment, and raw tool input/output remains
behind existing opt-in flags. Provider-specific raw metadata is not treated
as a shared search schema. This change extends the earlier
[child-lineage decision](../implemented/2026-09-26-paged-mcp-child-lineage.md):
one extra tool now has a separate provider/project/session discovery job.

## Alternatives considered

- Keep only five tools and add more options to `session_search`: this still
  requires a keyword before an agent can discover available projects and
  sessions.
- Add one tool for every metadata or message tag: the overlap makes tool
  selection harder while existing timeline filters already cover per-session
  events.
- Search all raw provider metadata and tool payloads by default: their schemas
  and sensitivity vary, and this would weaken the explicit evidence boundary.

## Consequences

Existing MCP calls remain valid. The new browse tool adds an index-backed path
for finding sessions without parsing every transcript, while explicitly
scoped message searches still have the existing full-scan cost. A persistent,
incremental content index remains a separate performance change. Indexed
project counts may include rows no longer present in provider storage;
returned session rows are checked before exposure and cursors advance over
raw index positions so stale rows cannot hide later sessions. Browse cursors
also include the metadata DB revision, invalidating a continuation after a
concurrent update rather than silently duplicating or skipping rows.

## Verification

`npm run review` passed governance and typechecking. The focused MCP service,
SQL, and protocol tests passed (30/30), and `npm test` passed all 1,065 tests.
A compiled stdio MCP client exercised
both the legacy and `2026-07-28` protocols against all five available real
providers, browsing provider/project/session levels and opening one session
and query-filtered timeline per provider. Title-only search found a real
OpenCode session. The cold connection/index refresh took 34.9 and 25.7 seconds;
most tool calls took 1–7 ms, while one 25-row OpenCode browse took 26.5 seconds
before a 2 ms repeat. No provider source or normal Viewer process was changed.
Locally packed and installed 2.0.0 Viewer/MCP tarballs also served exactly six
tools through a real legacy stdio client and returned all five available
providers from `session_browse`; the packed smoke took 28.57 seconds including
index refresh. Neither package was published.
