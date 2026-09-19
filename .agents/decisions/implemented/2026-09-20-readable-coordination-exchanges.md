---
status: implemented
date: 2026-09-20
decision: Read each coordination exchange through its exact recorded source on demand
---

## Context

The Reader channel lists dispatches, follow-ups and returns, but its source links
can resolve only to scalar protocol evidence. Codex parent-side FINAL_ANSWER
envelopes are not normalized Message rows, so the latest child reply cannot
represent a particular earlier return. P5 requires reading each exchange.

## Decision

Keep channel rows body-free until their disclosure opens. A read-only
`/api/:provider/session/:session/reader/coordination/:observation/content`
route resolves the observation from the current protocol before calling optional
`ProviderAdapter.getReaderCoordinationContent`. The adapter owns envelope and
tool-input interpretation; its `null` response is authoritative unavailable
content and triggers no other transcript/protocol read. Only adapters without
the hook use the shared exact-normalized-text path. A 6000-character continuation uses a content hash and returns
409 when its content changes, including loss of previously readable text.
Optional `getReaderCoordinationContentRevision` covers only the selected source
and required ownership evidence. The route compares that revision around the
body read; provider-wide index revisions do not invalidate individual content.
Codex checks fresh source-file signatures and reads a captured source extent;
modern NEW_TASK children need no parent content, while legacy/fork ownership
includes the required parent's signature. Child completion lookup also checks
the recorded turn when present. Source navigation remains a secondary action.

## Alternatives considered

Loading all child messages at first render would increase preparation cost.
Using the latest child answer would misattribute repeated returns. Parsing
provider payloads in browser code would split semantic ownership.

## Consequences

Codex supports the recorded request, communication, delivery and completion
forms covered by its adapter. Other adapters can use exact normalized text or
the optional hook. Missing readable text is stated locally. No provider files
are written. The Codex hook reads the selected source plus parent evidence when
required to establish ownership; a completion without readable text does not
cause a child-family protocol read.

## Verification

- `npm run review` passed governance checks and TypeScript typechecking.
- New route/render tests cover two follow-ups and two returns, complete long
  content continuation, changed/deleted content, source changes during a read,
  unavailable child content, exact normalized text and localized body-free rows.
  The first implementation passed the focused route/render/client/coordination
  and owned-reader suite (24 tests). Independent review then identified
  unnecessary child protocol loading after provider-declared unavailable text
  and a missing-observation continuation that retried the same invalid offset.
  The fixes add focused coverage for authoritative null, adapters without a
  hook, and deletion of the whole observation.
- Direct client tests passed (5 tests) for deferred/coalesced reads, retained
  disclosure content, versioned continuation, stale-content reload, failure
  retry and the terminal unavailable explanation.
- Browser-state translations were added to the actual client locale table.
  The final suite passed 948/948, Node 22.15.0 focused regressions 36/36, and
  the restarted desktop E2E passed with no browser errors. CI status is tracked
  by the delivery plan.
- A real stable child completion initially returned HTTP 409 in 8424 ms, then
  HTTP 200 in 28 ms. The rejection was caused by checking the entire Codex index
  revision around a single body read. The scoped revision change passed 17
  source-loaded tests without writing build output, including unrelated index
  activity, immediate selected-file changes, required-parent changes, source
  deletion and same-ordinal/different-turn replacement. Direct execution of the
  current route against the same real source returned 200 twice (1370 characters,
  identical content hash; 9292 ms cold and 28 ms warm). The running HTTP service
  was subsequently rebuilt and restarted. HTTP checks matched seven real
  observations to their exact local source: two completions and two delivered
  results (1370/1392 characters), plus three opaque collaboration arguments
  reported as unavailable. The real browser read the selected return, expanded
  the 184-part child history and restored the original task, open bodies and
  focus when closed. A final review also covered turn-less to named-turn source
  replacement and preserving non-BMP characters across rendered chunk boundaries.
