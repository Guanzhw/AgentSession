# Runtime Protocol Workbench research

Status: accepted input to the SDD requirements and design

Date: 2026-08-20

## Problem evidence

AgentSession currently presents itself primarily as a cross-provider session
reader. Its richer structured model exists, but most of it is exposed only by
`GET /api/:provider/session/:id/protocol`. The detail page consumes protocol
evidence mainly to attach subagent sessions to the legacy Flow/Execution view.
Events and context artifacts have no first-class product surface.

The current `SessionProtocol` contains five domains:

- ordered `SessionEventEnvelope` records;
- typed session relationships;
- separate `Task` and `AgentRun` entities;
- metadata-first `ContextArtifact` records;
- per-domain capability descriptors and provenance.

The protocol is incomplete as a harness inspection contract:

- event `kind` is open text and common providers usually emit only derived
  `message.*` envelopes, not a shared model/tool/control lifecycle;
- there is no whole-protocol validator for sequence density, unique identity,
  reference integrity, contradictory continuation edges, or capability claims;
- task dispatch, retry/attempt, cancellation, scheduling, and run outcome are
  only partially representable;
- context loading, injection, citation, inheritance, and consumption are mostly
  declared vocabulary without provider producers;
- relationship endpoints are bare session ids rather than canonical composite
  session references;
- the only HTTP query returns an unbounded single-session snapshot;
- At the original 2026-08-20 snapshot OpenCode, OpenClaw, Copilot CLI, and
  Gemini CLI exposed no protocol accessor. The later provider refreshes now
  supply OpenCode and OpenClaw protocol builders; the historical observation
  remains a record of the pre-implementation baseline.

Current local data confirms the remaining coverage gaps rather than a missing
accessor. OpenCode and OpenClaw now return validated protocols, while their
provider snapshots still have bounded orchestration/context domains; Claude
Code, Codex, Hermes, and Pi likewise return protocols with sampled sessions
dominated by derived message events and often-empty orchestration/context
domains.

## Simplification evidence

The dedicated Analysis subsystem is about 6,390 source/test/documentation lines
before CSS and broad integration call sites. It owns external analyzer launch,
artifact snapshots, run directories, proposal validation, implementation
handoff, settings, routes, SEA assets, and a large session-detail UI. It is a
separate product inside the viewer and distracts from durable harness facts.

The Flow-specific generator is smaller, but the full feature spans:

- `FlowTree` generation and provider adapter methods;
- two HTTP endpoints and multiple JSON/export fields;
- lazy detail-page rendering and an inspector;
- roughly 500 lines of browser behavior and a large CSS surface;
- overlapping topology predicates and fixtures.

`SessionTree`, `SessionContainer`, `SessionMetrics`, `AgentLoop`, runtime
environment evidence, system-prompt evidence, and provider-owned parsers are
not Flow or Analysis implementation details. They remain useful inputs to the
Protocol Workbench and conversation projection.

The pre-change baseline is `npm test`: 277 tests passed on 2026-08-20.

## DeepSeek Harness upstream snapshot

DeepSeek Harness is explicitly pre-release and rejects incompatible on-disk
formats rather than promising migrations. The upstream snapshot used by this
specification is:

- repository: `deepseek-ai/deepseek-harness`;
- tracked commit: `b2e3b2a0125854567a4a5fcba75782e42fe84901`;
- matching upstream tag: `dsh-v0.1.5-alpha.2`;
- package at inspection: `@deepseek-ai/dsh@0.1.5-alpha.2`;
- `SESSION_FORMAT_VERSION`: `3`, with frozen readable v0/v1/v2 generations.

Current upstream facts relevant to AgentSession (alpha.2/v3 refresh 2026-09-10):

- a session is an append-only typed event log; model messages are derived;
- event sequence numbers are zero-based and contiguous upstream;
- the current core event vocabulary includes turn/step boundaries, user and
  assistant messages/attempts, tool calls/results, request headers/context,
  feedback, team/workflow facts, `system/message`, deliverables/catalog
  facts, PTC dispatch, and `session/end-seed`; `assistant/chunk` remains a
  legacy v0/v1 decode shape only;
- surface events can cite earlier event sequences and replace surface nodes;
- fork lineage persists `parentSession`; v0/v1 use `seedLength`, while v2/v3
  use `isSeeded` and the last inherited `session/end-seed` marker;
- JSONL persistence supports raw and multi-frame Zstandard files for all four
  generations, with packed rows retained only for v0/v1 and canonical
  `startSeq/endSeq` replacement plus lossless `sourceEventSeqs` in v3;
- `0.1.2-alpha.3` removed the SQLite persistence backend; the current
  `0.1.5-alpha.2` release has not restored it. Its SQLite packages
  (`@deepseek-ai/dsh-storage-sqlite` kv facet,
  `@deepseek-ai/dsh-session-query-sqlite` FTS5) are not session persistence.
  Schema 17 remains relevant only for explicit diagnostics on existing
  legacy stores;
- the upstream `session-query` service now provides bounded event reads,
  surface projection, event tracing, lineage traversal, filtering, and search;
- the event map is declaration-merge extensible, so unknown non-ignorable
  events must remain a truthful compatibility failure.

The tracked current vocabulary includes `agent/inbox/spliced`, Agent Teams
events (`team/member`, `team/task`, `team/message/queued`, and
`team/message/delivered`), feedback put/delete, `model/selection`,
`subagent/model-selection-policy`, and
`session-log-deepseek/delivery-accepted`. They are log-only control/model/
delivery facts, not ordinary conversation messages.

The AgentSession DSH adapter understands the v0/v1 JSONL/Zstd layouts and packed rows,
plus the v2/v3 one-event-per-row layouts, range provenance, and surface/usage
projections. The retained alpha.5 web snapshot is historical v0 evidence only;
the current compatibility boundary is alpha.2/v3. Its protocol normalization preserves request
headers/context, `session/end-seed`, cited source events, surface replacement,
exact cancellation reasons, and the distinction between inherited and
child-owned events. Legacy SQLite stores remain explicitly detected rather than
being reported as an empty provider.

Because DSH changes quickly, upstream commit/package/schema information is a
tested compatibility input, not prose that can drift unnoticed. The official
alpha.5 checked-in web snapshot is retained byte-for-byte as historical v0
evidence; its omitted event envelopes are synthesised on read per upstream `parseSessionLog`
(`packages/test-support/llm-replay/src/index.ts`). The credentialed alpha.2
live run remains unavailable (key auth failure), and local Windows DSH currently
exposes v0 sessions only. The current adapter is verified against the official
alpha.2 v3 source clone and persisted source fixture; provider/API/browser v3
evidence therefore remains fixture-bound until a local v3 session is available.

## Independent review findings

Two Luna audits independently recommended:

- complete protocol coverage before deleting Flow;
- delete the Flow-specific generator/UI/routes while retaining shared
  tree/container/metrics/agent-loop foundations;
- remove 75-85% of the Analysis-specific subsystem;
- retain runtime environment and system-prompt evidence after decoupling them
  from Analysis configuration;
- add a protocol validator, bounded graph/query projection, and real-provider
  integration fixtures.

Pi's read-only review agreed on the protocol validator, protocol caching,
DSH sequence/provenance/dangling-edge risks, and central view projections. It
recommended retaining more of the old Analysis/Flow product. This spec rejects
that product decision because the explicit objective is simplification and a
runtime-inspector repositioning; the reusable evidence and validation ideas are
retained without the external analyzer product.

## Fixed constraints

- Provider-owned data remains read-only.
- Canonical identity is always `(provider, sessionId)`.
- Recorded and derived facts remain distinguishable.
- Unsupported and unavailable are not rendered as observed zero values.
- Unknown provider events are retained only when safe and ignorable; required
  unknown semantics produce diagnostics rather than invented projections.
- Large sessions and relationship families are always queried with explicit
  bounds.
- Existing viewer metadata remains viewer-owned.
- Generated `dist/`, runtime logs, temporary upstream checkouts, and analysis
  run directories are never committed.
