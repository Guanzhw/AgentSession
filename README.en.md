# OpenSessionViewer

> A local AI session archive for developers: one searchable, traceable, reviewable web UI for OpenCode, CodeAgent, Claude Code, Codex CLI, and Gemini CLI sessions.

[English](./README.en.md) · [中文](./README.md)

![Node.js >= 22.5.0](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen?style=flat-square&logo=node.js)
![Zero Runtime Dependencies](https://img.shields.io/badge/runtime_deps-0-blue?style=flat-square)
![MIT License](https://img.shields.io/badge/license-MIT-purple?style=flat-square)
![v1.2.0](https://img.shields.io/badge/v1.2.0-orange?style=flat-square)

## Attribution

OpenSessionViewer is based on [OpenSession](https://github.com/HeavyBunny19C/OpenSession). It keeps the original local, multi-provider AI session viewer direction, moves the codebase to TypeScript, and extends the roadmap toward richer nested-session, tool-flow, and context visualization.

## What It Is

OpenSessionViewer is a local-first viewer for AI coding sessions. It reads session data already stored on your machine and presents a unified dashboard, search, detail pages, statistics, exports, and trace views. It does not modify the original provider databases.

The focus is no longer just “list my chats.” The goal is to help you reconstruct what happened during an AI-assisted engineering workflow:

- which user prompt started the session
- what each assistant step did
- which tools, MCP servers, skills, LSP calls, or subagents were invoked
- how task/subtask branches fit back into the main conversation
- how token usage, cost, runtime, and model distribution changed
- which sessions are worth starring, renaming, deleting, or exporting

## Supported Providers

| Provider | Status | Default Source | Capabilities |
|:---|:---:|:---|:---|
| OpenCode | Full | `$XDG_DATA_HOME/opencode/opencode.db` or `~/.local/share/opencode/opencode.db` | Browse, search, star, rename, delete, trash, export, stats, trace, nested sessions |
| CodeAgent | Full | `$XDG_DATA_HOME/opencode/db/ngagent.db` or `~/.local/share/opencode/db/ngagent.db` | OpenCode fork with the same viewer capabilities |
| Claude Code | Read-only | `~/.claude/transcripts/` + `~/.claude/projects/` | Browse, search, token stats |
| Codex CLI | Read-only | `~/.codex/sessions/**/*.jsonl` | Browse, search, token stats |
| Gemini CLI | Read-only | `~/.gemini/tmp/*/chats/*.json` | Browse, search, token stats |

OpenCode and CodeAgent store stars, custom titles, soft deletes, and trash state in OpenSessionViewer’s own metadata database. The original session databases remain read-only.

## Features

- **Unified dashboard**: detected and undetected providers are shown in the top bar, with unavailable providers disabled.
- **Session list and search**: time-range filtering, infinite scroll, title search, and message-content search.
- **Session detail review**: messages, tool calls, todos, and subsessions render in one review surface.
- **Recursive session tree**: OpenCode/CodeAgent child sessions are organized as nested session containers instead of flat message rows.
- **Tool Flow Tree**: the right-side Flow view shows root sessions, messages, tools, and subagent branches by hierarchy.
- **Table of Contents**: long sessions get navigation for prompts, assistant turns, task branches, and nested sessions.
- **Trace API**: step/span summaries classify tools, skills, agents, MCP calls, and LSP activity.
- **Statistics**: total sessions, total messages, token trends, model distribution, and daily session activity.
- **Local management**: OpenCode/CodeAgent support starring, renaming, batch actions, soft delete, restore, and permanent delete.
- **Export**: OpenCode/CodeAgent sessions can be exported as Markdown or JSON, with JSON including the session tree.
- **Bilingual UI**: use `--lang en` or `--lang zh`.

## Quick Start

```bash
npx @guanzhw/opensessionviewer
```

Then open:

```text
http://localhost:3456
```

Run from source:

```bash
git clone https://github.com/Guanzhw/OpenSessionViewer.git
cd OpenSessionViewer
npm install
npm start
```

## CLI Options

```text
opensessionviewer [options]

--port <number>       Server port, default 3456
--opencode-db <path>  OpenCode database path, alias --db
--claude-dir <path>   Claude Code data directory
--codex-dir <path>    Codex CLI data directory
--gemini-dir <path>   Gemini CLI data directory
--config <path>       OpenSessionViewer JSON config
--allow-terminal-launch
                      Allow the local UI to open resume commands in Windows Terminal
--reindex             Rebuild the cross-provider index on start
--lang <en|zh>        UI language
--open                Open the browser on start
-h, --help            Show help
```

## Environment Variables

| Variable | Purpose |
|:---|:---|
| `PORT` | Default server port |
| `SESSION_VIEWER_DB_PATH` | OpenCode DB path, lower priority than `--opencode-db` |
| `OPENCODE_DB_PATH` | Alternative OpenCode DB env var |
| `XDG_DATA_HOME` | XDG data root for OpenCode and CodeAgent |
| `CLAUDE_CONFIG_DIR` | Claude Code data directory |
| `CODEX_HOME` | Codex CLI data directory |
| `GEMINI_HOME` | Gemini CLI data directory |
| `OPENSESSIONVIEWER_META_PATH` | OpenSessionViewer metadata DB path |
| `OH_MY_OPENSESSION_META_PATH` | Legacy metadata DB path |
| `OPENSESSIONVIEWER_CONFIG` | JSON config path |

## Resume Commands

Session detail pages always show a copyable session ID. When a provider has a
known resume command and a valid recorded project directory, the page also
offers a copyable command. Actual terminal launching is disabled unless the
server starts with `--allow-terminal-launch`.

Provider commands can be overridden in `config.json` under the normal
OpenSessionViewer config directory, or in the file selected by `--config`:

```json
{
  "resumeCommands": {
    "opencode": {
      "executable": "opencode",
      "args": ["--session", "{sessionId}"]
    },
    "codeagent": {
      "executable": "my-codeagent",
      "args": ["resume", "{sessionId}"],
      "cwd": "D:\\WorkSpace"
    }
  }
}
```

Supported placeholders are `{sessionId}` and `{projectPath}`. Commands are
started as executable/argument arrays rather than raw shell strings. A custom
`cwd` is useful for providers whose history does not record a project path.

## Claude Code History

Claude Code histories are read from both the legacy `~/.claude/transcripts`
layout and the current `~/.claude/projects/<project>/*.jsonl` layout.
OpenSessionViewer never modifies these files.

Claude Code removes transcript files according to its `cleanupPeriodDays`
setting, which defaults to 30 days. Project metadata can remain in
`~/.claude.json` after the JSONL transcript has been removed; in that case the
viewer reports the metadata-only state but cannot reconstruct the deleted
conversation. Use a positive retention period appropriate for your archive
needs if older sessions must remain available.

## Architecture

```text
src/
├── providers/
│   ├── interface.ts       # ProviderAdapter interface
│   ├── index.ts           # Provider registry
│   ├── opencode/          # OpenCode-compatible SQLite adapter factory
│   ├── codeagent/         # CodeAgent adapter, reusing OpenCode schema/parser
│   ├── claude-code/       # Claude Code JSONL adapter
│   ├── codex/             # Codex CLI JSONL adapter
│   └── gemini/            # Gemini JSON adapter
├── db.ts                  # OpenCode-compatible DB queries
├── meta.ts                # Local metadata for star, rename, delete, trash
├── index-db.ts            # Cross-provider session index
├── server.ts              # HTTP API and SSR pages
├── views/                 # Server-rendered templates
├── static/                # Browser JS/CSS
└── locales/               # English and Chinese copy
```

## Current Validation

The latest real-data validation used:

```text
OpenCode DB: C:\Users\QQ110\.local\share\opencode\opencode.db
Server: http://127.0.0.1:3456/opencode
Data: 24 sessions, 1903 messages
```

Validated coverage:

- dashboard, session list, search, stats, and session detail
- recursive session tree, TOC, and Flow view
- OpenCode management action entry points
- CodeAgent unavailable-provider page when the default DB is absent
- delegated `agent-browser` E2E with no browser/page console errors

## Roadmap

Next work focuses on making AI workflows easier to reconstruct precisely:

1. **Session Container Rewrite**
   - Model sessions as recursive containers so root sessions, child sessions, and subsessions can be inserted and rendered consistently.

2. **Nested Subagent Expansion**
   - Expand `task` / `subtask` tool calls into collapsible nested subagent sessions instead of ordinary tool rows.

3. **Context View**
   - Add a context view that shows what was placed into context for every step of every session.
   - The goal is to answer: which messages, files, tool outputs, summaries, system prompts, agent prompts, or compacted history did the model actually see at that step?

4. **Table Of Contents Upgrade**
   - Improve navigation for long sessions: user prompts, assistant turns, tool calls, subagents, and important milestones.

5. **Metrics Upgrade**
   - Add per-session token usage, runtime, step duration, tool counts, and better model/provider breakdowns.

6. **Tool Flow Tree**
   - Upgrade the current trace/tool view into a complete tree that includes all sub-session branches, task calls, spans, and timing.

7. **QA/Polish Pass**
   - Fix and verify disclosure accessibility, add browser regression checks, and make `agent-browser` verification repeatable.

## Development

```bash
npm run typecheck
npm run build
npm start
```

## License

MIT
