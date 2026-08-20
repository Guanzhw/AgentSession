# Runtime Protocol Workbench requirements

Status: approved for implementation

## Product objective

AgentSession SHALL move from a unified transcript reader to a local-first
inspector for how agent harnesses run, derive sessions, dispatch work, and
manage context. Conversation remains a useful projection, but it is not the
only or primary structured model.

## R1. Complete protocol contract

1. Every registered provider SHALL implement `getSessionProtocol()` for every
   readable session. A message-only provider SHALL return derived events and
   truthful `none` descriptors for unsupported domains rather than omit the
   protocol surface.
2. Protocol version 2 SHALL use canonical composite `SessionRef` values at
   graph/query boundaries while preserving provider-owned session ids.
3. Common events SHALL have a normalized category and kind for session,
   message, model, reasoning, tool, task, agent run, context, and control
   activity. Provider-native kinds MAY remain as provenance metadata.
4. The protocol SHALL represent harness/session state, origin, terminal
   outcome, fork seed boundary, and inherited event count when source evidence
   exists.
5. Task and AgentRun SHALL remain separate. AgentRun SHALL be able to represent
   attempt number, parent run, trigger event, scheduling reference, child
   session, timing, outcome, and cancellation/failure reason when recorded.
6. Session relationships SHALL preserve type, direction, source/target refs,
   triggering event/task/run anchors, timestamp, and provenance.
7. Context artifacts and lifecycle events SHALL express loading, injection,
   generation, consolidation, citation, inheritance, compaction, and
   reinjection only when provider evidence supports the fact.
8. In-file message/event branches SHALL be represented as branch topology and
   SHALL NOT be fabricated as cross-session relationships.

## R2. Protocol integrity

1. A shared validator SHALL check:
   - protocol version and canonical session identity;
   - event id uniqueness and dense sequence order;
   - task, run, artifact, and relationship identity uniqueness;
   - parent/trigger/producer/child references;
   - Task/AgentRun separation;
   - self/cyclic/contradictory lineage edges;
   - compaction continuation consistency;
   - capability descriptor truthfulness.
2. Validation SHALL return bounded errors and warnings. Corrupt individual
   sessions SHALL not prevent other sessions/providers from loading.
3. The HTTP workbench SHALL never present an invalid protocol as complete.
4. Provider fixtures SHALL cover recorded, derived, unsupported, corrupt,
   dangling, cyclic, current, and legacy shapes.

## R3. Query and projection surface

1. The existing full protocol endpoint SHALL remain read-only.
2. The server SHALL provide bounded summary, event-page, and graph projections
   without requiring the browser to interpret provider data.
3. Event queries SHALL support cursor/limit plus normalized category/kind,
   phase, task, run, session, and correlation filters where meaningful.
4. Graph queries SHALL support bounded depth/node count and SHALL report
   truncation, missing nodes, unavailable providers, and validation diagnostics.
5. Repeated protocol construction SHALL be cached by a provider-owned revision
   that changes when protocol-relevant source facts change.
6. Protocol projection code SHALL not branch on provider id.

## R4. Runtime Workbench

1. Detail navigation SHALL become `Overview | Conversation | Runtime | Raw`.
   The legacy Analysis tab SHALL be removed.
2. Runtime SHALL appear for every readable session and degrade by protocol
   capability, not by subagent topology.
3. Runtime SHALL provide server-derived lenses for:
   - summary and capability coverage;
   - ordered events;
   - tasks and AgentRuns;
   - related/forked/continued/compacted/scheduled sessions;
   - context artifacts and lifecycle.
4. The default lens SHALL summarize structural facts and anomalies rather than
   render one unbounded graph.
5. Recorded and derived evidence SHALL be visually distinct. Unsupported,
   unavailable, missing, invalid, and truncated states SHALL be explicit.
6. Runtime objects SHALL link to canonical session URLs and relevant
   Conversation anchors when available.
7. The page SHALL remain keyboard accessible, usable at 390 px width, and
   bounded for long sessions.

## R5. Remove Flow

1. The dedicated FlowTree model, provider accessor, routes, JSON/export fields,
   lazy panel, inspector, browser behavior, styles, locale strings, docs, and
   tests SHALL be removed after Runtime covers its required execution evidence.
2. SessionTree, SessionContainer, SessionMetrics, AgentLoop, Trace, and linked
   child-session evidence SHALL remain unless superseded by a simpler shared
   projection with equal evidence fidelity.
3. No compatibility shim SHALL centrally branch on provider id.

## R6. Remove Session Analysis

1. The external session analyzer, proposal validator, implementation handoff,
   analysis run listing, analysis routes, settings UI/config writing, detail UI,
   browser code, SEA internal assets, docs, and dedicated tests SHALL be
   removed.
2. Existing `.agentsession/analysis` directories SHALL not be deleted,
   migrated, launched, or modified. They simply cease to be product inputs.
3. RuntimeEnvironment and system-prompt evidence SHALL remain independent
   read-only provider capabilities.
4. Project-directory mappings currently nested under Analysis configuration
   SHALL move to provider-owned/general configuration before Analysis removal.
5. Analysis-title filtering SHALL be removed as part of the product cleanup.
6. Resume terminal launch MAY remain; its configuration and messaging SHALL no
   longer mention Analysis.

## R7. DeepSeek Harness current compatibility

1. DSH support SHALL be tested against an explicit upstream compatibility
   snapshot including commit, npm version/tag, session format, and SQLite schema.
2. The JSONL reader SHALL support current raw and multi-frame Zstd layouts,
   packed chunk rows, current core event vocabulary, `session/end-seed`, fork
   `parentSession`/`seedLength`, source-event citations, and surface operations.
3. DSH protocol normalization SHALL preserve request provider/model/context,
   tool call/result identity, usage, cancellation/interruption reasons,
   compaction, workflow/subagent evidence, and exact provenance where stored.
4. DSH `agent/inbox/spliced` and Agent Teams member/task/mailbox events SHALL be
   accepted and projected as control, team, task, and delivery facts without
   becoming ordinary conversation messages. Team task revisions, owners,
   dependencies, and delivery states SHALL remain observable.
5. Reconstructed DSH relationships SHALL be marked derived.
6. Dangling workflow references SHALL remain explicit unresolved references and
   SHALL NOT become fake readable child sessions.
7. Opt-in DSH SQLite persistence SHALL either be read through a validated
   current-schema adapter or produce a clear unsupported-schema/backend
   diagnostic. It SHALL never silently disappear.
8. Unknown required DSH events or incompatible session/schema versions SHALL
   fail that session truthfully without blocking other providers.
9. Packed-row decoding SHALL use exact-key validation. Rows with unknown fields
   SHALL remain opaque or fail truthfully; decoding SHALL NOT discard them.

## R8. Documentation and positioning

1. README, English README, provider guide, CLI/config help, package README, and
   E2E guidance SHALL describe AgentSession as a harness runtime inspector.
2. Removed Flow and Analysis behavior SHALL not remain in commands, settings,
   screenshots, API examples, or capability claims.
3. Provider capability tables SHALL distinguish recorded, derived, partial,
   unsupported, unavailable, and legacy behavior.

## R9. Verification and delivery

1. The implementation SHALL pass typecheck, full tests, build, binary smoke,
   and relevant focused tests.
2. Real local provider sessions SHALL validate protocol access and Runtime
   rendering; synthetic fixtures alone are insufficient.
3. Browser E2E SHALL validate desktop and narrow viewport, keyboard access,
   canonical session navigation, long-session bounds, and zero browser errors.
4. DSH verification SHALL include current official source/package evidence and
   a current-format fixture or real store when available.
5. `git diff --check`, independent review, and a requirement-by-requirement
   completion audit SHALL pass.
6. Intended changes SHALL be committed meaningfully, pushed to the correct
   GitHub remote, and local/remote SHA equality plus zero divergence SHALL be
   proven.

## Explicit non-goals

- Writing, repairing, migrating, deleting, or compacting provider-owned data.
- Controlling a remote harness or adding a write-capable management plane.
- Reconstructing hidden prompts or context not present in durable evidence.
- Preserving the old Flow or Analysis HTTP/UI contracts with compatibility
  wrappers.
