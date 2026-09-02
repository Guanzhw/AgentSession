# Runtime Protocol Workbench design

Status: approved for implementation

## 1. Architectural decision

The product architecture becomes protocol-first without making provider raw
data mutable and without immediately deriving every legacy Message from the
protocol.

```text
provider-owned durable data
        |
        +--> provider parser --> Message compatibility projection
        |
        +--> provider protocol adapter --> validated SessionProtocol v2
                                             |
                                             +--> bounded protocol queries
                                             +--> Runtime Workbench
                                             +--> list summaries
                                             +--> MCP/export projections

SessionTree/Container/Metrics remain temporary shared conversation projections.
FlowTree and Session Analysis are removed.
```

Provider adapters own source interpretation. Shared protocol code owns
validation, normalized categories, entity links, bounded projections, and
render-ready shapes. UI/routes never branch on provider id.

## 2. Protocol v2

Version 2 is an internal/public JSON breaking change accepted by this major
refactor. The existing endpoint path remains, but returns a versioned body.

### 2.1 Canonical references

```ts
interface SessionRef {
  provider: ProviderId;
  sessionId: string;
}

type ProtocolEntityRef =
  | { kind: "session"; ref: SessionRef }
  | { kind: "event" | "task" | "run" | "artifact"; id: string };
```

Provider adapters may construct a provider-local protocol before the server
adds the provider id. All graph/query/API boundaries use `SessionRef`.

### 2.2 Session facts

`SessionProtocol` gains:

- `version: 2`;
- a session descriptor containing ref, state, origin, timestamps, cwd, harness,
  fork seed boundary, inherited event count, and provenance;
- events, relationships, tasks, agent runs, context artifacts, branches;
- validation diagnostics and completeness.

Session state is `unknown | queued | running | waiting_input | blocked |
completed | failed | cancelled | interrupted`.

### 2.3 Events

Events retain source-order `sequence`, exact timestamp, turn/step/correlation
anchors, and provenance. They add a normalized category:

```text
session | message | model | reasoning | tool | task | run |
context | control | team | unknown
```

Core normalized kinds include:

```text
session.started / session.ended / session.seed-boundary
message.user / message.assistant / message.tool
model.request / model.response / model.retry
tool.called / tool.completed
task.created / task.updated
run.started / run.completed
context.loaded / context.injected / context.compacted /
context.reinjected / context.cited
control.approval / control.permission / control.sandbox /
control.schedule
team.member / team.task / team.message.queued /
team.message.delivered
```

Provider-native type and bounded safe attributes stay in provenance/provider
metadata. Unknown required source events make the session incomplete; unknown
ignorable events become `unknown` events.

### 2.4 Relationships and graph links

Session relationship kinds remain typed and add anchors:

```text
parent | spawned | forked | continued | compacted-into |
scheduled-run-of | handed-off
```

`spawned` alone implies subagent execution. Fork/continuation/compaction remain
lineage. Handoff is collaboration and does not imply either.

The protocol workbench projection derives graph edges among session, event,
task, run, and artifact entities from explicit typed fields. These derived UI
edges do not become new provider facts.

### 2.5 Task and AgentRun

Task owns requested work, dependencies, owner/assignee, status, scheduling,
deadline, and timestamps. AgentRun owns one attempt: mode, agent/model,
parent/child run, trigger event, attempt number, child session, timing, state,
outcome, and recorded failure/cancellation reason.

Snapshots such as DSH Team tasks use stable task id plus revision. A later
revision updates the same task projection and remains visible in its source
events.

### 2.6 Context and branches

Context artifacts remain metadata-first and content-safe. They gain explicit
producer/consumer/citation event/run references and version/lineage metadata.
The existing bounded content endpoint may expose source content only when an
existing provider evidence capability already authorizes it.

Branch topology is a provider-optional domain over event/message ids:

```ts
interface SessionBranch {
  id: string;
  parentBranchId: string | null;
  forkEventId: string | null;
  headEventId: string | null;
  selected: boolean | null;
  provenance: EventProvenance;
}
```

It never creates a new canonical session.

## 3. Validation

`validateSessionProtocol(protocol, capabilities)` returns:

```ts
interface ProtocolValidation {
  ok: boolean;
  completeness: "complete" | "partial" | "invalid";
  errors: ProtocolDiagnostic[];
  warnings: ProtocolDiagnostic[];
}
```

Diagnostics have a stable code, bounded message, entity ref, and provenance.
Validation is pure and does not repair source facts. Adapter accessors finalize
through one shared helper that sequences, validates, freezes, and caches the
protocol. Routes return known-but-invalid sessions with diagnostics; unknown
sessions remain 404 and unsupported providers disappear because every provider
now supplies at least derived events.

## 4. Provider coverage

### Existing protocol providers

Codex, Claude Code, Pi, Hermes, and DSH migrate to v2 and fix capability
overclaims. Their current source-specific tests remain, rewritten around the
validator and graph anchors.

### New protocol providers

- OpenCode derives events from normalized messages/parts and uses canonical
  parent/child records for relationships and tasks/runs.
- OpenClaw preserves its in-file active path plus branch topology and registry
  spawn evidence.
- Copilot exposes event-log messages/tools and inline-agent task/run facts but
  does not invent independently resumable child sessions.
- Gemini exposes derived message/model/tool events and truthful `none` domains
  for facts its legacy JSON does not store.

## 5. DSH compatibility strategy

The adapter declares a compatibility snapshot containing upstream commit/tag,
npm latest/next, session format, known core event types, and SQLite schema.
Tests compare the checked-in snapshot with parser fixtures so an upstream
refresh is an explicit maintenance operation.

JSONL remains the primary supported backend. The adapter validates header
identity, current project/session layout, duplicate canonical ids, encoding
mixes, packed-row exact keys, contiguous zero-based upstream seq, seed boundary,
and surface/source-event references.

SQLite schema 17 is detected. Initial implementation may return a provider
diagnostic instead of reading it, because upstream ships no migration guarantee
and no default profile selects it. Silent absence is forbidden.

`agent/inbox/spliced` and Team events are accepted as log-only protocol facts.
They are never projected to ordinary Message history unless upstream surface
semantics explicitly make them model-visible.

## 6. Query/API design

```text
GET /api/:provider/session/:id/protocol
GET /api/:provider/session/:id/runtime/summary
GET /api/:provider/session/:id/runtime/events
GET /api/:provider/session/:id/runtime/graph
```

The full endpoint returns the validated v2 snapshot. Runtime endpoints accept
strictly bounded query parameters. The graph returns render-ready nodes/edges,
missing/unavailable placeholders, diagnostics, and truncation metadata.

Protocol caching is keyed by provider id, session id, and a provider protocol
revision. File adapters use file/family revisions; SQLite adapters use database
revisions. List summaries and Runtime routes share the cache.

## 7. Runtime UI

Runtime replaces Execution and Analysis. It is server-rendered first, with
small browser enhancement code for lens selection, filtering, pagination, and
cross-highlighting.

Lenses:

- Summary: state, capability coverage, counts, anomalies, latest structural
  activity;
- Events: virtual/paged ordered timeline;
- Work: Task and AgentRun hierarchy/attempts;
- Sessions: time-oriented lineage/orchestration graph plus accessible list;
- Context: artifacts, compactions, injections, citations, inherited context.

The UI uses one detail drawer for evidence and provenance. It does not recreate
the Flow side inspector or render ordinary conversation twice.

## 8. Deletion design

### Flow

Delete `flow-tree` generators, adapter method, support predicates, routes,
payload/export fields, lazy panel, inspector JS, CSS, locales, docs, and tests.
Execution evidence is rendered by the Runtime Work lens from protocol
Task/AgentRun/relationship entities.

### Analysis

Delete all `src/analysis*.ts`, analysis routes/view, config/settings surfaces,
external launch and implementation handoff, SEA assets, docs, CSS/JS/locales,
and dedicated tests. Existing run directories remain untouched.

Move opaque project-directory mapping to a top-level `projectPaths` provider
configuration used only by provider path resolution. Keep runtime-environment
and system-prompt evidence.

## 9. Migration and rollback

The implementation lands in reviewable commits:

1. specification and protocol v2 core;
2. provider protocol coverage including current DSH;
3. Runtime query/read model and UI;
4. Flow and Analysis deletion plus configuration migration;
5. documentation, QA, and release cleanup.

There is no runtime feature flag preserving old Flow/Analysis. Git history is
the rollback mechanism. Provider data is never migrated, so rollback cannot
damage source sessions.

## 10. Backlog (open evolution items)

1. **Normalized event kind for harness environment reloads.** A session may
   reload plugins/skills/configuration mid-flight. No normalized kind exists;
   such records currently land in `context`/`control`/`unknown` events with
   provider-native types only. Propose `environment.reloaded` (category
   `control`), and `environment.loaded` for a startup inventory, once provider
   evidence demonstrates the recorded shape. Pending decision — the UI
   information design (`docs/design/ui-v2.md`) must not invent this kind.
   Later optional enhancement, evaluated only after the core provider/ownership
   work (see the work-graph Evolution backlog).
