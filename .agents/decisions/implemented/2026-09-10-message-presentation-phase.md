---
status: implemented
date: 2026-09-10
decision: Preserve provider-recorded assistant presentation phases through the shared Message boundary.
---

# Shared message presentation phase

## Context

Real Codex response items record `phase=commentary` for intermediate assistant
output and `phase=final_answer` for final output. `recordsToMessages()` currently
discards this field, so the common conversation renderer cannot disclose
commentary separately without guessing from position. The shared Agent Loop
already groups response fragments by turn identity and is the narrow consumer
boundary for this evidence.

## Decision

Add the optional typed `Message.presentationPhase` field with the values
`commentary` and `final`. Codex maps only its recorded `payload.phase` values;
missing or unknown values remain undefined. The Agent Loop preserves a boundary
between different phases while continuing to merge same-phase fragments and
call-bound tool results. Conversation rendering may use this evidence for
progressive disclosure, but must never infer final output from the last message.

## Alternatives considered

Inferring the last assistant fragment as final is invalid for streaming and
open turns. Reusing Session Protocol event `phase` conflates response
presentation with lifecycle state. Storing raw provider fields only in opaque
metadata leaves the shared renderer unable to make the evidence-based choice.

## Consequences

The provider boundary gains a small optional field without a new protocol or
provider branch in the UI. Providers without an equivalent recorded boundary
remain unknown until their adapter has explicit evidence. A phase change with
the same turn id produces separate Agent Loop turns, preventing commentary
from being presented as final while preserving all tokens, tools, and text.

## Verification

`test/codex-provider.test.mjs` covers Codex commentary/final/unknown mapping,
paired `agent_message` deduplication, and singular token attribution.
`test/message-presentation.test.mjs` covers phase boundaries, same-phase
fragment grouping, tool preservation, and legacy phase-less grouping.
`test/message-phase-disclosure.test.mjs` covers SSR process disclosure,
unknown-text preservation, open-segment visibility, checkpoint boundaries, and
ToC exclusion for collapsed commentary. `src/views/session.ts` consumes the
field without provider-specific browser logic.
