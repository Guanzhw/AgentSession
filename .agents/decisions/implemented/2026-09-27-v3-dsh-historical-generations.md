---
status: implemented
date: 2026-09-27
decision: Read selected DeepSeek Harness v1 and v2 sources with generation-owned validation while preserving the original human history.
---

# AgentSession 3.0 DeepSeek Harness historical generations

## Context

The 3.0 catalog already selected the highest available DSH generation for a
canonical session, including v1 and v2, but the Reader loader rejected those
selected files. The released 2.0 parser documents distinct v1 `seedLength`
and v2 `isSeeded`/`session/end-seed` envelopes. In both generations,
`surfaceOp` can change the model-facing context without rewriting the
previously recorded human conversation.

## Decision

Parse v1 and v2 raw JSONL or Zstandard sources in the DSH adapter. Validate
their generation-specific header, event envelope, sequence, surface operation,
and replacement provenance at the source boundary. Keep the highest selected
generation authoritative: a malformed selected v2 produces an explicit error,
not a fallback to a lower generation. Partition inherited seed records from
child-owned history and usage; preserve the inherited source even when the
parent is not locally readable. A replacement retains its protocol event but
does not create a second Reader item or overwrite the appended human-visible
message or tool result. Web and native MCP consume that same normalized source.

## Alternatives considered

- Treat a selected v1/v2 source as unreadable: this would advertise a canonical
  session that 3.0 cannot open, losing supported historical data.
- Reuse v3 header and `startSeq`/`endSeq` rules: v1/v2 envelopes use different
  seed and replacement fields, so this would reject valid records or shift
  ownership.
- Render replacement content as another message: this would double-count a
  model-context rewrite as human conversation.

## Consequences

The v1/v2 parser is owned by DSH rather than a shared provider projection.
Invalid selected sources remain diagnosable. No provider source is migrated or
modified. CORE-07 remains open for native team, mailbox, workflow, and current
upstream coverage across representative real generations.

## Verification

The first two public historical acceptance cases failed against the previous
shared debug binary. The isolated implementation passed 3/3 in
[the HTTP and native MCP test](../../../v3/test/dsh-v1-v2-history.test.mjs):
v1/v2 raw and compressed sources, canonical highest-generation selection,
inherited/owned Reader and request usage, v2 replacement, protocol source
event, six-tool MCP access, and selected-source errors. The DSH Rust unit
tests passed 10 with two private opt-in tests ignored, and prior v0/v3 focused
HTTP/MCP checks passed 21/21. Synthetic source SHA-256 ledgers were identical
before and after each run. The frozen real DSH corpus contains v0/v3 only;
v1/v2 behavior still needs a real historical source and final integrated
binary check.
