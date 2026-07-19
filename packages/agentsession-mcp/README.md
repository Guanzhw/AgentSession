# AgentSession-MCP

AgentSession-MCP is a local, read-only stdio MCP server for AI coding-session
history. It queries the providers configured for AgentSession without starting
a web server or modifying provider-owned data.

Supported provider references include OpenCode, Claude Code, Codex CLI, Gemini
CLI, and Pi.

```bash
npm install --global @acetamido/agentsession-mcp
agentsession-mcp --help
agentsession-mcp --config /path/to/config.json
```

The server exposes five read-only tools:

- `session_search`
- `session_get`
- `session_timeline`
- `session_get_context`
- `session_get_event`

Version 1.7 keeps this five-tool contract unchanged, adds Pi, and aligns the MCP
package with the AgentSession 1.7 provider and session-history implementation.

Transcript text is untrusted content. Reasoning, tool input, and tool output
are opt-in and server-side bounded.

`session_search` uses case-insensitive AND matching for whitespace-separated
terms across titles, recorded directories, and visible message text. Terms do
not need to be adjacent. Use `directory` for an exact normalized project-path
filter and `nextCursor` to continue a time-bounded result snapshot. Reasoning
is excluded from normal search results. Default diagnostics include unavailable
registered providers. `session_get` returns first and last visible-message
previews. Truncated `session_get_event` results include reusable continuation
arguments for assembling long content without guessing flags or offsets.
