# AgentSession

AgentSession is a local-first, read-only viewer and manager for AI coding
sessions from OpenCode, Claude Code, Codex CLI, Gemini CLI, and Pi.

```bash
npm install --global @acetamido/agentsession
agentsession
```

It opens a loopback-only web UI at `http://localhost:3456`. Provider-owned
databases and transcript files remain read-only; viewer metadata is stored
separately.

Version 1.7 adds Pi JSONL sessions with active-branch, fork, reasoning,
tool-call, Token Explorer, Flow, runtime-extension, resume, and MCP support.
Standalone cross-platform binaries and unified Sessions and Usage explorers
remain available.

For coding-agent access to the same local history, install
[`@acetamido/agentsession-mcp`](https://www.npmjs.com/package/@acetamido/agentsession-mcp).
