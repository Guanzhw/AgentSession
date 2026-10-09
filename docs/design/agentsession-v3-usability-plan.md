# AgentSession 3.0 Reader usability plan

Updated 2026-10-09. This finite plan tracks human-facing usability checks for the current 3.0 candidate. It complements the [presentation contract](runtime-presentation-contract.md) and [row-level acceptance contract](agentsession-v3-acceptance-contract.md); it does not replace their provider, protocol, release, or performance gates.

## Baseline and scope

Treat the recorded Windows candidate `caffb72b` and its historical port `25066` as the **before baseline**, not the current-workspace acceptance build. Its fixed 2.0 comparison used port `38994`; these identities do not claim either listener is still running. The [2026-10-09 workspace consolidation](../../.agents/decisions/implemented/2026-10-09-sole-v3-workspace.md) makes 3.0 the sole runtime and default entrypoint. Preserve the baseline DOM and its capture failure. After an implementation, bind acceptance to the freshly built and served candidate's source revision, binary identity, and embedded UI asset identity, as well as the source case, browser, viewport, language, and theme. Keep provider sources read-only.

The 2026-10-02 candidate report records that the before baseline's parallel API and source checks passed but its screenshot check failed; the acceptance contract keeps `UX-01` (user preference for the redesign) at `U`. Preserve that before-DOM and capture failure under the `caffb72b` identity. Historical screenshots and checks on other candidate identities remain useful context, not proof for a later candidate or evidence of the user's approval. The baseline capture gap remains recorded even if a later candidate can be captured; post-change evidence must be a fresh desktop capture and interaction record bound to the new served candidate.

This plan covers seven user outcomes: recognizing the work, reading the default story, opening complete detail, keeping orientation and control, receiving clear feedback while content loads, understanding source-backed facts, and reading comfortably with desktop controls. It does not add a new styling direction or reopen unrelated source-coverage, performance, platform, persistence, packaging, or release work. Model and usage information remain compact and directly visible in the reply context, as required by the presentation contract; calm attention is not a reason to hide them.

## Finite acceptance outcomes

Use a real current-candidate session where available. If a required state is absent from current data, use a controlled case and label it as such; never imply the controlled case is a provider observation. Capture both the operation and the resulting page so the evidence shows what the reader could actually understand and do.

| ID / priority | User outcome and scenario | Pass condition |
| --- | --- | --- |
| LIB-01 / P0 | From Library, identify one target by readable title, project, or search; include a same-title pair when present. Open it, then return to Library. | The chosen canonical session is clear; the Reader opens that session; Back preserves the committed query/filter and useful list position. |
| STORY-01 / P0 | Read a simple question-and-answer case and a case with a dispatch or asynchronous handoff, main-thread continuation, and returned result. | The opening view makes the request and readable response clear, then tells the work story at its recorded turning points. The simple case has no empty process/collaboration region. Relevant assignments and returned results are understandable in place. Model and usage stay compact and visible with their reply. |
| DETAIL-01 / P0 | Expand one process/tool detail and one child or related history; read to a later page, search for later content, and close or return. | The user can reach the full recorded content from its context; search finds content inside collapsed/late-loaded work and opens the correct owner; returning restores the parent reading position. |
| ORIENT-01 / P0 | Move between Library, Reader, a search result, a child pane, and a related/source link; use browser Back/Forward and keyboard focus. | The current session, pane, and search scope remain understandable. URL, title, owner, committed search, scroll position, and focus return to the corresponding view after navigation. |
| FEEDBACK-01 / P1 | Start a Library search and open a Reader detail that requires a request or continuation; observe pending, success, empty, and failed/unavailable outcomes where the source permits. | A pending operation has visible feedback; success, no match, partial/unavailable data, and error are distinguishable; completion or failure does not leave a stale pending indicator or blank unexplained area. This checks communication while waiting, not a latency target. |
| FACTS-01 / P0 | Open one genuinely missing/unavailable or partial source state and inspect an asynchronous/child relationship with known evidence. | The page states the local record's actual availability and scope at the affected content. It does not invent a live process, assignment, completion, parent receipt, timestamp, context change, or reasoning. Recorded model/usage values retain their source meaning. |
| DESKTOP-01 / P1 | Repeat the representative Reader path in English and Chinese, light and dark, using keyboard navigation; inspect reduced-motion and text/contrast at the affected controls. | Text, code, navigation, and focus remain usable in all four language/theme combinations; focus is visible and operable; reduced-motion preserves the action without requiring animation. Record the actual desktop viewport. |

P0 outcomes establish the central reading path and truthful control. P1 outcomes establish the supporting desktop states. Each row is closed independently; a pass in one row does not imply a pass in another.

## Evidence and exit gates

The following current v3 tests are evidence pointers, not inherited pass claims: `v3/test/ui-library-filters.test.mjs`, `ui-library-focus.test.mjs`, `ui-library-web01-frozen.test.mjs`; `ui-first-readable-reply-real.test.mjs`, `ui-complex-reader-real.test.mjs`, `ui-codex-collab-real.test.mjs`, `ui-codex-execution-reader-real.test.mjs`; `ui-inline-child-process.test.mjs`, `ui-three-level-real.test.mjs`, `ui-content-search.test.mjs`, `ui-pane-search.test.mjs`, `ui-reader-search-repeat-hit-real.test.mjs`, `ui-runtime-related-navigation.test.mjs`; `ui-library-source-failure-real.test.mjs`, `ui-inherited-context-real.test.mjs`, `ui-pi-context-result.test.mjs`; `ui-locale.test.mjs`, and `ui-theme.test.mjs`. Run or inspect the relevant v3 checks against the identified candidate before using them to support a current result. Legacy Node test paths in the acceptance contract are historical pointers, not substitutes for v3 UI checks.

For each row, retain: candidate identity; scenario and whether source-backed or controlled; browser and actual viewport; language/theme; interaction sequence; screenshots or an explicit capture failure; visible browser errors; outcome; and a short account of any confusing or blocked step. Do not put private session body text in committed evidence.

An outcome passes only when its scenario has been exercised on the freshly built and served post-change desktop candidate and its pass condition is supported by a saved interaction record bound to that candidate's source, binary, and embedded UI identity. Existing test results can support implementation behavior, but cannot replace the real-surface observation. Preserve the `caffb72b` before-DOM and screenshot failure as baseline evidence; do not reuse either as post-change evidence. A failure becomes a narrowly stated issue only after the observed step and expected behavior are recorded; make no implementation or visual redesign without that evidence. A capture failure remains a verification gap, not a pass.

The UX task is ready for human review when all P0 and P1 rows have evidence and none has an unresolved blocking failure. User feedback on the visual direction is a separate record, not a prerequisite to preparing the review. No user approval of 3.0 visuals has been obtained; do not label the redesign approved or convert `UX-01` to a pass without that feedback. These gates do not close `DEL-01`, `DEL-03`, `STATE-01`, `SRC-01/02`, `PLATFORM-01`, or any release requirement.

## Current task ledger

The final October 8 candidate is `f378fc7e` on port 25077; its completed
representative checks are recorded in the final section below. The following
native10 ledger preserves the earlier observations and gaps.

The before baseline is `caffb72b`. October 4 native observations belong to
`d138e749` on port 25075, embedded JavaScript `55fb7157` and CSS `a9ac2507`.
The October 4 CUA checks used the Codex in-app browser at 1280 by 720. Full binary, invocation,
70 build-input hashes, zero source mismatches, served-asset identities and
private interactions are under `tmp/v3-usability-20261004/native-after10/`.
All 41 backend input hashes remain unchanged from native9. Earlier observations
and failures retain their own candidate identities.

The previous native9 return path restored the child and visible focus but lost
both pane queries and results. That RED is retained in its private interaction
record. The [search-return decision](../../.agents/decisions/implemented/2026-10-04-v3-reader-search-return.md)
records the bounded fix. On native10, child-source Enter → Back → Forward → Back
retains both searches, their selected highlights and the parent insertion focus.
The earlier focus REDs remain under `native-after6/` and `native-after7/`.

The final seven existing QA suites ran with the native10 executable and passed
52 tests, zero failures and zero skips. The suites include controlled fresh
Vite UI harnesses and isolated native Axum processes; they are not all checks
on port 25075. Their raw output is
`agent-browser-after10/final.stdout.log`. Four existing screenshot hooks ran,
and each image was visually inspected:

| Capture | Actual scope | Desktop size |
| --- | --- | --- |
| `first-reply-current.png` | Frozen real Codex opening reply, isolated native10 Axum process; reply precedes folded process | 1440 by 900 |
| `controlled-library-current.png` | Controlled HTTP Library, fresh Vite UI, successful two-page content search | 1440 by 900 |
| `controlled-pane-current.png` | Controlled parent/child late content search, fresh Vite UI; cropped view excludes the child heading | 1258 by 566 |
| `public-dsh-current.png` | Public synthetic DSH fixture, isolated native10 Axum process; dispatch, main continuation, returned facts and compact fixture metadata | 1440 by 1000 |

All four images use English and system theme rendering dark.
`agent-browser-after10/screenshots.private.json` binds their hashes, source
inputs and actual native/controlled scope. The controlled images are not
native port-25075 screenshots. The DSH fixture is synthetic, not a private
provider observation. October 4 CUA capture of the restored real parent failed
with “Unable to capture screenshot”; the result is retained. These captures
provide partial visual evidence, not closure of every row or all four desktop
language/theme combinations.

The following table preserves the October 4 audit. The October 8 recovery
section below records the newer captures and current row-status changes.

| ID | Status | Existing v3 evidence pointer | Current observation and remaining verification |
| --- | --- | --- | --- |
| LIB-01 | functional observed; visual coverage incomplete | `ui-library-filters.test.mjs`; `ui-library-web01-frozen.test.mjs`; `ui-content-search.test.mjs` | Native OpenCode `Pong` query shows seven rows and a same-title, same-project PONG pair with distinct times and canonical links. Opened the 4:52 session; after reply-owner Back and Reader Back, Library restores the query, seven rows, exact link focus and scroll 0. The current controlled Library PNG covers content-search success; the native same-title/return scene has no capture. |
| STORY-01 | functional observed; partial screenshots | `ui-first-readable-reply-real.test.mjs`; `ui-complex-reader-real.test.mjs`; `ui-codex-collab-real.test.mjs` | Native PONG shows request/reply and recorded model/provider with input 8575, output 26 and recorded zeros; no process is rendered. Real Codex shows request/main continuation plus recorded spawn/start and result/completion entries with actor/source links. Returned-result Enter opens its canonical Agent reply at top 91.95–247.34. Current frozen Codex and public synthetic DSH PNGs support readable opening and collaboration patterns; they do not capture this real simple Q/A or Codex collaboration path. |
| DETAIL-01 | functional observed; partial screenshot | `ui-inline-child-process.test.mjs`; `ui-three-level-real.test.mjs`; `ui-pane-search.test.mjs` | Native root search finds `3037f727` in folded tool output and opens the exact six-step process/tool owner. Child search finds 13 matches and reveals event 24, character 53 in its own scope. Collapse retains the parent term, insertion URL and visible toggle; reexpand restores the child term, results and highlight. Native return restores both selected contents. The controlled pane PNG covers late content/highlight/context boundary; native complete-detail/return pixels remain absent. |
| ORIENT-01 | native9 query-loss fixed; functional observed; capture incomplete | `ui-library-focus.test.mjs`; `ui-pane-search.test.mjs`; `ui-reader-metadata.test.mjs` | Native child-source Enter → Back → Forward → Back preserves canonical parent/path, both `3037f727` terms, 25 root results plus cursor, 13 child results, two highlights and the selected root process. Each Back focuses the child toggle at top 689.95, bottom 719.95 inside the 720px viewport. Fresh-mount/reload, delayed layout/content and moved-reading cases also pass in the current controlled suite. Arbitrary unrelated read-more/detail state and pixel scroll snapshots are not serialized. CUA capture of the real returned page failed. |
| FEEDBACK-01 | functional observed; success screenshot only | `ui-content-search.test.mjs`; `ui-library-source-failure-real.test.mjs`; `ui-pane-search.test.mjs` | Current controlled checks distinguish initial/continued pending, success, empty, failed continuation and changed-source diagnostics; interrupted pane searches resume on return. Native root/child requests showed searching/opening feedback. Real unavailable Reader shows localized heading, local-record explanation, Try again and closed technical details; retry restores that state and Library return retains query/link focus. Pending/failure/empty/native-unavailable pixels remain absent. |
| FACTS-01 | source/API/functional observed; visual coverage incomplete | `reader-recorded-metadata-http.test.mjs`; `ui-library-source-failure-real.test.mjs` | Current native9→10 source oracle confirms unchanged backend inputs and read-only SQLite hash. PONG input 8575/output 26 belongs to its exact assistant row; the distinct Simple pong reply case has 8546/33. Model/provider and zero/null components match their owning rows and provenance IDs. Real Codex still returns HTTP 503 with `codex_multiple_source_files_unmerged`; the UI discloses that diagnostic and the child's encrypted task limitation. Controlled revision changes discard stale results/selection while retaining the term and explicit diagnostic. Nine metadata cases pass on native10. Real unavailable/metadata pixels remain absent. |
| DESKTOP-01 | keyboard/DOM observed; four-combination visual inspection incomplete | `ui-locale.test.mjs`; `ui-theme.test.mjs`; `UX-01` | Native EN/ZH × light/dark Enter navigation retains the canonical PONG reply owner, focus within the 1280 by 720 viewport, a 2.67px outline and no horizontal overflow. Temporary reduced-motion emulation retains navigation, reduces transition to 0.00001s and uses auto scrolling; it is cleared and English/system restored. The four current PNGs are English/dark only. Text/code/contrast visual inspection in all four combinations remains unverified. |

Independent review of the final search-return source found no actionable
product defect. Meaningful REDs for lost queries, pending restoration, actual
mount/layout timing, late root/child content and moved reading position remain
under `agent-browser-after10/`, with their successive GREEN runs. The final
52-test run covers the frozen source, including the last syntax adjustments.
The reconstructed frozen incremental diff is identified as reconstructed
evidence, not an original byte snapshot; older diffs/runs stay historical.

Compact reply metadata, Library restoration, unavailable feedback and their
unchanged backend checks are recorded in the
[reply-metadata decision](../../.agents/decisions/implemented/2026-10-04-v3-reader-reply-metadata.md).
Private journals also preserve premature observations, selector/history-step
mistakes and source-case distinctions. They are not product regressions or pass
evidence. No private transcript body is copied into this ledger.

The third goal turn revalidated the live native10 process, all 70 build inputs
with zero drift, the successful canonical Reader bootstrap and the retained
52-pass QA run. The current PONG page remained readable through CUA, but its
documented screenshot call again failed with “Unable to capture screenshot”.
The private current-state and blocker records are under `native-after10/`.
Independent review of the plan, raw observations and existing capture hooks
found no further necessary source-only work that could close the remaining
visual gaps. The same capture blocker has persisted for three consecutive
goal turns. A custom screenshot startup command was also automatically rejected
with the stated reason “blocked by policy”; that route was not retried.

The goal was resumed after that blocked audit. Three consecutive resumed turns
confirmed native10's listener, binary identity and successful canonical Reader
bootstrap. The PONG page was available through CUA; the documented screenshot
call failed in all three turns. `native-after10/resume-1-blocker.private.json`,
`resume-2-blocker.private.json` and `resume-3-blocker.private.json` retain those
observations. A fresh independent primary-evidence audit verified all 70 source
inputs with zero mismatches, the unchanged binary and the raw 52-pass QA result.
It found no further necessary source-only work that can close the remaining
visual requirements. The resumed audit's three-turn threshold is met without
counting the earlier blocked turns.

As of October 4, all seven outcomes remained open for their stated visual gaps.
The resumed overall UX goal was blocked on the unavailable capture surface and
visual inspection, with its full scope retained. The next action was to restore
an available authorized capture surface and obtain the missing captures.

### October 8 capture recovery

After the user restarted Codex and requested another attempt, the documented
CUA screenshot API succeeded in the Codex in-app browser. The task-owned
native10 process was restarted on loopback port 25075 using its saved
invocation. Its binary remains `d138e749`; an independent read-only audit
verified all 70 build inputs with zero mismatches and the retained raw
52-pass, zero-failure, zero-skip run. Those tests were reused, not rerun.
The earlier capture failures and rejected custom startup command remain
historical evidence; neither was reclassified as a pass.

Fresh native screenshots and their scenario, URL, actual viewport, language,
theme and hashes are bound to the live binary, 70 unchanged build inputs and
three matching served assets in `recovery.private.json` under
`native-after10/capture-recovery-20261008/`. They show the Library pending
state, the seven-result `Pong` query, the two PONG rows with distinct times,
the chosen 4:52 Reader, its compact reply metadata and the Library return.
Browser Back from the reply owner and Reader restored `Pong`, seven results
and focus on the chosen canonical 4:52 link. The first three scenario captures
use 1280 by 720; the reply-owner and return captures use the browser's actual
1088 by 1244 viewport after its size changed. No viewport override was set.
The JPEG pixels are 1265 by 712 and 1073 by 1227 respectively; screenshot pixel
dimensions are distinct from the recorded browser viewport.
English/light and English/system are recorded; system rendered light in the
earlier Library frames and dark in the return frame. English/system was
restored after the light-theme check.

This recovery removes the screenshot-channel blocker. LIB-01 passes for this
recorded representative native path: the same-title pair is distinguishable,
the correct canonical Reader opens, and Back restores the query and useful
list position with the exact target visibly focused. Independent read-only
review agrees with that bounded result. The intermediate same-title screenshot
has focus on the next Ping Pong row, not the chosen PONG; the returned screenshot
shows the chosen 4:52 PONG focused.

The simple Q/A, metadata and pending-state portions of STORY-01, FACTS-01 and
FEEDBACK-01 gain native evidence. The recovery does not supply the remaining real collaboration,
complete-detail/search return, unavailable/empty-state, or four-combination
desktop visual checks. The 1088-wide reply and return frames also show a
horizontal scrollbar, so they do not establish the DESKTOP-01 no-overflow
condition. The other six usability outcomes remain open. `UX-01` stays `U`; no user
visual approval is claimed.

At this recovery point, the next action was to inspect the outstanding native
scenes and four desktop language/theme combinations, then close only the rows
their evidence proves.

### October 8 desktop fixes and final verification

The recovered capture surface exposed two concrete desktop failures. At the
actual 1088-wide panel, the 1120px document minimum caused horizontal overflow
and an outline Enter moved the page sideways. The root minimum now matches the
existing 1040px three-column grid. Native10 RED pixels and the failing
1088-width regression remain preserved. Native11 passed both 1088/1280-width
cases and the real panel check.

Native11 then exposed a separate keyboard failure: activating a distant search
hit scrolled to its text but left focus on the offscreen result button. A
settled Tab returned to the top search list. Explicit successful root/child
search activation now focuses the named matching region and centers its mark;
the next Tab reaches that owner's source control. Restoration retains its
existing parent-insertion focus. The old repeat-hit test explicitly expected
search-list focus; its two assertions now check the intended destination while
preserving the complete-content, repeat-hit and canonical-anchor checks.
Actual before snapshots, incremental patches and RED/GREEN logs remain under
`native-after11/`. Independent source review found no actionable findings.
These local layout/focus corrections require no new decision record.

The final native12 executable is `f378fc7e126346539d00f0d9168565de4362e0de00f07eaa91ecb28bd6133a28`,
served by the task-owned process on loopback port 25077. Embedded UI assets are
`index-IDliipID.js` and `index-BjLgtFyX.css`. The saved invocation and
`native12-identity-audit.private.json` bind its actual process, binary, 70
matching build inputs and three matching served HTML/JS/CSS resources to the
build. All 41 backend inputs are unchanged from native11; its only three
changed build inputs are the focus components. Provider source paths remain
the same frozen, read-only corpus.

Final evidence is under
`tmp/v3-usability-20261004/native-after12/desktop-audit-20261008/`.
`interactions.private.json` has 42 observations; 38 JPEGs were actually viewed.
`screenshot-audit.private.json` in the native12 directory records their exact
pairing, SHA-256, decoded pixel dimensions, URL, viewport, language and theme.
The in-app browser's actual viewport was 1088 by 1244; scrollable Reader
captures have client width 1073 and JPEG dimensions 1073 by 1227. Unscrollable
Library/simple/unavailable frames can be 1088 by 1244. Viewport and image
dimensions are recorded separately. Every final observation has scrollX 0 and
document width equal to client width.

| ID | Final status | Final native12 representative evidence |
| --- | --- | --- |
| LIB-01 | P | 02–05 distinguish the two same-title PONG rows, open the correct 4:52 canonical Reader, and restore `Pong`, seven results and exact visible result focus. |
| STORY-01 | P | 03 shows readable simple Q/A and compact recorded model/provider/usage. 06–09 show the real Codex request, main continuation, recorded dispatch/start and completed return with actor/source links, then its readable Agent result in the parent. |
| DETAIL-01 | P | 10–11 continue the main reply from 1400/1430 to all 1430 characters. 15 shows complete input 384/output 352. 24 and the paging record show source-order continuation appending events through 64/707. 26–28 reach the child's last event and exact search owner; 30/35 reopen and close it from its context. |
| ORIENT-01 | P | 12/13 and 27/28 show root/child destination focus and the next Tab staying at its owner. 31–34 exercise source Enter, Back, Forward, Back: canonical parent path, both committed searches, root 25+ and child 13 results, both highlights and parent-insertion focus return. 35 shows visible insertion focus after closing. |
| FEEDBACK-01 | P | 01/36/40 show real pending states. Subsequent success, 37–39 unavailable/diagnostic/retry completion, and 41 settled no-match with a source-coverage warning are distinguishable and clear pending feedback. |
| FACTS-01 | P | 26/31 explicitly state that the child's task body is encrypted and cannot be recovered locally. 38 preserves the unmerged-source diagnostic; 41 distinguishes unavailable coverage from no recorded matches. Recorded collaboration and reply metadata retain their owning source meaning. |
| DESKTOP-01 | P | 15/17/19/21 show full tool input/output and visible match focus in EN/ZH × light/dark. 16/18/20 and 22 retain the same owner's next-Tab control. 23 and the motion record confirm auto scrolling and unchanged navigation under reduced motion; emulation was cleared. |

These passes are bounded to the recorded representative paths. Source-return
restores the parent insertion, not the child's previous final-reply pixel
position. The two restored searches/highlights are recorded DOM facts; the
return images do not show all of them simultaneously. Arbitrary unrelated
read-more/detail state is not serialized. Next appends the source-order prefix
to 1–64; Previous remains disabled at the prefix start. No successful Previous
navigation or replacement paging is claimed.

The observation corrections preserve mixed timing in capture 25, the
intermediate header-close scroll in 29, and the distinction between pending
40 and completed empty 41. Stable evidence is identified separately. The
native11 filing correction, initial selector/setup mistakes and all earlier
capture failures remain available rather than being reclassified as passes.

Validation for the focus slice: all 17 fresh-Vite pane-search cases passed,
including the real Axum-backed case after correcting its binary environment.
Final native12 embedded checks passed 9 tests, zero failures/skips: four
Library-focus/repeated-hit cases and five theme/locale/complex-Reader cases.
The repeated-hit case read all 46,510 characters. Raw logs are
`search-focus-final.stdout.log` and `focused-desktop-tests.stdout.log` under
native12; stderr is empty. The older 52-pass native10 run remains reused
historical evidence, not a final native12 rerun.

The earlier full Library-focus run also exposed an existing controlled-test
setup error: reload removed its artificial minimum page height, making the
saved scroll position unreachable. Native10 and native11 reproduced the same
limit. Reapplying the existing setup after reload restores that test premise
without weakening its assertions or changing product return behavior.

The final UI/Rust builds and root `npm run review` passed. Browser error logs
returned no entries. Independent image review agrees that all seven finite
rows have evidence and no remaining blocking failure. This completes the
finite usability work and makes the candidate ready for human review. English
and system theme were restored; temporary viewport/motion overrides are clear.
`UX-01` remains `U`: no user visual approval or release acceptance is inferred.

### October 9 annotated feedback

The user rejected the previous Reader presentation and requested cross-Harness
usage insights. The earlier functional and image checks remain historical;
they do not override that feedback. The [Reader and usage feedback record](agentsession-v3-reader-feedback-20261009.md)
owns the revised behavior and candidate-specific validation. `UX-01` retains
negative feedback on the previous design and awaits review of the new candidate.
