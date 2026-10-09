---
status: implemented
date: 2026-09-28
decision: Attribute Codex compaction response cost once and match later legacy usage against its recorded cumulative offset.
---

# Codex compaction usage in AgentSession 3.0

## Context

Two hash-verified Codex child transcripts in the eight-file Stats adjudication
contain a canonical `token_usage_record` immediately followed by `compacted`.
The canonical response adds its six-field usage vector to the thread cumulative
total. Later `event_msg:token_count` rows mirror canonical requests but report
the cumulative total without that compaction vector. The first legacy row after
compaction has zero usage components, a positive total, and an unchanged
pre-compaction cumulative total; it records context size rather than a request.
Exact request-plus-cumulative matching counted these rows again.

## Decision

Keep the canonical compaction response as an additive request. In the Codex
adapter, recognize a compaction offset only when an explicit `compacted` marker
immediately follows a complete canonical usage record and that record advances
the previous complete canonical cumulative total by its request vector. Match
later complete legacy request/cumulative pairs against canonical pairs after
subtracting the accumulated compaction vector. Exclude the post-compaction
context-size row only when its complete cumulative total equals the canonical
cumulative total less all validated compaction costs so far. Preserve existing behavior for incomplete fields,
other ownership epochs, and unrelated repeated requests.

Bump the Codex Stats source revision and Reader revision salts, the list Stats
dependency version, and the stored catalog summary schema version so derived
values are recaptured from provider sources.

## Alternatives considered

- Suppress equal request vectors after compaction: rejected because distinct
  requests can have equal vectors and the recorded cumulative values identify
  the mirrors more precisely.
- Drop the canonical compaction response: rejected because it has a distinct
  response ID and advances the provider-recorded cumulative total.

## Consequences

Codex Stats, Reader, and catalog projections recapture affected derived data
from unchanged provider sources. A legacy row without complete usage evidence
continues through the existing selection rules. The catalog schema bump also
recaptures other providers' derived summaries once.

## Verification

The public single-compaction regression was red with selected totals
`[12, 6, 3, 8, 8, 11, 11]` and green with `[12, 6, 8, 11]`.
The two-compaction regression was red with `[12, 6, 8, 5, 4]` and green
with `[12, 6, 8, 5]`. `cargo test --workspace` passed (159 core and 2 app
tests; 14 ignored).
`cargo fmt --all -- --check` and `npm run review` passed. An isolated Web
probe over eight hash-verified source copies matched the independent golden:
372 requests and 49,669,260 tokens, including 111/15,507,985 and
94/13,519,855 for the two compaction files. The probe preserved source hashes.
An additional isolated three-file Web probe excluded three confirmed false
context requests (29,707, 33,292, and 26,621 tokens), moving its total from
527/64,950,671 to 524/64,861,051; source hashes remained unchanged.
This evidence covers these selected transcripts, not the full Codex corpus.
