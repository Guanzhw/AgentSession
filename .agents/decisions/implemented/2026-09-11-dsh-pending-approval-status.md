---
status: implemented
date: 2026-09-11
decision: Classify only a currently open DSH turn with an unmatched approval ask as waiting_input.
---

## Context

DeepSeek Harness persists approval questions as `approval/asked` followed by a
same-ID `approval/decided`. The approval invariant requires both events to be
inside an open turn, while a crash or incomplete tail can leave an ask without
its decision. Existing status folding used only the latest `turn/end`, so it
could not distinguish a newer open turn from an older completed turn.

## Decision

Fold owned DSH events in source order. Reset the pending approval set at each
`turn/start`, remove IDs on `approval/decided`, and return `waiting_input` only
when the current turn remains open with at least one unmatched ask. A closed
turn's latest `turn/end` reason remains authoritative.

## Alternatives considered

- Derive status solely from the latest `turn/end`: rejected because it loses
  the current open-turn state when a newer turn follows a completed one.
- Add a new protocol field: rejected because the existing canonical status
  vocabulary already includes `waiting_input`.

## Consequences

Current interactive approval waits are visible through the existing protocol
descriptor and work-status projections. Validly paired approvals in a closed
turn retain that turn's terminal status.

## Verification

The focused DSH regression fixture cites official source commit
`b2e3b2a0125854567a4a5fcba75782e42fe84901`, paths
`packages/interaction/user-approval/src/invariant.ts` and
`packages/interaction/user-approval/tests/invariant.spec.ts`. It covers a
valid paired approval that remains terminal, an unmatched ask in a newer open
turn, and a newer open turn whose approval is already decided. The main agent
ran the repository build and full tests: 553/553 passed. Real DSH work/run APIs
retained completed/cancelled history without pending attention. No real current
unmatched approval was available; positive approval coverage remains the
official-source-backed fixture, not live approval evidence.
