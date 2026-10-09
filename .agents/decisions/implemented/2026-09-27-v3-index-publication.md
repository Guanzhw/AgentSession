---
status: implemented
date: 2026-09-27
decision: Use provider-owned source inventories and a scope-isolated SQLite read model with atomic catalog and search publication for AgentSession 3.0.
---

# AgentSession 3.0 derived index publication

## Context

The Rust vertical slice reads provider sources correctly but reparses full
sessions for each list or Reader request. Its browse cursor hashes session
summaries, so a body-only rewrite with an unchanged summary leaves the old
cursor valid. The public regression in
[`v3/test/mcp-browse-slice.test.mjs`](../../../v3/test/mcp-browse-slice.test.mjs)
records this failure. A derived index must make unchanged startup cheap while
keeping provider files authoritative and read-only.

## Decision

Give each provider adapter ownership of a cheap, complete source inventory,
source capture/revision evidence, and index-document extraction. Keep source
format, generation selection, append safety, and parent dependencies in that
adapter. The shared core stores a catalog and search read model in a SQLite
sidecar under an effective source-scope namespace. It never uses viewer
metadata or a canonical session ID alone as a source-cache key.

One OS advisory refresh lock per scope coordinates independent Web and stdio
MCP processes. Changed sources are parsed into staging generations; a short
SQLite transaction publishes catalog, search documents, diagnostics, and one
durable revision together. Queries read one published revision. Only a
complete successful provider inventory can confirm deletion. Browse/search
cursors bind effective filters, source scope, and the published revision, so
an observed source rewrite invalidates them even if visible summary fields
are unchanged. Reader continuations remain bound to their own source revision.

Start with whole-session rebuilds for changed sources. Add tail-only parsing
only after a provider's append behavior and owner/usage semantics are proven.

## Alternatives considered

- Keep reparsing on every query: simplest, but it cannot meet the measured
  startup/search workload or reliable catalog revision semantics.
- Use a process-local cache: helps one process but gives independent MCP hosts
  no shared revision or refresh coordination.
- Hold one SQLite write transaction while parsing the entire corpus: atomic
  but blocks readers and increases crash/lock costs.
- Use FTS5 as the search contract: its tokenization differs from the accepted
  AND-substring behavior; it can be considered later only as a no-false-negative
  candidate filter.

## Consequences

Provider adapters need a typed inventory/capture boundary beyond `list()` and
`load()`. Storage adds an internal schema and cross-process lock, while public
session identity and viewer metadata remain provider plus canonical ID. A
source that is unavailable, unreadable, or only partly enumerated must yield
an explicit diagnostic; a failed refresh cannot silently publish old facts as
current or remove indexed sessions. The index is rebuildable and does not
migrate or delete 2.0 state.

## Verification

First turn on the recorded body-only rewrite regression and prove an unchanged
fresh-process run does not parse session bodies. Then check append, rewrite,
truncation, deletion, corrupt tail, compression generation switch, and parent
dependency changes against source facts and stale cursors. Exercise one Web
and two MCP processes with crash/restart and separate source scopes sharing a
metadata path. Compare full search results and refs before measuring matched
time, CPU, memory, disk, and output against the frozen 2.0 baseline. The chosen
scope, capture and atomic publication boundaries are implemented in
[`index.rs`](../../../v3/crates/core/src/index.rs); product-level acceptance
remains explicit in DEL-01/03 of the
[acceptance contract](../../../docs/design/agentsession-v3-acceptance-contract.md).

The debug-only `crash-test-hook` feature now pauses after the catalog revision
write and before SQLite commit, with an explicit child-process environment
opt-in. [`index-crash-recovery.test.mjs`](../../../v3/test/index-crash-recovery.test.mjs)
waits for that phase marker, checks the previous catalog, search rows, FTS,
and revision through a separate read-only SQLite connection, then force-kills
the writer. It checks rollback and `quick_check=ok` before one Web and two MCP
processes concurrently refresh the copied source. Their successful responses,
new search term, and rejected old cursor establish recovery on the exercised
Windows debug binary. The feature is absent from ordinary builds and explicitly
rejected in release builds. The 2dd3c8ab packages were not rebuilt for this
test; full multi-process resource limits remain open.
The first instrumented test run exposed a wrong assertion about the unchanged
second fixture session's old search term; its failure log was retained and the
assertion was corrected. The final focused run passed 3/3. The instrumented
binary contains the phase marker while the unchanged 2dd3c8ab Windows package
does not.

The same unchanged deterministic test also passed on an isolated WSL ext4
Linux x64 snapshot: locked/offline debug build with `crash-test-hook`, ELF
SHA-256 `800acb041bede157956983ee6effc06979b6daa5ea9331364572e3a883f9889b`.
It observed the exact pre-commit marker, old catalog/search/FTS/revision during
the hot transaction and after SIGKILL, then revision 1 to 2 and consistent new
search results across the surviving Web and two MCP processes. SQLite
`quick_check` returned `ok`; all four children exited, and all 67 snapshot
files matched their original per-file SHA-256 manifest. The test passed 1/1
in 384.664 ms (1172.012 ms including runner). Evidence is retained in ignored
`tmp/v3-delivery/linux-crash-hook-20260929/` (`summary.json`, `test.log`,
`crash.stderr.log`, `processes.jsonl`, and `source-manifest.json`). No platform
fix was required. This covers a deterministic pre-commit process crash on the
test-only debug build, not power loss, disk failure, or exact release-package
fault injection. Windows 2dd3c8ab ZIP and Linux 40ed8519 tar remain unchanged.

The independent 2026-10-01 review verified that provider capture still occurs
outside the short publication transaction, with source revalidation before
catalog/search/revision publication. Current binaries, complete regressions,
shared-state measurements and unresolved platform gates are indexed in the
candidate report (`../../../tmp/v3-delivery/FINAL-CANDIDATE-20261001.md`, local evidence).
Historical deterministic debug fault injection and release journal-phase
checks keep their original binary scope; implementation status does not turn
them into exact current-release fault-injection runs.
