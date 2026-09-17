---
status: implemented
date: 2026-09-17
decision: Align recorded main and task activity in a bounded optional sidebar window
---

## Context

The current task list preserves identities but requires readers to compare
clocks manually. Complete normalized relations include child-owned completions
that cannot be placed in the parent prose. Card channel excerpts are bounded
and cannot establish the complete time range.

## Decision

Project a ten-minute recorded-time window from complete ReaderRelations and
owned main-session text parts. Render aligned lanes in the existing optional
sidebar with exact source links and explicit bounded continuation. Keep
completion and receipt distinct; cluster close points only for display.

## Alternatives considered

Stretching lines through the entire transcript interrupts continuous reading.
Using card excerpts hides later returns. A bounded on-demand projection keeps
the reading surface intact and gives the visual overview complete source scope.

## Consequences

Add a read-only Reader activity endpoint and a small shared projection. Provider
data and protocol semantics do not change. Connectors indicate recorded
observations, not inferred continuous execution or request/result pairing.

## Verification

Model/route/client/render tests, independent review and real seven-lane,
twenty-record Codex window checks passed. Both Node 22.15.0 and 26.5.0 suites
passed 855 tests. Desktop and 390px light/dark checks cover exact main/child
sources, keyboard paging, Escape return and browser history. Full browser QA
and remaining product acceptance scope are recorded in
[the activity-map specification](../../../docs/design/runtime-activity-map.md).
