---
status: implemented
date: 2026-09-27
decision: Keep AgentSession 3.0 Viewer metadata in an effective source-scope namespace and import 2.0 metadata only through an explicit, non-overwriting operation.
---

# AgentSession 3.0 Viewer metadata source scope

## Context

Two configured source roots can contain the same provider and canonical session
ID but different conversations. A shared `meta.db` keyed only by provider and
session ID made a title or deletion in one 3.0 process affect the other. The
public two-root fixture and core regression in
[`v3/test/source-boundaries.test.mjs`](../../../v3/test/source-boundaries.test.mjs)
and [`v3/crates/core/src/meta.rs`](../../../v3/crates/core/src/meta.rs) capture
this boundary. Existing 2.0 Viewer metadata and its old index must survive the
new installation unchanged.

## Decision

Normalize the configured source paths without depending on whether a source
currently exists. Keep canonical provider/session identity in the public API,
while storing 3.0 Viewer metadata under `meta/scopes/<source-scope>/meta.db`.
Processes with the same normalized absolute configured paths share that
namespace; aliases with different path spellings stay separate even if they
resolve to the same physical source. Different configurations retain
independent titles, stars, and exclusions.
Preserve the unscoped 2.0 `meta.db`. Import a selected 2.0 SQLite database into
one selected 3.0 source scope only when explicitly requested, and refuse to
overwrite an existing 3.0 target.

## Alternatives considered

- Continue using the unscoped database: same canonical IDs from different
  roots would share Viewer changes.
- Import an unscoped database automatically at startup: a process could apply
  its rows to the wrong source scope, and an upgrade would migrate user state
  without an explicit choice.
- Include the source scope in public session IDs: this would break canonical
  provider references, URLs, MCP results, and resume identity.

## Consequences

Changing a configured source path intentionally selects another Viewer state
namespace. An explicit import command and side-by-side launch instructions
must identify the intended source configuration. Legacy rows, including
retired providers, stay in the imported database even though 3.0 exposes only
the five supported providers. Source files and the original 2.0 database stay
read-only during import.

## Verification

The core shared-state test first failed on a cross-scope title and passed after
metadata isolation. `v3/test/source-boundaries.test.mjs` passed three HTTP
cases, including two live processes with the same canonical ID and a restart
after a missing source directory appeared. `v3/test/meta-migration.test.mjs`
passed the explicit import, refusal to overwrite an existing target,
incompatible source, and live WAL snapshot cases. A controlled private 2.0
database copy retained all 12 metadata rows, 1,064 v1 index rows, two retired
provider rows, and identical source/target schema and row digests; the source
hash did not change. `v3/test/meta-slice.test.mjs` passed Viewer mutations and
MCP source visibility. A public two-process test at the fixed
2.0 SHA started both versions against the same Codex source, imported the
old Viewer database, changed only the 3.0 title, and restarted 2.0 with its
preserved title and star. This verifies the rollback process on the tested
Windows host; release packaging and cross-platform replay remain open.
