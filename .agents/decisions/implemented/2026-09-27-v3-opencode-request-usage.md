---
status: implemented
date: 2026-09-27
decision: OpenCode records at most one source-backed request usage per assistant message in Session Protocol v3
---

# OpenCode request usage in Session Protocol v3

## Context

The OpenCode v3 protocol exposed source events but left request usage empty,
although OpenCode 2.0 already projected assistant-message token records. A
session summary's aggregate token counters cannot identify individual
requests. OpenCode v1 joins messages to parts in Reader views, and v2 fork
databases can contain copied parent rows, so neither a part join nor every row
stored under a fork establishes a request owned by that session.

## Decision

The [OpenCode adapter](../../../v3/crates/core/src/providers/opencode.rs)
projects usage from the provider-owned message tables. For v1 it reads each
message once and accepts assistant messages only, independent of their number
of parts. For v2 it accepts assistant rows using the same inherited-row filter
as the event stream, so a copied parent request is not attributed to the fork.
Each record uses the canonical session and message IDs and links to the native
v1/v2 source event when that event exists.

The mapping follows the 2.0 `messageTokens` semantics: input, output, and
reasoning are recorded as known zero when absent or invalid; absent cache-read
and cache-write values remain unknown; an explicit total is retained only
when it equals the sum of the known components. All-zero records, including
zero-token error responses, and total-only values do not create request records.
Model, timestamp, recorded provenance, and message ownership remain tied to
that assistant message. Usage coverage is `observed` when records exist and
`not-observed` otherwise. No session-summary totals are used to fill request
fields.

The adapter reads usage at the same stable source revision as the protocol
event stream. Shared protocol validation remains responsible for canonical
session ownership, unique record IDs, and event-anchor consistency. Daily
statistics and export aggregation are separate work; this change does not
close CORE-14.

## Alternatives considered

Summing session-level token counters or emitting one usage item per Reader part
would invent request boundaries. Including fork copies would assign inherited
usage to a second session. Neither matches the source ownership evidence.

## Consequences

Both supported OpenCode SQLite schemas can expose recorded assistant request
usage with explicit cache and total semantics. Missing cache components and
inconsistent totals stay unknown, and a session without request records keeps
`not-observed` coverage. Statistics and other providers remain unaffected.

## Verification

- The public v1/v2 HTTP test was RED against the pinned older release binary
  (`1f213e649f102e8e69a83e62f457a9ab5d867c12c66e7291b76b987a096435f1`): the
  v1 request IDs expected from assistant messages were absent. The new public
  schema fixtures then passed 2/2, covering exact IDs and source ownership,
  cache/reasoning/total fields, part de-duplication, fork-copy exclusion,
  zero/error and missing usage, and observed/not-observed coverage.
- The frozen read-only SQLite oracle checked one selected OpenCode session and
  252 recorded requests against raw v2 message rows. Database snapshot SHA-256
  `c9df86b1ab86eace661e8d0e608b48df83aa87fdc9ec5448efa760cd5fbf3429` and its
  WAL state were unchanged. The fixture-side and provider databases are read
  only during protocol reads.
- Focused OpenCode HTTP, Reader, protocol-slice, and Web/MCP source-read tests
  passed 16/16 against debug binary SHA-256
  `c2950010a3c2ad1c19a7ff7641ae7e6d8c9d8f71b11bd6843c81d324c42940bf`.
  Rust workspace tests passed 101 core and 2 app tests; 11 source-gated tests
  remained ignored. Governance and the final diff check are recorded in the
  delivery plan.
