# Work Graph protocol evidence matrix

Status: accepted research input (updated 2026-09-08)

Date: 2026-09-02

> Update: the OpenClaw stage landed as
> [`.agents/decisions/implemented/2026-09-03-openclaw-current-sqlite-coexistence.md`](../../../.agents/decisions/implemented/2026-09-03-openclaw-current-sqlite-coexistence.md)
> and refreshed the snapshot row below to agent schema 19 (verified 2026-09-03;
> `session_nodes`/`session_windows`/`transcript_events` canonical, legacy JSONL
> archived with exactly-once dedup).
>
> Update: the Codex provider stage landed as
> [`.agents/decisions/implemented/2026-09-02-codex-native-v3-mapping.md`](../../../.agents/decisions/implemented/2026-09-02-codex-native-v3-mapping.md).
> Its recorded window ids form a linear context-version lineage
> (`window_id`/`previous_window_id`/`first_window_id`), so the earlier "no
> common context-version lineage" observation is superseded for 0.151+ rollouts;
> the four graph domains for Codex sessions are now native v3 facts rather than
> unknown. Other provider stages remain as ordered below.
>
> Follow-up audit (see
> [`.agents/decisions/implemented/2026-09-02-codex-new-format-user-messages-and-v3-audit.md`](../../../.agents/decisions/implemented/2026-09-02-codex-new-format-user-messages-and-v3-audit.md)):
> 0.151+ rollouts record user turns as `response_item` user rows tagged
> `user.text` (not `event_msg/user_message`); the parser now emits them.
> Recorded turn lifecycle (`task_started`/`task_complete`/`turn_aborted`
> with duration, time-to-first-token, context window, and mode kind)
> updates the Execution row below: attempts ARE recorded, but map to no
> protocol Execution mode, so Execution facts stay tied to subagent runs
> until an attempt entity exists. `world_state` snapshots (instructions,
> skills, environments) stay unmapped: the protocol artifact contract is
> metadata-first and would require synthesizing summaries.

> Current Codex refresh (2026-09-03): official `openai/codex` release tag
> `rust-v0.153.0` (peeled commit
> `41e22fee981a63b3698df7ed36bad393cda24715`) and repository HEAD
> `36984da4424cb91b6bc88c6af8d73207930ac729` add
> `.jsonl.zst`, first-class `token_usage_record` and
> `inter_agent_communication`, plus namespaced v1 `multi_agent_v1/close_agent`. The adapter
> now reads compressed rollouts, maps per-response usage, projects
> communication only into Runtime v3 actors/coordination, and normalizes close
> to `interrupt`; cumulative turn/thread usage is not
> counted again. Installed 0.152.1 local rollouts remain legacy-shaped and
> were smoke-tested read-only. See
> [the implemented decision](../../../.agents/decisions/implemented/2026-09-03-codex-current-compatibility.md).

## Provider freshness snapshot (2026-09-08)

OpenCode freshness supersedes the earlier 2026-09-03 row: on 2026-09-08,
`opencode-ai` latest is `1.18.29`, the release tag is
`16747470f976aca3d362ad730bcd3fe82ecc2c9a`, comparison tag `v1.18.27` is
`4b7e19e315cca414121ba1d61523fef74bb3ae8b`, and the separately checked
upstream HEAD is `ecbc6ccac85b3e8087b6445e584318419b9e2b34`. The official
source diff is empty for the session SQL, todo, v1 session schema, and
OpenCode session/tool files; v1.18.29 is a Codex OAuth model-filtering bugfix,
not a session-storage schema change. Both tags retain the `message`/`part`
projection, todo primary key `(session_id, position)`, `subtask`/`compaction`,
ToolPart `callID`, `background`/`jobId` metadata, and task-state result
envelopes. The OpenCode native-v3 implementation and bounded source-derived
fixture are covered by the implemented decision for this stage.

Verified by the main agent, with the OpenCode, Claude Code, Hermes, and Pi rows
refreshed on 2026-09-08 and the remaining rows last refreshed on 2026-09-03,
against official docs, upstream
repository HEAD/releases, npm dist-tags, locally installed versions, and the
newest local real data. Every row is a **snapshot claim**: it does not cover
versions checked later, and negative observations apply only to that snapshot.
Pending rows mean the newest upstream format has not been refreshed against
the adapter yet — absence of verification is not evidence of absence of
features.

| Provider | Official docs / repository | Installed | npm dist-tag | Upstream HEAD / tag | Adapter format status |
|:---|:---|:---|:---|:---|:---|
| OpenCode | <https://opencode.ai/docs/> · <https://github.com/anomalyco/opencode> | 1.17.11 (Windows) | opencode-ai latest 1.18.29 | HEAD `ecbc6ccac85b3e8087b6445e584318419b9e2b34`; tag `v1.18.29` `16747470f976aca3d362ad730bcd3fe82ecc2c9a` | **Current-format refresh complete 2026-09-08.** The relevant session/tool schema is unchanged from v1.18.27. Native v3 preserves finalized v2 facts and adds evidence-backed Coordination plus canonical assistant-message Usage. Local read-only snapshot: 131 sessions / 73 parent links / 182 todos / 2,968 messages / 13,091 parts; no context epoch/input rows and no background envelope. Synthetic regression shape is bounded and source-derived, not live capture. |
| Claude Code | <https://code.claude.com/docs/en/overview> · <https://github.com/anthropics/claude-code> | 2.1.207 | latest/next 2.1.263; stable 2.1.236 | `ab9b2cf7bb9e4f98ff264c07a22e46d83c29c558` (`v2.1.263`) | **Current-format refresh and native v3 complete 2026-09-08.** Official HEAD and `v2.1.263` release tag coincide; installed `v2.1.207` remains the local CLI. Official docs/source verify project JSONL, optional task-notification `tool-use-id`, `system/compact_boundary` + `compactMetadata.preTokens`, and assistant usage fields. Native v3 preserves finalized v2 facts, deduplicates repeated fragments by canonical assistant response id, retains missing-id notifications, maps `stopped` to cancelled, and leaves lineage/compact operations out of fabricated coordination/context results. Local snapshot: 11 project transcripts / 132 records / 21 assistant fragments / 14 distinct response ids; no sidechains/tasks/compaction. No live 2.1.263 transcript was available, so current-format support is official-source/docs verified. |
| Codex CLI | <https://github.com/openai/codex> + official Codex docs | 0.152.1 | 0.153.0 (tag `41e22fee981a63b3698df7ed36bad393cda24715`) | `36984da4424cb91b6bc88c6af8d73207930ac729` | **Current-format refresh complete 2026-09-03.** Release-tag source is anchored at peeled commit `41e22fee…`; current source-shape evidence is from repository HEAD `36984da…`. It confirms `.jsonl.zst`, `token_usage_record`, `inter_agent_communication`, and namespaced `multi_agent_v1/close_agent`; the checked-in fixture is source-derived bounded synthetic data, not a live capture. Local 0.152.1 smoke confirms legacy `token_count`/collaboration and metadata markers; 0.153.0 is not installed locally. |
| OpenClaw | <https://github.com/openclaw/openclaw> · <https://docs.openclaw.ai/> | 2026.7.1-2 | 2026.9.3 | release `1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7`; separate audit HEAD `0140d656b1012a3059fd8f769952485a58b8a4e5` | **Native v3 core complete 2026-09-09.** Agent schema 19 and schema SQL sha256 `fe93217454642e911608f81afc53c9fb3bb7c20cc32bc73f8f6eeaaf232b91b8` are verified from the release snapshot; moving upstream HEAD is recorded separately. v2 emits canonical events for every stored record and canonical branch refs; v3 maps only bounded `entry_json` Goal/actor/spawn/runtime/status/swarm/usage-lineage facts, with limited Goal states mapped to shared `blocked`. Advanced task/run/delivery tables remain deferred. Legacy JSONL remains readable and uses the same builder contract. Local install `2026.7.1-2` is pre-flip with one legacy session and no current SQLite sample, so live current-format validation is unavailable. |
| Hermes Agent | <https://hermes-agent.nousresearch.com/docs/> · <https://github.com/NousResearch/hermes-agent> | v0.19.1 (local `840fb55a8aaeb69bfcd6f34a80e57f9a5bcd44ce`) | v0.21.1 / `v2026.9.7` | release commit `2237be355906fbe6065ce1815711eee52b2d646e`; separate HEAD `6e2b8e070d28b1a3381a3fb290b6b8d6cce13cef` | **Current-format refresh and native v3 complete 2026-09-08.** Official release and HEAD provenance are separate. Current schema 30 evidence includes active/compacted message flags plus async `parent_session_id` ownership, legacy CLI `origin_session` routing fallback, and API wake-target `origin_session_id`; the wake target never claims provider-session ownership. The adapter keeps active transcript linear, preserves finalized v2 facts, and maps each canonical async row to independent dispatch/lifecycle/delivery observations. Persisted child AgentRuns remain terminal and unbound because no handle-to-child key exists. Local read-only schema 23 snapshot: 4 sessions / 21 active messages / 1 child / 1 async delegation / 4 model-usage rows; no compaction, memory, experience, user/team, handoff, or continuing-interaction rows. Fixture is source-derived bounded synthetic, not live capture. |
| Pi | <https://github.com/earendil-works/pi-mono> · package `@earendil-works/pi-coding-agent` | 0.80.10 | 0.85.1 | `f53ac1135149f03fd1e2a5bfd29861120eaf5b96` | **v3 / 0.85.1 refresh and native v3 complete 2026-09-08.** npm package tag/gitHead is `d981de1229ef899957bbe968bc8dcda02a21f477`; the independent upstream HEAD is `f53ac113…`. The official session format remains v3. The reader preserves finalized v2 facts, emits one bounded Usage record per canonical assistant request, maps readable `branch_summary`/compaction summaries to Context versions and transformations, and canonicalizes branch heads only when the matching event exists. The current official boundary is `firstKeptEntryId`; `retainedTail` is historical/harness extension evidence only. Local Pi 0.80.10 data was smoke-tested read-only; no live 0.85.1 transcript was available. `pending` is not terminal; only `stopReason=deferred` is terminal. |
| DeepSeek Harness | <https://www.deepseek.com/harness/en/> · <https://github.com/deepseek-ai/deepseek-harness> | 0.1.3-alpha.2 | alpha tag `dsh-v0.1.3-alpha.2` | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` | **Adapter snapshot is official alpha.2, verified from the local shallow clone.** Read-only storage accepts canonical `session.jsonl` (v0), `session.v1.jsonl` (frozen historical v1), and `session.v2.jsonl` (current v2), in raw or independently framed Zstandard encoding; each session root selects one highest generation and diagnoses mixed encodings or duplicate generation files. v2 stores one event per row, uses `isSeeded` plus the last tagged `session/end-seed` cut, embeds Assistant streams, and applies ordered surface replacement. v0/v1 packed rows remain legacy decode inputs. Credentialed live alpha.2 run remains unverified. |

## Purpose

This stage extends the existing protocol-first Runtime Workbench into a
work-graph-first multi-agent runtime viewer. The product shell and conversation
navigation are still predominantly session/transcript oriented even though the
validated v2 boundary and bounded Runtime queries already exist. Provider
sessions remain the canonical storage and lookup boundary, while the shared
protocol supplies typed facts for four orthogonal projections:

- **Work** — goals, tasks, dependencies, ownership, and outcomes;
- **Execution** — attempts, agents, models, foreground/background execution,
  scheduling, and terminal state;
- **Coordination** — spawn, delegation, messages, waits, interrupts, handoffs,
  and result delivery;
- **Context** — context versions and transformations plus scoped memory,
  experience, user information, instructions, skills, rules, and summaries.

This matrix separates source evidence from adapter reconstruction. `recorded`
means the provider owns the fact; `derived` means AgentSession reconstructs it
from recorded facts; `missing` means the inspected source does not record it;
`unknown` means available evidence cannot establish the semantic claim.

Summary and Events remain cross-cutting inspection utilities rather than graph
domains. The four graph projections supersede the existing Work, Sessions, and
Context lens partition when the new UI is implemented: Sessions topology moves
under Coordination, and Execution becomes independent of requested Work.

Gemini CLI and GitHub Copilot CLI are outside the continuing provider scope.
Their adapters plus registration, configuration, README, localization, tests,
and the "every registered provider" requirement were **removed in `c8c00a9`
(2026-09-02)**, so there is no residue left to remove here. Neither is an input
to the new protocol design; this paragraph is retained only as scope history.

## Current shared boundary

Session Protocol v2 already supplies canonical `SessionRef`, ordered events,
typed session relationships, `Task`, `AgentRun`, `ContextArtifact`, optional
branches, provenance, validation, and bounded Runtime projections. It can
represent task dependencies, attempts, execution modes, producer/consumer
artifact lineage, and session-level context summaries.

The following facts are not public protocol entities today:

- a durable goal and its relationship to tasks;
- an actor/team identity independent of a session or run;
- continuing coordination such as follow-up, mailbox delivery, wait,
  interrupt, and result acknowledgement;
- a context version and the transformation that produced it;
- request-level token identity, owning run, accounting scope, or
  direct/inherited/shared context attribution.

Existing list and Tree metrics expose selected-session direct usage and
family-inclusive usage. Provider adapters also remove copied inherited history
and duplicate usage records at their source boundary. Those projections are
useful but do not make usage ownership queryable in Session Protocol v2.

The new contract also needs a bounded evidence-coverage state for every domain
projection. Provenance fidelity continues to answer **how an observed fact was
obtained** (`recorded | derived`). Coverage separately answers whether facts
are `observed`, `not-observed`, `unknown`, or `unsupported` in this snapshot:

- `observed` requires one or more facts and their recorded/derived provenance;
- `not-observed` means the provider can expose the domain but this bounded
  source snapshot contains no matching fact;
- `unknown` means available evidence cannot decide the requested semantics;
- `unsupported` means the provider contract declares that it cannot expose the
  domain.

The research label `missing` maps to `not-observed` when a capable inspected
snapshot has no fact, or `unsupported` when the provider source/adapter has no
such evidence boundary. Entity count zero is never used to choose between
those states.

## Real-data matrix

| Provider | Work | Execution | Coordination | Context | Usage ownership |
|:---|:---|:---|:---|:---|:---|
| Codex | Native v3 remains the provider boundary. Historical 0.151 data above is retained, while current-format support additionally accepts official 0.153 first-class communication and per-response usage records; child Tasks/Runs still require recorded lineage or matching child rollouts. | Current local 0.152.1 records expose `session_meta`, `task_started`/`task_complete`, and collaboration response items; no execution mode is inferred from counts. Official v1 close output maps explicitly to completed/failed/unknown/requested by status evidence. | Historical native v3 observations remain valid; current first-class `inter_agent_communication` maps only to a recorded `message` with unknown delivery status, while collaboration namespaces include `multi_agent_v1` close. | Existing compacted window lineage mapping remains; compressed representation is decoded without changing source ordering. | `token_count` and official `token_usage_record.usage` each represent one request. Cumulative `turn_token_usage`/`thread_token_usage` are never counted as additional requests; no context-origin slices are recorded in the local 0.152.1 snapshot or official usage shape. |
| Claude Code | `<task-notification>` and sidechains can provide recorded tasks and derived runs. The 11 local files / 132 records inspected contain neither. | Sidechains map to `subagent`; foreground/background, attempts, scheduling, and teams are missing in current transcript evidence. | Recorded sidechain lineage can be paired with task notifications. Handoff and continuing message/wait evidence are missing from the snapshot. | Official docs record subagent `system`/`compact_boundary` with `compactMetadata.preTokens`; the adapter emits a metadata-only compaction event/artifact. The local snapshot contains no boundary or memory/experience records. | Assistant response ids deduplicate fragments; scalar/nested cache and inclusive output/reasoning components are normalized once. No context-origin slices or request/run ownership entity is recorded. |
| DeepSeek Harness (alpha.2 snapshot) | Native v3 maps recorded `goal/change` snapshots and uses clear tombstones as event evidence; recorded goal phase `paused` maps exactly to shared `GoalStatus.paused`, alongside `team/task` status, owner, `blockedBy`, and `writeScopes`. It does not infer goal membership or ownership. The official alpha.2 source establishes these mappings; local v0/v1 fixtures and minimal v2 fixtures keep the evidence bounded. | Native turn/step/tool lifecycle gives recorded execution evidence; v2 `assistant/attempt` is diagnostic only and never creates an assistant message. Native v3 workflow observations bind only exact recorded run/child ids; background, async, and scheduled execution remain unknown. | Native v3 preserves exact team/member actors, queued/delivered message ids and actors, and workflow lifecycle evidence. Current generation selection preserves one canonical root and keeps dangling children explicit. | Recorded compaction summaries become v3 transformations only when a readable result exists; lifecycle-only compaction remains an event. v0/v1 `seedLength` and v2 `isSeeded` plus tagged `session/end-seed` establish inherited boundaries, not token ownership. No live memory/dream/experience evidence exists. | Native v3 emits one usage record for each last-wins turn/step request from `data.usage` or final embedded stream usage, with retry boundaries opening a new slot; empty assistant messages still count. Direct/inherited/shared request-origin attribution remains unknown without provider evidence. |
| OpenCode | Native storage contains 182 todo rows; the adapter projects them as recorded `todo` Tasks keyed by the provider primary key `(session_id, position)`, with mutable content, priority, and timestamps excluded from identity. The official Todo status description lists `pending`, `in_progress`, `completed`, and `cancelled`; unrecognized values are skipped. Official current `subtask` parts provide task-request events, and task tool metadata/output provides derived subagent Tasks/Runs. Goals and task dependencies remain unrecorded. | Tool part status/timing is recorded; current task result envelopes distinguish running/completed/error and `background=true` maps to background AgentRuns. Runtime session state, attempts, and scheduled execution remain unknown. | `session.parent_id` is recorded and task tool metadata pairs a child session with a launcher. Mailbox, team, handoff, and continuing coordination remain unrecorded. | Official compaction parts map to metadata-only `context.compaction` events with recorded auto/overflow/tail fields; a tail anchor is emitted only when its message exists, and no context artifact is invented. Local context epoch/input tables are empty and memory evidence remains unknown. | Session token columns are recorded and tree aggregation includes each child once. Native v3 now emits one request UsageRecord per nonzero canonical assistant message when token components are present; totals are retained only when component-consistent and no origin slice is inferred. |
| Pi | Session files expose no Task or AgentRun abstraction. | No execution mode, attempt, or scheduler abstraction is recorded. | `parentSession` is lineage only and cannot distinguish rotation from explicit fork; it must not imply subagent work. | In-file branches, compaction, and branch summaries are recorded. Readable active summaries become bounded Context versions/transformations; `firstKeptEntryId` is the current official boundary, while `retainedTail` is historical/harness extension evidence only. No memory/dream/experience evidence is present. | Native v3 emits one Usage record per canonical assistant request, deduplicated by response id when recorded; aggregate/billed session totals and nested non-assistant usage are not promoted to request records. No inherited/shared ownership evidence exists. |

OpenCode native-v3 mapping (freshness 2026-09-08): todo Tasks use the exact
snapshot-local `(session_id, position)` source key; task-tool `callID` is kept
separate from `part.id`; background runs stay non-terminal without an explicit
`<task state="completed|error">` envelope; one launch observation is emitted
per normalized subagent Task/Run, with separate result-delivery observations
only for explicit result envelopes. Goal/Actor facts and context result
versions remain empty; compaction without a result is `unknown` coverage.

Additional installed-provider evidence guards against false generalization:

- Hermes distinguishes compression continuation from delegation: compression
  yields `compacted-into` plus a metadata-only context summary, while
  `_delegate_from` yields spawned facts. The current `async_delegations`
  registry is the single Task/handle source; a persisted child is a separate
  unbound AgentRun, so one live handle plus one child does not become two
  tasks. No child session or handle binding is invented when absent. The local
  read-only snapshot had 4 sessions, 21 active messages, 1 async delegation,
  and no compacted message rows; its aggregate token columns remain
  session/per-model totals.
- OpenClaw records branch topology (in-window JSONL record shape, current
  SQLite `transcript_events`) and may record parent/spawn/fork in
  `session_nodes`; Task/Run are never projected: both current SQLite and
  legacy builders always emit empty `tasks`/`agentRuns` arrays (capabilities
  `none`), and no verified delegation mapping exists in the verified agent
  schema beyond message-tool outcome receipts. Its registry `contextTokens`
  is a capacity, not consumed usage. The current SQLite reader (agent schema
  19, verified 2026-09-03) records `windowLineage` generations and
  session-level parent/spawn/fork facts.

The numeric observations above are ephemeral local observations captured on
2026-09-02; they are evidence for schema decisions, not committed test
fixtures, and any totals that grow with an ongoing session (message counts,
usage totals) must not be carried forward as permanent facts. They can be
reproduced from a running local Viewer with:

```text
GET /api/codex/session/01a0576a-98e2-7c31-a265-6d98d5fbff12/protocol
GET /api/claude-code/session/fc2b5510-5a53-4f54-9fba-500d73717c9f/protocol
GET /api/deepseek-harness/session/session-b9bef2b1-7d5b-4551-847b-71a6fa47d2e3/protocol
GET /api/opencode/session/ses_1ddf03616ffeTE5c6cbpUPMY3n/protocol
GET /api/pi/session/019f7a93-2297-76db-827d-ee366e46482e/protocol
```

The Codex observation used CLI `0.151.0-alpha.7.2`; DeepSeek Harness used
`0.1.2-alpha.3` for the historical live observations above. The current
adapter refresh is verified against the official alpha.2 shallow clone and
source codec evidence; a credentialed alpha.2 live run was unavailable. Other rows
are source-shape observations rather than claims
about a stable provider release. Real transcripts remain provider-owned and
are intentionally not copied into this repository.

## Usage origin slice audit (2026-09-03)

The bounded projection stage (task A, decision
[`2026-09-03-bounded-usage-origin-accounting`](../../../.agents/decisions/implemented/2026-09-03-bounded-usage-origin-accounting.md))
audited the seven providers against the **then-current adapters, fixtures, and
locally verified snapshots** for **per-request input/cache context-origin
slice evidence** before writing any provider-native mapping. Conclusion: **no
exact request-origin slices were found in that snapshot**, so no provider
mapping was added — the shared Execution origin aggregate (`usage.origins`)
reports known lower bounds and an honest `unclassified` remainder, and never
a fabricated direct/inherited/shared split. The shared projection
implementation stays valid; it is not rolled back.

This negative conclusion holds only for the audited snapshot. DSH alpha.2,
OpenClaw current SQLite, Pi 0.85.1, Claude Code 2.1.207, OpenCode 1.17.11,
and Hermes Agent 0.19.1 local data are snapshot-verified and likewise show no
origin slices; Codex 0.152.1 remains **pending/unknown** for newer local
formats — never "no slices".

| Provider | Request-context-origin evidence | Conclusion |
|:---|:---|:---|
| Codex | Recorded per-request usage components only (`token_count` or official `token_usage_record.usage` → components; explicit empty `contextOriginSlices`). Cumulative turn/thread totals are not requests. | **No slices** in the verified local 0.152.1 snapshot and official 0.153 usage shape; no mapping. |
| DeepSeek Harness | v0/v1 `seedLength` and v2 `isSeeded`/tagged `session/end-seed` establish session/context inheritance; they are not per-request token origin slices. Official alpha.2 `TokenUsage` carries component totals and no context-origin record. | **No slices** in alpha.2 source evidence — **no mapping** (do not force-map). |
| Claude Code | Assistant usage carries `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`/`reasoning_tokens`; the inspected records also carry nested `cache_creation` fields. No request-context-origin record. | **No slices in snapshot** (installed 2.1.207; npm latest/next 2.1.263, stable 2.1.236; official tag/HEAD `ab9b2cf7…`). Native v3 records one request per canonical response and leaves origins empty. |
| OpenCode | Session aggregate columns are `tokens_input`/`tokens_output`/`tokens_cache_read`/`tokens_cache_write`/`tokens_reasoning`; message JSON has a separate `tokens` object. No origin record in the local schema/data or official 1.18.27/1.18.29 session schema. | **No slices in snapshot** (1.17.11 evidence; npm latest 1.18.29, release comparison and HEAD separately verified 2026-09-08). |
| Pi | Per-record assistant usage `{input, output, cacheRead, cacheWrite, totalTokens, cost}` (live records may additionally carry `reasoning`); official current fields provide request components but no context-origin slice. Nested toolResult and summary usage remain recorded aggregate evidence, not assistant request identity. | **No origin slices** — verified 2026-09-08 against npm 0.85.1 package tag/gitHead `d981de12…`, independent upstream HEAD `f53ac113…`, official session docs, and the local 0.80.10 read-only smoke (no live 0.85.1 transcript). Native v3 emits bounded assistant-request Usage records and keeps origins empty; it does not treat `retainedTail` as current official evidence or infer direct/inherited/shared splits. |
| OpenClaw | Per-event assistant usage `{input, output, reasoningTokens, cacheRead, cacheWrite, totalTokens}`; no origin record (agent schema 19 `transcript_events`, same shape as legacy JSONL). | **No slices** — native v3 keeps `contextOriginSlices=[]`; aggregate/lineage fields are not request ownership evidence. |
| Hermes | Session-level `input_tokens`/`output_tokens`/`reasoning_tokens`/`cache_read_tokens`/`cache_write_tokens` are consumed at the store boundary; observed `session_model_usage` aggregates match them and are not added again. No per-request origin record. | **No slices in snapshot** (v0.19.1 local `840fb55a` evidence; official v0.21.1 / schema 30 release commit `2237be35…` and separate HEAD `6e2b8e07…` rechecked 2026-09-08). No inherited/shared ownership mapping or async/child correlation key. |

Because origin slices were absent in the audited snapshot, the Codex-style
projection row describes the current truth for those snapshot-verified cases:
`classified` zero lower bound, `unclassified` = known component total,
`complete: false`. When a provider later records real slices (after its
freshness refresh), the native v3 mapping pattern in
`.agents/decisions/implemented/2026-09-02-codex-native-v3-mapping.md` applies.

## Evidence-backed invariants

1. Provider session identity remains canonical. Work Graph ids add no alternate
   session lookup key.
2. Task and Run remain separate: a task can have zero or many attempts; mode,
   model, timing, and usage belong to execution.
3. Session lineage is not execution. `parent`, `continued`, `forked`, compacted
   continuation, and an in-file branch do not imply a subagent.
4. Launch acknowledgement is not completion. Result delivery, terminal child
   evidence, and interruption remain distinct coordination facts.
5. Compact is a context transformation, not a background task or memory write.
   The user-facing result is the resulting context version or recorded summary,
   while raw lifecycle evidence stays available on demand.
6. Memory, experience, and user information are optional scoped artifacts.
   Their absence is `not-observed`, `unknown`, `unsupported`, or provider
   unavailable according to coverage and availability evidence; it is never
   inferred from an entity count of zero, ordinary messages, or tool
   availability.
7. A copied transcript prefix is stored inherited history and contributes no
   usage record. A real child model request still counts once even when its
   input was assembled from inherited or shared context.
8. Cache reads are request usage. `shared` describes context origin or reuse;
   it is not permission to deduplicate distinct billed requests.
9. Recorded/derived provenance and observed/not-observed/unknown/unsupported
   coverage remain distinguishable in protocol, API, graph, and UI output.

## Confirmed protocol gaps

The next protocol stage should add bounded, typed facts rather than an
arbitrary node/edge bag:

- `Goal` and explicit goal/task membership;
- `Actor` and optional team membership, independent of session/run identity;
- coordination observations with typed sender, recipient, task/run/session
  anchors, delivery state, and provenance;
- context versions and transformations that link source context/artifacts to a
  resulting context, including compact/dream/memory/experience operations only
  when the provider records those semantics; an operation without an observed
  result remains a lifecycle event rather than a transformation;
- optional `experience` and `user-info` artifact kinds using the existing
  session/agent/project/user/organization scopes;
- request-level usage records with stable provider identity, owning session,
  timestamp/model, optional run/event/turn anchors, token components, and
  request accounting scope;
- optional per-component input/cache origin slices (`direct`, `inherited`, or
  `shared`) whose sums are bounded by their owning request component; one
  request may contain multiple origins, and output/reasoning is never assigned
  a context origin; source session references remain optional evidence;
- aggregate usage projections that report direct selected-execution usage and
  inclusive descendant usage without treating inherited stored history as new
  work.

The four UI graphs should be projections of these typed facts. They must not
become a second provider parser or a generic graph persistence format.

## Provider implementation order

After the shared protocol, validator, projections, and fixtures stabilize:

1. Codex, because live data proves continuous subagent coordination,
   compaction lineage, and inherited-history de-duplication.
2. DeepSeek Harness, because its recorded event vocabulary covers inbox,
   workflows, teams, delivery, request context, and seed boundaries.
3. Claude Code and OpenCode, using their narrower recorded task/sidechain and
   parent/tool/todo evidence without inventing absent semantics.
4. Pi, preserving branch and compaction facts while keeping task/run support
   explicitly unavailable.
5. Other supported providers only when real data establishes a mapping.

Each provider stage requires fixtures, a real-data API check, browser QA for
its visible facts, and an independent review.
