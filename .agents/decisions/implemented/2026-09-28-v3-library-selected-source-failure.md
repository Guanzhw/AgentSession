---
status: implemented
date: 2026-09-28
decision: A selected Library source failure clears invalid rows and reports the current provider diagnosis while preserving the user's filters and retry path.
---

# Library selected-source failure

## Context

The 3.0 Library can search all five providers or select one. A failure in a
selected provider must not look like an empty search result or leave rows from
an earlier successful page beside a new source error. The Web API already
distinguishes `provider_unavailable` and `source_error`, and `/api/providers`
reports the current storage diagnostic.

## Decision

The browser now retains those error
codes and shows a provider-specific diagnostic. On a source failure, it clears
the loaded family rows, totals, cursor, and child pages; it keeps the search
query and filters, marks the result unloaded, and offers Reload families.

The provider can become unavailable after initial page load, so an unavailable
response refreshes `/api/providers` before showing its storage diagnosis.
If that status request fails, the original selected-provider error remains
visible. A later generic transport error removes the old source diagnosis and
shows its own failure. Request identity is checked again after asynchronous
diagnostic loading, so an older failure cannot replace a newer Library result.
Provider-owned files and databases remain read-only.

## Alternatives considered

Keeping the earlier rows with the new source diagnosis would present stale
results as current. Caching the initial provider status would lose the reason
for a source that fails after page load. Both options were rejected by the
controlled browser transitions.

## Consequences

Selected-source errors now interrupt that Library result until an explicit
retry succeeds. Generic transport errors replace an earlier source diagnosis;
they do not claim the provider itself is invalid. Filters and query remain
available for retry, and no provider source is modified.

## Verification

The [controlled browser test](../../../v3/test/ui-library-filters.test.mjs)
first failed when selecting an unavailable provider showed no source-specific
diagnostic. Independent review then identified stale rows after a same-filter
Load more failure and a stale initial provider status after source loss. The
new scenarios were RED: 40 stale rows remained, and the current diagnostic
never appeared. A final retry scenario was RED because a generic failure
retained the prior source diagnosis. These cases are GREEN; the controlled
browser file passed 3/3.

The [isolated Axum/browser test](../../../v3/test/ui-library-source-failure-real.test.mjs)
and malformed-source API/hash test passed 2/2. The real browser used a copied
Codex transcript plus a malformed OpenCode database, and both copies retained
their SHA-256 hashes. After rebuilding the embedded UI and debug app, a serial
run of those three test files passed 5/5. Independent spot review found no
remaining P1/P2 in the selected-source failure and retry transition. Exact
release-package and five-provider visual acceptance remain separate gates.
