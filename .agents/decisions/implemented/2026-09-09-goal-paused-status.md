---
status: implemented
date: 2026-09-09
decision: Add the recorded paused state to the shared Session Protocol v3 GoalStatus and preserve it in the DeepSeek Harness projection.
---

# Shared GoalStatus `paused`

## Context

DeepSeek Harness native v3 already records `goal/change` snapshots with phase
`paused`, but the shared GoalStatus enum could only represent that phase as
`unknown`. OpenClaw v2026.9.3 independently records `SessionGoal.status` as
`paused`, providing a second provider boundary for the same semantic state.

## Decision

Add `paused` to the shared GoalStatus type, factory, and finalized validator.
The DeepSeek Harness provider maps its recorded `paused` phase exactly to the
new value. Runtime Work Graph labels use localized English and Chinese text,
with a neutral static visual treatment. `paused` is non-terminal and does not
change Task or AgentRun status.

The public enum is extended only when independent provider evidence establishes
the shared meaning. OpenClaw `usage_limited` and `budget_limited` remain
provider-owned until another provider supplies equivalent evidence.

## Alternatives considered

- Keep `paused` as `unknown`: rejected because it discards a stable recorded
  state with two independent provider sources.
- Map `paused` to `blocked` or `queued`: rejected because neither preserves the
  provider's non-terminal paused meaning.
- Add all OpenClaw-only status values now: rejected because they lack the
  required second-provider evidence.

## Consequences

Consumers can distinguish a recorded paused goal from queued, blocked, and
terminal goals without provider-specific branching. Existing v2 fields and
Task/AgentRun state are unchanged; providers without paused evidence continue
to use the existing states. Codex's recorded user-suspension value remains the
provider-owned `unknown` mapping documented in
`2026-09-02-codex-native-v3-mapping.md`; it is not a goal lifecycle `paused`.

## Verification

- Shared v3 factory/validator tests accept `paused` and reject undeclared
  values.
- DSH native v3 tests verify exact recorded phase mapping.
- Runtime Work Graph SSR tests verify English/Chinese labels and neutral CSS.
- Independent review found no functional defect; its one stale Codex ADR finding
  was corrected without changing the Codex mapping.
- `npm run review`, all 486 tests, and `git diff --check` pass.
