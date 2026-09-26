# AgentSession

AgentSession 2.0 is a local-first, read-only harness runtime inspector for
OpenCode, Claude Code, Codex CLI, Pi, and DeepSeek Harness. OpenClaw and Hermes
Agent were last included in published v1.10.1 and are fully removed from the
2.0 Viewer and MCP. Old provider URLs are incompatible with 2.0.

It reads provider-owned session data and exposes the Runtime Workbench:
`Overview | Conversation | Runtime | Raw`, with Summary, Events, Work,
Sessions, and Context lenses. Conversation is a compatibility projection;
Runtime is the structured view of harness state, session derivation, scheduled
work, and context lifecycle.

Every readable session exposes validated Session Protocol v2 with canonical
`{ provider, sessionId }` references, dense source-order events, typed session
relationships, separate Task/AgentRun entities, metadata-first context
artifacts, capability descriptors, and recorded/derived provenance.

```bash
npm install --global @acetamido/agentsession
agentsession
```

The server binds to `http://127.0.0.1:3456` and never writes provider-owned
databases, transcripts, or event logs. Only viewer metadata is writable.

Current read-only APIs:

```text
GET /api/:provider/session/:id/protocol
GET /api/:provider/session/:id/runtime/summary
GET /api/:provider/session/:id/runtime/events
GET /api/:provider/session/:id/runtime/graph
```

Requires Node.js `>= 22.15.0`. Project-directory mappings use top-level
`projectPaths`; terminal launching is limited to structured provider resume
commands and can be disabled with `--disable-terminal-launch`.

See the [repository README](../../README.en.md), [provider contribution
guide](../../docs/CONTRIBUTING-PROVIDER.md), and [2.0 provider scope and
migration plan](../../docs/design/agentsession-v2-provider-scope.md) for
installation, configuration, provider coverage, and migration details.
