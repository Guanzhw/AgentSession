---
status: implemented
date: 2026-09-27
decision: The 3.0 Library exposes canonical family roots and direct children through revision-bound structured pages
---

# Library family paging

## Context

The first 3.0 Library fetched every visible session and reconstructed parent
groups in the browser. The frozen OpenCode source alone has 151 sessions, many
of them children; a DeepSeek Harness child has a parent outside the selected
corpus. A flattened list gives that child the appearance of an ordinary root.

## Decision

[The Rust Library projection](../../../v3/crates/core/src/library.rs) owns the
provider-plus-canonical-ID family graph. `/api/v3/library/sessions` pages roots,
including explicit missing, hidden, or cyclic parent boundaries;
`/api/v3/library/children` pages direct children of one canonical parent.
Both endpoints return a bounded page and a cursor bound to source scope,
filters, sort order, and the current visible inventory revision. Project paths
use the existing cross-host normalization. A matching descendant retains its
root as context even when the root itself does not match. The Viewer metadata
overlay consumes the catalog rows from that same refresh, avoiding a second
provider inventory refresh in one Library request. The global page preserves
healthy providers when another source is unavailable or cannot refresh, and
reports that source in `sourceDiagnostics`; a provider-specific request fails
explicitly.

Legacy direct-offset family and child requests accept offsets beyond the end
of their rows and return an empty page with the unchanged total. Offset and
cursor remain mutually exclusive. The 100000 offset validation remains at the
content-search HTTP boundary.

## Alternatives considered

Returning one flat session page would force the browser to infer lineage and
could split a family across pages. Treating an unavailable parent as a true root
would lose the original parent reference. A positional cursor without scope and
revision would silently resume into another source selection or changed list.

## Consequences

The API preserves the child reference and labels missing evidence. It currently
constructs the complete visible family graph for each request, so bounded
responses alone do not establish large-library latency or memory targets.
The Web client now consumes these family pages and forwards provider, project,
and title filters through both root and child pagination. The later
[JSON-only list decision](2026-09-28-v3-json-only-list-responses.md) resolves the
2.0 HTML-fragment difference for 3.0; `timeRange`, `starredOnly`, and
`hasSubagent` remain HTTP-02 parity gaps.

## Verification

- [The public HTTP test](../../../v3/test/library-family-http.test.mjs) failed
  with a 404 before implementation, then passed with 43-child traversal,
  project path aliases, descendant context, parent boundaries, and invalid or
  stale cursor checks. A later canonical-ID search case failed before its
  matching fix and passed after it.
- A read-only frozen five-provider traversal reached each of 157 visible
  sessions once: OpenCode 151/78 roots, Claude 1/1, Codex 2/2, Pi 1/1, and
  DeepSeek Harness 2/2 with one missing-parent boundary. Eight source hashes
  were unchanged. The probe is retained under ignored `tmp/`.
- [A separate boundary test](../../../v3/test/library-partial-source.test.mjs)
  first found that a malformed OpenCode source was silently omitted from the
  otherwise healthy global page. It passed after adding per-source diagnostics;
  the direct OpenCode request returns 503 and both source hashes remain intact.
- Rust workspace tests passed 102 core and 2 app tests, with 12 private-input
  cases ignored; `npm run review` passed. HTTP-02 remains open.
- `node --test v3/test/legacy-list-routes.test.mjs` first returned HTTP 400 for
  both family and valid child requests at offset 100001, then passed with HTTP
  200, empty rows, unchanged totals, and child `shown: 0`. The same test keeps
  ordinary flat-list offsets above 100000 valid and content-search offsets
  above 100000 invalid. The focused core cursor test also confirms offset and
  cursor cannot be combined for either endpoint.
- The later [Library filter browser test](../../../v3/test/ui-library-filters.test.mjs)
  passed against a fresh Svelte build and an isolated HTTP fixture.
  It traversed two providers and projects, filtered child pages, unavailable
  source diagnostics, and Reader Back/Forward/reload while retaining query,
  expansion, and scroll. The final Svelte source change still needs embedding
  in a new Rust binary; the full five-provider visual filter path needs final
  release verification.
