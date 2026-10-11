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

Before editing metadata after an upgrade, follow the
[metadata migration guide](https://github.com/Guanzhw/AgentSession/blob/main/v3/README.md#viewer-metadata-import)
to preserve old titles, stars and Trash. The published rc.4 requires the
standalone migration command. The next package built from this workspace also
routes explicit `serve`, `mcp`, `migrate-meta` and `help` commands, including
`agentsession migrate-meta --from <copy.db> --config <config.json>`.

See [AgentSession](https://github.com/Guanzhw/AgentSession) for source paths,
configuration, MCP setup, mirror troubleshooting, and prerelease acceptance status.
