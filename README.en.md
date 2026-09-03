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
| OpenCode | active | `$XDG_DATA_HOME/opencode/opencode.db` or `~/.local/share/opencode/opencode.db` | `partial/derived` message/part events plus native child/session relationships, todo Tasks, subtask/compaction events, and background task AgentRuns (official 1.18.27; installed 1.17.11). |
| Claude Code | active | `~/.claude/transcripts/`, `~/.claude/projects/` | `partial/derived` transcript, recorded `system/compact_boundary` (`compactMetadata`), and sidechain/task-notification evidence; npm latest/upstream 2.1.259 is verified, installed CLI is 2.1.207, and no live 2.1.259 transcript was available. |
| Codex CLI | active | `~/.codex/sessions/**/*.jsonl`, cold `*.jsonl.zst` rollouts | `full/recorded` response/item, tool, compaction, and current `token_usage_record`; `inter_agent_communication` is exposed only in Runtime v3 actors/coordination and does not alter the linear transcript; `partial/derived` NEW_TASK relationships, Tasks, and AgentRuns. `close_agent` normalizes to `interrupt`; the installed 0.152.1 still mainly writes legacy `token_count`/collaboration shapes, while the official 0.153.0 release and current source HEAD cover the new shapes. |
| OpenClaw | active — current SQLite (with legacy/archive JSONL fallback) | `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` (agent schema 19, verified 2026-09-03); legacy/archive `sessions/*.jsonl` | `partial/derived` branch/window generations, reasoning, tools, and recorded session_nodes parent/spawn/fork lineage; no child without source evidence. Tasks/AgentRuns are `none`: both current and legacy builders always emit empty arrays, with no verified mapping. |
| Hermes Agent | active | `$HERMES_HOME/state.db` | `full/recorded` SQLite events and `partial/derived` compression continuation/delegation lineage; compression is not spawned work. |
| Pi | active | `~/.pi/agent/sessions/**/*.jsonl` | `full/recorded` branch/compaction events and `partial/derived` parent lineage; never invented spawn. Current upstream is `@earendil-works/pi-coding-agent` (npm 0.84.4 / repo `earendil-works/pi-mono`, HEAD `4e69b0c2…`, official session format **v3**, verified 2026-09-03); the v3 reader maps custom-role messages, records retainedTail/fromHook evidence, and uses Pi's billed session total for token totals — all recorded entries (assistant + toolResult + compaction/branch_summary `totalTokens`, including abandoned/history branches, never retainedTail copies); nested `run-N/session.jsonl` files are pi-subagents run artifacts (no parentSession, no lineage). |
| DeepSeek Harness | active preview | `$DSH_HOME/sessions/**/session.jsonl[.zstd]` or `~/.dsh/sessions/**` | `full/recorded` v0 event log/context and `partial/derived` workflow, team, and cross-session relationships. |

All providers also expose message search, token statistics, export, and local
management that changes only AgentSession metadata. Runtime-environment and
system-prompt evidence remain independent read-only capabilities: only locally
resolvable sources are shown, and hidden provider prompts are never claimed.
An undetected installation is shown as unavailable with its provider diagnostic;
it is never reported as an empty successful source.

## OpenClaw current SQLite compatibility

OpenClaw moved sessions/transcripts into the per-agent SQLite store starting
with 2026.7.2-beta.1 (agent schema 19 today); `sessions/*.jsonl` and
`sessions.json` are legacy/archive (doctor migration inputs). AgentSession's
current implementation (verified 2026-09-03):

- Primary store: `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
  (opened read-only; WAL-aware snapshot signatures). Canonical session id =
  `session_nodes.session_key` (e.g. `agent:main:main`); `session_windows` are
  transcript generations (`previous_session_id` + `reason`:
  initial/reset/rollover/fork/rewind/switch/recovery/compaction), and the
  viewer exposes the live window with the recorded generation chain in
  `metadata.windowLineage` (bounded to 20).
- `transcript_events.event_json` has the same record shape as the legacy
  JSONL, so the existing parser is reused unchanged; the active path is
  computed from raw events (`session_transcript_active_events` is a derived
  projection and is not trusted).
- Protocol relationships come only from the recorded field: `parent_session_key`
  yields a `parent` edge, `spawned_by` yields a `spawned` edge (both when
  distinct, deduplicated to `parent` when identical); tree/family views use the
  documented structural-parent precedence.
- Legacy JSONL stays readable; when SQLite and JSONL expose the same canonical
  session (window id of any generation, or registry sessionKey), the SQLite
  representation wins exactly once — no double counting. Coverage is
  agent-scoped, so an identical id recorded by another agent never hides a
  legacy session; covered old-generation window ids remain resolvable to the
  canonical session.
- Diagnostics truthfully distinguish current SQLite / legacy-only JSONL /
  unsupported schema (version >19 or missing shape) / unreadable (corrupt or
  permission) / unavailable (no agents dir); one corrupt agent store never
  hides another agent's usable data.
- Verification baseline: official HEAD `f92a12c5…` and release `v2026.8.2`
  (byte-identical schema SQL, sha256 `54fa65dc…`, agent schema 19). The local
  install 2026.7.1-2 is pre-flip and no current-format data directory exists
  on this machine, so live local validation was not completed (recorded
  explicitly, not claimed as success).

## DeepSeek Harness compatibility

The DSH adapter is currently an **alpha.5 compatibility snapshot**; the
project policy is to track the newest alpha/official HEAD (the stable
`latest` rc is not treated as the newest preview). Its current compatibility
snapshot is tag `dsh-v0.1.2-alpha.5`, commit
`db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`, official HEAD
`49a606bc5b5934603f22a26957a07dc799ab0291`, package
`@deepseek-ai/dsh@0.1.2-alpha.5`, and session format version `0`. Alpha.5 does
not change the physical storage format relative to alpha.3 (same event
catalog, `seedLength`-based header line, packed rows, range-encoded
provenance), so no parser/protocol change was needed; the official alpha.5
checked-in web snapshot (`snapshots/web/fresh-round-trip/session.jsonl`) is
adopted as a fixture whose `seq`/`time` are synthesised on read per upstream
`parseSessionLog`. No new official live-session evidence exists for alpha.5
(the credentialed live run was unavailable because the configured key failed
authentication); the alpha.3-era local live observations remain the live
record.

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

Alpha.3 removed the SQLite persistence backend, and alpha.5 has not
restored it (its SQLite packages are a storage-hub kv facet and an FTS5
session-query backend, not session persistence). When a legacy schema 17 store
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
