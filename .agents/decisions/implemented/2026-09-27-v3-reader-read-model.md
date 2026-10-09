---
status: implemented
date: 2026-09-27
decision: Publish a scope- and exact-source-revision-bound Codex Reader read model; keep other providers on their adapter-owned source-backed Reader path.
---

# AgentSession 3.0 Reader read model

## Context

The existing catalog/search [publication decision](2026-09-27-v3-index-publication.md)
does not cover Reader. A frozen 753 MB Codex root needed about 20.58 seconds
for bootstrap and 19.99 seconds for its first relations page, with about
1.07 GB peak resident memory. A later 32-entry relations page took 38.43 seconds
and about 1.24 GB peak memory. Each route reloads the parent; placement can
also load children and traverse the complete protocol stream. The returned
page size alone does not bound construction work.

## Decision

The implemented Codex path is a rebuildable SQLite Reader projection scoped by
source scope, provider, canonical session ID, exact selected-source revision,
and projection version. Provider adapters own source selection, capture and
normalization. The shared core queries published Reader items, event lookup,
TOC, content chunks, relations and placement anchors without provider-specific
schema rules. A generation becomes visible only after successful validation
and atomic publication. Web and MCP processes share it under the same scope.
Codex supplies `reader_revision` and `reader_capture`; the adapter default
returns no persistent Reader stamp, so the other four providers retain their
source-backed Reader path. This is the current adoption boundary.

Initially preserve the current exact-source freshness contract: reselect the
source and hash its bytes with bounded buffers on each request. A matching
generation skips full JSON parsing and normalization; a changed source or
dependency invalidates old cursors. Cold capture and large-record memory must
be measured separately. Before implementation, freeze the exact Reader output
and a deterministic repeated-normalization RED test; add append, rewrite,
truncate, same-size/same-mtime rewrite, source-selection, scope, child-parent
dependency and crash/lock cases before claiming a durable read model.

## Alternatives considered

- A process-local `LoadedSession` cache cannot serve independent Web and MCP
  processes and can retain large bodies in each process.
- mtime/size or watcher-only freshness misses an arbitrary same-size rewrite
  with the timestamp restored. Sublinear source IO on every request requires
  a different, explicitly accepted snapshot-freshness contract or a proven
  strong change token.
- Tail-only append parsing comes after ownership, deduplication, tool-output
  completion and fallback-ID effects are shown safe for each provider.

## Consequences

The first version may still read all source bytes for an exact hash, and a
cold generation may still use the present parser. Those costs remain visible
until streamed capture replaces whole-file materialization. Content is never
truncated to meet a resource target. A generation's Reader and relation refs
retain public canonical identities and recorded provenance; missing evidence
retains a diagnostic. Incomplete staging is invisible and a failed refresh
cannot masquerade as a current result.

## Verification

Require exact item/ref/order/owner/TOC/placement and full content hashes on
the public three-level fixture and the frozen long root, plus unchanged source
SHA. Check hot same-process and new-process pages, stale cursor cases and
crash/restart with a Web process and two independent MCP processes. Record
first visible content, complete paging, CPU, source bytes read, parser counts,
peak combined RSS and derived disk size over matched repeated runs. The current
long-root measurements are the pre-change baseline, not evidence of a gain.
The publication boundary is implemented; runtime checks retain their exact
binary and source scope. Remaining measurements belong to the
[acceptance contract](../../../docs/design/agentsession-v3-acceptance-contract.md)
rather than an unresolved choice of publication architecture.

## Pilot evidence and remaining gates

The first Codex implementation publishes items, relations, placements and
UTF-16 content chunks in one SQLite transaction. Public Reader and browser
checks, the frozen long-root release probe, and a new-process parser-count test
confirm reuse. An independent review found two concrete defects: content seek
had no `start_units` index, and an offset above SQLite's signed range produced
HTTP 500. Both now have failing-then-passing focused regressions. A separate
two-Web/two-MCP cold-open test reproduced an immediate SQLite `database is
locked` error. WAL/schema initialization now has its own cross-process lock;
session publication keeps a separate lock so hot reads do not queue behind a
long cold capture. Schema version 0 caches acquire the offset index on open.

The Codex pane-search path now reads this model in bounded chunks and reuses it
in a new process. The review and public tests do not yet establish a matched
long-root output/hash comparison, cold peak-memory target, crash/lock recovery,
or final release Web-plus-MCP resource profile at that checkpoint. Other
providers retain their source-backed Reader path. These historical results
keep their original scope; the chosen current adoption boundary is Codex.

A later deterministic source-rewrite check caught a direct Codex load returning
mixed early/late rows after a same-length rewrite with mtime restored. The
provider now verifies the raw source hash after every plain stream parse; the
focused RED/GREEN test covers direct `session_get`, `session_timeline`, and cold
Reader capture. This adds a bounded full-byte read to cold Codex capture, so
the earlier resource measurements need a matched replay before acceptance.

Current Windows83/Linux70 share the same 70 production inputs. The
current candidate report (`../../../tmp/v3-delivery/FINAL-CANDIDATE-20261001.md`, local evidence)
links complete regressions, raw/API/DOM content equality, exact-release
five-pair Reader timing and actual Linux source I/O. The
source-I/O report (`../../../tmp/v3-delivery/reader-source-io-70caaeed-20261001/REPORT.md`, local evidence)
records each warm request's exact full-source hash reads and final source
reply through the last cursor; that original run did not measure internal
build counts. A later original-ELF breakpoint and fixed2 V8 coverage check (`../../../tmp/v3-delivery/projection-counter-70caaeed-20261001/REPORT.md`, local evidence)
observed cold capture/normalization/publication once and zero warm rebuilds on
the same 15-source cohort. Its instrumented durations are excluded from
latency results. The same original ELF later completed every selected-root
segment and TOC page: 1,498 ordered source references match the preserved
historical DOM ledger, with 70 successful HTTP responses and final null cursors.
The independent saved-response review is linked from the counter report;
shared-process performance keeps its separate DEL-03 status. Production telemetry was
not added and counts are not inferred from cache files or source inspection.
