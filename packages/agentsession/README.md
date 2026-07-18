# AgentSession

AgentSession is a local-first, read-only viewer and manager for AI coding
sessions from OpenCode, Claude Code, Codex CLI, and Gemini CLI.

```bash
npm install --global @acetamido/agentsession
agentsession
```

It opens a loopback-only web UI at `http://localhost:3456`. Provider-owned
databases and transcript files remain read-only; viewer metadata is stored
separately.

Version 1.5 adds unified cross-provider Sessions and Usage explorers,
provider-filtered token trends, Codex session analysis, and stable
session-detail tab transitions.

For coding-agent access to the same local history, install
[`@acetamido/agentsession-mcp`](https://www.npmjs.com/package/@acetamido/agentsession-mcp).
