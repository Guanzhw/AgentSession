---
status: implemented
date: 2026-09-17
decision: Keep coordination milestones readable in place and connect the same task's recorded steps
---

## Context

The real nine-task Codex Reader shows ordinary messages between repeated process
disclosures. At 1265px, one viewport can contain four collaboration labels and
no main-agent prose. Task identity exists but following its returns requires
opening the sidebar and finding sources again.

## Decision

Fold ordinary coordination messages with their owning execution process. Keep
dispatch, follow-up, interruption and delivery milestones in place. Connect
each key milestone to the previous and next key milestone of the same canonical
lane, using the existing scoped Reader source-navigation mechanism.

Links mean adjacent recorded steps, not paired request/result causality or
continuous execution. They follow the normalized local source sequence. Child
completion without a parent position stays in its existing source-owned view.

## Alternatives considered

A global timeline would interrupt the primary reading surface. A line spanning
the entire document becomes difficult to follow through long tool bodies and
nested child histories. Local connected steps preserve prose and exact anchors.

## Consequences

No provider/protocol changes. Ordinary messages remain available in the process
and task sequence; mixed key/ordinary positions remain visible. Canonical lane
identity, rather than labels, determines the connections. No new client graph
or transcript interpretation is introduced.

## Verification

The full suite passes on the current and minimum supported Node versions.
Focused rendering, continuation, client and route tests preserve source order,
identity and pane-local selection. Real dispatch/receipt/follow-up navigation,
browser Back, keyboard navigation and ordinary-message source expansion pass.
Desktop, 390px and 320px layouts were inspected in both themes; the final
restarted build passes the full live E2E suite. Independent review, review and
pre-push gates pass. See the [slice evidence](../../../docs/design/runtime-inline-task-steps.md)
for the precise scope. Parallel-overlap comprehension and overall visual
acceptance remain open.
