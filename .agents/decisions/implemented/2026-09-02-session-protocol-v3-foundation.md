---
status: implemented
date: 2026-09-02
decision: Establish the Session Protocol v3 typed foundation for work, actor, coordination, context-version, and request-usage facts before implementing projections, provider mappings, or a Work Graph-first UI.
---

# Session Protocol v3 foundation

## Context

Real Codex, Claude Code, DeepSeek Harness, OpenCode, Pi, Hermes, and OpenClaw
data shows that Session Protocol v2 already preserves session identity, tasks,
runs, lineage, branches, and context artifacts, but loses continuous
coordination, context transformations, and request-level usage ownership.
Transcript-first navigation also expands inherited/background conversation into
the table of contents even when the useful fact is the work result or resulting
context. The evidence matrix is
[`docs/specs/work-graph-protocol/evidence-matrix.md`](../../../docs/specs/work-graph-protocol/evidence-matrix.md).

## Decision

Keep `(provider, sessionId)` as the canonical storage boundary and evolve the
shared protocol before adding provider-specific behavior. Add typed Goal,
Actor, Coordination, ContextVersion/Transformation, and UsageRecord facts with
provenance and bounded projections. Add domain projection coverage distinct
from fact provenance: `observed | not-observed | unknown | unsupported` states
must not be inferred from an entity count. Extend context artifact kinds for
optional experience and user information while retaining scope and
content-access controls.

Usage records represent real model requests and are counted once at their
owning execution. Inherited copied history is not a request. Context origin is
a multi-valued, per-component breakdown for input and cache components: one
request may combine direct, inherited, and shared slices. It is independent of
request identity and aggregate accounting scope, and never silently removes a
recorded request or cache read. Origin slices may cite their source sessions
when the provider records them. "Direct usage" means requests owned by the
selected session/execution; "inherited" and "shared" describe context origin,
not additional or subtractive request records. Work, Execution, Coordination,
and Context graphs are derived views over typed protocol facts, not a generic
graph storage contract.

Stabilize the protocol, validator, and fixtures before adding bounded
projections or mapping providers. Summary and Events remain cross-cutting inspection
utilities; the four graph domains supersede the current Work/Sessions/Context
lens partition described in
[`docs/specs/runtime-protocol-workbench/design.md`](../../../docs/specs/runtime-protocol-workbench/design.md#7-runtime-ui)
when the new UI lands. The v2 API, validation, bounds, and canonical reference
requirements remain in force.

Remove Gemini CLI and GitHub Copilot CLI from registration, configuration,
documentation, localization, and tests in a dedicated stage before migrating
providers to the new contract. That stage also replaces the existing
"every registered provider" requirement; until then their current v2 behavior
remains unchanged. Neither provider influences the new contract.

## Alternatives considered

- Extend the existing transcript and table of contents with more nested cards.
  Rejected because one linear order cannot represent parallel execution,
  repeated attempts, continuing coordination, and context lineage.
- Add a generic node/edge graph with arbitrary provider metadata. Rejected
  because it moves provider interpretation into consumers and weakens
  validation, provenance, and capability boundaries.
- Implement each provider first and infer a shared schema afterward. Rejected
  because current adapters already use incompatible derived meanings and would
  make the UI the accidental integration boundary.
- Deduplicate all shared-context input tokens across child sessions. Rejected
  because distinct provider requests and cache reads remain real usage even
  when their input origin is inherited or shared.

## Consequences

The v3 typed foundation is now the target protocol boundary; its bounded
projections and provider mappings remain later independently reviewed stages.
Conversation becomes one optional lens. Providers may support only a subset of domains and scopes;
missing memory, experience, user information, teams, background execution, or
handoff remains explicit. Existing v2 Task, AgentRun, ContextArtifact, and
SessionRelationship facts require a migration path rather than replacement.
The UI can show compact results and scoped context without inserting shared
background transcript into conversation navigation.

The existing Runtime Protocol Workbench requirements and design remain the
implemented v2 baseline. On implementation, this decision supersedes their UI
lens partition and registered-provider coverage only where stated above; the
documents must be updated in the same change rather than left contradictory.

## Verification

The foundation was verified with focused v3 fixtures for identity, references,
bounds, provenance, request usage ownership, coverage, source diagnostic
preservation, and context/goal lineage. `npm run review` and the full 300-test
suite passed. Real Provider/API evidence for Codex, Claude Code, DeepSeek
Harness, OpenCode, and Pi plus the current Runtime browser baseline informed
the schema; there is intentionally no v3 route or four-graph browser surface in
this foundation stage. An independent review found and verified correction of
invalid-versus-partial diagnostic precedence. Projection, API, provider, and UI
stages require their own decision updates and validation.
