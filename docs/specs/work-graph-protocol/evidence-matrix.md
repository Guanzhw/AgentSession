# Work Graph protocol evidence matrix

Status: accepted research input

Date: 2026-09-02

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
Their current adapters are compatibility residue to remove, together with
registration, configuration, README, localization, tests, and the existing
"every registered provider" requirement, before provider migration to the new
contract. Until that removal stage lands, their existing v2 behavior remains
unchanged; neither is an input to the new protocol design.

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
| Codex | Six child sessions in `01a0576a-98e2-7c31-a265-6d98d5fbff12` become six derived Tasks and Runs. `NEW_TASK` is recorded when present. Goals and dependencies are missing. | Six real runs are `subagent`; recorded activity can preserve `background`, but this sample has none. Attempt and scheduling evidence are missing. | The parent records 6 spawn, 5 follow-up, 6 send-message, 28 wait, 15 list, and 1 interrupt calls. V2 projects six typed spawned relationships/tasks/runs while retaining the calls only as generic transcript/message-tool evidence; it lacks typed continuing-coordination facts. | Six recorded compactions become six metadata-only summary artifacts. Window ids exist in source records but no common context-version lineage exists. No memory/experience evidence is present. | Request usage and copied-prefix/duplicate identities are provider-normalized. The live list reports 82,713,620 tokens, but v2 cannot bind request usage to a Run or expose origin ownership. |
| Claude Code | `<task-notification>` and sidechains can provide recorded tasks and derived runs. The 11 local files inspected contain neither. | Sidechains map to `subagent`; foreground/background, attempts, scheduling, and teams are missing in current evidence. | Recorded sidechain lineage can be paired with task notifications. Handoff and continuing message/wait evidence are missing. | Compact lifecycle records are supported as recorded metadata-only summaries, but the inspected local files contain none. Memory/experience evidence is missing. | Assistant message ids deduplicate fragmented usage. The sampled session reports 63,490 tokens; v2 has no request/run ownership entity. |
| DeepSeek Harness alpha.3 | Native events include goal change, workflow, and team tasks; team `blockedBy` can become dependencies. Live data proves subagent work but not live goals or teams. | Native turn/step/tool lifecycle gives recorded execution evidence. Live child descriptors are `one-shot`; background, async, attempt, and scheduled execution remain missing or unknown. | Parent/descriptor lineage, inbox splice, delivery events, workflow, and team message vocabulary are recorded. Live sessions prove inbox and child interaction; fixtures prove teams, while handoff remains missing. | Recorded compaction lifecycle and request context are present. `seedLength` and `session/end-seed` establish inherited boundaries. No live memory/dream/experience evidence exists. | Usage components and inherited seed boundaries are recorded. A live child has 26,383 stored-family tokens but 13,362 owned-suffix tokens. Shared cache ownership and a public dedup identity are missing. |
| OpenCode | Native storage contains 182 todo rows, but the protocol does not consume them. A live root has 34 derived subagent tasks/runs. Goals and task dependencies are missing. | Tool part status/timing is available; runtime session state remains unknown. Background, async, attempt, and scheduled execution are missing. | `session.parent_id` is recorded and tool parts can pair a child session with a launcher. Mailbox, team, handoff, and continuing coordination are missing. | The inspected database has no populated context epoch/input evidence and the adapter exposes no context artifacts. | Session token columns are recorded. Tree aggregation includes each child once, but no inherited/shared attribution or protocol-level request identity exists. |
| Pi | Session files expose no Task or AgentRun abstraction. | No execution mode, attempt, or scheduler abstraction is recorded. | `parentSession` is lineage only and cannot distinguish rotation from explicit fork; it must not imply subagent work. | In-file branches, compaction, and branch summaries are recorded. Compaction becomes a metadata-only summary artifact. No memory/dream/experience evidence is present. | Active-branch assistant usage is direct; abandoned branches are excluded. The sampled session reports 4,995 tokens. No inherited/shared ownership evidence exists. |

Additional installed-provider evidence guards against false generalization:

- Hermes distinguishes compression continuation from delegation: compression
  yields `compacted-into` plus a context summary, while `_delegate_from` yields
  Task/Run/spawned facts. Its sampled root has 9,865 direct and 10,859
  family-inclusive tokens.
- OpenClaw records branch topology and may record `spawnedBy`, but the current
  adapter does not produce Task/Run entities. Its registry `contextTokens` is a
  capacity, not consumed usage. Trajectory context events currently remain
  outside the adapter.

The numeric observations above are ephemeral local observations captured on
2026-09-02; they are evidence for schema decisions, not committed test
fixtures. They can be reproduced from a running local Viewer with:

```text
GET /api/codex/session/01a0576a-98e2-7c31-a265-6d98d5fbff12/protocol
GET /api/claude-code/session/fc2b5510-5a53-4f54-9fba-500d73717c9f/protocol
GET /api/deepseek-harness/session/session-b9bef2b1-7d5b-4551-847b-71a6fa47d2e3/protocol
GET /api/opencode/session/ses_1ddf03616ffeTE5c6cbpUPMY3n/protocol
GET /api/pi/session/019f7a93-2297-76db-827d-ee366e46482e/protocol
```

The Codex observation used CLI `0.151.0-alpha.7.2`; DeepSeek Harness used
`0.1.2-alpha.3`. Other rows are source-shape observations rather than claims
about a stable provider release. Real transcripts remain provider-owned and
are intentionally not copied into this repository.

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
