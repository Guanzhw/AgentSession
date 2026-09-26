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
`b51b7fa66513da93063810ad191f2fb0cec5971796a6949fc1223c92003b0104`.

| Repetition | A0 startup (s) | A1 startup (s) | A0 first search (s) | A1 first search (ms) | A0 repeat (s) | A1 repeat (ms) |
|:---:|---:|---:|---:|---:|---:|---:|
| 1 | 25.889 | 13.588 | 11.596 | 63.4 | 11.530 | 58.6 |
| 2 | 25.087 | 12.706 | 11.683 | 72.5 | 12.273 | 54.8 |
| 3 | 24.618 | 12.659 | 11.376 | 62.7 | 11.278 | 55.6 |
| 4 | 24.667 | 12.802 | 10.860 | 83.1 | 11.889 | 62.0 |
| 5 | 26.610 | 13.354 | 12.388 | 60.3 | 12.085 | 70.0 |
| Median | 25.087 | 12.802 | 11.596 | 63.4 | 11.889 | 58.6 |
| p95 (maximum of five) | 26.610 | 13.588 | 12.388 | 83.1 | 12.273 | 70.0 |

Median measured search wall time improved about 183-fold for the first
unchanged-process query and 203-fold for its repeat. Startup improved about
49%, but remains above the two-second usability target. Median startup peak
RSS was 3.188 GB for A0 and 3.114 GB for A1; the content index does not solve
the startup memory peak. A1's reused metadata plus search databases occupied
about 52 MB, versus about 0.6 MB for A0's metadata DB.

One fresh A1 index build, kept separate from the five warm-restart repetitions,
took 16.755 s in the first Codex query after 12.963 s of startup; the next
query took 95 ms. Its metadata plus search databases occupied 47.96 MB. A
single cold-build observation is not a p95 estimate. A two-page `benchmark`
query reached the end with 34 results and identical page-sequence hashes in
A0 and A1. Synthetic tests additionally cover changed/deleted sources,
canonical duplicate IDs, OpenCode match ordering, short Chinese terms,
literal wildcard characters, and tool-name event references. Real MCP checks
exercised all five providers; the local Pi sample had no tool records.

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
