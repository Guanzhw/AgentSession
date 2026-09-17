---
status: implemented
date: 2026-09-17
decision: keep the Reader page owner stable while locating recorded related history inline
---

## Context

Opening a related session from Contents can replace the main pane and URL while
leaving the document title, export links and management/resume controls owned by
the previous session. Inline source jumps also change the pathname to a child
although the parent page remains mounted. Reloading then produces another page.

A real native-navigation trial does not preserve the parent reading context:
Back loses the search, opened process/tool disclosures and scroll position.
Correcting only the header or relying on browser page caching is insufficient.

## Decision

Keep the canonical root pathname, page title and global actions together.
Open recorded related-session controls inline, including Contents entries.
Use the recorded local milestone when available; otherwise place the related
history after the transcript with an explicit unknown-position label.

Represent the selected inline content in a root-owned URL using `readerSource`
and the necessary `readerAncestor` path. Values are same-origin canonical
session/source URLs. Restore each level through an existing normalized reader
control, never by inferring a relationship from task names. Native standalone
links keep their canonical destination and perform a complete page navigation.

Preserve the mounted parent's search, disclosures and loaded continuations.
Back, Forward and close retain pane-scoped anchors and return focus. Source
links keep canonical hrefs so opening a link independently reads its actual
owner. An unrelated source with no recorded mount path opens that standalone
owner rather than partially replacing the current shell.

## Alternatives considered

Full native navigation fixes action ownership but loses continuous reading in
the tested browser. Swapping an entire SSR page shell adds reinitialization
and state ownership across unrelated global controls without improving the
recorded-parent/child reading workflow. Keeping child pathnames with a root
header repeats the measured ownership ambiguity.

## Consequences

The pathname identifies global actions; a locator identifies the focused inline
history. Copied links can reconstruct a recorded nested reading path without
copying transient search state into URLs. Missing positions stay explicit.
Existing tests that expect a child pathname while retaining the root pane must
change, while state-preservation and exact-source assertions remain required.

## Verification

Focused navigation/location tests pass, including delayed responses, duplicate
loads, nested native/scalar locations, canonical hrefs and retained continuation.
Independent review found no blocking issue; the main agent inspected the diff.
Real Codex checks preserve a 196-match parent search, opened tool and exact
return position; three-level source URLs reconstruct in a new tab and on reload.
Close restores each parent's opener, and scalar-event Back returns to the exact
parent delivery. Page title/export/management/resume ownership was inspected
both inline and standalone, without executing those actions.

Full tests, live site E2E, seven installed-provider samples and Windows binary
checks pass. A browser-only missing translation was found in real use and
corrected in both client catalogs with a regression test. At 390px there is no
page overflow, but nested prose narrows to 270px: full-width nested reading
remains a separate P6 visual gap in the [acceptance record](../../../docs/design/runtime-acceptance-evidence.md).
