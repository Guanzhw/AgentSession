---
status: implemented
date: 2026-09-27
decision: Publish bounded Runtime projections from the validated provider protocol bundle without inferring missing domains.
---

# AgentSession 3.0 Runtime projections

## Context

The 3.0 Web had source-ordered Events and recorded Work but the accepted
HTTP-05/CORE-10 contract also requires summary, graph, execution,
coordination, and context views. Transport-specific reconstruction would
separate those views from the validated v2/v3 source snapshot and could
misrepresent missing provider evidence.

## Decision

Derive the new projections from one finalized protocol bundle in the Rust
core. Summary reports actual counts, validation, and declared or unknown
domain coverage. Graph keeps Task and AgentRun as separate node kinds, retains
recorded relationship provenance, limits nodes to 1–200 and also bounds
relationship visits and edges during construction. A related session whose
source was not checked stays `unverified`. Execution, coordination, and
context pages carry the source revision and bounded entries; continuation
cursors bind source scope, canonical session, revision, domain, and kind
filter. Axum translates these projections without provider-specific rules.

## Alternatives considered

- Rebuild the graph and domain facts in the browser: this would duplicate
  provider interpretation and detach coverage from validation.
- Return the complete protocol document for every view: this would make a
  small page read scale with the whole serialized snapshot.
- Treat related IDs as resolved because an edge names them: the edge proves
  the reference, not that the other source is available.

## Consequences

All seven runtime routes now have a common source revision and explicit
partial coverage. Domain page output and graph construction have limits.
Domain projections still construct the selected bundle and sort its facts per
request; large-session latency and five-provider domain parity remain open.
The frontend now exposes Summary, Events, Work, Sessions graph, Execution,
Coordination, and Context through bounded projection requests. Five-provider
desktop visual acceptance remains open.

## Verification

[Public HTTP tests](../../../v3/test/protocol-projections-http.test.mjs) first
failed with 404 on the missing routes, then passed 5/5 on the integrated debug
binary SHA-256
`f47fd4786b75f74542614cb126bfdb9c84e35a691550e160ccc96277a4f6bd89`.
They cover task/run separation, node and query bounds, recorded parent
topology, frozen Codex execution/coordination/compaction, cursor filters and
source revision, and explicit invalid-source errors. The focused run passed
19/19 HTTP, MCP, and browser tests (the Library case used a fresh Svelte build
with a mock API; the others used the pinned binary); Rust workspace passed 104 core
plus 2 app tests with 12 private opt-in tests ignored. A copied current Codex
transcript (SHA-256 `9dfb722c90169d4c8668b0ed95e08bab840750798119484d247704081fb2d475`)
returned 200 on all seven protocol/runtime routes at one revision, with the
source and copy hashes unchanged.
The frontend browser test on a real Axum server first found two lenses where
seven were required (RED), then passed 1/1 on integrated debug binary SHA-256
`00c532d737e2953201be2ecc0a2a32460485cbac6944aa76e720f555e09393e0`.
Existing Events and Work browser tests passed 2/2, and the HTTP projection
tests passed 5/5. The public Codex source fixture SHA-256
`17e3638a76197a60969f83849707bda886377c6d69cd8f5a78a6620f44f7dc12`
was unchanged. The focused browser test covers coverage/provenance display,
source links, cursor errors, stale revision, and invalid protocol diagnostics.
