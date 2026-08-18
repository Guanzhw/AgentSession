# AgentSession

> A local AI session archive for developers: one searchable, traceable, reviewable web UI for OpenCode, Claude Code, Codex CLI, OpenClaw, Hermes Agent, Pi, DeepSeek Harness, and legacy Copilot and Gemini sessions.

[English](./README.en.md) · [中文](./README.md)

![Node.js >= 22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen?style=flat-square&logo=node.js)
![Zero Runtime Dependencies](https://img.shields.io/badge/runtime_deps-0-blue?style=flat-square)
![MIT License](https://img.shields.io/badge/license-MIT-purple?style=flat-square)
![v1.8.3](https://img.shields.io/badge/version-1.8.3-orange?style=flat-square)

## What's New in 1.8.3

- AgentSession MCP npm installs and standalone executables now receive their
  exact version from the build source, so protocol handshakes no longer return
  a stale release number.
- Flow detail inspectors now shrink to their content and stay within the visible
  area near the selected node; long content scrolls internally instead of
  opening at the top of a tall Flow or beneath the fixed navigation bar.
- macOS tests canonicalize both analysis-run paths before comparison, accepting
  the system's equivalent `/var` and `/private/var` directory forms.

See [CHANGELOG.md](./CHANGELOG.md) for the complete release notes.

## Attribution

AgentSession is based on [OpenSession](https://github.com/HeavyBunny19C/OpenSession). It keeps the original local, multi-provider AI session viewer direction, moves the codebase to TypeScript, and extends the roadmap toward richer nested-session, tool-flow, and context visualization.

## What It Is

AgentSession is a local-first viewer for AI coding sessions. It reads session data already stored on your machine and presents a unified dashboard, search, detail pages, statistics, exports, and trace views. It does not modify the original provider databases.

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
| OpenCode | Full shared support | `$XDG_DATA_HOME/opencode/opencode.db` or `~/.local/share/opencode/opencode.db` | Shared Agent Loop views, trace, local prompt evidence, runtime inventory, analysis; plus SQLite-native advanced statistics |
| Claude Code | Full shared support | `~/.claude/transcripts/` + `~/.claude/projects/` | Shared Agent Loop views, trace, local prompt evidence, runtime inventory, analysis; sidechain subagents when transcripts retain them; session protocol: task notifications to Task/AgentRun, compact boundary events |
| Codex CLI | Full shared support | `~/.codex/sessions/**/*.jsonl` | Shared Agent Loop views, trace, local prompt evidence, runtime inventory, analysis, nested subagents; session protocol: NEW_TASK tasks/runs, compaction variant events |
| OpenClaw | Full shared support | `~/.openclaw/agents/*/sessions/*.jsonl` | Branch-aware JSONL, reasoning, tool calls/results, shared Agent Loop views, analysis, and resume. |
| Hermes Agent | Full shared support | `$HERMES_HOME/state.db` | Read-only SQLite sessions, reasoning, tool calls/results, shared Agent Loop views, analysis, and resume; compression lineage is not misclassified as subagents; session protocol: compacted-into relationships and opaque events |
| GitHub Copilot CLI | Legacy history support | `~/.copilot/session-state/*/events.jsonl` + `~/.copilot/session-store.db` | Existing histories remain browsable, searchable, exportable, and available to shared views; resume and analysis are disabled by default. |
| Gemini CLI | Legacy history support | `~/.gemini/tmp/*/chats/*.json` | Browse, search, export, token statistics, shared views, and local prompt/runtime evidence for existing histories. It has no default resume or analysis action, and its flat chat format has no child-session relationship, so AgentSession does not invent embedded subagent branches. |
| Pi | Full shared support | `~/.pi/agent/sessions/**/*.jsonl` | Shared Agent Loop views, trace, local prompt evidence, runtime inventory, analysis, active branches, and fork relationships. A recorded subagent launcher embeds the child at that call; a source-only fork relationship remains explicitly inferred. Session protocol: compaction/branch_summary events and metadata-first artifacts |
| DeepSeek Harness | Full shared read support | `$DSH_HOME/sessions/**/session.jsonl.zstd` or `~/.dsh/sessions/**/session.jsonl.zstd` | Reads DSH v0 event-sourced logs (including multi-frame Zstd and packed chunks), reasoning, tools, compaction, workflow/subagents, stored prompt snapshots, runtime inventory, analysis, and the full session protocol. The stock headless CLI has no stable default resume argument, so AgentSession does not invent a terminal resume command. |

Every provider has browse, content search, viewer-only metadata management,
Markdown/JSON export, daily token statistics, Tree/Container/Metrics/Flow/Trace,
and local prompt/runtime evidence. Active providers with a source-supported
resume command additionally expose resume and proposal-only analysis when a valid project directory is available. Recursive
embedded branches are shown only when a
source records a parent/child relationship; AgentSession labels source-only
relationships as inferred instead of fabricating an invocation. Command-launching
features require a valid project directory recorded by the source or supplied by
an explicit viewer-owned project-key mapping. Provider-owned source data remains
read-only.
Advanced statistics remain source-native: AgentSession does not invent project,
model, or cost dimensions that a transcript does not actually record.

### Shared Agent Loop

Providers normalize their raw records into one provider-neutral coding-agent
loop: user input → agent turn → reasoning/text/tool calls → tool results →
optional subagent branches. Tree, Container, Metrics, Flow, and the generic
Trace derive from that loop. A provider may override the generated Trace only
when its source contains a richer native step model; it cannot weaken the
common response-boundary or tool-result semantics.

Adding a provider? Follow the [provider contribution guide](./docs/CONTRIBUTING-PROVIDER.md) for the adapter, MCP, test, and release checklist.

### Shared Session Protocol

On top of the Message read/compatibility view, Codex CLI, Claude Code, Pi,
Hermes Agent, and DeepSeek Harness expose a provider-neutral standardized session protocol
(`getSessionProtocol` + `protocolCapabilities`): events with stable REQUIRED
sequences (`SessionEventEnvelope`, dense 1..n in canonical source record
order — never timestamp chronology), explicit session relationships (parent /
spawned / forked / continued / compacted-into / scheduled-run-of), a separated
Task and AgentRun model, and metadata-first context artifacts
(`ContextArtifact`). Every value carries provenance (`recorded` = native source
evidence, `derived` = reconstructed by the adapter from other evidence).

- Context compaction becomes the standard `context.compaction` event: Codex
  `compacted` / `context_compacted` / `contextCompaction` variants (opaque when
  no summary exists), Claude Code compact boundaries and PreCompact/PostCompact
  records, Pi `compaction` and `branch_summary` entries, Hermes compression
  continuations, and DeepSeek Harness `compaction/summary` and `compaction/prune`
  entries (the summary is retained as metadata-only; a prune is opaque). Plain compaction never emits
  memory/context lifecycle events.
- Subagent/parent-session evidence normalizes to relationships and
  Task/AgentRun: Codex NEW_TASK envelopes and spawn tool calls, Claude
  `<task-notification>` records and sidechain transcripts, Hermes delegate
  sessions. Execution mode (foreground/background/subagent/scheduled/team)
  belongs to AgentRun only; Tasks carry status, dependencies, and assignee.
  Compression continuations are never treated as subagents; Pi's
  `parentSession` exports only a derived parent relationship (rotation or fork
  is indistinguishable from file metadata) without fabricating a spawn. DeepSeek
  Harness exports fork/spawn, Task, and AgentRun only when its header,
  `subagent/descriptor`, or `tool-workflow/*` records supply the evidence.
- Context artifacts are metadata-first: `kind` (memory/instruction/skill/rule/
  summary), `scope` (session/agent/project/user/organization), `origin`
  (user-authored/agent-generated/provider-generated), and `contentAccess`
  (full/summary/metadata-only/unavailable) describe the artifact and never
  carry compacted transcript text. Compaction-derived artifacts are always
  kind=summary, scope=session, origin=provider-generated,
  contentAccess=metadata-only, with `sourceSessionIds` set. Lifecycle
  observations such as `memory.generated` are event kinds emitted only when
  provider evidence supports them.
- Every domain is declared truthfully through `CapabilityDescriptor`
  (full/partial/none + recorded/derived + details). Domains mixing recorded
  and derived values declare partial/derived; providers without an accessor
  default to none and never fabricate native support.

All providers store stars, custom titles, soft deletes, and permanent exclusions in AgentSession’s own metadata database. Original session databases and transcript files remain read-only.

## Features

- **Unified Sessions entry**: `/sessions` lists every detected provider together with provider multi-select, project/time filters, sorting, and cross-provider infinite scroll. Sessions retain their `(provider, sessionId)` identity and canonical provider-owned detail URL.
- **Session list and search**: the global entry filters provider titles, viewer custom titles, and directories; provider pages retain message-content search, starring, and local management. A reversible title-type filter can separate displayed titles containing analysis/analyze signals from other sessions; it is a viewer heuristic, not provider metadata.
- **Session detail review**: provider-owned response boundaries keep reasoning, action/tool calls, and observation/tool results together as ReACT turns.
- **Stable detail tabs**: Overview, Conversation, Execution, Analysis, and Raw data share one content track. The Conversation table of contents fades without reflowing the title, actions, or tab bar and honors reduced-motion preferences.
- **Recursive session tree**: OpenCode, Codex, Copilot, Pi, DeepSeek Harness, and Claude Code sessions with stored parent/child evidence render child sessions as nested containers; inline Copilot agents remain embedded because they are not independently resumable sessions. Source-only relationships remain visibly inferred.
- **Execution view**: only sessions with real subagent topology get the Execution tab. It renders subagent forks/returns and branch summaries that link directly to the source conversation for branch evidence, including `Agent`, `task`, `subtask`, `spawn_agent`, and `delegate_task` launchers plus provider-marked custom agents. Linear conversations get no Execution tab or lazy markup.
- **Table of Contents**: long sessions get navigation for prompts, assistant turns, known launcher branches or provider-marked custom agents, and nested sessions.
- **In-conversation search**: open the compact detail-page search from the action bar or press `/`; results report matching turns and text occurrences, highlight the exact text, and keep previous/next controls visible while navigating.
- **Trace API**: step/span summaries classify tools, skills, agents, MCP calls, and LSP activity.
- **System-prompt evidence API**: `GET /api/:provider/session/:id/system-prompts` exposes only current locally resolvable instructions, rules, and runtime sources; it never claims to recover a hidden provider prompt.
- **Session protocol API**: `GET /api/:provider/session/:id/protocol` (read-only) returns capability descriptors (per domain `full/partial/none` + `recorded/derived`) and the standardized protocol (stably sequenced events, relationships, tasks/agent runs, metadata-first context artifacts). Unknown providers, unknown sessions, and providers without protocol support answer 404.
- **Session list statistics**: the session lists (`/sessions`, provider pages, and their JSON APIs) attach a bounded per-session stats summary for the current page only: message count, total token usage when recorded, observed duration (first/last event activity span from protocol evidence, raw created→updated otherwise — never presented as active CPU time), context compaction count and last compaction time, child/background agent-run counts, active task/agent-run statuses, and context-artifact/memory counts. Counts derive through the Session Protocol surface without provider-id branches; providers without protocol support degrade to the base summary, and token totals are never fabricated.
- **Unified Usage entry**: `/stats` aggregates selected providers through one daily token-composition contract. The total trend exposes provider filters directly, while contribution cards apply a single-provider filter in place or open provider-specific details. Provider detail pages retain top sessions, period comparison, model ranking, day drill-down, and optional cost estimates. For file-backed subagent transcripts, it counts only requests owned by that transcript and excludes copied parent history; a recorded request total is retained even when its component breakdown is incomplete. File-backed providers expose only dimensions present in their transcripts.
- **Local management**: every provider supports starring, renaming, batch actions, soft delete, restore, and permanent exclusion; these actions only mutate viewer metadata.
- **Export**: OpenCode sessions expose one Export menu for Markdown or JSON, with JSON including the session tree.
- **Bilingual UI**: use `--lang en` or `--lang zh`.

## Quick Start

Download the archive for your platform from [GitHub Releases](https://github.com/Guanzhw/AgentSession/releases), then verify it against `SHA256SUMS` from the same release. Each archive contains:

- `agentsession` / `agentsession.exe`: the Web Viewer;
- `agentsession-mcp` / `agentsession-mcp.exe`: the read-only stdio MCP server.

Windows x64, Linux x64, Linux arm64, and macOS arm64 are published. The binaries embed Node.js, Web assets, and the analysis helpers, so they do not require a system Node.js installation or a source checkout. Commercial code signing is not currently configured, so Windows SmartScreen or macOS Gatekeeper may ask users to confirm the downloaded executable.

Alternatively, install from npm:

```bash
npm install --global @acetamido/agentsession
agentsession
```

Then open:

```text
http://localhost:3456
```

Run from source:

```bash
git clone https://github.com/Guanzhw/AgentSession.git
cd AgentSession
npm install
npm start
```

## CLI Options

```text
agentsession [options]

--port <number>       Server port, default 3456
--opencode-db <path>  OpenCode database path
--claude-dir <path>   Claude Code data directory
--codex-dir <path>    Codex CLI data directory
--copilot-dir <path>  GitHub Copilot CLI data directory
--gemini-dir <path>   Gemini CLI data directory
--pi-dir <path>       Pi agent data directory
--dsh-dir <path>      DeepSeek Harness data directory (default: $DSH_HOME or ~/.dsh)
--openclaw-dir <path> OpenClaw state directory
--hermes-dir <path>   Hermes Agent data directory
--config <path>       AgentSession JSON config
--disable-terminal-launch
                      Disable resume and analysis command launching
--reindex             Rebuild the cross-provider index on start
--lang <en|zh>        UI language
--open                Open the browser on start
-h, --help            Show help
```

## Environment Variables

| Variable | Purpose |
|:---|:---|
| `PORT` | Default server port |
| `AGENTSESSION_DB_PATH` | OpenCode DB path, lower priority than `--opencode-db` |
| `XDG_DATA_HOME` | XDG data root for OpenCode |
| `CLAUDE_CONFIG_DIR` | Claude Code data directory |
| `CODEX_HOME` | Codex CLI data directory |
| `COPILOT_HOME` | GitHub Copilot CLI data directory |
| `GEMINI_HOME` | Gemini CLI data directory |
| `OPENCLAW_STATE_DIR` | OpenClaw state directory (highest priority) |
| `OPENCLAW_HOME` | OpenClaw home; state defaults to its `.openclaw` child |
| `HERMES_HOME` | Hermes Agent data directory |
| `PI_CODING_AGENT_DIR` | Pi agent data directory, defaults to `~/.pi/agent` |
| `DSH_HOME` | DeepSeek Harness data directory, defaults to `~/.dsh` |
| `AGENTSESSION_META_PATH` | AgentSession metadata DB path; the default config is stored beside it unless `AGENTSESSION_CONFIG` is set |
| `AGENTSESSION_CONFIG` | AgentSession JSON config path |

## AgentSession-MCP: local session history for coding agents

`@acetamido/agentsession-mcp` is a separate stdio MCP package for Codex, Claude Code,
GitHub Copilot CLI, OpenCode, and other MCP hosts to query the session history from
locally available providers. It starts no web server, binds no port, and never
modifies provider-owned data.

### Interactive install and automatic updates

No global install is required. This command detects local coding agents, asks
which ones to configure, and writes only the user-level MCP configurations you
confirm:

```bash
npx --yes --prefer-online @acetamido/agentsession-mcp@latest install
```

Codex, Claude Code, and OpenCode are supported installer targets. Copilot remains
a legacy history provider and is no longer configured by the installer. The generated MCP
configuration launches `npx --prefer-online @acetamido/agentsession-mcp@latest`,
so every coding-agent startup forces npm to check cached package metadata and
uses the latest published MCP. `install` never overwrites an existing server
named `agentsession`, and `update` refreshes only an entry created by this
installer. To migrate a manual or legacy entry, explicitly add `--replace`:

```bash
# Non-interactive install. --config is forwarded to the MCP as AGENTSESSION_CONFIG.
npx --yes --prefer-online @acetamido/agentsession-mcp@latest install \
  --target codex,claude-code --config /path/to/config.json --yes

# Refresh installer-managed auto-updating entries.
npx --yes --prefer-online @acetamido/agentsession-mcp@latest update \
  --target all --yes

# Intentionally migrate a manual or legacy agentsession entry.
npx --yes --prefer-online @acetamido/agentsession-mcp@latest update \
  --target all --replace --yes
```

Pi's upstream CLI currently has no native MCP configuration surface, so the
installer does not claim to install into Pi. A Pi extension must explicitly
provide an MCP bridge before it can be supported.

### Manual installation

```bash
npm install --global @acetamido/agentsession-mcp
agentsession-mcp --config /path/to/config.json
```

It exposes exactly five read-only tools: `session_search`, `session_get`,
`session_timeline`, `session_get_context`, and `session_get_event`. Keyword
search covers titles, recorded message text, and recorded directories by
default. Whitespace-separated terms must all match but do not need to be
adjacent. `session_search` accepts `directory` to match a normalized recorded
project path and returns `nextCursor` for continuing the same time-bounded
snapshot. Normal search does not return reasoning; reasoning, tool input, and
tool output require explicit opt-in and are always bounded server-side. Default
search diagnostics include every registered provider, including unavailable
ones. `session_get` includes first and last visible-message previews so a title
match normally provides an EventRef without an extra timeline call.
`session_timeline` omits blank message segments; tool and requested thinking
segments remain separate events. Truncated `session_get_event` content includes
reusable `continuation`/`continuations` arguments until `nextOffset` is null.
Provider local storage is authoritative: sessions the Viewer hides, soft-deletes,
or permanently excludes remain reachable through the MCP; Viewer metadata is
never an access filter here.

Use the same AgentSession JSON config to reuse provider paths and the metadata
directory. MCP output limits are optional and server-capped:

```json
{
  "mcp": {
    "searchLimit": 20,
    "timelineLimit": 50,
    "eventMaxChars": 4000,
    "contextWindow": 5
  }
}
```

For manual registration, use the `agentsession-mcp` command and optional
`--config` argument. For example, in Codex CLI:

```bash
codex mcp add agentsession -- agentsession-mcp --config /path/to/config.json
```

## Resume Commands

Session detail pages always show a copyable session ID. When a provider has a
known resume command and a valid project directory from the source or a
configured mapping, the page can open the command in a terminal. Before launching, the page exposes the resolved
command and working directory in a copyable disclosure. Command launching is
enabled by default; start with
`--disable-terminal-launch` to hide and disable resume and analysis launches.
Launch prefers Windows Terminal (`wt.exe`) when available and falls back to
opening the configured PowerShell host directly.
The API waits for the terminal host or PowerShell wrapper to confirm startup
before returning success. If the host cannot start, the page shows an error
instead of a success toast. Runtime launch logs include the selected host,
fallback information, and the launcher PID when available.

Active providers with a stable terminal resume command declare a default command:

| Provider | Default command |
|---|---|
| OpenCode | `opencode --session {sessionId}` |
| Claude Code | `claude --resume {sessionId}` |
| Codex CLI | `codex resume {sessionId}` |
| OpenClaw | `openclaw tui --local --session <sessionKey>` resolved from the canonical session ID through the registry |
| Hermes Agent | `hermes chat --resume {sessionId}` |
| GitHub Copilot CLI | Legacy history only; no default launch |
| Gemini CLI | Legacy history only; no default launch |
| Pi | `pi --session {sessionId}` |
| DeepSeek Harness | Stock headless CLI has no stable default resume command; no launch |

Every command and the PowerShell-compatible terminal shell can be overridden in
`config.json` under the normal AgentSession config directory, or in the
file selected by `--config`:

```json
{
  "resumeCommands": {
    "opencode": {
      "executable": "opencode",
      "args": ["--session", "{sessionId}"]
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
generated `-EncodedCommand` argument. When omitted, AgentSession selects
`pwsh.exe` and then `powershell.exe`, using `["-NoExit", "-NoLogo"]`.

## Web Settings

Open `/:provider/settings`, for example
`http://127.0.0.1:3456/opencode/settings`, to manage analysis, target paths,
provider commands, resume commands, and the PowerShell host with switches and
form fields. The page shows the exact config path and validates settings before
saving. The underlying JSON remains available in a collapsed Advanced section.

Changes to `analysis`, `resumeCommands`, and `resumeShell` apply to the running
server immediately. Server paths, port, and provider data directories are
persisted but require a restart. `allowTerminalLaunch` is intentionally not
web-configurable. Command launching is enabled by default; start AgentSession
with `--disable-terminal-launch` to turn it off for the current process.

Token Explorer does not embed a vendor price catalog. To enable cost estimates,
add per-million-token rates under a `provider/model` key in Advanced JSON settings.
The estimate appears only when the stats page is filtered to one model:

```json
{
  "tokenPricing": {
    "openai/gpt-5": {
      "currency": "USD",
      "inputPerMillion": 1.25,
      "outputPerMillion": 10,
      "cacheReadPerMillion": 0.125,
      "sourceLabel": "Vendor pricing page",
      "sourceUrl": "https://example.com/pricing",
      "asOf": "2026-07-13"
    }
  }
}
```

### Project key mappings

Some transcript formats retain a stable but opaque project key instead of the
working directory. Gemini CLI is one example. AgentSession never derives a
folder from that key. Instead, copy the key from the session's **Raw data** tab
and add one `project-key=absolute-path` line under **Settings → Project
directory mappings**, or save the equivalent viewer-owned configuration:

```json
{
  "analysis": {
    "providers": {
      "gemini": {
        "projectPaths": {
          "opaque-project-key-from-raw-data": "D:\\WorkSpace\\my-project"
        }
      }
    }
  }
}
```

At use time, AgentSession uses only an existing absolute directory,
canonicalizes it locally, marks it as a configured mapping in the session
details, and never writes it back to the provider transcript. The mapping then
enables Gemini runtime resolution for matching legacy sessions.

`currency` must be a three-letter code, rates must be finite and non-negative,
and `sourceUrl` must be an absolute HTTP/HTTPS URL. Unpriced reasoning/cache
dimensions are reported as omitted instead of silently treated as free. Use the
actual model key and a trustworthy source, and maintain the `asOf` date yourself.

## Runtime Logs

AgentSession writes append-only JSONL runtime events under the metadata
directory:

```text
<metadata-dir>/logs/runtime-YYYY-MM-DD.jsonl
```

The log records server startup, provider indexing, HTTP route patterns and
statuses, metadata mutations, settings saves, terminal launches, and analysis
prepare/launch events. Launch events may include the working directory path for
local diagnosis. The log intentionally avoids request bodies, transcript
content, prompts, tool output, full command arguments, cookies, tokens, and
secrets. Analysis-run stdout/stderr and evidence snapshots remain in each run's
own `diagnostics/` directory.

## Session Analysis And Evaluation Proposals

AgentSession can launch a configured analyzer non-interactively from every
active provider detail page. The default runner is OpenCode's non-interactive
command, but it is configurable globally or per active provider, so Copilot CLI
and Pi sessions can use the same bounded, proposal-only analysis lifecycle.
Gemini CLI remains a legacy history provider and intentionally has no default
analysis action. The analysis run:
it snapshots the session as indexed JSONL
evidence, snapshots selected artifacts, creates an evaluation seed, and asks
the analyzer to write:

- `report.md`: the primary, human-readable analysis result
- `evaluation-proposals.json`: the replay, held-out, and regression validation plan
- `artifact-proposals.json`: proposed target changes, which may be an empty list.
  Individual proposals may use `kind: "skill-evolution"` when the proposal is
  an evidence-backed update to future agent skills, instructions, or harness
  guidance.

These three files are the final analysis products. Files such as
`session-index.json`, `evidence-index.json`, `evidence.jsonl`, `artifacts.json`,
and `manifest.json` are supporting evidence and diagnostics. Completed runs
expose direct open and download links in the session's **Analysis activity**
panel. Active, failed, and invalid runs expose available analyzer stdout/stderr
logs there as well, together with a copyable PowerShell analyzer command.

Analysis inputs are intentionally separated:

- **Session evidence** is the normalized conversation, tool results, system
  prompt records, and other session data.
- **Analysis materials** are provider-neutral raw inputs configured by the
  selected target, such as documentation, tests, prompt assets, scripts, or
  explicit external reference files.
- **Runtime extensions** are provider-resolved instructions and behavior,
  including files such as `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`, plus
  skills, agents, commands, plugins, hooks, tools, and rules.

Before launch, AgentSession resolves the current local provider runtime
extensions and automatically captures the default selected project/user skills,
instructions, agents, commands, plugins, hooks, tools, rules, or extension
bundles that are capturable. Each provider still owns the exact kinds and search
paths. Most transcripts do not contain an immutable historical extension
manifest, so this is current local resolution rather than a claim to recreate
the exact environment loaded when the session started. Each captured artifact
records the runtime extension IDs that contributed it.

The session detail page keeps launch actions together: **Continue in terminal**
and **Analyze selected** sit in the same action row. The analysis selector below
them is an inventory-style grid. Rows represent the source scope, such as
analysis targets, project runtime, and user runtime. Columns represent material
kinds, such as skills, prompts, agents, rules, and other inputs. The summary
shows selected target and runtime counts before launch.

New runs organize those files by purpose:

```text
<run>/
├── manifest.json
├── outputs/
│   ├── report.md
│   ├── evaluation-proposals.json
│   ├── artifact-proposals.json
│   └── implementation-result.json # requested from implementation runs
├── inputs/
│   ├── session.json
│   ├── evaluation-seed.json
│   ├── analysis-request.md
│   └── accepted-proposals.json    # written after user approval
├── evidence/
│   ├── session-index.json
│   ├── evidence-index.json
│   ├── evidence.jsonl
│   ├── artifacts.json
│   └── artifact-snapshots/
└── diagnostics/
    ├── analyzer.stdout.log
    ├── analyzer.stderr.log
    ├── messages.json            # raw snapshots only with includeRawSnapshots
    ├── tree.json
    ├── container.json
    ├── metrics.json
    ├── flow.json
    └── trace.json
```

Older flat run directories remain readable.

Generated evaluation cases begin with `status: "proposed"`. AgentSession
does not modify skills or mark a proposal as validated. Promotion should happen
only after baseline and candidate executions pass replay, held-out, and
regression checks.

After the analyzer exits, AgentSession automatically checks the output
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

`extension_*` queries inspect the captured provider runtime context.
`artifact_*` queries inspect the bounded snapshots produced from both
configured analysis materials and automatically captured runtime extensions.
The `runtimeExtensionIds` field identifies snapshots that came from runtime
context.

Interruption signals come from explicit tool error reasons. High error rate is
kept as a transparent heuristic: the result includes the threshold, minimum
tool-call sample, raw counts, rate, and complete ranking. The analyzer is told
to inspect successful and failed outcomes contrastively before proposing an
edit.

Analysis uses the same startup launch setting as resume commands. Launching is
enabled by default and can be turned off with `--disable-terminal-launch`.
Analysis must also be enabled. OpenCode has a built-in analyzer command that
can be overridden:

```json
{
  "analysis": {
    "enabled": true,
    "defaultTarget": "skills",
    "outputDir": ".agentsession/analysis",
    "includeRawSnapshots": false,
    "shell": {
      "executable": "powershell.exe",
      "args": ["-NoExit", "-NoLogo", "-NoProfile"]
    },
    "implementation": {
      "command": {
        "executable": "opencode",
        "args": [
          "run",
          "Read the attached implementation request and implement the accepted proposals.",
          "--model", "deepseek/deepseek-v4-flash",
          "--dir", "{projectPath}",
          "--file", "{implementationPromptPath}"
        ]
      }
    },
    "targets": {
      "skills": {
        "label": "Analyze skills",
        "fileExtensions": [".md", ".json", ".yaml", ".yml", ".js", ".ts", ".py"],
        "promptFile": "prompts/analyze-skills.md"
      },
      "docs": {
        "artifactRoots": ["docs"],
        "artifactFiles": ["README.md"],
        "fileExtensions": [".md", ".mdx", ".txt"]
      }
    },
    "providers": {
      "opencode": {
        "targets": {
          "skills": {
            "prompt": "Prioritize reusable skills that affected the selected session."
          }
        },
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
      }
    }
  }
}
```

Supported command placeholders are `{sessionId}`, `{projectPath}`, `{target}`,
`{runId}`, `{runDir}`, `{sessionPath}`, `{sessionIndexPath}`,
`{evidenceIndexPath}`, `{evidencePath}`, `{accessManifestPath}`,
`{analysisToolPath}`, `{promptPath}`, `{reportPath}`, `{evaluationSeedPath}`,
`{evaluationPath}`, `{proposalsPath}`,
and `{artifactsPath}`. Implementation commands additionally support
`{implementationPromptPath}`, `{acceptedProposalsPath}`, and
`{implementationResultPath}`. `{prompt}` is also available for agents that require the
complete prompt as one argument, although `{promptPath}` or `"stdin": "prompt"`
is preferable for large sessions. `{messagesPath}` remains available when
`includeRawSnapshots` is enabled for debugging or compatibility.

The OpenCode example uses its non-interactive `run` command and attaches the
generated request as a file. Configure OpenCode permissions so it may write
only inside the analysis output directory. `--dangerously-skip-permissions`
can make unattended local testing easier, but should only be added for a
trusted project and trusted prompt.

After a run completes with `manifest.validation.ok === true` and at least one
validated proposal, the session page can launch an implementation run.
Clicking **Implement accepted proposals** is the first-pass user approval gate:
it writes `inputs/accepted-proposals.json` with the accepted proposal IDs and
full proposal records, writes `inputs/implementation-request.md`, points the
configured implementation command at that request, and asks the agent to make
only the accepted proposal changes. The request also points the agent at
`inputs/analysis-access.json` when the run has one, so implementation can follow
the same bounded file-first interface for evidence context. The agent should
write `outputs/implementation-result.json`, verify the result, and leave it for
human review. It does not merge automatically.

Relative `artifactRoots` and `outputDir` paths are resolved from the recorded
session project directory. Absolute artifact roots are allowed when explicitly
configured. `artifactFiles` can include project-relative files such as
`README.md` or absolute external reference documents. Provider runtime paths
such as `.opencode/skills`, `.claude/skills`, `~/.claude/skills`, `AGENTS.md`,
and `CLAUDE.md` should not be repeated here; the provider adapter discovers
them as runtime extensions. Files are copied into a bounded snapshot so the
analysis remains reviewable even if the original material changes later.
`fileExtensions` controls filename suffix filtering for those artifact roots.

When `analysis.outputDir` is omitted, runs default to
`.agentsession/analysis` inside the session project. AgentSession writes
`.agentsession/.gitignore` so generated runs stay out of source control even
when the project does not already ignore that directory. Each run carries the
read-only evidence query tool and its local dependency in its
own `tools/` directory, so the analyzer does not need access to the
AgentSession installation directory. Explicit absolute output directories
remain supported, but a project-scoped analyzer sandbox must also be able to
access that path.

Target-specific analyzer instructions can be edited directly on the settings
page or configured as `analysis.targets.<target>.prompt`. `promptFile` is an
optional reference to an existing text file; relative paths are resolved from
the directory containing `config.json`, and AgentSession does not create
that file. Use **Preview effective prompt** on the settings page to inspect the
same composed prompt template used for a run, with session-specific paths shown
as placeholders.

Built-in analysis targets are available without adding entries under
`analysis.targets`:

- `skills`: selected OpenCode runtime skills
- `prompts`: prompt files and templates
- `agents`: selected OpenCode runtime agent definitions and roles
- `docs`: documentation directories
- `rules`: selected OpenCode runtime instructions and rules
- `tests`: tests, specs, and fixtures
- `workflows`: CI and repository automation
- `scripts`: project scripts and command-line helpers

The settings page exposes these as presets. Entries under `analysis.targets`
can override a built-in target or define another custom target.

`analysis.defaultTarget` controls the single target used when a session page
launches analysis. Older `defaultTargets` arrays remain accepted for existing
configuration, but only the first valid target is used.

The settings page edits `analysis.providers.<provider>.targets.<target>`
overrides. Each target shows the effective provider-neutral analysis material
roots, explicit files, and suffix filters that will be used by default. The
session page presents those targets next to provider-resolved runtime extensions
in the inventory selector, but the two inputs remain separate in the generated
analysis bundle. Provider runtime context is resolved automatically at launch.
**Reset to default** removes the provider-specific difference when possible so
the value inherits from `analysis.targets` or the built-in target again.

By default, analysis runs write `evidence/session-index.json`,
`evidence/evidence-index.json`, and immutable `evidence/evidence.jsonl`;
the `diagnostics/` directory always includes analyzer stdout/stderr logs. Set
`analysis.includeRawSnapshots` or a target-level `includeRawSnapshots` to
`true` only when a legacy analyzer needs bulk diagnostic snapshots.

Provider target overrides can be placed under
`analysis.providers.<provider>.targets.<target>`. This allows different prompts,
artifact roots, and file suffix filters for the same target. Additional custom
targets can use the same structure. See
[`docs/ANALYSIS-PROVIDER-IMPLEMENTATION.md`](./docs/ANALYSIS-PROVIDER-IMPLEMENTATION.md)
for the agent-oriented implementation guide for other providers.

## Claude Code History

Claude Code histories are read from both the legacy `~/.claude/transcripts`
layout and the current `~/.claude/projects/<project>/*.jsonl` layout.
AgentSession never modifies these files.

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
│   ├── claude-code/       # Claude Code JSONL adapter
│   ├── codex/             # Codex CLI JSONL adapter
│   ├── openclaw/          # OpenClaw branch-aware JSONL adapter
│   ├── hermes/            # Hermes read-only SQLite adapter
│   ├── copilot/           # GitHub Copilot CLI event-log adapter
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

Real-data validation is intentionally environment-provided rather than recorded
as a repository-specific database path, session ID, or result count. Run it
against a local server and a real OpenCode session with reasoning, tools,
tokens, and subagent activity:

```powershell
$env:AGENTSESSION_QA_BASE_URL = 'http://127.0.0.1:3456'
$env:AGENTSESSION_QA_SESSION_ID = '<real-session-id>'
npm run qa:e2e
```

`AGENTSESSION_QA_SESSION_ID` is required; the repository intentionally
does not include a machine-specific fallback.

Validated coverage:

- dashboard, session list, search, stats, and session detail
- recursive session tree, TOC, and Flow view
- OpenCode management action entry points
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

6. **Token Explorer** ✅
   - Interactive statistics page with filtering, multi-series trend, model ranking, and drill-down sessions.

7. **Tool Flow Tree**
   - Upgrade the current trace/tool view into a complete tree that includes all sub-session branches, task calls, spans, and timing.

8. **QA/Polish Pass**
   - Fix and verify disclosure accessibility, add browser regression checks, and make `agent-browser` verification repeatable.

## Development

```bash
npm run typecheck
npm run build
npm start
```

## License

MIT
