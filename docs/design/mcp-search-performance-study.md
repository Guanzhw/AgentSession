# MCP search and Codex indexing study

## Decision to make

Determine whether a derived, incremental search index and a provider-owned
Codex scan projection make AgentSession's five-provider MCP search usable on a
large local history, and whether a narrow Rust worker adds enough benefit over
the same optimized Node data flow to justify shipping it. This study does not
authorize a full backend rewrite or a package release.

## Frozen behavior and data boundary

- Search preserves case-insensitive, whitespace-term AND substring matching.
  Candidate indexes may narrow work, but the existing matcher verifies every
  returned text hit. Include one- and two-character, Chinese, punctuation,
  Unicode case, multi-term, common-term, no-hit, and late-hit queries.
- A match retains canonical provider, session, message, and segment references.
  Check complete result sets across all cursor pages, roles, parent/child
  ownership, title/directory ranking, and source navigation. Tool-call
  discovery searches normalized tool names; tool inputs, outputs, and thinking
  remain behind the existing explicit read controls.
- Provider files and databases are read-only. AgentSession's index is derived
  state that can be rebuilt; user metadata and v1 history are preserved.
- Use the same local five-provider source snapshot and query labels for every
  arm. Keep raw query text and transcripts out of committed benchmark output;
  store query hashes, result-key hashes, source signatures, and counts. Record
  the source extent and any changes during a run rather than treating a live
  append as a stable snapshot.

## Comparison arms

| Arm | Work measured |
|:---|:---|
| A0 | Current Node startup metadata scan and complete MCP message search. |
| A1 | Node with the same search contract, provider-owned scan projection, and derived incremental content index. |
| B | Rust parser/index worker producing A1's exact projection and index updates; Node still owns MCP, HTTP, Viewer, and provider contracts. |

A0 to A1 measures data-flow and indexing gains. A1 to B measures the language
boundary's additional gain. Include Rust process startup, IPC, serialization,
and failure handling in B's elapsed time. Do not compare a warm B index with a
cold A0 scan.

## Workloads and recorded metrics

Measure initial full index build, unchanged fresh-process startup, one changed
or appended source refresh, first query, repeated same-process query, all-page
query traversal, metadata browse, and a long-session event read. Separate
fresh process from filesystem-cache state; call a run “cold disk” only if the
OS cache was actually controlled. Record Node/Rust versions, source commit,
configuration, corpus bytes and file count, exact command, elapsed wall/CPU
time, peak RSS, bytes and file reads, parse count, index size, result and error
counts, and complete result-key hashes. Retain every attempt, including
timeouts or failed index builds. Run at least five matched repetitions per arm
after the implementation is frozen, rotating arm order; report median and p95
with each individual run.

The proposed usability targets on the fixed local corpus are under one second
for repeated query p95 and under two seconds for unchanged fresh-process
startup. These are targets, not measured outcomes. Initial build and
incremental-update costs, disk usage, and correctness remain visible even if
query latency meets those targets.

## Adoption gate

Adopt a Rust worker only after A1 and B return identical complete results and
canonical provenance, including parent-dependent Codex records, source
changes, corrupt files, and every cursor page. B must improve at least one
end-to-end primary workload by roughly 30% median or reduce peak RSS by roughly
40% versus A1, without a material p95 regression. The installed npm packages
and Windows x64, Linux x64/arm64, and macOS arm64 binaries must pass their real
MCP smoke without requiring users to install Cargo. Record the maintenance and
distribution cost alongside the measured gain. If B misses the gate, keep A1.

## 2026-09-26 measured result and decision

The frozen Windows Codex corpus contained 840 JSONL files and 3,400,267,634
bytes (stat-manifest SHA-256
`0819d9d3232a22252a2dfcc4ae29463583678c3aea6ca5d96d9d5ba2193d7db0`).
Both arms used Node 26.5.1 on an i5-14600KF with 32 GiB RAM, the same
`updatedBefore` boundary, and likely-warm host caches that were not cleared.
Each run started a fresh MCP process against its own existing AgentSession
metadata DB; A1 reused its already-built content index. Five repetitions
alternated A0/A1 and A1/A0. All ten runs had no tool or provider errors,
unchanged pre/post corpus stat manifests, 20 first-page results, and identical
ordered result/reference hashes. The compiled artifacts are identified in each
ignored `tmp/bench-session-search/<run-id>/result.json`; A0 is clean
`d047100f2a2275283fd972a13b4f51c8c56c26b2`, and A1's measured core
artifact SHA-256 is
`f63d2e6142bd2662295983d50048f14ae264d867426c4bf0ac8da2e42ba882a8`.
The five A1 runs used the portable SQLite `instr()` candidate check. A later
guard for half-surrogate queries and removal of an unnecessary index-format
bump leave the measured `codex` query path unchanged. A separate warm check of
the final core artifact
`f819686df76d94395e74953cf0dc1da9e3bf8b969030ccdbbde0b57e9006cb4e`
returned the same hashes in 78.7 ms and 70.5 ms for first and repeated search.

| Repetition | A0 startup (s) | A1 startup (s) | A0 first search (s) | A1 first search (ms) | A0 repeat (s) | A1 repeat (ms) |
|:---:|---:|---:|---:|---:|---:|---:|
| 1 | 25.347 | 12.741 | 11.560 | 90.7 | 11.274 | 69.9 |
| 2 | 25.729 | 13.072 | 12.197 | 94.0 | 11.909 | 78.4 |
| 3 | 24.971 | 12.681 | 11.490 | 76.8 | 11.448 | 70.4 |
| 4 | 24.749 | 12.425 | 11.161 | 84.4 | 11.202 | 73.8 |
| 5 | 24.565 | 12.318 | 11.360 | 93.2 | 11.108 | 79.2 |
| Median | 24.971 | 12.681 | 11.490 | 90.7 | 11.274 | 73.8 |
| p95 (maximum of five) | 25.729 | 13.072 | 12.197 | 94.0 | 11.909 | 79.2 |

Median measured search wall time improved about 127-fold for the first
unchanged-process query and 153-fold for its repeat. Startup improved about
49%, but remains above the two-second usability target. Median startup peak
RSS was 3.192 GB for A0 and 3.134 GB for A1; the content index does not solve
the startup memory peak. A1's reused metadata plus search databases occupied
about 36.5 MB, versus about 0.6 MB for A0's metadata DB.

One fresh A1 index build, kept separate from the five warm-restart repetitions,
took 11.847 s in the first Codex query after 12.427 s of startup. Its metadata
plus search databases occupied 36.51 MB. A
single cold-build observation is not a p95 estimate. A two-page `benchmark`
query reached the end with 34 results and identical page-sequence hashes in
A0 and A1. Synthetic tests additionally cover changed/deleted sources,
canonical duplicate IDs, OpenCode match ordering, short Chinese terms,
literal wildcard characters, a UTF-16 half-surrogate query, and tool-name event
references. Real MCP checks exercised all five providers; the local Pi sample
had no tool records.

The [standalone Rust parser probe](../benchmark-rust-codex-parse.md) found a
13.227 s Node versus 7.621 s Rust median for source read, JSON parse, and
record-envelope hashing, with exact raw digests. This is useful evidence for
investigating the **startup scan**. It is not B: the Rust probe does not emit
Codex's normalized, parent-owned search projection, replace the startup scan,
or include worker IPC and package integration. No Rust worker is adopted in
this change. The next architecture experiment should compare A1 with a narrow
worker that owns both Codex startup scan and normalized search projection,
using the parity and packaging gate above. A persistent startup projection is
also worth testing because raw parsing in Rust alone would still leave a
multi-second startup on this corpus.
