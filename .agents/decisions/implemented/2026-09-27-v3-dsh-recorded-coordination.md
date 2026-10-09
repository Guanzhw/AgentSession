---
status: implemented
date: 2026-09-27
decision: DSH Runtime Coordination projects recorded Reader mailbox and workflow observations
---

## Context

The DSH Reader already records source-ordered team message queue/delivery and
workflow start/end observations. Protocol v3 retained their raw events but left
Runtime Coordination empty, so a caller could not follow the recorded handoffs
through that domain. The public synthetic Teams source has twelve such records.

## Decision

The [DSH adapter](../../../v3/crates/core/src/providers/deepseek_harness.rs)
projects those twelve normalized Reader observations from the same loaded
snapshot into protocol v3. Each fact keeps the Reader kind, state, correlation,
source event, recorded provenance, and sender/target session refs. The shared
[coordination fact](../../../v3/crates/core/src/protocol/observations.rs) now has
optional session refs so DSH endpoints are not discarded; Codex retains its
existing protocol shape. The shared Runtime projection orders facts by their
source event. Coverage is observed when such facts exist and not-observed when
the selected source has none.

Workflow correlation remains distinct from AgentRun identity. A workflow start
without a recorded end stays started; this slice does not infer completion,
team membership, actors, or ownership beyond the explicit sender/target refs.

## Alternatives considered

Keeping only raw source events would leave the Runtime Coordination domain empty
despite recorded Reader handoffs. Mapping session IDs into actor paths would
misstate their identity, so optional session refs carry those endpoints directly.

## Consequences

The public root exposes twelve source-ordered coordination facts in the v3
document and Runtime page. Sources without those observations report
not-observed coverage. AgentRuns remain empty until separately recorded run
identity exists.

## Verification

- RED: `node --test --test-name-pattern='recorded Reader coordination' v3/test/dsh-protocol-foundation-http.test.mjs` failed with Runtime `scannedEntries` 0 versus 12 Reader/source observations.
- GREEN: the same test passed after projection, checking all twelve ordered
  source anchors, exact provenance, IDs, states, correlations, and endpoints.
  A separate open-workflow case kept its lone start at `started` without an
  AgentRun or inferred completion.
- `cargo build --manifest-path v3/Cargo.toml -p agentsession-v3` passed.
- `cargo test --manifest-path v3/Cargo.toml -p agentsession-core` passed:
  105 passed, 12 explicitly gated tests ignored.
- DSH foundation/Reader/fixture and Codex collaboration HTTP tests passed
  21/21. The HTTP harness checked SHA-256 hashes of the three original public
  source files and their isolated copies after reads; the frozen DSH Work/usage
  checks also ran against selected real data.
