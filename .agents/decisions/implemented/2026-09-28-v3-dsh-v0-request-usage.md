---
status: implemented
date: 2026-09-28
decision: Project DeepSeek Harness v0 assistant settlement usage as source-owned requests after the seed boundary
---

# DeepSeek Harness v0 request usage

## Context

The Rust v0 reader retained assistant messages but left request usage and the
session token total empty. The released 2.0 adapter selects v0
`assistant/message` usage from child-owned events. A checked-in rc8 transcript
has two such settlements with turn/step, source sequence, timestamp, model, and
token fields. The frozen real seeded v0 child has one usage-bearing settlement
after `seedLength` and an inherited settlement before it. An unseeded frozen
v0 generation has 508 usage-bearing settlements. These records establish
request ownership without deriving usage from rendered text or session totals.

## Decision

The [DSH adapter](../../../v3/crates/core/src/providers/deepseek_harness.rs)
emits one request record for each owned v0 `assistant/message` with valid
recorded usage. It excludes rows before `seedLength` and does not treat
`assistant/attempt`, other usage-bearing events, or packed chunks as v0
requests. Each record retains the canonical session, source event sequence,
timestamp, turn when recorded, and provider model provenance. Token components
use the same source-boundary validation as later generations: reasoning is a
subset of output, absent cache-write remains unknown, and an absent total is
computed only from the recorded exclusive components. Invalid usage produces
an event-anchored warning. A source with no accepted requests reports
`not-observed`, or `unknown` when invalid recorded samples prevent that
conclusion. The session token total sums accepted request totals when present.

The v1/v2/v3 turn/step replacement and retry fold remains unchanged; v0 has
one settlement event per recorded request in the observed source shapes.

## Alternatives considered

Leaving v0 unknown would discard recorded request evidence. Reusing the
v1/v2/v3 slot fold would impose retry semantics that the frozen v0 sources do
not record. Counting every usage-bearing row would include non-request events.

## Consequences

v0 request usage and the session token total are available to Protocol and
statistics consumers for selected v0 sources. Absent token categories remain
unknown. This does not infer usage for rows without a recorded settlement.

## Verification

The rc8 Rust behavior test first failed with zero usage records and now passes
with two exact request records (including cache, visible output, reasoning,
model, provenance, and totals). Focused HTTP tests confirm the same two
records and compare the seeded frozen v0 child's one owned request against an
independent raw Zstandard frame decode. The frozen source SHA-256 is checked
before and after Web and stdio MCP access. The frozen unseeded v0 source was
independently inspected: 508 owned assistant settlements carry usage, all with
append surface operations and turn/step; three other usage-bearing event kinds
remain outside request projection. The Windows portable executable SHA-256
`8a2a1d7daa16f592c34b493add9897d3cd52edcb97bcaba167c4adadd5bfc04f`
then loaded an isolated copy of that v0 source through HTTP. Its validated
Protocol v3 document returned 508 canonical-owned requests totaling
102,197,093 tokens, matching the independent raw decode. Original and copy
SHA-256 remained `8cca0c2f3e8d8e463a5577149efa5f951f59c51fba7cb12d8b6b900c9b6c5eeb`.
The run recorded its counts and hashes in the ignored
`tmp/v3-delivery/dsh-v0-large-8a2a1d7d/evidence.json`. This does not close
all CORE-14 or HTTP-06 provider and export cases.
