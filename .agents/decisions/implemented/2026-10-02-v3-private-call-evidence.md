---
status: implemented
date: 2026-10-02
decision: v3-private-call-evidence
---

# Private request and terminal evidence for acceptance

## Context

The historical exact83 shared-state round4 lost the raw browse error and original cursor. A later complete-page attempt ended without a completion marker after one successful round and an incomplete second round. Neither event identifies a product cause or a historical default-metadata writer. SQLite read-only use also changed the copied OpenCode SHM timestamp while the entire database family kept identical endpoint bytes.

## Decision

Use [file-backed call evidence](../../../scripts/v3-bench-call-evidence.mjs) for shared-state, matched-search and controlled QA consumers. Save exact private requests before dispatch and successful responses or serialized SDK/HTTP errors before assertions. Audit begin/terminal identities and content hashes. Immediately observe MCP startup rejections, bound startup waiting and retain nullable child exit observations. Keep user-facing output to counts, fixed labels and hashes.

Run long acceptance controllers as hidden standalone owned processes, with independent fresh state and completion records. Preserve interrupted and historical attempts. Tests use copied provider inputs and explicit shadow profiles; original databases and existing listeners are outside execution scope.

Declare a separate current byte-equivalent input gate before measuring: require full file/count/content preservation, stable runtime/helper identity and stable stat metadata except an OpenCode `-shm` mtime change with exactly equal bytes. Report stat deltas. The original stat-strict flags and historical failures retain their own values; a new bounded subclaim must not rewrite them. Controlled metadata endpoint semantics and qualified FileSystemWatcher events can establish current isolation, but cannot identify historical writers or certify continuous kernel-level write absence.

## Alternatives considered

- Post-assertion summaries: lose precisely the failed response and cursor needed for diagnosis.
- Reusing retained state or overwriting failed rounds: confounds fresh-state acceptance and destroys evidence.
- Treating any database file hash/time change as changed user metadata: ignores derived index data and SQLite shared-memory bookkeeping.
- Kernel FileIO attribution on this machine: WPR FileIO start returned access denied (`0x80070005`), so no trace was collected.

## Consequences

Private evidence uses additional disk and synchronous observer work. SDK dispatch timing excludes evidence writes; startup answer timing includes them and remains separately labeled. OS cache/background workloads and process-only resource sampling remain explicit limits. Byte equality is an endpoint claim, with only the stated SHM timestamp exception; it is not writer attribution. Product Rust/UI and release binaries are unchanged.

## Verification

Meaningful RED failures, preserved unsuccessful runtime attempts and current helper regression results are indexed in the local continuation report (`../../../tmp/v3-performance/formal-resume-20261001T1901/RESUME-REPORT.md`, local evidence). The final actual-source focused suite has 71 tests, exit 0; root review exit 0. Exact83 five-round traversal is 4P/1F with 2040 complete raw pairs; its new provider_error and startup guard gaps remain explicit. Paired raw/golden correctness audit is true, current byte-equivalent eligibility true, while original strict flags/exit 1 remain unchanged. Exact83 controlled metadata and current-input debug crash have separately bounded passes. Six actual paired guard-function cases passed before measurement. Sealed history, 70 production inputs and candidate identity matched at final verification. No historical failure or whole-stage completion is inferred.
