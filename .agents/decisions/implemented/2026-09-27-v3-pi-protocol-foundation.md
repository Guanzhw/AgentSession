---
status: implemented
date: 2026-09-27
decision: Pi publishes a validated same-byte partial protocol foundation
---

## Context

Pi source events already preserve physical JSONL rows and assistant content
blocks, including inactive in-file branches. Protocol documents and Work were
unavailable. A header parentSession records a path; entry parentId records
file-local ancestry. Neither establishes a recorded cross-session AgentRun.

## Decision

The [Pi adapter](../../../v3/crates/core/src/providers/pi.rs) reads one byte
snapshot for Reader anchors, revision, event candidates and observation coverage.
It finalizes a partial v2 bundle and uses the shared v3 upgrade to preserve the
same facts. Existing revision salt and Reader behavior remain unchanged.

Relationships, tasks, runs, branches, context, execution, coordination,
work and ownership remain explicitly unknown. Request usage was unknown in
this foundation slice; the later [Pi request usage decision](2026-09-27-v3-pi-request-usage.md)
adds source-backed `usageRecords`. Header, branch and compaction
events retain recorded source-order anchors. Header parent paths are not
converted into protocol relationships in this slice. Provider capabilities
continue to advertise only partial recorded session events.

## Alternatives considered

Deriving a canonical parent from its filename would discard the raw path's
meaning in the current relationship model. A later relationship slice can
decide how to retain a raw locator and expose derived identity. Inferring runs
from entry parentId would confuse file-local history with cross-session work.
Independent source reads would risk combining revisions.

## Consequences

Readable Pi sessions expose validated v2/v3 documents and empty partial Work
with explicit unknown coverage. This is a source-faithful foundation; structured
branch and context lifecycle remain unported even when corresponding raw events
exist. Reader parent derivation remains its existing separate projection.

## Verification

- The five new [foundation HTTP tests](../../../v3/test/pi-protocol-foundation-http.test.mjs)
  failed against the frozen pre-change release: four document 503 responses
  instead of 200, and malformed-record 503 instead of 422.
- The coordinator's shared debug build passed with `cargo build -p
  agentsession-v3 --locked --offline` using the current source.
- `node --test --test-concurrency=1 v3/test/pi-protocol-foundation-http.test.mjs
  v3/test/pi-protocol-slice.test.mjs v3/test/pi-rust-slice.test.mjs
  v3/test/protocol-events-http.test.mjs` passed 12/12, with no skips.
- Both public Pi formats preserve every physical row and content-block ordinal,
  complete event pagination, Reader/v2/v3 revision equality, inactive branch
  anchor boundaries, malformed-record errors and capability/coverage agreement.
- One frozen real Pi source passed 5-row/6-event assertions; its SHA-256 remained
  `c6db5c9c105be0961721fef7f0f8f1b5d2458933bc48fc13302fd768e0c42c29`.
  Original and isolated-copy hashes were checked after each HTTP run. This short
  real source does not cover branch or compaction behavior; public fixtures do.
- `npm run review` and `git diff --check` passed. Browser validation is delegated
  to the coordinator's shared Runtime checks; this slice directly verified HTTP
  and stdio MCP surfaces.
