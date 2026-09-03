# Contributing a Provider

This guide explains how to add a local AI harness provider to AgentSession.
The adapter owns source parsing and provider-specific semantics; the viewer,
Runtime Workbench, and read-only MCP consume normalized contracts. Provider
databases, transcripts, and event logs must never be written, migrated,
deleted, or repaired.

`src/providers/interface.ts` is authoritative. Keep provider behavior under
`src/providers/<provider-id>/` and do not add central provider-ID branches in
routes, projections, or browser code.

### UI v2 P0 surface contract

The shared viewer presents Library / Statistics / Settings in the primary rail. A
session detail has Work (default), Conversation, and Events tabs. Provider
adapters continue to supply only normalized evidence: Work embeds the existing
Work Graph lenses, Conversation renders the linear message projection, and the
Events shell links to recorded evidence without fabricating an event stream.
Missing provider fields remain empty or unknown. The browser only switches
server-rendered panels and does not interpret provider data.

## Provider evidence freshness

Provider formats evolve independently. Before changing any provider parser,
schema mapping, or protocol mapping, verify the evidence snapshot:

1. Check the official docs, the upstream repository HEAD or release/package
   dist-tag, the locally installed version, and the newest local real data
   available for that provider.
2. Record `verified-at` (date), the version/commit checked, the official
   source link(s), and the sample format(s) inspected. Keep this record with
   the change (decision record or evidence note); never reuse an old record
   for a new change.
3. Negative conclusions ("no X recorded") hold only for that snapshot. Do not
   restate them as permanent provider capabilities, and never write an
   absence as an indefinite negation.
4. When format drift is found, mark the affected support explicitly as
   `supported` / `legacy` / `pending` (e.g. "current-format support pending
   until refreshed against the newest version") and keep the
   unsupported/legacy diagnostic truthful.
5. Never auto-upgrade the user's installation and never write provider data:
   documentation and adapter refresh is read-only with respect to provider
   storage and installed versions.

When capability or format-support wording changes, update the provider table
in both READMEs and the evidence matrix, then run `npm run
check:governance` and `git diff --check`.

### Pi evidence snapshot (2026-09-03)

Pi current upstream: package `@earendil-works/pi-coding-agent` npm `0.84.4`
(2026-08-28, tag `b79e4cc8…`), source repo
<https://github.com/earendil-works/pi-mono> (official `docs/session-format.md`
reference), HEAD `4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057` (2026-09-02).
Session format `CURRENT_SESSION_VERSION = 3`: v3 = v2 + rename
`message.role "hookMessage"` → `"custom"`; all other entry types (message /
model_change / thinking_level_change / compaction / branch_summary / custom /
custom_message / label / session_info) are unchanged from v2. Compaction
entries may carry `retainedTail` (materialized kept context, replacing
`firstKeptEntryId` in harness-generated compactions), `usage`, `details`, and
`fromHook`; toolResult messages may carry nested `usage`; Pi's own
session totals (`agent-session.js getSessionStats` / `usage-totals.js
getUsageCostBreakdown`) are billed/session totals over ALL recorded file
entries (assistant + toolResult + compaction/branch_summary usage, including
abandoned/history branches; recorded `totalTokens` fields only; retainedTail
copies never counted separately). Locally installed 0.82.1
writes v3; 547 live files (all v3) verified — no `role custom` /
`retainedTail` / toolResult-usage records present locally yet, so those
paths are covered by the official source/docs plus
`test/fixtures/pi-v3-current.jsonl`; nested `run-N/session.jsonl` files are
pi-subagents run artifacts (header `parentSession: null`, no lineage).

### Codex CLI evidence snapshot (2026-09-03)

The installed CLI is `0.152.1` (`codex --version`). The official
[`openai/codex` repository](https://github.com/openai/codex) released
`rust-v0.153.0`; its peeled release-tag commit is
`41e22fee981a63b3698df7ed36bad393cda24715`. The repository HEAD checked on
this date is `36984da4424cb91b6bc88c6af8d73207930ac729`; its current rollout
source defines `.jsonl.zst` compression, first-class
`token_usage_record` and `inter_agent_communication` items, and the v1
namespaced `multi_agent_v1/close_agent` tool. Local 0.152.1 rollouts contain `session_meta`,
`event_msg/token_count`, `response_item` collaboration calls, and
`inter_agent_communication_metadata`; the inspection snapshot had 413 records,
65 usage records, and no first-class communication item. The adapter accepts
plain and compressed rollouts, maps current usage records, and keeps
first-class communication in Runtime v3 actors/coordination rather than the
linear transcript. It normalizes `close_agent` to the protocol `interrupt`
kind. The checked-in current fixture is source-derived and bounded, not a
live capture. Cumulative
`turn_token_usage`/`thread_token_usage` fields are not counted as requests;
only the recorded per-response `usage` is used. Child lineage still requires
recorded parent/session metadata or a matching child rollout.

### Claude Code evidence snapshot (2026-09-03)

The installed CLI is `2.1.207` (`claude --version`). The npm package currently
publishes `2.1.259` on `latest`/`next` and `2.1.236` on `stable`; these are npm
dist-tags, not a local upgrade. The official repository
<https://github.com/anthropics/claude-code> has `HEAD` and release tag
`v2.1.259` at `f173a697aa6486945f1b9c4aa9ce5383d2c87db6` on this date. The
older installed release tag `v2.1.207` is `d4d8fbbb333c627d8fe2c1c583a5ccc26fdb1aed`.
The official docs describe project-scoped JSONL transcripts and document
subagent `system`/`compact_boundary` records with
`compactMetadata.trigger`/`preTokens`. The protocol recognizes that recorded
boundary and keeps it metadata-only; it does not turn background, teammate,
mailbox, or memory behavior into linear messages without a transcript record.
Assistant usage normalizes Anthropic's total input as
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, keeps
`output_tokens` inclusive of thinking while exposing mutually exclusive visible
output/reasoning components, and supports the observed nested `cache_creation`
object when the scalar is absent. Repeated assistant fragments with one
response id remain one usage record. The local snapshot contains 11 project
transcripts and 132 records (21 assistant usage records, 14 distinct response
ids, no sidechains, task notifications, or compaction boundaries); a read-only
adapter/protocol smoke loaded 11 sessions. Current 2.1.259 format support is
docs/upstream-verified; no live 2.1.259 transcript was available. The checked-in
fixture is source-derived bounded synthetic data, not a live capture.

### Hermes Agent evidence snapshot (2026-09-03)

The installed Hermes package is `0.19.1` (local source checkout
`840fb55a8aaeb69bfcd6f34a80e57f9a5bcd44ce`). The official release
`v2026.8.31` / Hermes Agent v0.21.0 has annotated tag object
`6e8f8418e6378eb2617e4de074e13dedd091b8af` and peeled source commit
`29112bef099274229cadff79cdff7bf7b99c4b77`; separately, current upstream
HEAD is `7b72fd12476aedc06a993d92c4337e2ceb214bc7`, rechecked immediately
before handoff. The release tag and HEAD are distinct evidence sources.
The local read-only `state.db` snapshot is
schema 23 with 4 sessions, 21 active messages, 1 child, 1 async delegation,
and 4 per-model usage rows; it has no compacted rows or memory/experience/
user/team/handoff tables.

Official current source documents schema 29, `messages.active`/
`messages.compacted`, and an `async_delegations` registry. The adapter reads
the active transcript boundary, keeps compacted history out of linear
messages/ToC, and records async handle/state as one background Task when that
registry evidence exists. A separately persisted delegate child is one
unbound AgentRun with its child session id; no handle-to-child binding or
second Task is inferred. Compression stays metadata-only context lineage; an
unrecognized async state or missing child session remains unknown.
Session aggregate token columns are consumed; the observed per-model rows
match those totals but are not separately added. No request ownership or
inherited/shared split is invented. The checked-in fixture is
source-derived bounded synthetic data, not a live transcript.

### OpenCode evidence snapshot (2026-09-03)

The installed CLI is `1.17.11` (`opencode --version`). npm `opencode-ai`
currently publishes `1.18.27` as the newest release. The official repository
is <https://github.com/anomalyco/opencode> (the historical `sst/opencode` URL
redirects there): release tag `v1.18.27` is
`4b7e19e315cca414121ba1d61523fef74bb3ae8b`, while the separately checked
repository HEAD is `b578b7261fc9ec4917fe272df5cc4bd8a056cd5d`.
The release schema keeps `message`/`part` as the read projection and defines
`todo`, `subtask`, and `compaction` records. The current task tool records
`background`, `jobId`, child `sessionId`, and bounded task-state result
envelopes. AgentSession maps those provider-owned facts to todo Tasks,
task-request/compaction events, and background AgentRuns; it does not infer
context artifacts from the empty local context-epoch table. The real local
read-only snapshot contained 131 sessions (73 with a parent), 182 todos,
2,968 messages, and 13,091 parts; no context epoch/input rows were populated,
and no background task envelope appeared. The regression shape is bounded
synthetic data derived from official source, not a live capture, and contains
no local transcript body. Because the current todo table has no row id, Task
identity uses a bounded fingerprint of stable recorded fields rather than
position alone; compaction tail anchors are emitted only when the referenced
message is present. The official Todo status contract documents `pending`,
`in_progress`, `completed`, and `cancelled`; an unrecognized status is skipped
with no invented lifecycle state. The synthetic fixture preserves the exact
source keys `CompactionPart.type/auto/overflow/tail_start_id`,
`SubtaskPart.type/prompt/description/agent/model/command`, and task metadata
`parentSessionId/sessionId/background/jobId` plus state `title` and the task
output `id/state` envelope.

## Contract boundary

Every adapter implements `ProviderAdapter`:

- stable lowercase `id`, display `name`, and `icon`;
- `detect()`, `getDataPath()`, `scan()`, and `getSession()`;
- normalized `getMessages()`, trusted `getTokenStats()`, and bounded `searchMessages()`;
- optional `exportSession()`, runtime-environment evidence, system-prompt evidence, structured conversation projections, and a provider-owned resume command;
- `protocolCapabilities` and `getSessionProtocol(sessionId)` for every readable session;
- `getStorageDiagnostic()` when a detected backend is known but unsupported.

IDs are canonical everywhere: scan results, lookup, URLs, metadata keys,
exports, resume commands, protocol references, and MCP requests. Use Unix
milliseconds. A malformed individual source file must not stop other sessions
from loading; preserve a bounded diagnostic and use `null` or an empty
collection where the contract permits unavailable optional data.

Raw source fields are normalized at the adapter boundary. Browser code must
not interpret provider schemas. Preserve nullable message fields (`thinking`,
tool name/input/result, tokens, metadata) explicitly, and keep reasoning,
assistant text, tool calls, and tool results inside their source response
boundary.

## Choose a reference adapter

| Source shape | Reference | Boundary to preserve |
|:---|:---|:---|
| JSONL transcript | `src/providers/claude-code/` or `src/providers/codex/` | Record order, response boundaries, and child evidence. |
| Branch-tree JSONL | `src/providers/pi/` or `src/providers/openclaw/` | In-file branches and canonical parent/session IDs. |
| Event-sourced JSONL with Zstd frames | `src/providers/deepseek-harness/` | Frame decoding, packed-row keys, source sequence, and required event vocabulary. |
| Provider-native SQLite | `src/providers/hermes/` | Provider schema, WAL snapshots, and lineage remain local to the adapter. |
| OpenClaw current SQLite + legacy JSONL coexistence | `src/providers/openclaw/` | `session_nodes` canonical keys vs legacy file window ids; exactly-once dedup (SQLite wins); legacy-only/unsupported/unreadable diagnostics. |
| OpenCode SQLite | `src/providers/opencode/` | Only the OpenCode schema is supported; arbitrary SQLite is not interchangeable. |

Shared helpers in `src/providers/shared/` are schema-neutral: file caching,
message/session projections, runtime evidence, canonical project mapping, and
Session Protocol validation/finalization. Do not move provider field
assumptions into those helpers.

## Session Protocol v2

Every registered provider must expose a protocol for every readable session.
Message remains the universal conversation projection; protocol v2 is the
structured harness contract.

Use canonical references at every graph and query boundary:

```ts
type SessionRef = { provider: ProviderId; sessionId: string };
```

The finalized protocol contains `version: 2`, a session descriptor, events,
relationships, tasks, agent runs, context artifacts, optional branches,
validation, completeness, and a provider revision.

### Events

Events retain source order and exact source anchors. `sequence` is dense and
one-based in AgentSession's normalized projection; timestamps never reorder
events. Emit a normalized category (`session`, `message`, `model`,
`reasoning`, `tool`, `task`, `run`, `context`, `control`, `team`, or
`unknown`) and a stable normalized kind while preserving provider-native kind
and bounded safe attributes in provenance/provider metadata.

Every value carries `provenance.fidelity`: `recorded` when the source stores
the fact, `derived` when the adapter reconstructs it. Unknown required source
semantics must leave the session incomplete with a diagnostic; unknown
ignorable events may remain `unknown` events. Never silently drop required
events.

### Relationships, Tasks, and AgentRuns

Relationships preserve type, direction, canonical source/target refs,
timestamp, provenance, and event/task/run anchors. Supported types are
`parent`, `spawned`, `forked`, `continued`, `compacted-into`,
`scheduled-run-of`, and `handed-off`. `spawned` is the only relationship that
implies detached subagent work; lineage and collaboration edges do not.

`Task` is requested work: status, title, owner/assignee, dependencies,
schedule, deadline, revision, and outcome. `AgentRun` is one attempt: mode,
agent/model, task, trigger, parent run, child session, timing, outcome, and
failure/cancellation reason. Keep run mode on `AgentRun`, never on `Task`.

### Context and branches

Context artifacts are metadata-first. Preserve kind, scope, origin,
`contentAccess`, source path, producer/consumer/citation links, source session
IDs, version/lineage, hash, redaction, and a short non-sensitive summary.
Never copy transcript or compaction text into an artifact. Emit context
lifecycle events (`context.loaded`, `context.reinjected`, `context.cited`,
`memory.generated`, `memory.consolidated`) only when the source supports that
observation; plain compaction alone is not a lifecycle event.

In-file branches use event/message IDs and remain branch topology. They never
create a second canonical session or a fabricated cross-session edge.

Implement with the factories and validator in
`src/providers/shared/session-protocol.ts`, then finalize through the shared
runtime path so validation, caching, revisions, and projections stay uniform.

## Configuration and launch boundaries

When a source has only an opaque project key, keep it as
`metadata.projectKey`. A user may provide an existing absolute directory in
the top-level configuration:

```json
{
  "projectPaths": {
    "my-tool": {
      "opaque-project-key": "C:\\work\\project"
    }
  }
}
```

This is viewer-owned lookup data; it never mutates provider storage and never
guesses a path. Add a provider CLI data-path flag only when the provider root
is configurable. A resume command is optional and must be a structured
provider-owned executable/argument specification. Do not advertise resume when
the source lacks a stable selector or project directory. DSH currently has no
default resume command.

Terminal launch is resume-only. Do not add write-capable management or launch
tools to AgentSession-MCP.

## Provider registration and MCP

1. Add the lowercase ID to `ProviderId` and register the adapter once in
   `src/providers/index.ts`.
2. Ensure unavailable providers remain in `getAllProviders()` while only
   detected providers enter `getAvailableProviders()`.
3. Keep provider-specific parsing and projections out of routes and views.
4. Confirm the MCP provider allow-list and tests accept the ID where the MCP
   package uses a static schema.
5. Keep all MCP tools read-only, bounded, and explicit that provider content
   is untrusted input.

## DeepSeek Harness requirements

For DSH, keep compatibility metadata synchronized with the checked-in snapshot:

- repository `deepseek-ai/deepseek-harness`;
- alpha.5 tag commit `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5` (official
  HEAD `49a606bc5b5934603f22a26957a07dc799ab0291`);
- tag `dsh-v0.1.2-alpha.5`;
- package `@deepseek-ai/dsh@0.1.2-alpha.5`;
- session format `0`; current SQLite schema `null`, legacy schema `17`
  (alpha.5 has no session-persistence SQLite plugin; its SQLite packages are
  a storage-kv facet and an FTS5 query backend).

JSONL is the primary backend. Test raw and multi-frame `.jsonl.zstd`, packed
`text-chunks`/`reasoning-chunks`/`tool-call-chunks`, zero-based upstream
sequence, range-encoded `sourceEventSeqs`, header identity, `request/header` and
`request/context`,
`session/end-seed`, fork seed length, source-event citations, surface
replacement, compaction, cancellation/interruption, workflow/subagent facts,
`agent/inbox/spliced`, Agent Teams member/task/mailbox events, `model/selection`,
`subagent/model-selection-policy`, and `session-log-deepseek/delivery-accepted`.
These records are control/model/delivery facts, not ordinary messages. Preserve
dangling references as unresolved diagnostics; never invent a readable child
session. Keep the alpha.3-derived and rc.8 fixtures as readability regressions
and the official alpha.5 web snapshot (byte-for-byte) as the current fixture,
synthesising its omitted `seq`/`time` per upstream `parseSessionLog`.

If legacy SQLite persistence or another known backend is detected but unsupported,
return an explicit storage diagnostic naming the detected and expected schema.
Never silently treat durable data as an empty provider.

## Tests and acceptance

Use provider-owned fixtures for current, legacy, malformed, unavailable,
derived, unsupported, dangling, and cyclic records. Check:

- canonical IDs and source-order sequence stability;
- parser corruption isolation and cache invalidation;
- nullable message normalization and token non-duplication;
- truthful capability descriptors and protocol validation diagnostics;
- relationship anchors, Task/AgentRun separation, branch topology, context privacy, and canonical links;
- unavailable and unsupported-backend behavior;
- `/api/providers`, `/protocol`, Runtime summary/events/graph, and the detail page;
- MCP search/get/timeline/context/event bounds and untrusted-content handling;
- a real local source, not fixtures alone, when provider schemas or paths are involved.

Run at least:

```powershell
npm run typecheck
npm test
npm run build
```

For user-visible changes, restart the loopback server, inspect `/api/providers`
and representative protocol/runtime responses, then run `npm run qa:e2e` at
desktop and 390px widths. Review `git diff --check`, confirm provider data was
not changed, and update both READMEs when public capabilities change.

## Related source

- `src/providers/interface.ts` — authoritative adapter contract.
- `src/providers/shared/session-protocol.ts` — v2 types, factories, validator, and finalizer.
- `src/protocol-runtime.ts` — cache and bounded Runtime projections.
- `src/providers/deepseek-harness/compatibility.ts` — DSH compatibility snapshot.
- `src/providers/pi/` — compact provider-specific protocol example.
- `packages/agentsession-mcp/src/session-history-server.ts` — read-only MCP boundary.
- [`docs/specs/runtime-protocol-workbench/`](./specs/runtime-protocol-workbench/) — requirements and design source.
