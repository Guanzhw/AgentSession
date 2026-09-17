---
status: implemented
date: 2026-09-17
decision: Prepare Reader prose and runtime projections from one provider-owned request snapshot
---

## Context

A 496 MB active Codex transcript was reread by session, messages, revision,
protocol and owned-reader accessors during a single 18.8-second HTML request.
Each accessor may refresh the file index; the 64 MB payload cache cannot keep
the root while loading its children. Retrying independent accessors can also
observe different revisions during concurrent appends.

## Decision

Add an optional provider-owned Reader snapshot capturing session, normalized
messages, inherited context and lazy protocol/owned-reader projections from
one file-store revision. HTML and reader-pane routes consume this explicit
snapshot. Keep protocol preparation inside the existing diagnostic boundary,
so unavailable runtime evidence does not suppress readable prose. The shared
runtime cache retains finalized protocol data, not captured transcript closures.

## Alternatives considered

Increasing the global payload cache retains large private histories and does
not establish request consistency. Implicit provider pinning makes unrelated
accessors depend on ambient request state. Browser-only changes do not address
the measured repeated parsing.

## Consequences

The optional adapter capability preserves legacy provider behavior. A store
capture keeps only the requested payload and family metadata for this request;
other routes and exports retain their current contracts. Appends appear on a
subsequent refreshed request rather than changing a snapshot already in use.

## Verification

Fixed real root/child input reduced the median HTML route time from 9.76 to
7.47 seconds and root reads from twice to once. Complete HTML matched after
normalizing relative-time labels; five stable real snapshot hashes matched.
Six focused tests cover append isolation, canonical identity, missing sessions,
legacy parity and protocol-only failures; they pass on Node 22.15.0 and 26.5.1.
All 861 tests, independent review, seven-provider live Reader/API checks and
browser E2E passed. The giant real page opens and preserves tools when returning
from child history, but still takes about 24 seconds to reach DOMContentLoaded.
Full performance acceptance remains open in
[the acceptance record](../../../docs/design/runtime-acceptance-evidence.md).
