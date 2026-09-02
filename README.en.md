# AgentSession

AgentSession is a local-first, read-only harness runtime inspector. It reads
OpenCode, Claude Code, Codex CLI, OpenClaw, Hermes Agent, Pi, and DeepSeek Harness data to reconstruct how a harness ran,
derived sessions, scheduled work, and loaded, compacted, inherited, or
re-injected context.

Conversation remains a useful compatibility projection, but it is not the only
structured model. Provider-owned databases, transcripts, and event logs are
always read-only. Stars, custom titles, and exclusions live in separate
AgentSession metadata.

[中文](./README.md)

![Node.js >= 22.15.0](https://img.shields.io/badge/node-%3E%3D22.15.0-brightgreen?style=flat-square&logo=node.js)
![Zero Runtime Dependencies](https://img.shields.io/badge/runtime_deps-0-blue?style=flat-square)
![MIT License](https://img.shields.io/badge/license-MIT-purple?style=flat-square)

## Work Graph

Session detail navigation is `Work Graph | Conversation | Overview | Raw`, with
Work Graph selected by default. It appears for every readable session and degrades by protocol evidence;
unsupported, unavailable, missing, and invalid states are explicit rather than
rendered as observed zeroes.

Work Graph has five server-derived lenses:

- **Work**: goals, Tasks, dependencies, and explicit links from a Task to each AgentRun attempt.
- **Execution**: actors, run attempts, and request usage for the selected session; inherited or shared input/cache still belongs to the real request where it occurred and is counted once there — the same shared context's cacheRead across distinct requests is not deduplicated, and inherited stored history is never a new request.
- **Coordination**: recorded observations and canonical parent, spawned, forked, continued, compacted-into, scheduled-run-of, and handed-off session relationships.
- **Context**: compaction results, context versions, and scoped artifacts such as memory, experience, and user info, with direct, inherited, and shared origins.
- **Evidence**: bounded, source-ordered events, protocol status, diagnostics, and provenance.

### Session Protocol v2 and v3

Every registered provider implements `getSessionProtocol()` for every readable
session. Graph and query boundaries use the canonical composite `SessionRef`
`{ provider, sessionId }`; provider-owned session IDs remain unchanged.

A v2 snapshot contains:

- `version: 2` and a session descriptor with state, origin, timestamps, cwd,
  harness, terminal outcome, fork seed boundary, inherited event count, and provenance;
- dense source-order `events` with normalized category/kind, turn/step/correlation anchors, and provenance;
- typed session relationships, `tasks`, `agentRuns`, metadata-first
  `contextArtifacts`, and optional in-file `branches`;
- `validation`, `completeness`, and a provider `revision`.

Common event categories are `session`, `message`, `model`, `reasoning`,
`tool`, `task`, `run`, `context`, `control`, `team`, and `unknown`.
`recorded` means the source stores the fact; `derived` means the adapter
reconstructed it from source evidence. The validator checks dense sequences,
unique entities, references, Task/AgentRun separation, lineage conflicts, and
truthful capability descriptors.

Adapters do not invent child sessions, hidden prompts, context text, or
lifecycle observations absent from source evidence. In-file message branches
remain branch topology and never become cross-session relationships.

Session Protocol v3 adds the Work, Execution, Coordination, and Context domains
to the same canonical session boundary, including direct, inherited, and shared
origin slices for request usage. The shared upgrade currently preserves v2
facts and marks unrecorded v3 coverage as unknown; providers can add native v3
evidence incrementally without moving provider interpretation into the browser.

## Read-only HTTP API

These `GET` APIs return bounded, server-normalized JSON:

```text
GET /api/:provider/session/:id/protocol
GET /api/:provider/session/:id/runtime/summary
GET /api/:provider/session/:id/runtime/events?cursor=&limit=&category=&kind=&phase=&correlationId=
GET /api/:provider/session/:id/runtime/graph?depth=&maxNodes=
GET /api/:provider/session/:id/runtime/work?maxItems=
GET /api/:provider/session/:id/runtime/execution?maxItems=
GET /api/:provider/session/:id/runtime/coordination?maxItems=
GET /api/:provider/session/:id/runtime/context?maxItems=
```

The full `/protocol` response contains the v2 snapshot, capability
descriptors, validation, and any storage diagnostic. The four domain APIs return
bounded v3 projections. `events` uses a cursor and limit; `graph` uses depth and
maxNodes. Responses report truncation, missing sessions, unavailable providers,
and validation diagnostics. Unknown sessions return 404; known incomplete or
invalid sessions retain their diagnostics.

## Provider coverage

All seven registered providers expose Session Protocol v2. The table separates
source-recorded facts from adapter-derived facts; `partial` never means that a
fact was stored natively.

| Provider | Lifecycle | Local source | Protocol fidelity and coverage |
|:---|:---|:---|:---|
| OpenCode | active | `$XDG_DATA_HOME/opencode/opencode.db` or `~/.local/share/opencode/opencode.db` | `partial/derived` message/part events plus native child/session records for relationships, Tasks, and AgentRuns. |
| Claude Code | active | `~/.claude/transcripts/`, `~/.claude/projects/` | `partial/derived` transcript, compact-boundary, and sidechain/task-notification evidence. |
| Codex CLI | active | `~/.codex/sessions/**/*.jsonl` | `full/recorded` response/item, tool, and compaction events; `partial/derived` NEW_TASK relationships, Tasks, and AgentRuns. |
| OpenClaw | active — JSONL reader (legacy/archive); latest SQLite refresh pending | `~/.openclaw/agents/*/sessions/*.jsonl` (legacy/archive); latest upstream primary storage is `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` | `partial/derived` branch topology, reasoning, tools, and registry lineage; no child without source evidence. |
| Hermes Agent | active | `$HERMES_HOME/state.db` | `full/recorded` SQLite events and `partial/derived` compression continuation/delegation lineage; compression is not spawned work. |
| Pi | active | `~/.pi/agent/sessions/**/*.jsonl` | `full/recorded` branch/compaction events and `partial/derived` parent lineage; never invented spawn. The current upstream package/repo has moved to `@earendil-works/pi-coding-agent` (official session format v3); the existing reader needs continued validation against v3/current versions. |
| DeepSeek Harness | active preview | `$DSH_HOME/sessions/**/session.jsonl[.zstd]` or `~/.dsh/sessions/**` | `full/recorded` v0 event log/context and `partial/derived` workflow, team, and cross-session relationships. |

All providers also expose message search, token statistics, export, and local
management that changes only AgentSession metadata. Runtime-environment and
system-prompt evidence remain independent read-only capabilities: only locally
resolvable sources are shown, and hidden provider prompts are never claimed.
An undetected installation is shown as unavailable with its provider diagnostic;
it is never reported as an empty successful source.

## DeepSeek Harness compatibility

The DSH adapter is currently a **alpha.3 compatibility snapshot** (not the
newest version); the project policy is to track the newest alpha/official
HEAD (the stable `latest` rc is not treated as the newest preview). Its
current compatibility snapshot is commit
`dd6322d604e00eec1ba5e0c8541159906a21094a`, tag `dsh-v0.1.2-alpha.3`, package
`@deepseek-ai/dsh@0.1.2-alpha.3`, and session format version `0`. Upstream
alpha.5 and official HEAD refresh is **pending** (see the evidence-matrix
freshness snapshot).

JSONL is the supported primary backend. It accepts raw `.jsonl`, multi-frame
`.jsonl.zstd`, and packed `text-chunks`, `reasoning-chunks`, and
`tool-call-chunks`. Alpha.3 range-encoded `sourceEventSeqs` are decoded once at
the provider boundary. The adapter preserves zero-based source sequence,
core `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`,
`assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`,
`request/header`, `request/context`, surface/source-event citations,
`session/end-seed`, fork `parentSession`/`seedLength`, compaction,
cancellation/interruption, workflow/subagent evidence,
`agent/inbox/spliced` plus Agent Teams `team/member`, `team/task`,
`team/message/queued`, and `team/message/delivered`. Alpha.3 also records
`model/selection`, `subagent/model-selection-policy`, and
`session-log-deepseek/delivery-accepted`. These are control/model/delivery facts,
not ordinary conversation messages.

Alpha.3 removed the SQLite persistence backend. When a legacy schema 17 store
is detected, it is still surfaced as an explicit **unsupported backend/schema
diagnostic**; it never silently disappears or appears as an empty provider.
The stock headless CLI has no declared default resume argument, so AgentSession
does not invent a DSH resume command.

## Installation

Requires Node.js `>= 22.15.0`. Standalone binaries are also available from
GitHub Releases.

```bash
npm install --global @acetamido/agentsession
agentsession
```

From source:

```bash
git clone https://github.com/Guanzhw/AgentSession.git
cd AgentSession
npm install
npm start
```

The server binds to loopback at `http://127.0.0.1:3456` by default.

## CLI

```text
agentsession [options]

--port <number>       Server port (default: 3456)
--opencode-db <path>  OpenCode database
--claude-dir <path>   Claude Code data directory
--codex-dir <path>    Codex CLI data directory
--pi-dir <path>       Pi agent data directory
--dsh-dir <path>      DeepSeek Harness data directory (default: $DSH_HOME or ~/.dsh)
--openclaw-dir <path> OpenClaw state directory
--hermes-dir <path>   Hermes Agent data directory
--config <path>       AgentSession JSON configuration
--disable-terminal-launch  Disable resume command launching
--reindex             Rebuild the index at startup
--lang <en|zh>        UI language
--open                Open the browser after startup
-h, --help            Show help
```

Terminal launching is limited to an explicit provider resume command. Commands
are structured executable/args/cwd objects and are guarded by loopback,
same-origin checks and `--disable-terminal-launch`; AgentSession has no
write-capable terminal control plane.

## Configuration

The default user configuration is `config.json` in the metadata directory;
`AGENTSESSION_CONFIG` or `--config` can select another file. Project mappings
are top-level `projectPaths`, not a provider-specific nested setting:

```json
{
  "projectPaths": {
    "codex": {
      "opaque-project-key": "C:\\work\\project"
    }
  },
  "resumeCommands": {
    "claude-code": {
      "executable": "claude",
      "args": ["--resume", "{sessionId}"]
    }
  },
  "resumeShell": {
    "executable": "powershell.exe",
    "args": ["-NoLogo", "-NoProfile"]
  }
}
```

Each `projectPaths.<provider>` key must be a stable opaque project key from
the source and each value an existing absolute directory. AgentSession never
guesses or writes this mapping back to provider data. `resumeCommands` only
overrides resume commands; `resumeShell` defines the trusted local host.
`allowTerminalLaunch` is a startup switch and is not persisted.

Common environment variables are `PORT`, `AGENTSESSION_DB_PATH`,
`XDG_DATA_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCLAW_STATE_DIR`,
`OPENCLAW_HOME`, `HERMES_HOME`,
`PI_CODING_AGENT_DIR`, `DSH_HOME`, `AGENTSESSION_META_PATH`, and
`AGENTSESSION_CONFIG`.

## AgentSession-MCP

`@acetamido/agentsession-mcp` is a separate read-only stdio MCP server. It
queries sessions still present in provider storage, never writes provider data,
and does not use Viewer hide/exclude metadata as an access filter. Its bounded
tools are `session_search`, `session_get`, `session_timeline`,
`session_get_context`, and `session_get_event`.

```bash
npx --yes --prefer-online @acetamido/agentsession-mcp@latest install
```

## Development and verification

```bash
npm run typecheck
npm test
npm run build
```

For real-data verification, inspect `/api/providers`, one representative
session's `/protocol`, all four Runtime APIs, and the desktop plus 390px
viewport through `npm run qa:e2e`. See the [provider contribution guide](./docs/CONTRIBUTING-PROVIDER.md) and the [Runtime Workbench specification](./docs/specs/runtime-protocol-workbench/).

## License

MIT
