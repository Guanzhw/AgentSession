---
status: implemented
date: 2026-09-26
decision: Load long Reader conversations in revision-bound complete-turn segments
---

## Context

A real 2,686-message Codex session produced 23,498,218 HTML bytes and 179,823
DOM elements. A warm browser navigation reached DOM interactive at 7,160 ms.
The existing deferred tool-process bodies still left a large initial document.
The [2.0 delivery plan](../../../docs/design/agentsession-v2-provider-scope.md)
requires complete history and exact source navigation while reducing first-load
work. The request-local snapshot decision keeps each individual projection
coherent; it does not define a contract across later HTTP requests.

## Decision

For conversations above 160 rendered entries, group complete user turns into
segments targeting 48 messages each. Render the first segment and the complete
table of contents in the initial page. Keep the global message, checkpoint,
and runtime placement projection as the single source of ordering. Leave later
turns as explicit, accessible load controls, and load the next segment when it
approaches the viewport.

`/api/:provider/session/:id/reader/segment` returns server-rendered markup for
one segment. Its URL carries a SHA-256-derived markup revision; a changed
segment fails with HTTP 409 and instructs the reader to reload the page. A
separate `segment-location` read locates deep part/task anchors that are not
listed on a placeholder. The browser loads the owning segment before process
chunks or source navigation, scopes late fragments to their reader pane, and
retains canonical anchors and the full ToC. Both endpoints read provider data
through the existing adapter and reader snapshot boundary.

## Alternatives considered

- Keep all turn markup in the initial HTML: retains the measured transfer and
  browser DOM cost.
- Slice arbitrary HTML or message counts: could split a user turn and change
  reasoning, tool, checkpoint, or child-work placement.
- Add a provider-specific Reader format or browser-side interpretation: would
  duplicate the normalized server presentation contract.

## Consequences

Readers can begin with the first turn batch and reach any later recorded
message through a ToC, search result, URL fragment, or visible load control.
Transient failures leave a retryable placeholder; a revision mismatch is an
explicit reload requirement. Loaded segments remain within the active reader
pane and keep keyboard focus and return navigation coherent.

This reduces initial transfer and DOM construction, but each later request
currently rebuilds the full server projection. One unusually large user turn
also remains a large segment. Those costs should be measured separately before
considering a parser or index worker in another language.

## Verification

- `npm run ci:quality`: 1,057/1,057 tests, governance, typecheck and build pass.
  The long Reader regression checks a late message, checkpoint uniqueness,
  location, revision validation and fragment content.
- `npm run qa:e2e` passes against the isolated real OpenCode v2 server with no
  browser errors, including a previously unloaded assistant fragment, native
  Back/Forward restoration, process loading and inline child return.
- A real 2,686-message Codex page has 43 segments. Initial DOM falls to
  23,089 elements; the late assistant URL fragment loads its segment, focuses
  the canonical target and leaves it visible. Keyboard activation of a load
  control transfers focus into the new turn. The live route returns 409 for a
  stale revision, 400 for an invalid index and 404 for a missing deep anchor.
  Real OpenCode and DeepSeek Harness long pages also show one loaded initial
  segment.
- Final packed Viewer and MCP 2.0.0 installs pass real five-provider API and
  protocol calls. Windows SEA binaries build and pass Viewer/static/MCP smoke.
  The independent review found and fixed a load-button focus issue.
