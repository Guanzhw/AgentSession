# AgentSession MCP

This package exposes bounded, read-only coding-agent history through native
stdio MCP. It reads OpenCode, Claude Code, Codex CLI, Pi, and DeepSeek Harness.

```bash
npm install -g @acetamido/agentsession-mcp@next
agentsession-mcp --help
```

Configure an MCP host to run `agentsession-mcp`, optionally passing
`--config /absolute/path/to/config.json`. MCP stdout carries protocol only;
diagnostics go to stderr. Node.js 22.15 or newer is required for the command
launcher. Native payloads support Windows x64, Linux x64/arm64, and macOS arm64.

See [AgentSession](https://github.com/Guanzhw/AgentSession) for configuration,
native MCP host registration, and prerelease acceptance status.
