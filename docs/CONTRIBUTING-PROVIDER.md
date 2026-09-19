# Contributing a Provider

This guide explains how to add a local AI harness provider to AgentSession.
The adapter owns source parsing and provider-specific semantics; the viewer,
Runtime Workbench, and read-only MCP consume normalized contracts. Provider
databases, transcripts, and event logs must never be written, migrated,
deleted, or repaired.

`src/providers/interface.ts` is authoritative. Keep provider behavior under
`src/providers/<provider-id>/` and do not add central provider-ID branches in
routes, projections, or browser code.

### Work-history reader surface contract

The shared viewer presents Library / Statistics / Settings in the primary rail.
Session detail opens complete owned history, with source-positioned
collaboration inserts and full child histories loaded inline. Work and Events
are secondary disclosures. Provider adapters supply normalized content,
canonical identities and protocol evidence; the browser manages reading,
navigation and connection geometry. Missing fields remain empty or unknown.
See the [reader contract](design/runtime-reader-slice.md) for pane ownership,
search scope and progressive content.

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

### Pi evidence snapshot (2026-09-08)

Pi current upstream: package `@earendil-works/pi-coding-agent` npm `0.85.1`,
package tag/gitHead `d981de12…`, and source repo
<https://github.com/earendil-works/pi-mono> at independent HEAD
`f53ac113…`. The official session format remains v3. The reader preserves the
finalized v2 snapshot, emits one bounded Usage record per canonical assistant
request, and maps readable active `branch_summary`/compaction summaries to
Context versions and transformations. The current official boundary is
`firstKeptEntryId`; `retainedTail` is retained only as historical/harness
extension evidence and is not treated as a current standard field. The local
installation is Pi 0.80.10, and no live 0.85.1 transcript was available, so
current-format support is anchored in the official npm/source/docs evidence
plus bounded fixtures and adapter tests. Nested `run-N/session.jsonl` files
remain pi-subagents artifacts with `parentSession: null`, not lineage.

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

### Codex memory evidence snapshot (2026-09-19)

The retained V1 `stage1_outputs` / `memories/rollout_summaries` sample supports
an on-demand diagnostic lookup for later consolidation. The installed CLI is
`0.155.0-alpha.9.2` and Desktop is `26.915.4065.0`; these versions are not
attributed retrospectively to the September 17 sample. Current upstream also
has a separately stored V2 pipeline; this change does not advertise its
unverified artifact/diagnostic grammar. The checked official commits, links,
observed request forms and retention boundary are recorded in the
[artifact evidence snapshot](design/reader-memory-followups.md#provider-evidence-freshness).
Use recorded request identity and a derived current-file binding, not a time
match, a mutable global job row or a worker ID, to associate downstream work.

### Claude Code evidence snapshot (2026-09-08)

The installed CLI is `2.1.207` (`claude --version`). The npm package currently
publishes `2.1.263` on `latest`/`next` and `2.1.236` on `stable`; these are npm
dist-tags, not a local upgrade. The official repository
<https://github.com/anthropics/claude-code> has `HEAD` and release tag
`v2.1.263` at `ab9b2cf7bb9e4f98ff264c07a22e46d83c29c558` on this date. The
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
response id remain one native-v3 request usage record; an inconsistent explicit
total is retained as unknown rather than replaced by a computed total. Missing
task-notification `tool-use-id` does not discard the notification, and `stopped`
maps to cancelled. The local snapshot contains 11 project
transcripts and 132 records (21 assistant usage records, 14 distinct response
ids, no sidechains, task notifications, or compaction boundaries); a read-only
adapter/protocol smoke loaded 11 sessions. Current 2.1.263 format support is
docs/upstream-verified; no live 2.1.263 transcript was available. The checked-in
fixture is source-derived bounded synthetic data, not a live capture.

### Hermes Agent evidence snapshot (2026-09-08)

The installed Hermes package is `0.19.1` (local source checkout
`840fb55a8aaeb69bfcd6f34a80e57f9a5bcd44ce`). The official current release is
`v2026.9.7` / Hermes Agent v0.21.1, with release source commit
`2237be355906fbe6065ce1815711eee52b2d646e`; separately, current upstream
HEAD is `6e2b8e070d28b1a3381a3fb290b6b8d6cce13cef`. The release tag and HEAD
are distinct evidence sources, and the official source declares schema 30.
The local read-only `state.db` snapshot is
schema 23 with 4 sessions, 21 active messages, 1 child, 1 async delegation,
and 4 per-model usage rows; it has no compacted rows or memory/experience/
user/team/handoff tables.

Official current source documents schema 30, `messages.active`/
`messages.compacted`, and an `async_delegations` registry. The adapter uses
`parent_session_id` as the canonical persisted spawner, retains
`origin_session` as a legacy CLI session-key fallback, and does not treat the
current API completion wake target `origin_session_id` as ownership. It reads
the active transcript boundary, keeps compacted history out of linear
messages/ToC, and records async handle/state as one background Task when that
registry evidence exists. A separately persisted delegate child is one
unbound AgentRun with its child session id; no handle-to-child binding or
second Task is inferred. Compression stays metadata-only context lineage; an
unrecognized async state or missing child session remains unknown.
Session aggregate token columns are consumed; the observed per-model rows
match those totals but are not separately added. No request ownership or
inherited/shared split is invented. Native Session Protocol v3 preserves the
finalized v2 facts and exposes separate dispatch, lifecycle, and result-delivery
observations; aggregate tokens remain `unknown` usage coverage because no
request scope is recorded. The checked-in fixture is source-derived bounded
synthetic data, not a live transcript.

### OpenCode evidence snapshot (2026-09-08)

The installed CLI is `1.17.11` (`opencode --version`). npm `opencode-ai`
currently publishes `1.18.29` as the newest release. The official repository
is <https://github.com/anomalyco/opencode> (the historical `sst/opencode` URL
redirects there): release tag `v1.18.29` is
`16747470f976aca3d362ad730bcd3fe82ecc2c9a`, comparison tag `v1.18.27` is
`4b7e19e315cca414121ba1d61523fef74bb3ae8b`, and separately checked repository
HEAD is `ecbc6ccac85b3e8087b6445e584318419b9e2b34`. The official source diff
for the session SQL, todo, v1 session schema, and OpenCode session/tool files
is empty between those tags; v1.18.29 is a Codex OAuth model-filtering bugfix,
not a session-storage schema change.
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
no local transcript body. Because the current todo table primary key is
`(session_id, position)`, Task identity uses that snapshot-local source key;
continuity after row reordering across snapshots is unknown. Tool correlation
uses recorded `callID`, while `part.id` remains the source identity for the
event/task/run. Background mode is terminal only with an explicit task result
envelope. Native v3 preserves finalized v2 facts, emits evidence-backed
launch/result observations and one request UsageRecord per canonical assistant
message, and leaves Goal/Actor/Context result domains empty or unknown. The
official Todo status contract documents `pending`, `in_progress`, `completed`,
and `cancelled`; an unrecognized status is skipped with no invented lifecycle
state. The synthetic fixture preserves the exact source keys `CompactionPart.type/auto/overflow/tail_start_id`,
`SubtaskPart.type/prompt/description/agent/model/command`, and task metadata
`parentSessionId/sessionId/background/jobId` plus state `title` and the task
output `id/state` envelope.

## Contract boundary

Every adapter implements `ProviderAdapter`:

- stable lowercase `id`, display `name`, and `icon`;
- `detect()`, `getDataPath()`, `scan()`, and `getSession()`;
- optional `getLibrarySessions()` for a cheap, current metadata-only snapshot
  of all visible canonical roots and descendants. OpenCode uses it to preserve
  live SQLite refresh behavior. Other providers use the startup index; Library
  does not rescan transcripts or construct protocols on navigation. An empty
  live snapshot replaces that provider's indexed rows for this request only;
- normalized `getMessages()`, trusted `getTokenStats()`, and bounded `searchMessages()`;
- optional `getSessionReaderSnapshot(sessionId)` for providers whose Reader
  accessors otherwise repeat expensive parsing. Capture the canonical session,
  normalized messages, inherited context and revision once per HTML/pane
  request. Its lazy `getProtocolSnapshots()` and `getOwnedReaderProjection()`
  reuse that source extent. Protocol failures stay inside the runtime
  diagnostic boundary; the finalized runtime cache does not retain the
  snapshot's raw-input closures. Codex implements this capability; other
  providers keep their existing accessors;
- optional `getInheritedContext()` disclosure when the provider records an
  inherited boundary separately from the owned transcript. Return the complete
  normalized prefix for shared bounded rendering. `sourceSession` may be null
  when its canonical identity was not recorded; readable background must not
  depend on knowing that identity;
- optional `getContextChangeResult(sessionId, checkpointId)` for on-demand
  recorded context-change result bodies, using canonical protocol checkpoint
  IDs and the provider's owned-record boundary;
- optional `getContextArtifactContent(sessionId, artifactId)` for a retained
  artifact body. Keep body text out of protocol snapshots; bind content reads
  to the exact versioned artifact ID and report stale versions explicitly.
  This read must not prepare the input transcript or its complete family;
- optional `getContextArtifactEvidence(sessionId, artifactId, request)` for
  on-demand retained operations associated with that exact artifact. Advertise
  it using `evidenceAccess: "on-demand"`, independently of body access. The
  provider owns discovery, source parsing, artifact binding and bounded cursor
  coverage; shared routes and Reader code consume typed activities and request
  records. Keep current-file bindings derived and request outcomes unknown
  unless the source records them. Diagnostic evidence does not become a
  discovered session, a local producer run, or conversation token usage. Closed
  Reader rendering, body reads and normal protocol revisions must not inspect
  diagnostic logs. See the [artifact evidence contract](design/reader-memory-followups.md);
- optional `exportSession()`, runtime-environment evidence, system-prompt evidence, structured conversation projections, and a provider-owned resume command;
- optional `getOwnedReaderProjection()` for providers whose legacy structured
  tree loads a complete family. Return the complete selected session tree plus
  canonical metadata-only child descriptors; reuse recorded protocol evidence
  supplied by the route for attachment. Child histories load through the same
  reader endpoint on demand. Keep full-tree exports and family-inclusive
  metrics semantically unchanged;
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

Recorded question replies can attach optional `Message.questionAnswers`
(`id`, `question`, `answer`) after provider-owned recognition. Codex recognizes
complete `send_user_message_question_reply` envelopes in recorded `user.text`
messages. Raw `content`, text parts, and source IDs remain unchanged; tree,
document, and JSON export may include the additive typed projection. Reader
body, ToC, and search use the readable presentation, with a `question-answer`
continuation field; `text` still resolves the original record. Unknown shapes
stay ordinary text, and question IDs alone do not establish a tool relationship.

## Choose a reference adapter

| Source shape | Reference | Boundary to preserve |
|:---|:---|:---|
| JSONL transcript | `src/providers/claude-code/` or `src/providers/codex/` | Record order, response boundaries, and child evidence. |
| Branch-tree JSONL | `src/providers/pi/` or `src/providers/openclaw/` | In-file branches and canonical parent/session IDs; OpenClaw v2 anchors every stored record and v3 maps only recorded native facts. |
| Event-sourced JSONL with Zstd frames | `src/providers/deepseek-harness/` | Frame decoding, packed-row keys, source sequence, and required event vocabulary. |
| Provider-native SQLite | `src/providers/hermes/` | Provider schema, WAL snapshots, and lineage remain local to the adapter. |
| OpenClaw current SQLite + legacy JSONL coexistence | `src/providers/openclaw/` | `session_nodes` canonical keys vs legacy file window ids; exactly-once dedup (SQLite wins); bounded `entry_json` normalization for v3 Goal/Actors/Runs; legacy-only/unsupported/unreadable diagnostics. |
| OpenCode SQLite | `src/providers/opencode/` | Only the OpenCode schema is supported; arbitrary SQLite is not interchangeable. |

Shared helpers in `src/providers/shared/` are schema-neutral: file caching,
message/session projections, runtime evidence, canonical project mapping, and
Session Protocol validation/finalization. Do not move provider field
assumptions into those helpers.

## Reader context-change bodies

The context-result accessor returns normalized summary availability, ordered
retained groups, derived source-order positions, omitted encrypted-field paths
and metadata-only image attachment references. It is separate from inherited
parent context. The reader calls it only when a checkpoint is opened or its
content continued; ordinary reader/protocol/graph preparation must not load
retained result bodies. Adapters without this accessor continue to use their
existing normalized checkpoint summary where recorded.

Keep raw provider field interpretation in the adapter. Preserve readable text
beside omitted fields, retain empty-versus-absent summary evidence, and never
copy ciphertext or image encodings into reader plaintext. Test canonical IDs,
owned-record isolation, complete body continuation and explicit availability.
The Codex adapter demonstrates this optional consumer; other adapters need
source evidence before adding it.

## Reader collaboration sources

When a recorded collaboration event has a readable normalized message or tool
call, bind its `messageId` and `toolCallId` on the event envelope at the provider
boundary. A coordination observation's local `eventId` refers to that same
event. Shared reader code resolves the existing content part; it does not parse
provider call names or construct message IDs from raw payloads.

Use `sourceEventRef` for an exact event owned by another canonical session.
`child-turn-completed` represents a child's recorded terminal lifecycle event;
its source owner must equal its `fromSessionRef`. Build that ID from the same
owned records and lifecycle helper used by the child protocol. Preserve the
recorded completion clock, and represent parent result delivery separately.

Validate reference shape and ownership locally. Only the owning session can
establish whether a referenced external event is currently readable. A missing
source stays explicit rather than becoming a nearby message or inferred edge.

## Session Protocol v2

Every registered provider must expose a protocol for every readable session.
Providers that otherwise reread the same input for v2 and native v3 may expose
`getSessionProtocolSnapshots(sessionId)`. It returns finalized `{ v2, v3 }`
from one source snapshot/revision, or null for an unknown session. The Reader
uses this optional capability and the existing bounded runtime cache; providers
must retain their independent accessors and must not retain raw preparation
input solely for the pair. See the
[paired preparation decision](../.agents/decisions/implemented/2026-09-17-atomic-reader-protocol-snapshots.md).
Providers with independently changing context storage may implement
`getProtocolRevision(sessionId)`. Runtime caches prefer it while token-stat
caches keep `getStatsRevision()`. Codex includes the selected memory row's
artifact/production-evidence identity, not every unrelated memory-store write.
Its request-local Reader snapshot freezes the same metadata and revision.
`ContextArtifact.contentSourceTime` identifies the saved input version;
`productionEvidence` carries a matching recorded job and its times separately
from producer run/event references. Optional `contextArtifactSourceState`
reports availability of the additional readable store without replacing
overall context coverage or suppressing recorded compaction evidence.
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

`getInheritedContext()` discloses readable copied transcript messages when the
stored seed boundary proves the prefix. The optional header `parentSession`
provides its source identity independently. It reuses the generation's append-origin message normalization,
retains source message/call IDs and sequence metadata, and leaves inherited
usage unattached. The accessor returns the full prefix for the shared reader's
40-message pages and long-field continuation; a missing parent file does not
erase the recorded reference. When the parent ID is absent, return
`sourceSession: null`: the Reader labels the source as unknown and still reads
the prefix without inventing a link. Lineage without copied messages does not
create a disclosure. Late-loaded pages reuse the mounted Reader's existing
pane namespace, so copied message IDs remain local to that history.
Owned messages, search, exports, ToC, protocol and token aggregation keep their
existing selection. System/plugin context and replacement surfaces retain
their existing system-prompt/protocol evidence paths.
See the [inherited-background decision](../.agents/decisions/implemented/2026-09-17-dsh-inherited-context-reader.md)
for source ownership and the verified real-sample boundary.

For DSH, keep compatibility metadata synchronized with the checked-in snapshot:

- repository `deepseek-ai/deepseek-harness`;
- alpha.2 tag commit `b2e3b2a0125854567a4a5fcba75782e42fe84901`;
- tag `dsh-v0.1.5-alpha.2`;
- package `@deepseek-ai/dsh@0.1.5-alpha.2`;
- session format `3` (with frozen readable v0/v1/v2 historical generations);
  current SQLite schema `null`, legacy schema `17`.

JSONL is the primary backend. Test raw and multi-frame `.jsonl.zstd`, packed
`text-chunks`/`reasoning-chunks`/`tool-call-chunks`, zero-based upstream
sequence, range-encoded `sourceEventSeqs`, header identity, `request/header` and
`request/context`,
`session/end-seed`, v2/v3 inherited marker cut, v0/v1 fork seed length, source-event citations, surface
replacement, compaction, cancellation/interruption, workflow/subagent facts,
`agent/inbox/spliced`, Agent Teams member/task/mailbox events, `model/selection`,
`subagent/model-selection-policy`, `session-log-deepseek/delivery-accepted`,
`system/message`, and `tool/ptc-dispatch*`.
These records are control/model/delivery facts, not ordinary messages. Preserve
dangling references as unresolved diagnostics; never invent a readable child
session. Keep the rc.8 fixture as a v0 readability regression; use small
source-derived v1/v2 fixtures plus the official v3 fixture for generation and surface behavior. Upstream web
snapshots may omit `seq`/`time` in their presentation form, while persisted v2/v3
rows carry the complete event envelope. Validate the released envelope/storage
codec and bounded payload facts consumed by AgentSession; do not copy the full
provider payload schema into the adapter.

The DSH adapter also exposes native Session Protocol v3 facts at the provider
boundary. Keep goal revisions/tombstones, team membership/tasks/mailbox
lifecycle, exact workflow run/child bindings, readable compaction results, and
per-request usage provenance recorded-only. Leave context-origin slices and
memory/experience/user-info/async domains empty or unknown unless a future
released DSH event proves them. The v3 projection is additive over the
finalized v2 snapshot; it must not replace the human append-origin transcript
with model-surface replacement state. Replay `goal/change` transitions using
the released alpha.2 rules; an invalid replay yields no normalized goal and a
bounded Work diagnostic while preserving every raw event. Native v3 retains
valid zero-token legacy assistant settlements even though existing aggregate
token-stat selection keeps its historical behavior. A parent-owned
`subagent/catalog` is an exact direct-child discovery fact: project its
recorded child id, creation time, mode, and label, plus a spawned/started
observation; bind the child actor/session only when that child is present, and
do not infer a Task or terminal Run. `deliverables/presented` remains a
recorded event with its call id and bounded file metadata/count; it does not
invent work entities.

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
