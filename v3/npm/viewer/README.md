# AgentSession Viewer

AgentSession reads local conversations from OpenCode, Claude Code, Codex CLI,
Pi, and DeepSeek Harness through one native Rust runtime.

```bash
npm install -g @acetamido/agentsession@next
agentsession --help
agentsession --port 3457
```

Open `http://127.0.0.1:3457/sessions` to revisit conversations. Provider records
are read-only; Viewer metadata and derived state have their own storage.
Node.js 22.15 or newer is required for the command launcher. Native payloads
support Windows x64, Linux x64/arm64, and macOS arm64.

See [AgentSession](https://github.com/Guanzhw/AgentSession) for source paths,
configuration, MCP setup, and prerelease acceptance status.
