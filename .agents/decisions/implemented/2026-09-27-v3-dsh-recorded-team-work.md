---
status: implemented
date: 2026-09-27
decision: DSH Work projects source-anchored latest native team tasks
---

## Context

The [DSH protocol foundation](2026-09-27-v3-dsh-protocol-foundation.md) preserves
team/task source events, while its structured Work projection was empty. The
provider Reader already validates task revision ordering and retains the latest
native task revision separately from workflow correlations.

## Decision

The [DSH adapter](../../../v3/crates/core/src/providers/deepseek_harness.rs) reuses
that same loaded snapshot to publish one task observation per latest native team
task. Its ID and exact source sequence remain provider-owned; explicit completed
status maps to completed. Pending/running status maps to unknown because the
current shared observation contract has no nonterminal status variants. Creation
time remains absent because the latest event is an update, not creation evidence.
Tasks advertise partial recorded capability. AgentRuns and workflow task identity
remain unprojected.

The shared [Work projection](../../../v3/crates/core/src/protocol/observations.rs)
uses a provider's known Work coverage declaration before its generic observation
fallback. Unknown declarations retain the existing fallback, including Codex.
The Work page and v3 document return the same coverage and revision.

## Alternatives considered

Inferring AgentRuns from workflow IDs would assert identity beyond recorded facts.
Extending shared task structures with owner/title/dependencies requires a separate
consumer-backed contract slice. Treating a latest revision timestamp as creation
would mislabel source evidence.

## Consequences

The public synthetic DSH root now returns two completed team-task Work entries,
anchored to seq 18 and 20. Goals, task owners/dependencies, workflow tasks, AgentRuns,
execution, coordination, context, usage, exclusive ownership, and branches remain
unprojected or unknown as declared. The frozen real corpus contains no native
team/task records; its empty Work result remains correct and does not establish
real populated-task acceptance.

## Verification

- RED: `node --test --test-name-pattern='latest team task' v3/test/dsh-protocol-foundation-http.test.mjs`
  failed with actual 0 tasks versus expected 2 before implementation.
- `cargo build --manifest-path v3/Cargo.toml -p agentsession-v3` passed.
- DSH foundation/Work and Codex Work HTTP regression files passed 11/11, including
  same-source v2/v3/Reader revisions, exact source anchors, latest revisions,
  bounded pagination, filter-bound cursor rejection, pending status, and provider
  coverage agreement. The frozen test inspected two real sessions and checked
  all three original source hashes after HTTP reads.
- `cargo test --manifest-path v3/Cargo.toml -p agentsession-core`: 70 passed,
  seven explicitly selected private-source tests ignored.
- DSH Reader/MCP, legacy-boundary, and frozen-v0 regression files passed 5/5.
- `npm run review` passed. The five-provider capability HTTP file's first two
  tests passed; its third currently encounters the separately changing OpenCode
  document expectation (expected 503, actual 200). Root integration owns that
  independent expectation and the populated DSH browser check.
- Evidence base HEAD: `50a32e7c5b3fdaa1d335771da80d6c919d4ab536` plus this worktree.
  Frozen source corpus digest (SHA-256 of sorted source SHA-256 values joined by LF):
  `e15a521e1680d7a4248ca11d927e9b581d22b2847e2d97da5a7f2b6918188ea0`.
- This is a debug functional check against the current worktree; no release or
  performance claim is made.
