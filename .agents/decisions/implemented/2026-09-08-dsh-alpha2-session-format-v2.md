---
status: implemented
date: 2026-09-08
decision: Add a read-only DeepSeek Harness alpha.2 Session format v2 reader while retaining frozen v0 and v1 generation decoding.
---

# DeepSeek Harness alpha.2 Session format v2 reader

Evidence: official read-only shallow clone `tmp/upstream/dsh-alpha2`, tag
`dsh-v0.1.3-alpha.2`, commit `82a5fd61a7cf5c293cec4bdff68f455398d685e9`.

## Context

The adapter previously read only the unversioned v0 JSONL artifact, while the
official alpha.2 persistence package publishes immutable v0, v1, and v2
generations with materially different headers and Assistant event shapes.

## Decision

- Discover canonical `session.jsonl`, `session.v1.jsonl`, and
  `session.v2.jsonl` (raw or Zstandard) per session root and select the
  numerically highest generation. Mixed encodings or duplicate generation
  files are explicit diagnostics; an unreadable winner never falls back to an
  older generation.
- Keep provider data read-only and perform no migration or successor writes.
  v0 packed rows and the frozen v1 codec remain read inputs; v2 is one event
  per row with its own envelope and current event catalog.
- Preserve v0/v1 `seedLength`. For v2, `isSeeded` and the last tagged
  `session/end-seed` (`data.inherited === true`) define the inherited cut; the
  marker itself is the first own event.
- Project only append-origin user/message, assistant/message, and tool/result
  events onto the human transcript. v2 assistant streams stay embedded on
  assistant/message; assistant/attempt remains recorded diagnostics. Validate
  model-visible surface replacements at the parser boundary and retain them in
  protocol/context evidence without erasing conversation the user already saw.
- Read usage through one provider helper: assistant/message prefers
  `data.usage`, otherwise the final stream usage sample; assistant/attempt uses
  its final stream usage sample. Same-turn/step samples are last-wins until
  `llm/retry-started` opens a new billed slot. No direct/inherited/shared
  request-origin ownership is fabricated without source evidence.
- Match the released envelope/storage codec and validate the bounded payload
  facts consumed by AgentSession; the adapter does not duplicate the upstream
  provider's entire payload schema.

## Alternatives considered

Continuing to prefer compressed v0 bytes would hide newer canonical data and
violate the generation contract. Migrating old files in place would mutate
provider-owned storage, so the viewer keeps all source generations read-only.

## Consequences

The viewer can inspect current v2 surface semantics while retaining an
append-origin human transcript and historical v0/v1 readability. Mixed
physical encodings and malformed winners are visible diagnostics rather than
silently downgraded sessions.

## Verification

Typecheck, governance checks, focused DeepSeek Harness tests, and the full
`npm test` suite pass (446 tests). A real local v0 session was verified through
the provider, protocol/runtime APIs, and browser Work, Conversation, Events,
and Context surfaces. A credentialed live alpha.2 session was not available.
