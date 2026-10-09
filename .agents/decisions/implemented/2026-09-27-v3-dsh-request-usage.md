---
status: implemented
date: 2026-09-27
decision: DeepSeek Harness v3 publishes source-backed request usage per turn and step settlement
---

# DeepSeek Harness request usage in Session Protocol v3

## Context

The 3.0 DSH adapter read native v3 conversations and source events but exposed no
request usage. A rendered assistant message can be preceded by an attempt in
the same turn/step slot, and a recorded retry opens another request. Summing all
usage-bearing rows double counts attempts, while a session total loses request
ownership. The frozen v3 source also omits `cacheWriteTokens` in recorded
settlements.

## Decision

The [DSH adapter](../../../v3/crates/core/src/providers/deepseek_harness.rs)
selects recorded usage on `assistant/message` and `assistant/attempt` rows from
unseeded native v3 sources. Within one turn/step slot a later settlement
replaces the attempt; `llm/retry-started` clears that slot so the next attempt
is a distinct request. Each retained request carries its raw sequence, event,
timestamp, model when recorded, and canonical session. The adapter treats
`reasoningTokens` as a subset of output, retains absent token fields as `null`,
and does not manufacture a total when the source omits one. Invalid recorded
usage is omitted with an event-anchored protocol warning; it is not silently
counted. The v3 coverage domain reports observed, not-observed, or unknown
according to the evidence. Historical v0 settlements are covered by the later
[v0 request-usage decision](2026-09-28-v3-dsh-v0-request-usage.md).

## Alternatives considered

Aggregating Reader messages would lose failed attempts and retry boundaries.
Adding all source usage rows would count an attempt and its settlement twice.
Filling an absent cache-write component from a reported total would claim a
token category the source did not identify.

## Consequences

Session Protocol v3 exposes DSH native-v3 request records with source ownership
and retains partial token accounting honestly. The later v0 decision adds its
provider-owned request usage projection.

## Verification

- The [public HTTP tests](../../../v3/test/dsh-protocol-foundation-http.test.mjs)
  first failed because `usageRecords` was empty and attempt records could not
  be parsed. They now cover a complete request, missing cache write, settlement
  replacement, retry separation, a recorded zero-token request, and an invalid
  sample warning.
- The same test independently decodes both frames of the frozen 3,251-row DSH
  v3 source, compares all 508 assistant settlement requests and exclusive
  components with the real Axum document, and verifies source SHA-256 did not
  change. DSH Reader, foundation, v0, and stdio MCP focused tests pass.
- The shared protocol validator continues to check unique request identities,
  canonical ownership, and exact event provenance.
