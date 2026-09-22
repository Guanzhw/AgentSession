---
status: implemented
date: 2026-09-23
decision: Keep Reader history continuous while adding stable runtime overlays and pane-owned navigation.
---

## Context

The user's real-history screenshots showed disconnected child cards, repeated process and source doors,
scroll-dependent card geometry, sparse asynchronous records, and missing compaction navigation.
The fifteen-item scope and acceptance ledger are in `docs/specs/reader-feedback-2026-09/`.

## Decision

Attach expanded child history within its originating milestone. Merge adjacent process presentation while
retaining original message/tool anchors and owned usage. Continue paged fields on one content surface;
the Markdown owner supplies paragraph, list, table, fence or escaped-source continuation metadata.
The browser only applies that declared merge. Source pages remain finite; oversized structures that
cannot retain Markdown within the bound use a visibly labelled continuous source surface. The exact
limits and format choices live in the feedback design specification.

Keep member identity and retained lane slots stable. Stop the visual rail at its last recorded interaction;
this supersedes the unknown-tail presentation in the 2026-09-22 member-rails decision, without changing
recorded Agent status. Asynchronous execution uses exact native input/result excerpts and a local
separation-to-return bracket, distinct from member identity rails.

Reuse the existing collaboration overview as a desktop dock/overlay. Each Reader pane owns its panel,
child navigation and compaction nodes. Compaction ToC entries use the transcript's checkpoint placement
and retained-context anchor; they do not become messages or affect usage.

## Alternatives considered

Independent cards for loaded pages and child history obscure containment. Recomputing lane positions
from visible members moves the document while reading. A permanent lane per asynchronous execution
uses width without adding the member-interaction meaning of a rail.

## Consequences

HTML, browser hooks, styles and tests change together. Provider data and Session Protocol remain read-only
and retain their meaning. The collaboration panel preserves explicit open/close preference; scroll does
not change panel mode or card layout. Full source text remains accessible behind concise presentation.

## Verification

The final suite passed 1,070 tests and the desktop E2E completed 230 steps without browser errors.
Real Codex and DSH histories verified child containment, stable rails, process merging, asynchronous
links, panel ownership and compaction navigation. Seven browser continuation cases matched complete
rendering/source content. Independent source review found no remaining issues. Package and Windows
binary smoke checks passed; publication status is tracked in `docs/specs/reader-feedback-2026-09/tasks.md`.
