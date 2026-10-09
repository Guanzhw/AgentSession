---
status: implemented
date: 2026-10-01
decision: Preserve historical Codex UUID dispatch and explicit native child-thread run declarations with distinct evidence.
---

# Codex historical dispatch and child-header runs

## Context

Frozen Codex `multi_agent_v1` transcripts record nine spawn attempts, five
UUID acknowledgments and four explicit plaintext rejections. Eleven selected
canonical child headers across four roots independently declare their parent
through `source.subagent.thread_spawn.parent_thread_id`. Six declarations have
no parent acknowledgment, including five children of a root without dispatch.
The actor-path-only collaboration parser omitted these tasks and runs. This
extends [recorded collaboration](2026-09-27-v3-codex-recorded-collaboration.md)
and the [delegated list-stat scope](2026-09-28-v3-legacy-list-stats-scope.md).

## Decision

The Codex adapter recognizes the observed historical namespace and exact
call/output identities. Returned UUIDs are private resolution candidates, never
actor paths. Canonical child binding requires the selected header ID and exact
parent; conflicting native declarations and unavailable copied-history
ownership prevent binding. Modern actor-path matching remains strict.

A recorded spawn attempt creates one task, including each of the four known
rejections. Arbitrary opaque outputs remain unknown. A verified acknowledgment
creates one child run; historical start evidence and time come from that output.
Per-target waits preserve actual result targets and unique coordination IDs
sharing their raw event. Only string-valued completed results establish
completion. The first attributable completion stays immutable. Close's prior
completion snapshot can supply first terminal evidence with an unknown end
time. Resume snapshots and accepted follow-up input remain coordination.
Their full content stays in the exact original Reader tool. They create no
additional task or run. The selected real follow-up occurs after the initial
assignment completion.

An explicit selected native `thread_spawn` declaration independently creates
one derived `subagent` run with canonical child reference, Unknown status,
Unidentifiable pairing and null task/turn/start/end/terminal evidence. A generic
parent or fork association is insufficient. Deduplicate by canonical child
against acknowledgment-bound runs. These declarations create no dispatch,
Reader insertion, or execution observation.

Both standalone event streams and bundles append deterministic derived
`relationship` / `codex.child_thread_declared` dependency events after raw
parent records. Each has an exact selected child-header source ID containing
canonical child, native header ordinal and selected path. It has no timestamp,
Reader reference or execution. Run and relationship evidence use that event
and source ID. `SourceOrder` is normalized order: Recorded events retain native
positions; derived dependency events occupy deterministic appended slots.
Validation remains strict and parent raw IDs/order remain unchanged.

Selected child header identity, explicit declaration, ordinal, path and source
hash enter parent dependency revisions. Codex source revision namespace moves
from `codex-jsonl-v3-s2-5` to `codex-jsonl-v3-s2-6`; direct source-set namespace
moves from v4 to v5. The Stats projection namespace remains owned by Stats.

## Alternatives considered

- Treat a UUID or nickname as an actor path: the provider did not record it.
- Infer dispatch/start/completion from child activity: a header establishes the
  delegated run, while lifecycle facts need independent recorded evidence.
- Bind child evidence to an unrelated parent header or bypass validation:
  neither preserves truthful source ownership.
- Rewrite the original terminal after follow-up input: that would change which
  assignment the run describes without a separately defined episode contract.

## Consequences

Legacy delegated run counts preserve explicit native scope while keeping
missing lifecycle evidence visible. Header-only runs have canonical navigation
without fabricated Reader placement. Historical recorded spawns reuse the
existing Reader source anchors and canonical child insertion. Parent protocol
revisions invalidate old Reader/protocol/Stats derived state.

## Verification

Before production edits, `cargo test --manifest-path v3/Cargo.toml -p
agentsession-core historical_codex_dispatch_and_header_runs -- --nocapture`
failed with zero tasks versus three on the initial public fixture (RED).
After implementation, four focused Rust tests pass. The final core suite
passes 180 tests with 14 explicitly ignored private-corpus tests.

The sanitized fixture and
[v3 historical HTTP test](../../../v3/test/codex-historical-collaboration-http.test.mjs)
cover exact failures, unresolved success, opaque output, multiple wait targets,
first completion, resume/input/later result, close snapshots, source anchors,
canonical Reader child placement and source preservation. Rust checks also
cover five header-only runs, generic fork/parent exclusion, conflicting or
mismatched headers, unavailable copied-history ownership, malformed output
values, cached/uncached identity agreement, dependency revision changes and
standalone stream/bundle equality with unchanged raw event IDs/order.

Frozen byte-identical copies of four selected roots and eleven children produce
task counts 2/4/3/0, delegated runs 3/2/1/5, failed tasks 0/2/2/0 and observed
starts 2/2/1/0. Same isolated Viewer/index/cache state populated by the preserved
d86b2322 binary starts with all four task/run counts zero; the new DEBUG binary
rebuilds correct counts and revisions. All active-status arrays remain empty.
Owned usage remains 15 sessions, 1163 messages, 117 recorded requests,
11153853 known tokens and 339 unresolved usage observations. All 15 original
and copy source hashes are preserved. Private reports and commands are retained
under `tmp/v3-delivery/historical-codex-dispatch-implementation-20261001/`.

An initial full-840 DEBUG readiness attempt exceeded the test readiness window;
its failed log is retained. The four-root/eleven-child cohort establishes this
bounded behavior; it does not establish whole-corpus startup performance.
Release builds, desktop browser acceptance and publication remain separate
parent-task gates.
