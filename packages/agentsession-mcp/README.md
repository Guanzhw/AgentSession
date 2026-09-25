# AgentSession-MCP

AgentSession-MCP is a local, read-only stdio MCP server for AI coding-session
history. It queries the providers configured for AgentSession without starting
a web server or modifying provider-owned data.

AgentSession 2.0 supports OpenCode, Claude Code, Codex CLI, Pi, and DeepSeek
Harness histories. OpenClaw and Hermes Agent were supported by v1.10.1 and are
retired from both the 2.0 Viewer and MCP.

## Install into coding agents

Run the interactive installer directly from npm:

```bash
npx --yes --prefer-online @acetamido/agentsession-mcp@latest install
```

It detects and configures the user-level MCP settings for Codex, Claude Code,
and OpenCode. The generated launcher uses
`npx --prefer-online @acetamido/agentsession-mcp@latest`, which checks for a
new published package whenever the host starts. Existing `agentsession` entries
are never overwritten by `install`, and `update` refreshes only installer-managed
entries. Migrate a manual or legacy entry deliberately with:

```bash
npx --yes --prefer-online @acetamido/agentsession-mcp@latest update --target all --replace --yes
```

Use `--target codex,claude-code,opencode` to select hosts, and use
`--config /path/to/config.json` to pass the AgentSession config via
`AGENTSESSION_CONFIG`. Pi has no native upstream MCP configuration surface, so
it needs an extension-provided bridge and is not an installer target.

## Manual server installation

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

It supports both initialization-based MCP clients and stateless `2026-07-28`
clients over stdio; the five-tool, read-only contract is identical in both
protocol eras.

Version 1.8 added OpenClaw and Hermes while keeping the five-tool contract
unchanged. That support was present in the last published v1 release, 1.10.1.
AgentSession 2.0 supports the five providers listed above and does not accept
OpenClaw/Hermes provider references.

### Version behavior and retired provider references

The installer currently writes `@acetamido/agentsession-mcp@latest` into host
configuration. `npx` resolves that tag when the MCP process starts, so an
an existing entry will resolve to the current release after the 2.0 package is
published. Calls that request OpenClaw or Hermes sessions then become
incompatible: 2.0 has no provider registration or compatibility adapter for
those references. Remove retired provider IDs from MCP calls and host-side
workflows when moving to the 2.0 provider set.

Provider local storage is authoritative: every session still present in a
configured provider's local store is exposed by this server. Viewer-only
metadata such as stars, custom titles, or hidden/soft-deleted/permanently
excluded markers is never an access filter here; it affects only AgentSession
Viewer lists.

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
`session_timeline` omits blank message segments; tool and requested thinking
segments remain separate events.
