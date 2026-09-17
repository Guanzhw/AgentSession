---
status: implemented
date: 2026-09-17
decision: Read recorded memory artifacts alongside their source history without inventing a generating session
---

## Context

Codex retains stage1 memory notes and summaries keyed by the input thread.
The corresponding job is a mutable current row; its worker is not evidence
of a generating session. Actual content is absent from the Reader even though
the existing ContextArtifact protocol can describe its identity and origin.

## Decision

Keep metadata in ContextArtifact and read version-bound bodies on demand.
Expose the input snapshot time and a matching generation-job record separately
from producer session/run references. A small source-state field distinguishes
available, missing and invalid additional artifact storage without discarding
transcript or compact evidence. Reader shows saved outputs in a collapsible
section beside the input history, not at an invented conversation position.

Use a provider-owned protocol revision independently of token-stat revision.
Capture memory metadata with Reader input; ordinary protocol accessors use the
same source. Content requests read only the selected memory row, not the
transcript or family. A replaced artifact rejects old continuation offsets.

## Alternatives considered

Treating the input thread or worker as producer misstates the stored evidence.
Putting artifact bodies in protocol snapshots bloats unrelated consumers.
Sharing memory invalidation with token statistics repeats expensive transcript
scans for changes that do not alter request usage. Logging-only generation
history requires a separate observed parser and is not synthesized here.

## Consequences

Add optional artifact content and protocol-revision adapter methods. Existing
provider accessors and read-only source ownership remain unchanged. No memory
loading, reinjection or main-context change is inferred from artifact creation.

## Verification

`npm test` passes 880 tests; 29 focused tests also pass on Node 22.15.0.
Fixtures cover identity, job matching, missing/invalid sources, WAL updates,
stale versions, snapshot/usage isolation and body pagination. Four real saved
bodies match SQLite on every page; the original five API fields have unchanged
hashes for both inputs. Live keyboard, retry, stale continuation, source links,
1280px/390px and both locale/theme pairs were checked. Seven-provider checks,
`qa:e2e` and independent review passed. See the scoped accessibility finding
and remaining product work in
[artifact reading evidence](../../../docs/design/reader-memory-artifacts.md).
