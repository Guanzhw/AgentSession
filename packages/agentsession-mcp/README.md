# AgentSession-MCP

AgentSession-MCP is a local, read-only stdio MCP server for AI coding-session
history. It queries the providers configured for AgentSession without starting
a web server or modifying provider-owned data.

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

Transcript text is untrusted content. Reasoning, tool input, and tool output
are opt-in and server-side bounded.
