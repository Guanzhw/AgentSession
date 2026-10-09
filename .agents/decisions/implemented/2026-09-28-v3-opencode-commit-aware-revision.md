---
status: implemented
date: 2026-09-28
decision: Include bounded SQLite commit evidence in the OpenCode source revision used by search and Reader caches.
---

## Context

The OpenCode adapter previously identified a source revision from the database and WAL paths, sizes, and creation/modification times. A rapid same-size SQLite commit on Windows can preserve that signature. A real stdio MCP regression then reused an indexed document and returned `ok` after the underlying message JSON had become corrupt. The original focused case failed twice in 30 runs; a controlled fixture preserved the file metadata while the database change counter advanced from 5 to 6 and reproduced the stale result deterministically.

SQLite's [database format](https://www.sqlite.org/fileformat2.html#file_change_counter) documents the main-file change counter and notes that it need not advance on every WAL transaction. Its [WAL-index format](https://www.sqlite.org/walformat.html#the_wal_index_header) provides committed-frame state. A freshly opened `PRAGMA data_version` connection is not a comparable cross-request revision, as the [pragma contract](https://www.sqlite.org/pragma.html#pragma_data_version) requires comparison on the same connection.

## Decision

The provider revision hashes the existing DB/WAL metadata plus the first 100 database bytes, 32 WAL header bytes, and, while a nonempty WAL exists, the first 96 bytes of the WAL-index header when present. These bounded reads include the rollback-mode change counter and both WAL-index header copies without depending on reader lock/read-mark bytes. Missing sidecars have distinct markers; read errors remain explicit. The revision namespace advances from `opencode-sqlite-v3-slice-2` to `slice-3`, invalidating older derived cache entries.

## Alternatives considered

Hashing the entire database and WAL on each revision check would make routine search and Reader access proportional to provider database size. Database file metadata alone caused the observed collision. The main-file change counter alone misses WAL commits. A new SQLite connection's `PRAGMA data_version` value cannot be compared with an earlier connection's value.

## Consequences

Ordinary committed SQLite changes are detected even when timestamps and file sizes collide. This is a bounded commit fingerprint, not an arbitrary full-content hash against externally rewritten pages. Provider files are opened for reads only by this change; the adapter's existing read-only SQLite connection behavior remains separate.

## Verification

The deterministic rollback-journal case failed before the correction and passed afterward. A same-metadata, preallocated-WAL case and a copied WAL without a shared-memory sidecar also pass. Focused Node tests passed 16 with two private-data cases skipped; Rust workspace tests passed 165 core and 2 app tests with 14 conditional tests ignored. An independent review reran the three targeted cases and found no actionable defect. The final packaged binary and whole-suite evidence are recorded in the delivery plan.

On 2026-10-02, the empty-WAL reader-index lifecycle correction retained this commit-aware contract: an empty WAL has no committed frames, so a short or rebuilt SHM is excluded from its revision. Two deterministic source tests and an offset-100 MCP continuation failed with UnexpectedEof before the fix; four regression tests, 187 core/5 app tests, 21 Node cases and four-page real-copy traversal passed afterward. The correction evidence (`../../../tmp/v3-delivery/opencode-empty-wal-fix-20261002/REPORT.md`, local evidence) preserves diagnostics, failures and source bindings. Nonempty WAL and truncated source errors remain checked; the old exact83 failure is not retroactively attributed or passed.
