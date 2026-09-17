---
status: implemented
date: 2026-09-17
decision: Load folded tool and reasoning bodies through existing content continuation
---

## Context

One real large Reader response contains 35.6 MB HTML, including 19.6 MB of
input/output bodies in 7,902 initially closed tool disclosures. Its visible message bodies
account for 0.65 MB. Existing continuation already reads full canonical fields
through `/content`, including offset zero. The page has 232,296 elements;
deferring field bodies alone does not remove most of that structural DOM.

## Decision

Keep the full reading spine, message/part anchors, tool status, reasoning
ownership and runtime insertions. For folded tool and reasoning fields with a
canonical part ID, render a local unloaded control instead of the first body
chunk. Opening that specific disclosure requests offset zero through the
existing progressive loader. Manual reading and search use that same loader
and request ownership. Empty fields need no request. Source-less standalone
rendering keeps its existing inline content because it has no continuation
identity.

## Alternatives considered

Deferring only long fields saves about 10.3 MB in this case but still computes
all short hidden bodies. Hiding pre-rendered HTML with CSS does not reduce
payload or parsing. Paging whole process groups would also change source-anchor
resolution and requires a separate measured design for the remaining DOM cost.

## Consequences

Opening details now has an explicit loading state and a local retry on failure.
The existing tool-field and reasoning-body elements also carry progressive
identity; an error status is created only on failure and removed on retry.
An initial implementation added redundant wrappers and empty status elements,
increasing a real page's DOM by 10%; measurement prompted their removal before
acceptance.
Loaded chunks remain in their owning pane, and late responses cannot populate
another session. Default prose, canonical identities and complete search scope
are unchanged. The byte reduction is not proof of responsive large-history
navigation; server preparation and structural DOM still need measurement.

## Verification

SSR/client and real registered HTTP route tests cover short/long/empty fields,
retained anchors, both locales, failed/retried requests, search/manual
deduplication, replacement-token text and detached child panes. The complete
suite and live E2E pass; independent markup/loader review found no blocking
issue. A real 27,929-character tool output can be searched from its unloaded
state to a match beyond the first page; the UI loads through offset 6,000 and
highlights the match. Browser network blocking verifies local error/retry and
removal of the error node. Desktop source-link navigation/reload and expanded
390px content also pass.

The final active-root HTML is 23,745,775 bytes / 225,445 elements, compared with
35,579,034 bytes / 232,296 elements before this change. All 1,557 original prose
bodies retain their hashes; all 2,034 turn and 10,115 part anchors retain order,
with no missing entries. The later snapshot adds 8 prose bodies, 20 turns and
109 parts as the active session grows; these are not fixed-input timing samples.
Final page preparation remains 13.6 seconds, so large-history responsiveness is
still open. Private HTML and analysis stay under ignored `tmp/`.
