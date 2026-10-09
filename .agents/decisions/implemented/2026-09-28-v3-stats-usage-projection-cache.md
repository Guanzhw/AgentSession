---
status: implemented
date: 2026-09-28
decision: Cache validated Codex usage projections by source scope, catalog revision, and exact source digest.
---

## Context

The v3 stats route loaded a full protocol observation snapshot for every selected session on every request. On a frozen Codex inventory of 840 JSONL files representing 837 canonical sessions (3.4 GB), the first request took 46.864 seconds and a repeated request took 27.800 seconds. Date and model filters only need a small projection of each validated `UsageRecord`.

## Decision

`v3/crates/core/src/stats.rs` stores the fields used by statistics in a derived `stats-v2.sqlite` cache under `cache_dir`, separated by `source_scope`. A projection version, provider, catalog revision, exact source digest, and canonical session ID identify each entry. Codex opts in for full-inventory stats queries: its adapter selects source files once per digest pass and hashes each selected path and its bytes, covering copied-parent usage dependencies. Date and model filters aggregate those validated records per request. Directory, project, and root-scope queries remain uncached; Codex still uses the request-local observation batch, while OpenCode, Claude Code, Pi, and DeepSeek Harness use their ordinary protocol path.

Newly needed sessions are captured through the provider-owned validated protocol builder. A single SQLite transaction publishes them only after all selected sessions succeed and a second catalog revision and source digest match the initial ones. Publication takes the catalog's scope lock and checks its current revision again, preventing a concurrent catalog publisher from advancing it between validation and cache commit.

Codex now keeps its selected source-path map in a request-local Stats observation batch, so capturing each uncached session does not repeat the full source inventory walk. The batch constructs one protocol observation at a time through the same provider-owned builder. It validates a fresh exact source digest before returning, including for filtered queries that do not publish a usage cache. No selected-path map survives the Stats request.

The same request-local batch also records each selected source's canonical child identity once. Child dependency revisions and spawn resolution reuse these headers while retaining the original selected-source order, canonical-ID checks, copied-child byte hashing, and source-change validation. This avoids reopening every other session header for each uncached Codex session; the lightweight map expires with the request.

The Codex source digest now hashes selected file bytes independently with at most four scoped workers, then folds each file's SHA-256 and byte length with its canonical ID and selected path in sorted order. The digest domain advances from `codex-stats-usage-source-v7` to `v8`, invalidating old usage cache keys. The first and final full source checks, read errors, and whole-provider invalidation remain unchanged. Worker completion order cannot affect the aggregate. This is a latency pilot pending the frozen-corpus benchmark; the exact full-byte checks still run twice per Stats request.

## Alternatives considered

Caching complete HTTP reports would make date, model, directory, project, and scope filters difficult to compose and would duplicate response state. Fine-grained source dependencies could reduce invalidation work but require provider-specific dependency tracking beyond the current catalog contract.

## Consequences

Any Codex catalog revision or selected-source content change invalidates the whole provider projection, including unchanged sessions. The two exact digest passes read all selected source bytes per request, so the real-corpus benchmark determines whether warm requests improve enough to justify this conservative first slice. Provider sources remain read-only. Failed protocol capture, aggregation, or revision validation does not publish partial usage.

## Verification

RED before the exact digest: a fresh index reusing `codex:1` returned 15 instead of 16 known tokens from changed source, and a same-size, restored-mtime rewrite also returned 15 instead of 16. Focused Rust tests now cover filter JSON parity, restart reuse, both regressions, parent-source invalidation, scope isolation, empty-selection pruning, excluded malformed sources, mid-capture and concurrent-publication `SourceChanged`, and failed-capture atomicity. Run `cargo test --workspace`, `cargo build --workspace`, `node --test v3/test/stats-slice.test.mjs`, and `npm run review` for final verification.

For the request-local batch, a new source-walk regression was RED before implementation and GREEN afterward. `cargo test -p agentsession-core stats::tests` passed 19 tests, including a six-session walk bound and filtered mid-capture source-change rejection. `cargo test -p agentsession-core providers::codex::tests` passed 50 tests (8 private-corpus tests ignored); `cargo fmt --all` and `npm run review` passed. The frozen 840-file latency and report-hash check remain part of the release rebuild.

The child-header regression used six sessions: 30 direct `child_identity` reads before reuse and 6 afterward. The selected parent/child protocol document retained the same revision and run binding. After this change, `cargo test -p agentsession-core --lib` passed 155 tests (14 private opt-in tests ignored); an independent review found no verified P1/P2 finding against the prior ext4 source snapshot. The 840-file catalog-warm, usage-cold trial is recorded separately in the delivery evidence, with an exact response hash check.

The parallel digest pilot recorded RED compilation for the new worker-count tests before implementation, then GREEN for three focused cases. Those cases check the v8 aggregate against an independent ordered construction, 1/2/4-worker equality, same-size restored-mtime mutation, selected ID/path changes, and the original selected-path I/O error. The frozen 840-file warm Stats benchmark remains the adoption gate.

Independent review found that a failed selected-file read still dispatched all remaining files before the ordered fold returned its error. Workers now stop taking new files after a failure; at most the already assigned workers finish. The lowest failing selected index still determines the returned path. An injected-read regression failed against the unbounded worker loop and passed after cancellation; with one worker, it confirms only the first file is read from a 100-file selection after its error. The separate four-worker case checks ordered error selection. `cargo test -p agentsession-core --lib` passed 181 tests with 14 private opt-in tests ignored, and `cargo fmt --all -- --check` passed.
