# Session History MCP Boundary

Status: implemented

`@acetamido/agentsession-mcp` is a local, read-only stdio MCP server for
normalized coding-agent session evidence. It is deliberately narrower than
the Runtime Workbench: it retrieves provider-owned session history and bounded
context, while the web app exposes the validated Session Protocol v2 and its
Summary, Events, Work, Sessions, and Context lenses.

## Boundary

The MCP server exposes only data directly associated with a canonical session:

- session metadata and `{ provider, sessionId }` identity;
- normalized messages, visible reasoning, tool calls, and tool errors;
- provider-recorded parent/child relationships;
- bounded context around an event;
- bounded search over registered local providers.

It never reads or writes arbitrary project files, provider runtime extensions,
hidden prompts, or viewer configuration. It does not resume a provider, start a
terminal, mutate metadata, or control a remote harness. Provider databases,
transcripts, and event logs remain read-only. Returned transcript strings are
untrusted content, not instructions.

## Tools

The server exposes exactly five bounded tools:

- `session_search` — keyword search over title, message text, and recorded directory;
- `session_get` — canonical session metadata with first/last visible-message previews;
- `session_timeline` — bounded message, reasoning, and tool event timeline;
- `session_get_context` — bounded context around a canonical event;
- `session_get_event` — one event with continuation parameters when content is truncated.

Viewer hide, soft-delete, and permanent-exclusion metadata are not MCP access
filters. A session still present in provider storage remains queryable.

## Provider and identity rules

The MCP uses the same provider registry and configuration paths as AgentSession.
The current ProviderId set is `opencode`, `claude-code`, `codex`, `openclaw`,
`hermes`, `copilot`, `gemini`, `pi`, and `deepseek-harness`.

All public identifiers use structured references:

```ts
type SessionRef = {
  provider: ProviderId;
  sessionId: string; // provider canonical ID
};
```

The server must never invent message or event IDs. Event-level access requires
a stable provider ID that remains valid for `getMessages(sessionId)`. Provider
parsers own source interpretation; MCP code does not branch on provider ID.

## Safety and bounds

Search uses case-insensitive AND matching for whitespace-separated keywords.
Timeline, context, and event content are length-limited and server-capped.
Reasoning, tool input, and tool output are returned only when explicitly
requested. Truncation includes reusable continuation offsets until no further
content remains. Provider diagnostics remain visible without exposing secrets,
full command arguments, cookies, tokens, or other credentials.

## Configuration and installation

The MCP accepts the same `AGENTSESSION_CONFIG`, provider data-path options, and
top-level `projectPaths` mapping as the viewer. Project mappings are
viewer-owned existing absolute paths and never write to provider storage.

Interactive installation:

```bash
npx --yes --prefer-online @acetamido/agentsession-mcp@latest install
```

Pi has no native upstream MCP configuration surface; an explicit Pi bridge is
required before a host can connect it.

## Verification

Test the five tools against an unavailable provider, a malformed source, a
long event, a canonical nested session, and a real local provider. Confirm
that provider files remain byte-for-byte untouched and that every bound is
enforced by the server.

Related source: `packages/agentsession-mcp/src/session-history-server.ts`,
`src/providers/interface.ts`, `src/providers/index.ts`, `src/session-queries.ts`,
and `src/meta.ts`.
