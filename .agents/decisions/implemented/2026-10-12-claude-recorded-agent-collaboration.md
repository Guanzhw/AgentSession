---
status: implemented
date: 2026-10-12
decision: Render recorded participant-free tasks and normalize Claude structured Agent launches
---

## Context

A genuine Claude Code 2.1.296 background Agent capture produced a completed
task notification and a child transcript. Reader exposed Tasks & collaboration
because a task was recorded, but rendered an empty panel because the task had
no participant object. The parent also recorded an Agent tool call and a
structured asynchronous launch result with the canonical agent ID, while its
Reader and Runtime projections did not expose that child dispatch.

## Decision

The Claude adapter owns recognition of the recorded `Agent` tool call and its
matching structured `toolUseResult`. The call records a requested spawn; the
matching `isAsync: true`, `status: async_launched`, nonempty agent ID records
the started spawn and canonical child relationship. Unknown or incomplete
launch results retain the recorded request without inventing a child or an
AgentRun. Source event identity and order remain unchanged. Shared core and UI
consume the existing normalized relation contracts.

The same owning normalization supplies Reader and Protocol facts. Claude's
source revision namespace changes to invalidate derived projections for an
unchanged transcript. Task notifications retain their recorded summary as the
task description; their recorded status remains independent of inferred run
or child completion.

Reader displays tasks without a recorded participant directly in the
collaboration panel, with their summary, localized status and canonical source
action. Provenance stays in collapsed technical details. Participant-owned
tasks retain their existing participant view. Browser code does not parse
Claude payloads or infer child identities from text.

When a selected child has a settled empty relation snapshot, the open panel
shows an explicit localized empty state. Opening/loading/error states retain
their own status, and returning to the parent restores its recorded facts.

## Alternatives considered

Hiding the task-only launcher would discard available recorded evidence.
Guessing a child from prose, or treating every successful tool result as an
agent launch, would exceed the structured source contract. Reusing only the
Library's child-to-parent relationship would omit the parent's actual dispatch
anchor and would not repair the empty task panel.

## Consequences

This is a bounded provider and consumer correction for current recorded
evidence. It does not claim complete Claude task/run lifecycle coverage.
Provider records and existing Viewer user state remain read-only.

## Verification

The [stable readiness ledger](../../../docs/specs/stable-readiness-2026-10/tasks.md)
owns integrated artifact and review status. The actual final4 empty panel and
its API/raw source mapping are preserved under ignored
`tmp/stable-readiness-20261011/current-captures/desktop-final4/`.
The task-only and empty-child browser regressions failed before their UI changes; all five
collaboration browser checks then passed, including English/Chinese status,
keyboard source navigation, parent/child switching and no invented child handoff. Provider regressions,
new integrated native/browser evidence and fresh independent review complete
the affected-surface gate before handoff.
