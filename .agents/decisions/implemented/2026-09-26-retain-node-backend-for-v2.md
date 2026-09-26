---
status: implemented
date: 2026-09-26
decision: Retain the Node backend for AgentSession 2.0 and gate any later Rust component on matched evidence
---

# Retain the Node backend for AgentSession 2.0

## Context

The Viewer and MCP need complete five-provider history and search. A local
Codex cold-service profile measured 23.1 seconds for index refresh and 11.6
seconds for the following search, with high transient memory. CPU samples
identified JSONL parsing, hashing, decoding, and collection. Source inspection
found two cold-scan corpus passes: `sessionFiles.list()` parses to build file
metadata, then `scan()` rereads evicted bodies for owned counts and library
evidence. Search makes another complete pass. Separately, the long Reader page
spent much of its first load transferring and constructing a large DOM; lazy
complete-turn segments addressed that browser-side cost.

## Decision

Keep the TypeScript/Node backend for 2.0. Complete search and bounded Reader
loading are implemented in their existing ownership boundaries. Treat the
remaining Codex cost first as duplicated provider scan work: a future
provider-owned scan projection may reuse parsed evidence while preserving
parent provenance, source freshness, and the read-only provider boundary. A
native parser or index worker needs a matched correctness, time, and memory
comparison before adoption; this record does not commit to one.

## Alternatives considered

- Rewrite the backend in Rust for 2.0: it would leave repeated full-corpus
  passes and browser DOM construction intact unless the data flow changed too,
  while adding cross-platform packaging and maintenance at the release gate.
- Split JSONL on bytes before decoding in the existing parser: on a single
  753 MB rollout, three fresh-process runs kept the same source hash and
  81,428 records and reduced peak RSS, but were about 12% slower than the
  current parser. The prototype was not adopted.
- Stop searching after a convenient candidate count: rejected because later
  matches would again be silently unreachable.

## Consequences

The 2.0 release retains a measurable cold Codex indexing/search cost. The
decision avoids a language migration without a demonstrated net benefit and
keeps the next optimization scoped to the owning provider. Future benchmarks
must include the full result set, parent/child provenance, source changes,
peak memory, Windows/Linux/macOS packaging, and maintenance cost.

## Verification

The [2.0 delivery evidence](../../../docs/design/agentsession-v2-provider-scope.md)
records profile timings, memory samples, real search behavior, and Reader
measurements. The parser prototype used an ignored local benchmark against a
read-only historical rollout; no tracked source edit resulted. The current
branch's MCP and Viewer acceptance covers complete search and bounded output
on real provider data.
