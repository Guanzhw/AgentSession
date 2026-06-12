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

All registered providers declare a default resume command:

| Provider | Default command |
|---|---|
| OpenCode | `opencode --session {sessionId}` |
| CodeAgent | `codeagent --session {sessionId}` |
| Claude Code | `claude --resume {sessionId}` |
| Codex CLI | `codex resume {sessionId}` |
| Gemini CLI | `gemini --resume {sessionId}` |

Every command and the PowerShell-compatible terminal shell can be overridden in
`config.json` under the normal OpenSessionViewer config directory, or in the
file selected by `--config`:

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
    },
    "gemini": false
  },
  "resumeShell": {
    "executable": "powershell.exe",
    "args": ["-NoExit", "-NoLogo", "-NoProfile"]
  }
}
```

Supported placeholders are `{sessionId}` and `{projectPath}`. Commands are
started as executable/argument arrays rather than raw shell strings. A custom
absolute `cwd` is useful for providers whose history does not record a project
path. Set a provider entry to `false` to disable its resume actions.

`resumeShell.executable` may be `pwsh.exe`, `powershell.exe`, or an absolute path
to a PowerShell-compatible executable. Its `args` are inserted before the
generated `-EncodedCommand` argument. When omitted, OpenSessionViewer selects
`pwsh.exe` and then `powershell.exe`, using `["-NoExit", "-NoLogo"]`.

## Web Settings

Open `/:provider/settings`, for example
`http://127.0.0.1:3456/opencode/settings`, to manage analysis, target paths,
provider commands, resume commands, and the PowerShell host with switches and
form fields. The page shows the exact config path and validates settings before
saving. The underlying JSON remains available in a collapsed Advanced section.

Changes to `analysis`, `resumeCommands`, and `resumeShell` apply to the running
server immediately. Server paths, port, and provider data directories are
persisted but require a restart. `allowTerminalLaunch` is intentionally not a
web-configurable permission: start OpenSessionViewer with
`--allow-terminal-launch` to grant that capability to the current process.

## Session Analysis And Evaluation Proposals

OpenSessionViewer can launch a configured agent non-interactively from a
session detail page. The analysis run is proposal-only: it snapshots the
session as indexed JSONL evidence, snapshots selected artifacts, creates an
evaluation seed, and asks the agent to write:

- `report.md`: the primary, human-readable analysis result
- `evaluation-proposals.json`: the replay, held-out, and regression validation plan
- `artifact-proposals.json`: proposed target changes, which may be an empty list

These three files are the final analysis products. Files such as
`session-index.json`, `evidence-index.json`, `evidence.jsonl`, `artifacts.json`,
and `manifest.json` are supporting evidence and diagnostics. Completed runs
expose direct open and download links in the session's **Analysis activity**
panel.

Before launch, the session page also resolves the provider's current local
runtime extensions and lets you select project-scoped and user-scoped skills,
agents, commands, plugins, hooks, tools, rules, or provider extension bundles.
The exact kinds and search paths remain provider-owned. Most provider
transcripts do not contain an immutable historical extension manifest, so this
picker is labeled as current local resolution rather than claiming to recreate
the exact environment loaded when the session started. Each captured artifact
records the runtime extension IDs that contributed it.

New runs organize those files by purpose:

```text
<run>/
├── manifest.json
├── outputs/
│   ├── report.md
│   ├── evaluation-proposals.json
│   └── artifact-proposals.json
├── inputs/
│   ├── session.json
│   ├── evaluation-seed.json
│   └── analysis-request.md
├── evidence/
│   ├── session-index.json
│   ├── evidence-index.json
│   ├── evidence.jsonl
│   ├── artifacts.json
│   └── artifact-snapshots/
└── diagnostics/                 # only with includeRawSnapshots
    ├── messages.json
    ├── tree.json
    ├── container.json
    ├── metrics.json
    ├── flow.json
    └── trace.json
```

Older flat run directories remain readable.

Generated evaluation cases begin with `status: "proposed"`. OpenSessionViewer
does not modify skills or mark a proposal as validated. Promotion should happen
only after baseline and candidate executions pass replay, held-out, and
regression checks.

After the analyzer exits, OpenSessionViewer automatically checks the output
schemas, requires replay/held-out/regression cases, verifies proposal roots and
paths against the captured artifact inventory, resolves every `ev:...` and
`artifact:...` reference, requires explicit baseline/candidate expectations and
token/runtime criteria, and updates `manifest.json` to `completed`, `invalid`,
or `failed`.

The session page includes an **Analysis activity** panel. It polls while a run
is active and then shows the authoritative manifest result, process exit code,
proposal counts, validation errors, and local run directory. The launch toast
only confirms that the command was started; the activity panel determines
whether the run actually completed successfully.

The analyzer starts from a compact hierarchy and evidence index rather than a
single large session bundle. The generated prompt exposes read-only commands.
Their CLI output is compact Markdown, while exact evidence and artifact IDs are
preserved for follow-up queries and validation:

- `session_main_info`
- `session_query_system_prompts`
- `session_query_context`
- `session_query_errors`
- `session_query_tools` with `status: "completed"` for positive samples
- `session_find_anomalies`
- `session_get_evidence`
- `extension_list`
- `extension_get`
- `artifact_list`
- `artifact_get`

`extension_*` queries inspect the selected agent runtime extensions.
`artifact_*` queries inspect the bounded file snapshots. This terminology is
separate from artifact filename suffix filtering.

Interruption signals come from explicit tool error reasons. High error rate is
kept as a transparent heuristic: the result includes the threshold, minimum
tool-call sample, raw counts, rate, and complete ranking. The analyzer is told
to inspect successful and failed outcomes contrastively before proposing an
edit.

Analysis uses the same explicit `--allow-terminal-launch` safety gate as resume
commands. It must also be enabled and configured for each provider:

```json
{
  "analysis": {
    "enabled": true,
    "defaultTargets": ["skills", "tests"],
    "defaultTarget": "skills",
    "outputDir": ".opensessionviewer/analysis",
    "includeRawSnapshots": false,
    "shell": {
      "executable": "powershell.exe",
      "args": ["-NoExit", "-NoLogo", "-NoProfile"]
    },
    "targets": {
      "skills": {
        "label": "Analyze skills",
        "artifactRoots": ["skills", ".agents/skills", ".codex/skills"],
        "fileExtensions": [".md", ".json", ".yaml", ".yml", ".js", ".ts", ".py"],
        "promptFile": "prompts/analyze-skills.md"
      }
    },
    "providers": {
      "opencode": {
        "command": {
          "executable": "opencode",
          "args": [
            "run",
            "Read the attached analysis request and write the requested proposal files.",
            "--model", "deepseek/deepseek-v4-flash",
            "--dir", "{projectPath}",
            "--file", "{promptPath}"
          ]
        }
      },
      "claude-code": {
        "command": {
          "executable": "my-other-agent-cli",
          "args": ["--non-interactive"],
          "stdin": "prompt"
        },
        "shell": {
          "executable": "pwsh.exe",
          "args": ["-NoExit", "-NoLogo"]
        }
      }
    }
  }
}
```

Supported command placeholders are `{sessionId}`, `{projectPath}`, `{target}`,
`{runId}`, `{runDir}`, `{sessionPath}`, `{sessionIndexPath}`,
`{evidenceIndexPath}`, `{evidencePath}`, `{analysisToolPath}`, `{promptPath}`,
`{reportPath}`, `{evaluationSeedPath}`, `{evaluationPath}`, `{proposalsPath}`,
and `{artifactsPath}`. `{prompt}` is also available for agents that require the
complete prompt as one argument, although `{promptPath}` or `"stdin": "prompt"`
is preferable for large sessions. `{messagesPath}` remains available when
`includeRawSnapshots` is enabled for debugging or compatibility.

The OpenCode example uses its non-interactive `run` command and attaches the
generated request as a file. Configure OpenCode permissions so it may write
only inside the analysis output directory. `--dangerously-skip-permissions`
can make unattended local testing easier, but should only be added for a
trusted project and trusted prompt.

Relative `artifactRoots` and `outputDir` paths are resolved from the recorded
session project directory. Absolute artifact roots are allowed when explicitly
configured. `artifactFiles` can include specific project-relative files such
as `README.md` or `AGENTS.md`. Files are copied into a bounded snapshot so the
analysis remains reviewable even if the original artifact changes later.
`fileExtensions` controls filename suffix filtering for those artifact roots;
the older `extensions` field remains accepted for existing configurations.

When `analysis.outputDir` is omitted, runs default to
`.opensessionviewer/analysis` inside the session project. Each run carries the
read-only evidence query tool and its local dependency in its own `tools/`
directory, so the analyzer does not need access to the CodeagentSession
installation directory. Explicit absolute output directories remain supported,
but a project-scoped analyzer sandbox must also be able to access that path.

Target-specific analyzer instructions can be edited directly on the settings
page or configured as `analysis.targets.<target>.prompt`. `promptFile` is an
optional reference to an existing text file; relative paths are resolved from
the directory containing `config.json`, and OpenSessionViewer does not create
that file. Use **Preview effective prompt** on the settings page to inspect the
same composed prompt template used for a run, with session-specific paths shown
as placeholders.

Built-in analysis targets are available without adding entries under
`analysis.targets`:

- `skills`: reusable agent skills
- `prompts`: prompt files and templates
- `agents`: agent definitions and roles
- `docs`: documentation directories
- `rules`: agent/project rule directories
- `tests`: tests, specs, and fixtures
- `workflows`: CI and repository automation
- `scripts`: project scripts and command-line helpers

The settings page exposes these as presets. Entries under `analysis.targets`
can override a built-in target or define another custom target.

`analysis.defaultTargets` controls which targets are checked initially on a
session page. You can select any combination before launching analysis.
OpenSessionViewer creates one independent run per selected target, each with
its own report, evaluation proposals, artifact proposals, manifest, and
validation result. It does not merge multiple targets into one output bundle.
The older `defaultTarget` field remains supported as the first/default
selection for existing configurations.

By default, analysis runs write `evidence/session-index.json`,
`evidence/evidence-index.json`, and immutable `evidence/evidence.jsonl`;
the `diagnostics/` directory is omitted. Set `analysis.includeRawSnapshots`
or a target-level `includeRawSnapshots` to `true` only when a legacy analyzer
needs those bulk diagnostic files.

Provider target overrides can be placed under
`analysis.providers.<provider>.targets.<target>`. This allows different
commands, prompts, shells, artifact roots, and file suffix filters for the same
target. Additional custom targets can use the same structure.

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
