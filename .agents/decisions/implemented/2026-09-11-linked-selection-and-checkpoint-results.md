---
status: implemented
date: 2026-09-11
decision: Keep Runtime selection links evidence-bound and expose checkpoint result facts through the existing inspector.
---

## Context

Spec 18 closes two gaps in the Runtime Workbench: selecting a recorded goal or
actor did not highlight its explicit task/run evidence, and selecting a
context checkpoint could not inspect its recorded result version or compaction
facts. Run pages are bounded and replaceable, so later-page evidence must stay
available without expanding the global inventory.

## Decision

Use explicit `Goal.taskIds`, `Actor.runIds`, and normalized run/coordination/
context/artifact bindings for client-side selection. Add bounded page-scoped
context versions and decorate transformation evidence with the matching
recorded event's token and retained-summary facts in the server-rendered
evidence payload. The existing nested checkpoint and artifact visualization
remains the primary surface; the inspector provides bounded related buttons
and facts only.

## Alternatives considered

- Infer relationships from shared task names, provider-specific fields, or
  historical status; rejected because those are not recorded bindings.
- Add a flat result entity/inventory; rejected because it duplicates the
  context lane and weakens bounded page navigation.
- Parse provider data in the browser; rejected because Runtime consumes the
  server-normalized Session Protocol evidence.

## Consequences

Goal and actor selections remain precise even when task/run relationships are
partially available. Selecting a checkpoint or result version can reach its
owning run, task, result artifacts, and recorded context facts. Global evidence
stays bounded while a replaced run page supplies its own transformations,
versions, and artifacts. Missing result facts remain absent rather than being
fabricated.

## Verification

- `npm run typecheck`
- `npm run build`
- `node --test test/runtime-workbench.test.mjs` (55 passing)
- Focused tests cover explicit checkpoint facts, reverse links, and a later
  current-page checkpoint/result version beyond the initial 100-item inventory.
- Main-agent combined `npm test`: 559/559; review/pre-push gates passed.
- Illustrative EN/ZH × light/dark × 1280/768/320 selection matrix passed.
  The final build removed duplicate retained text and corrected version labels.
- Actual browser Next/Previous interaction over 121 illustrative runs reached
  checkpoints 101/102 with distinct 42/43-token results, summaries and versions;
  returning to page two removed the old checkpoint nodes. Browser errors were empty.
- Restarted Codex/OpenCode/DSH APIs validated. Real OpenCode E2E passed.
  Real samples have no run-bound context results, so positive results are
  explicitly fixture-backed rather than attributed to live provider data.
