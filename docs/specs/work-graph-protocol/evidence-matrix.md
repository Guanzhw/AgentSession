# Work Graph protocol evidence matrix

Status: accepted research input (updated 2026-09-03)

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

## Provider freshness snapshot (2026-09-03)

Verified by the main agent on 2026-09-03 against official docs, upstream
repository HEAD/releases, npm dist-tags, locally installed versions, and the
newest local real data. Every row is a **snapshot claim**: it does not cover
versions checked later, and negative observations apply only to that snapshot.
Pending rows mean the newest upstream format has not been refreshed against
the adapter yet — absence of verification is not evidence of absence of
features.

| Provider | Official docs / repository | Installed | npm dist-tag | Upstream HEAD / tag | Adapter format status |
|:---|:---|:---|:---|:---|:---|
| OpenCode | <https://opencode.ai/docs/> | 1.17.11 (Windows) | opencode-ai 1.18.26 | — | OpenCode SQLite schema support; refresh pending against 1.18.26 evidence. |
| Claude Code | <https://code.claude.com/docs/en/overview> · <https://github.com/anthropics/claude-code> | 2.1.207 | 2.1.258 | `aef74afe01f65b602258d6102b0da9730ac6f0aa` | Transcript parsing verified on installed 2.1.207; npm 2.1.258 / repo HEAD not yet verified. |
| Codex CLI | <https://github.com/openai/codex> + official Codex docs | 0.152.1 | 0.152.1 | `5e26f7621c1c470fe62350d61c9eb4d6c772a0da` | Native v3 mapping was verified on a **0.151 alpha historical snapshot**; it does not cover 0.152.1 — refresh pending. |
| OpenClaw | <https://github.com/openclaw/openclaw> · <https://docs.openclaw.ai/> | 2026.7.1-2 | 2026.8.2 | `f92a12c5813fb880ed6a05c4a728fd5f4ccc5473` | **Current-format SQLite support complete 2026-09-03.** Agent schema 19 verified at the recorded HEAD, the `v2026.8.2` release tag (schema SQL byte-identical, sha256 `54fa65dc…dc96f61e`), and newest main `2d9796d6…` (only package.json metadata differs). Canonical storage: `session_nodes(session_key, current_session_id)` + `session_windows` generations + `transcript_events`; legacy `sessions/*.jsonl` stay readable and deduplicated (SQLite wins exactly once). `sessions/*.jsonl` is **legacy/archive**. Live local validation unavailable (local install `2026.7.1-2` is pre-flip, no state dir), recorded explicitly. |
| Hermes Agent | <https://hermes-agent.nousresearch.com/docs/> · <https://github.com/NousResearch/hermes-agent> | v0.19.1 (upstream `0cd26ce9`, local `840fb55a`) | — | `1cb3ab617363ffab9e55239a7d2ab0d6f9c10473` | `state.db` conclusions hold only for this verified version and local samples; remote HEAD refresh pending. |
| Pi | <https://github.com/earendil-works/pi-mono> · package `@earendil-works/pi-coding-agent` | 0.82.1 | 0.84.4 | `4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057` | **v3 / 0.84.4 refresh complete 2026-09-03.** Official session format v3 verified against npm 0.84.4 source + `docs/session-format.md` + repo HEAD `4e69b0c2…` (2026-09-02; tag v0.84.4 = `b79e4cc8…`). v3 = v2 + rename `message.role "hookMessage"` → `"custom"`; entry types confirmed (session/message/custom/custom_message/model_change/thinking_level_change/compaction/branch_summary/label/session_info). Reader now maps custom-role message entries (display-gated), records retainedTail/fromHook on compaction evidence, and uses Pi's billed session total (`getSessionStats`/`usage-totals.js` over ALL recorded entries, incl. abandoned/history branches, `retainedTail` copies never counted) for token totals. 547 live v3 files scanned (all v3, incl. 49 nested `run-N/session.jsonl` subagent-run artifacts with `parentSession: null`) — no `role custom`/`retainedTail`/toolResult-usage records locally yet, covered by fixtures+official source. Former `@mariozechner/badlogic` references are **legacy**, not the current upstream. |
| DeepSeek Harness | <https://www.deepseek.com/harness/en/> · <https://github.com/deepseek-ai/deepseek-harness> | 0.1.2-alpha.5 (WSL global) | alpha dist-tag `0.1.2-alpha.5` (the `latest` tag points to an old rc — it is not the newest preview) | `49a606bc5b5934603f22a26957a07dc799ab0291` (alpha.5 tag `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`) | **Adapter snapshot is alpha.5 — refresh complete 2026-09-03.** Physical format unchanged from alpha.3 (version `0`, same event catalog, `seedLength` header line, packed rows, range-encoded provenance); official checked-in web snapshot adopted as fixture. Credentialed live alpha.5 run unavailable (auth failure). Alpha.3/rc.8 readers retained. |

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
| Codex | **Real-data row superseded.** The research-time observation below (2026-09-02, CLI `0.151.0-alpha.7.2`) is historical evidence and is replaced by the native v3 mapping in `.agents/decisions/implemented/2026-09-02-codex-native-v3-mapping.md`. Currently verified on `01a0576a-98e2-7c31-a265-6d98d5fbff12`: **1 goal / 13 tasks / 13 runs / 14 actors / 158 coordination observations / 11 context versions / 10 transformations**, all domains `observed`, and recorded request usage with **no origin slices** (Codex records none in the 0.151 alpha snapshot verified here). The old row: six child sessions became six derived Tasks and Runs; `NEW_TASK` recorded when present; goals/dependencies missing. | Research time: the six runs were `subagent`; recorded activity can preserve `background`, but that sample had none. Turn attempts ARE recorded for 0.151+ (`task_started`/`task_complete`/`turn_aborted`: timing, time-to-first-token, context window, mode kind) but map to no protocol Execution mode; scheduling evidence is missing. | Research time: the parent recorded 6 spawn, 5 follow-up, 6 send-message, 28 wait, 15 list, and 1 interrupt calls. The native v3 mapping now projects 158 typed coordination observations (spawn bound to child session/run/turn id, non-collaboration `wait`/`exec` excluded). | Research time: six recorded compactions became six metadata-only summary artifacts and no common lineage was provable. Superseded for 0.151+: recorded `window_id`/`previous_window_id`/`first_window_id` form a closed linear lineage (11 versions, no gap; first compaction links back to `session_meta.context_window.window_id`). | **No origin slices** — Codex does not record request context origins; per-request usage records exist (`usage:<session>:<ordinal>`) with `turnId` null (no recorded anchor). Research-time list total (82,713,620 tokens) is deliberately not carried as a permanent fact: session message/usage totals grow as sessions continue and are not stable facts. |
| Claude Code | `<task-notification>` and sidechains can provide recorded tasks and derived runs. The 11 local files inspected contain neither. | Sidechains map to `subagent`; foreground/background, attempts, scheduling, and teams are missing in current evidence. | Recorded sidechain lineage can be paired with task notifications. Handoff and continuing message/wait evidence are missing. | Compact lifecycle records are supported as recorded metadata-only summaries, but the inspected local files contain none. Memory/experience evidence is missing. | Assistant message ids deduplicate fragmented usage. The sampled session reports 63,490 tokens; v2 has no request/run ownership entity. |
| DeepSeek Harness (alpha.5 snapshot) | Native events include goal change, workflow, and team tasks; team `blockedBy` can become dependencies. Live alpha.3-era data proves subagent work but not live goals or teams; the official alpha.5 checked-in snapshot is a web fixture (single bash turn, no team/goal events). | Native turn/step/tool lifecycle gives recorded execution evidence. Live child descriptors are `one-shot`; background, async, attempt, and scheduled execution remain missing or unknown. | Parent/descriptor lineage, inbox splice, delivery events, workflow, and team message vocabulary are recorded. Live sessions prove inbox and child interaction; fixtures prove teams, while handoff remains missing. | Recorded compaction lifecycle and request context are present. `seedLength` and `session/end-seed` establish inherited boundaries. No live memory/dream/experience evidence exists. | Usage components and inherited seed boundaries are recorded. A live alpha.3-era child has 26,383 stored-family tokens but 13,362 owned-suffix tokens. Shared cache ownership and a public dedup identity are missing. |
| OpenCode | Native storage contains 182 todo rows, but the protocol does not consume them. A live root has 34 derived subagent tasks/runs. Goals and task dependencies are missing. | Tool part status/timing is available; runtime session state remains unknown. Background, async, attempt, and scheduled execution are missing. | `session.parent_id` is recorded and tool parts can pair a child session with a launcher. Mailbox, team, handoff, and continuing coordination are missing. | The inspected database has no populated context epoch/input evidence and the adapter exposes no context artifacts. | Session token columns are recorded. Tree aggregation includes each child once, but no inherited/shared attribution or protocol-level request identity exists. |
| Pi | Session files expose no Task or AgentRun abstraction. | No execution mode, attempt, or scheduler abstraction is recorded. | `parentSession` is lineage only and cannot distinguish rotation from explicit fork; it must not imply subagent work. | In-file branches, compaction, and branch summaries are recorded. Compaction becomes a metadata-only summary artifact. No memory/dream/experience evidence is present. | Active-branch assistant usage is direct; abandoned branches are excluded. The sampled session reports 4,995 tokens. No inherited/shared ownership evidence exists. |

Additional installed-provider evidence guards against false generalization:

- Hermes distinguishes compression continuation from delegation: compression
  yields `compacted-into` plus a context summary, while `_delegate_from` yields
  Task/Run/spawned facts. Its sampled root has 9,865 direct and 10,859
  family-inclusive tokens.
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
`0.1.2-alpha.3` for the live observations above (alpha.5 refresh was verified
against the official checked-in snapshot plus source codec evidence; the
credentialed alpha.5 live run was unavailable because the configured key
failed authentication, so no alpha.5 live numbers replace them). Other rows
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

This negative conclusion holds only for the audited snapshot. DSH alpha.5, OpenClaw current SQLite, and Pi 0.84.4 are now snapshot-verified (2026-09-03) and likewise show no origin slices; Codex 0.152.1, Claude 2.1.258, OpenCode 1.18.26, and Hermes remote HEAD remain **pending/unknown** — never "no slices".

| Provider | Request-context-origin evidence | Conclusion |
|:---|:---|:---|
| Codex | Recorded per-request usage components only (`token_count` → components; explicit empty `contextOriginSlices`). | **No slices** in the 0.151 alpha verified snapshot. 0.152.1 refresh pending. |
| DeepSeek Harness | `seedLength`/`inheritedEventCount`/session `end-seed` and the owned-suffix boundary establish session/context inheritance; they are not per-request token origin slices. Official alpha.5 snapshot/source inspected 2026-09-03: `TokenUsage` carries only component totals, no context-origin record. | **No slices** in alpha.5 snapshot and source — **no mapping** (do not force-map). |
| Claude Code | Assistant usage carries `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`/`reasoning_tokens`; no request-context-origin record. | **No slices in snapshot** (2.1.207 evidence). npm 2.1.258 / repo HEAD unverified. |
| OpenCode | Session/message token columns `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`/`reasoning_tokens`; no origin record. | **No slices in snapshot** (1.17.11 evidence). npm 1.18.26 unverified. |
| Pi | Per-record usage `{input, output, cacheRead, cacheWrite, totalTokens, cost}` (recorded field names from `docs/session-format.md`; live/provider-written records additionally carry `reasoning`, which is not in the documented `Usage` contract and is surfaced only as a recorded field); recorded on assistant messages and (per official docs/source) nested toolResult usage plus compaction/branch_summary summary usage; no origin record. | **No origin slices** — verified 2026-09-03 against npm 0.84.4 source (`usage-totals.js` `getUsageCostBreakdown` counts assistant + toolResult + summary usage under recorded component totals, no per-request origin), official `docs/session-format.md`, and 547 live v3 files. Reader totals now include those recorded totals (assistant + toolResult + compaction/branch_summary) across ALL recorded entries — Pi's billed session total (`getSessionStats` aggregates all entries, including compacted-away/abandoned history; `retainedTail` copies never counted) — and never infer direct/inherited/shared splits. |
| OpenClaw | Per-event usage `{input, output, reasoningTokens, cacheRead, cacheWrite, totalTokens}`; no origin record (verified in the current SQLite `transcript_events` shape 2026-09-03; same record shape as legacy JSONL). | **No slices** in the verified snapshot (agent schema 19 / legacy JSONL) — **no mapping**. |
| Hermes | Session-level token columns (input/output/reasoning/cache read/cache write) aggregated at the store boundary; no per-request origin record. | **No slices in snapshot** (v0.19.1 local `840fb55a` evidence). Remote HEAD `1cb3ab61…` unverified. |

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
