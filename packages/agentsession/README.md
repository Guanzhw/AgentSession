# AgentSession

AgentSession is a local-first, read-only harness runtime inspector for
OpenCode, Claude Code, Codex CLI, OpenClaw, Hermes Agent, Pi, and DeepSeek
Harness.

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

See the [repository README](../../README.en.md) and [provider contribution
guide](../../docs/CONTRIBUTING-PROVIDER.md) for installation, configuration,
provider coverage, and DSH rc.8 compatibility details.
