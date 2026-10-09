---
status: implemented
date: 2026-09-29
decision: Keep a same-canonical-ID Codex session in the catalog with an explicit unmerged-source diagnostic, and withhold its history and usage until a source-backed merge is proved.
---

# Codex multiple-source diagnostic

## Context

The [raw witness pack](../../../docs/design/agentsession-v3-codex-usage-witness-packs.md)
proves that two Codex files with one canonical session ID contain 147 and 59
disjoint, explicitly owned canonical requests. The previous sorted-path map
selected the later file and presented its 59 requests as a complete session.
The [seam evidence](../../../docs/design/agentsession-v3-codex-usage-seam.md)
also shows a declared strict prefix that excludes an aborted suffix.
Those records do not justify whole-file concatenation or legacy request inference.

## Decision

Current scope: the [direct history-base source-set decision](2026-09-29-v3-codex-direct-history-base-source-set.md)
now permits the proved two-file direct root prefix. The collision policy below
continues for unsupported source groups. The [partial Stats decision](2026-09-29-v3-stats-partial-source-coverage.md)
replaces provider-wide refusal with explicitly incomplete healthy-session
totals; unattributable unreadable headers still block Codex history globally.
The provider-owned implementation is in
[`codex.rs`](../../../v3/crates/core/src/providers/codex.rs) and
[`codex_source_set.rs`](../../../v3/crates/core/src/providers/codex_source_set.rs).

The Codex adapter groups readable source headers by canonical ID. A group with
multiple files publishes one catalog row with
`codex_multiple_source_files_unmerged`. Its revision hashes every member path
and its full bytes, so adding or removing a member, or changing member content
at the same size and restored mtime, invalidates the catalog and its search
documents. The catalog rechecks the complete inventory after capture and
before publication, closing an in-flight singleton-to-collision transition.
The stored summary schema advances to recapture older rows and search documents.
Inventory and direct lookup reread canonical header bytes even when size and
mtime are unchanged. A header that cannot establish an ID is not assigned an
ID from its filename. Known catalog rows remain browsable with
`codex_source_inventory_incomplete`, and their prior content-search documents
are removed. Direct Codex history and Stats remain unavailable because the
unresolved file could belong to any known ID. If no known row remains, the
provider descriptor and search response still report the incomplete-source
diagnostic. An unreadable member contributes a path/stat fingerprint to the
unresolved inventory revision, and a later readable header triggers recapture.
MCP browse reports `partial` with a bounded source diagnostic even when the
unknown file leaves zero canonical rows. Collision groups likewise mark the
provider browse diagnostic partial while retaining their canonical rows.

The diagnostic row has the canonical ID as its title and no fragment token
total or indexed conversation content. It carries a directory only when all
member headers record the same directory. It carries a parent reference only
when every member has a readable primary header for that canonical ID and the
headers explicitly agree on one nonempty parent across `parent_thread_id`,
`forked_from_id`, and Codex's recorded subagent spawn parent field. Missing,
unreadable, mismatched, or conflicting parent evidence leaves the reference
null. This catalog fact does not merge fragment history or make Reader,
Protocol, retrieval, or usage available. The mandatory `messageCount` field
is zero as a transport placeholder; the Library displays an unavailable mark
and the diagnostic text rather than presenting zero as a complete count.
Source paths remain private; the adapter re-enumerates them and the collision
revision preserves their identity in derived state.

Reader, Protocol, per-session MCP retrieval, and list-stat cache entry points
reject the colliding ID with a protocol-unavailable diagnostic before reusing
prior projections. Other Codex sessions continue through unique-source lookup;
colliding IDs are excluded from child-resolution maps so healthy parents do
not acquire fragment child facts. Provider-wide Stats refuses totals when the
collision is in scope. A directory filter may serve healthy sessions only
when the colliding row's common recorded directory proves it is outside the
filter. Stats source revisions hash every source file, including collision
members, and digest failures remain explicit.
Web and MCP search identify excluded Codex history with a `partial` provider
diagnostic and bounded affected count rather than reporting a complete empty
result.

This is a correctness stopgap. A future provider-owned source-set model must
prove history ordering, copied-prefix handling, response identity, legacy
mirrors, and per-file source positions before publishing merged Reader and
usage projections. A partial Stats report with per-session diagnostics can
replace the provider-wide unavailable response once its coverage contract is
defined. This decision makes no completeness claim for anonymous legacy
request usage or the broader Codex corpus.

## Alternatives considered

Keeping the later sorted path would continue to omit 147 proved canonical
requests while reporting a complete-looking session. Concatenating files or
ordinals would conflict with the observed copied prefix and ordinal reuse.
Both require evidence the source currently does not provide.

## Consequences

Colliding sessions remain findable by canonical ID in Library and MCP browse,
while their content endpoints and in-scope Stats return explicit unavailable
diagnostics. Healthy sessions and provably disjoint directory-filtered Stats
remain readable when every source header is resolved. An unattributable source
keeps known rows visible but blocks Codex content and usage globally until its
identity is resolved; the filename is only a hint. The source-set merge and
partial-report UX remain follow-up work.

## Verification

The synthetic two-file plus healthy fixture was RED before the change and is
GREEN with warm Reader/Stats caches, source addition/removal, same-size
restored-mtime body and header-ID rewrites, search suppression and partial
diagnostics, a healthy directory filter, and explicit per-session HTTP errors.
It also covers malformed-header uncertainty with one and zero known rows.
Stdio MCP browse retains the row while `session_get` refuses fragment history
and browse/search report partial coverage. A two-file duplicate fixture with
matching explicit fork parents verifies that browse exposes the common
canonical parent while withholding token totals and session content; a
disagreement fixture keeps the parent null. Summary schema 13 recaptures
schema-12 catalog rows. A zero-known-row MCP browse test
checks both provider and session levels. Unit tests cover a second source appearing
between inventory and publication, exact-stat canonical ID reassignment, and
an unresolved path whose bytes cannot be read. The Rust core suite passed
183 tests (14 intentionally ignored); focused Web/MCP tests passed 8 tests
(2 real-source tests skipped by their opt-in gates).
A controlled browser assertion shows the Library warning and an em dash in
place of the transport's placeholder zero; the four Library browser tests pass.

An isolated debug process read byte-identical copies of the two frozen witness
files (SHA-256 `22df7d75...` and `514b8a44...`). It returned one diagnostic
session, HTTP 503 for Reader, Protocol, and Stats, and no fragment user-search
hit. Both original and copied hashes were unchanged; the process was stopped.
The existing 3466/3467 services and provider source files were untouched.
