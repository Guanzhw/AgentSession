---
status: implemented
date: 2026-09-28
decision: Present recorded Claude compact boundaries as Reader checkpoints and Context observations without inventing a summary or version
---

# Claude compact boundary evidence

## Context

The public current Claude transcript records a `system/compact_boundary` row with UUID `compact-boundary-1`, trigger `auto`, and `compactMetadata.preTokens=167189`. The 3.0 source stream already classified it as `context.compact`, but the Reader rendered it as an ordinary system message and Runtime Context reported unknown coverage. The boundary does not contain a readable compaction result.

## Decision

The Claude adapter renders each recorded boundary as a `context` Reader checkpoint at its source position and links the same source event in Session Protocol v2/v3. It creates a Context observation with the recorded trigger and pre-compaction token count when present. Runtime Context shows those facts and links back to the exact Reader checkpoint. No ContextVersion, ContextTransformation, replacement range, or summary content is inferred from a boundary row.

The two new optional observation fields are normalized at the provider boundary. Other providers omit them, preserving their existing projection shape. The adapter parses boundary and sidechain observations in one pass over the same source bytes used by the protocol event stream.

## Alternatives considered

- Treat the boundary as a Context result. That would imply a readable new context version absent from the recorded row.
- Leave it in the raw event stream only. That would omit an observed turning point from the Reader outline and make the recorded pre-compaction count inaccessible in Runtime Context.

## Consequences

Readers can find and reopen the boundary in source order. The API distinguishes a recorded operation from a missing summary and retains `preTokens` as a pre-compaction count, not as a count of shadowed tokens. Claude compaction formats beyond the observed boundary remain outside this slice.

## Verification

The focused public HTTP test first failed because the Reader event used `message`, then passed with the Context checkpoint, source-linked observation, exact trigger/count, and no invented result. The public browser test opens the checkpoint from the outline and Context lens and returns to the same Reader event. The delivery plan records the final commands, source hashes, and real-data coverage limit.
