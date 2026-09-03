# Runtime Protocol Workbench implementation tasks

Status values: `[ ]` pending, `[-]` active, `[x]` complete

## S0. Specification and baseline

- [x] Record current architecture, local provider coverage, DSH upstream
  snapshot, Luna audits, Pi review, and baseline test result.
- [x] Define requirements, target design, deletion boundaries, and verification
  matrix.
- [x] Review this specification against implementation discoveries and keep it
  synchronized when a source-backed decision changes.

## S1. Protocol v2 foundation

- [x] Add versioned session descriptor, canonical refs, normalized event
  categories/kinds, run/task/context/branch extensions, and capabilities.
- [x] Add protocol validator/finalizer with stable diagnostics and integrity
  tests.
- [x] Add protocol cache/revision contract shared by list stats and routes.
- [x] Add bounded summary, event, and graph projection modules with tests.
- [x] Change full protocol API to return validated v2 output and distinguish
  unknown, incomplete, invalid, and unavailable states.

## S2. Complete provider coverage

- [x] Migrate Codex protocol and integration tests.
- [x] Migrate Claude Code protocol and correct mixed recorded/derived
  capability claims.
- [x] Migrate Pi protocol and add branch topology without inventing fork/spawn.
- [x] Migrate Hermes protocol and compression/delegation lineage.
- [x] Implement OpenCode protocol from native messages/parts/child sessions.
- [x] Implement OpenClaw protocol with active path, branches, and registry
  lineage; then refresh to current-format SQLite (agent schema 19,
  2026-09-03): `session_nodes` canonical keys, `session_windows` generations,
  `transcript_events` raw events; legacy JSONL stays readable with exactly-once
  dedup (SQLite wins).
- [x] Implement Copilot protocol with inline-agent task/run semantics.
- [x] Implement truthful derived Gemini protocol.
- [x] Add provider-wide contract tests for unknown/corrupt sessions and
  capability/validation consistency.

## S3. DeepSeek Harness refresh

- [x] Check in DSH compatibility metadata for master/tag/npm/session format/
  known event vocabulary/SQLite schema.
- [x] Update header/layout/identity and exact packed-row validation fixtures.
- [x] Normalize current turn/step/message/chunk/tool/request/context/seed events
  without losing source sequence or surface citations.
- [x] Add `agent/inbox/spliced` and Team member/task/mailbox protocol mappings.
- [x] Preserve fork seed length, `session/end-seed`, agent preset, delegation
  depth, cancellation/interruption, usage, and workflow provenance.
- [x] Detect SQLite persistence/schema 17 and return an explicit diagnostic;
  implement read support only if a validated current fixture is available.
- [x] Preserve the official rc.8 fixture as legacy packed-row coverage and add
  a derived alpha.3 physical-shape fixture with explicit provenance.
- [x] Run real alpha.3 headless and subagent store smokes for parser, token,
  lineage, API, and browser evidence.
- [x] Refresh the compatibility snapshot to alpha.5 (tag `db6bdc3576…`,
  HEAD `49a606bc…`): prove version `0`/catalog/header-line/packed-row/
  provenance-range formats unchanged; adopt the official checked-in web
  snapshot byte-for-byte with upstream envelope synthesis; keep alpha.3 and
  rc.8 readability regressions; record the unavailable credentialed live
  run (key auth failure) instead of live evidence.

## S4. Runtime Workbench

- [x] Implement summary/events/work/sessions/context render projections.
- [x] Replace the Execution tab with Runtime for every readable session.
- [x] Add server-rendered lenses, evidence drawer, pagination/filtering, and
  canonical conversation/session links.
- [x] Add English/Chinese strings and responsive accessible styling.
- [x] Add browser behavior without provider-specific interpretation.

## S5. Remove Flow

- [x] Remove FlowTree types/builders and `getSessionFlow` adapter surface.
- [x] Remove Flow routes, detail/export payloads, lazy panel, inspector JS/CSS,
  locales, docs, and old tests.
- [x] Simplify structured-view capability checks and retain Tree/Container/
  Metrics/Trace only where still consumed.
- [x] Prove Runtime Work/Sessions covers explicit, inferred, detached, nested,
  return, failure, and canonical-link fixtures formerly exercised by Flow.

## S6. Remove Session Analysis

- [x] Add provider/general project-path mapping independent of Analysis config.
- [x] Remove analysis core/tools/validator/evidence/layout/prompts/targets.
- [x] Remove analysis routes, settings/config writing, session UI, client code,
  styles, locales, runtime-log routing, and title filtering.
- [x] Remove SEA analysis assets/internal dispatch and update binary smoke.
- [x] Remove analysis docs/tests while preserving unrelated protocol fixtures.
- [x] Verify existing `.agentsession/analysis` directories are untouched.

## S7. Documentation and verification

- [x] Rewrite README/README.en/package README/provider guide/CLI help around
  harness runtime inspection.
- [x] Run typecheck, focused protocol/provider tests, full tests, build, binary
  build/smoke, and `git diff --check`.
- [x] Start the real server, inspect `/api/providers`, protocol/runtime APIs,
  logs, and representative real sessions for every locally available provider.
- [x] Run browser E2E at desktop and 390 px with zero browser errors.
- [x] Obtain independent Luna and Pi Pro diff reviews; verify every finding.
- [x] Complete the requirement-by-requirement audit and update this checklist.

## S8. Commit and push

- [x] Inspect worktree and remotes; preserve unrelated files.
- [x] Create meaningful commits with required Coding Agent/Model trailers.
- [x] Fetch and prove intended branch divergence before push.
- [x] Push to the correct GitHub remote.
- [x] Prove `HEAD`, remote branch SHA, and tracking ref match with zero
  divergence and report the evidence.
