---
status: implemented
date: 2026-09-01
decision: Normalize inherited provider history and logical compactions at the adapter boundary, while exposing direct and family-inclusive usage as distinct shared projections.
---

# Session ownership and usage projections

## Context

Codex legacy child transcripts can contain copied parent records, and one
logical compaction can be recorded in two adjacent provider record shapes.
Other providers, including DeepSeek Harness, record an explicit inherited
seed boundary and multi-event compaction lifecycle. Rendering those raw shapes
directly duplicates conversation navigation, context checkpoints, and apparent
usage even though the child only produced its owned suffix.

## Decision

Provider adapters own the classification and removal of inherited transcript
records and the canonicalization of provider records into one logical
`context.compaction` observation. Shared session projections trust that
normalized boundary. Detached child sessions contribute one Task entry to the
parent table of contents instead of expanding their conversation messages.

Shared metrics preserve existing family-inclusive totals and add explicit
direct usage for the selected session. Inherited stored history contributes to
neither value; a child session's own model requests contribute once to its
direct total and once to an ancestor's inclusive total.

Runtime context checkpoints group recorded lifecycle events and their artifact
by stable correlation identity before using timestamp proximity as a fallback.
When the normalized compaction event carries a provider-recorded summary, the
Context lens presents that summary as the resulting context.

## Alternatives considered

- De-duplicate message text and compaction timestamps in shared views. Rejected
  because provider record shapes and ownership evidence belong to adapters,
  and repeated text can be valid child work.
- Remove child usage from all parent projections. Rejected because family-wide
  cost remains useful when it is explicitly labelled inclusive.
- Expand every detached child's messages in the parent table of contents.
  Rejected because it exposes background transcript detail instead of the task
  relationship users navigate from the parent.

## Consequences

Providers must establish ownership before returning normalized messages and
must emit one canonical compaction per logical operation. Shared code remains
provider-neutral. Metrics consumers can distinguish selected-session work from
the full session family without subtracting inherited context heuristically.
Context summaries remain recorded evidence and are never synthesized by the
browser.

## Verification

- `npm test`: 288 tests passed.
- `npm run qa:e2e`: passed against the live viewer with all installed providers.
- Real Codex data reduced legacy copied-prefix overlap from 1,048 messages to
  seven valid repeated child-owned outputs and collapsed paired compact records
  into three logical checkpoints.
- Real DeepSeek Harness data rendered one recorded context result, kept its
  evidence collapsed, and reported 39,760 direct versus 53,122 inclusive tokens.
- An explicitly missing DeepSeek Harness directory reported the provider as
  unavailable without affecting the viewer.
- `npm run review`, `npm run pre-push`, and `git diff --check` complete the
  publication gate.
