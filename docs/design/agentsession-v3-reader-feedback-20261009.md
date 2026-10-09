# Reader and usage review, October 9

The user's annotated screenshots reject the previous Reader's information
hierarchy. Passing navigation tests did not establish a readable product.
The previous representative functional checks remain historical evidence;
`UX-01` has negative user feedback and needs another human review after these
changes.

## User tasks and changes

| Observed problem | Intended behavior |
| --- | --- |
| Permanent left rail contains paths, IDs, revisions and missing-memory status. | Use a two-column conversation and contents layout. Keep the back link, provider, date and message count near the title; open other metadata through Session details. |
| Header lists every provider and local-device status on every page. | Keep navigation and appearance controls in the header. Source state belongs where sources are selected or configured. |
| System prompt evidence and source references use unexplained terminology. | AI instructions is inside Session details; preserve saved versus currently available instruction provenance there. Remove the raw message-ID/content-field/character-count disclosure from every reading card. |
| A 304-character reply needs expansion and ends mid-word. | Automatically read the first bounded body chunk. Short replies are complete; long replies use readable boundaries and Show more without character counters. |
| Previous/Next segment and execution loading do not explain what changes. | Conversation controls say Show earlier messages and Continue conversation. Technical execution continuation and retry remain available independently of collaboration in Session details. |
| Contents is mostly roles and process counts, with both scrolling and page replacement. | Group each recorded user request with its replies. Replies start folded and the left toggle expands them. Search and direct targets merge their bounded directory page, reveal the owning group and nested work. Preserve the opening prefix and earlier anchors. |
| A large permanent search field duplicates browser Find. | Find in session opens on demand. Ctrl+Shift+F searches owned content including unloaded fields; native Ctrl+F remains available. Escape closes the search and restores its trigger focus. |
| Expanding tool input still requires clicking Load. | Opening Input or Output reads its first bounded chunk, with continuation and explicit retry for longer or failed reads. |
| A long repeated tool-owner quotation is unclear. | Use a compact Related reply link to the same canonical owner. |
| Rows of tool-only model and Token metadata push the first reply below the viewport. | Keep each reply's metadata on its own message card, inside the existing work disclosure. Ordinary reply metadata remains beside the reply. |
| Collaboration, model choice and context are hard to find. | Name returned messages from recorded participants or actor paths. Connect exact dispatch and return anchors in the conversation's left gutter; shared anchors open named destination choices. Use an inline collaboration disclosure with canonical task/child/return links and available reply previews. Keep requested model/reasoning/context and source records in closed Technical details. |
| Separate Reasoning cards compete with the replies. | Keep standalone reasoning in closed execution disclosures, in the root and inline child conversation. Manual opening and exact search/direct navigation reveal the recorded target. |
| Seven runtime views compete with ordinary reading. | Keep source inspection available through Technical details. Bring recorded collaboration and starting context into the conversation. |
| Usage is restricted to a single Harness and has no useful visual overview. | One Harness filter supports multiple selections and starts with all. Daily activity, recorded-model distribution, Harness comparison and request-based insights follow that selection; unknown Token totals remain distinct from recorded zero. |

Usage insights compare the last two complete seven-day UTC windows inside the
selected range, show the most-used recorded model and Harness by request count,
and identify days above twice the selected-range daily request average. The
high-activity rule includes zero-request dates, requires at least seven selected
days, and exposes its threshold. It does not infer errors or personal intent.
Model shares include requests without model attribution. A selected source
that cannot be read remains explicit; its absent records are not treated as
verified zero activity. Charts and high-activity dates open the matching daily
session list.

## Visual direction

Use the existing light/dark theme tokens: paper `#f8f9f6`, canvas `#eef1ed`,
ink `#1d2b25`, muted `#59675e`, forest `#29473b` and blue `#4058c8`.
Retain system theme behavior and the existing dark equivalents. Use Aptos and
Segoe UI for readable body text and a compact sans-serif title. The primary
surface is a left-aligned conversation; the 280px contents column supplies
orientation. Metadata and large work histories open when requested. Borders
distinguish user messages, returned agent messages and optional tool details,
instead of framing every paragraph equally.

## Evidence and limits

Scratch evidence lives in `tmp/v3-reader-feedback-20261009/`. The supplied
annotated images and the newly captured `01-reader-before.jpg` establish the
reported problems. Before-file snapshots and incremental patches isolate this
work from the pre-existing 3.0 migration.

The source-driven browser suite first reproduced incomplete short replies,
three-column chrome, permanently visible search, and replacing directory
navigation. A separate RED reproduced the second click required to load tool
input. All five initial acceptance scenarios then passed using current UI and
an isolated real native backend with synthetic provider files. Their provider
file SHA-256 was unchanged. These checks cover geometry at 1088/1280, complete
304-character text, bounded long-message expansion, automatic tool fields,
search keyboard/destination behavior and retained directory anchors.

The collaboration source oracle checked all 26 spawn configurations against
the frozen Codex transcript, all 203 relation observations, warm and restarted
derived state, and unchanged provider bytes. Requested model/configuration is
not actual reply metadata. Encrypted task text remains unavailable. Recorded
starting context is separate from the requested context-sharing setting.

Independent source review found an execution continuation/retry path gated by
collaboration. The control was moved to Session details so normal background
commands retain it. Actionable unavailable-resume diagnostics remain in Session
details. A real frozen DSH check also reproduced twelve detached metadata rows
before the collapsed work group; removing that parallel rendering path restores
the first reply to the reading path. Metadata stays attached to each original
message. The same simplification applies to inline child conversations.

The resumed checks found two Stats interactions that needed correction: a
Harness change unnecessarily remounted the entire page, and automatic smooth
scrolling interrupted consecutive chart clicks. The page now keeps its menu and
date range while its own request lifecycle reloads the selected sources. Chart
selection leaves the reading position stable. An accessibility check found the
interactive SVG had atomic image semantics; it is a named group containing the
existing keyboard-accessible day buttons.

The backend reuses the existing provider statistics projections. Removed code
includes unconsumed busiest-day response fields, duplicate daily/model tables,
the separate process-metadata renderers and location helpers, unused ordinal
calculations and the old metadata/provider-navigation CSS.

## Resumed validation

- Full current Rust core: 197 passed, 14 explicitly ignored, zero failures.
  `npm run review` and `git diff --check` pass. UI and release builds pass with
  74 unchanged build inputs.
- Reader candidate `abc8d835…`: 13 affected checks passed (11 leaf cases),
  including a complete 304-character reply, first-click tool fields, full
  46,510-character repeated-hit context search, nested canonical navigation,
  Resume diagnostics and the original short-Pi `bottom <= 566px` requirement
  (actual 558.98px). Earlier unaffected Reader checks remain separately recorded.
- DSH integration: 7/7 passed. The frozen long-session process check passed
  both its parent and browser case, retaining the original first-reply
  `top < 900px` requirement, all 45 opening work-step anchors, translated roles
  and accumulating source-linked Contents. Five metadata/navigation cases
  passed, including root, opening and inline-child ownership. Navigation tests
  exercise inline opening, the canonical child source, Back and refresh with
  exactly one restored child. Test migrations follow the changed disclosure
  and navigation behavior; original failures remain in the scratch evidence.
- Stats source browser suite: 8/8 passed, including stable rapid day selection,
  a multiselect that remains open, retained dates and matching export filters.
  Native API, frozen-source and actual download suite: 23 passed, one explicit
  opt-in phase-probe skip, zero failures. Frozen OpenCode DB/WAL hashes stay
  unchanged.
- Final native candidate `02c6559f…`: pricing/browser case passed with 18
  checks. Eight Stats/Settings, English/Chinese and light/dark accessibility
  audits each report zero violations. Served HTML, JavaScript and CSS match
  their build hashes; browser page-error lists are empty. The only source
  change since `abc8d835…` is the interactive SVG's named-group semantics, so
  the unchanged Reader and Rust API evidence is reused explicitly.
- Independent final source review found no actionable issue in the selected
  Reader/Stats components, App routing, Rust composition and HTTP/export
  boundaries. It reused the recorded checks and made no source changes.
- A bounded check of one current, inactive Codex transcript passed 11 checks:
  raw reply text matches, 32 canonical requests total 2,956,882 known Tokens,
  33 unresolved observations remain separate, and selected-source JSON/CSV
  agree. Original and copied file hashes stay unchanged. This checks one
  current session, rather than the entire current provider corpus.

Statistics details closes during a report reload; the visible pricing checks
reopen it and record eight reopenings. That low-frequency disclosure state has
not been changed in this scope.

Final preview identity, served-asset hashes, screenshots, DSH checks and the
pricing/accessibility rerun are recorded under
`tmp/v3-reader-feedback-20261009/final-accessible/` and `resume/`. The preview
uses a frozen comparison corpus; its totals are not a live account-wide usage
report. No human approval or release acceptance is inferred from automated
checks.

## Follow-up screenshot feedback

The follow-up removes the message-detail panel instead of renaming it, folds
standalone reasoning into execution, names returned Agent messages and adds
canonical dispatch/return connectors. The collaboration summary is inline;
model/context/provenance are closed technical details. Contents now folds each
request's replies and reveals exact search/direct destinations, including
unloaded directory pages and nested work.

The final preview is `a8673857…` on port 25081. Final root reading and canonical
child navigation checks pass, together with the separately recorded real Codex,
frozen DSH, inline-child/metadata, keyboard search and component checks. Earlier
native evidence is reused only across the documented UI dependency fixes.
Full commands, failures, counts, source hashes, reuse boundaries and final
screenshots are in `tmp/v3-reader-followup-20261009/RESULTS.md`. The final build
has 76 stable inputs and three matching served assets. User UX feedback remains
the authority for `UX-01`.
