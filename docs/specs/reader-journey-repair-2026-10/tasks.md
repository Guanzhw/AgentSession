# Execution and evidence

Updated: 2026-10-11. See [requirements.md](requirements.md) and
[design.md](design.md).

| Work package | Requirements | Owner | Status |
| --- | --- | --- | --- |
| Freeze spec and acceptance | All | Orchestrator | Complete |
| Search target and Reader reveal | SEARCH-01/02 | Search worker | Implemented; functional checks passed |
| Runtime return state | RUNTIME-01/02 | Runtime worker | Implemented; functional checks passed |
| Library stars, Trash states, source guidance | STAR-01, TRASH-01, SETUP-01 | Library worker | Implemented; functional checks passed |
| Shared App/API integration and localization | All, UI-01 | Orchestrator | Implemented; English/Chinese and focus inspected |
| Build, regression tests, API and desktop journeys | All | Orchestrator | Passed; browser automation and screenshot follow-through completed below |
| Independent review and fixes | All | Independent reviewer + orchestrator | Complete; post-validation P2 repaired and independently rechecked, no remaining actionable findings |

## Baseline

The working tree already contained the completed local
`prerelease-followthrough-2026-10` changes (npm command routing, explicit private
test prerequisites and release/upgrade documentation). Those edits are preserved.
The pre-existing port 3457 listener is owned by other active work and is not the
validation instance. Previous audit instances on 3468/3469 were stopped after
their verified task-owned command lines were inspected.

The rc.4 audit reproduced missing late-message reveal, a missing star retrieval
entrypoint, Runtime view/filter loss on browser Back, and simultaneous Trash
failure/empty states. Source setup guidance was an observed usability gap.

## Verification

### Browser and screenshot follow-through

The user authorized completion of screenshot review and the authored browser
automation on 2026-10-11. The orchestrator owns search tests, visual inspection
and integration; two workers own the Runtime and Library/Trash/Settings test
groups. Each group runs the repository's existing agent-browser suites against
task-owned data and saves screenshots. Failures are diagnosed and repaired
before affected checks repeat. A new independent review follows that validation.

The three final groups ran 35 checks: 33 actual browser cases and two SSR helper
checks, all passing with zero failures or skips. Each browser uses an isolated
agent-browser session; native tests own their processes and temporary sources.
Search and Library mocks serve the current built Svelte application; Settings
and Runtime also exercise the actual native Axum service. Final commands set
`AGENTSESSION_V3_BIN` to `v3/target/debug/agentsession-v3.exe` and
`AGENTSESSION_V3_AGENT_BROWSER_BIN` to the installed browser executable.

| Final command (`node --test --test-concurrency=1`) | Outcome | Local log under `tmp/reader-journey-completion-20261011/` |
| --- | --- | --- |
| `v3/test/ui-content-search.test.mjs` | 18 passed, including one SSR helper | `search-localization-final.log` |
| `v3/test/ui-library-filters.test.mjs v3/test/ui-management.test.mjs v3/test/ui-settings.test.mjs` | 10 passed | `library-tests-final.log` |
| `v3/test/ui-runtime-events.test.mjs v3/test/ui-runtime-projections.test.mjs v3/test/ui-runtime-related-navigation.test.mjs v3/test/ui-runtime-history.test.mjs` | 7 passed, including one SSR helper | `runtime-i18n-final-tests.log` |

The Library result is reused after the final Reader error-only correction; its
owning source and assertions are unchanged. Added source focus/reload assertions
were also rerun separately (two cases, then the final single case). One English
family capture had an unexplained black area; a fresh isolated run passed the
same case and produced a clean image, without a source/style change. The bad
image remains in `before-recapture/`, and the rerun is recorded in
`library-starred-recapture.log`. These repeats are not counted as new cases.

The new native Events pagination case appends 65 calls only to a task-owned
fixture copy, reads real first/second-page cursors from Axum, and verifies 25
rows, applied filters, exact source navigation, Back/Forward and scroll within
two CSS pixels. Both copied and public source hashes remain unchanged by reads.

Screenshot review found and repaired two product defects, with failing checks
retained before the fixes:

1. Settings source-anchor scrolling placed the heading behind the 68-pixel
   sticky header. The article now has a 92-pixel scroll margin; mock and native
   browser cases assert that the focused heading is below the header.
2. Trash translated the failed-source summary at read time. It now retains the
   failed count and translates on render. A browser case switches English →
   Chinese → English without retry and checks the existing summary each time.

The subsequent fresh-context independent review found one P2: dynamic Reader
location errors were passed to the strict translation dictionary, causing
unknown keys (including the Runtime stale-source sentence) to disappear in
Chinese. `errorText` now translates known keys and preserves unknown diagnostic
text; the existing `t(Message)` contract remains strict. Search and native
Runtime browser regressions failed before the correction and passed afterward.
The final cases verify known Chinese text, switching back to English, unchanged
Conversation URLs, and an unknown raw diagnostic remaining visible in Chinese.
Their baseline logs are `search-localization-baseline.log` and
`runtime-error-i18n-red-tests.log`. A test-only eval redeclaration failure was
also retained and corrected with local IIFE bindings before the final rerun.

The independent reviewer rechecked the repair using source, helper assertions,
actual failure/success logs and saved Chinese/raw-error screenshots, then
reported no remaining actionable journey findings. The orchestrator separately
inspected the changed source and saved images.

Two test corrections preserved their behavioral checks: the search stale-source
assertion now selects the visible Reader location error rather than an earlier
error in collapsed execution details; the Summary return test expects the saved
revision to reject changed source facts, while a separate fresh-document path
still verifies successful native counts. Baseline failure logs and the five
pre-fix screenshots remain under this task's ignored evidence directory.

Final UI and embedded native debug builds passed after the product corrections:
149 modules, `index-Do7tiR2L.css` / `index-BDTiHtKF.js`. The earlier Rust and native
contract checks below are reused: their Rust inputs and dependencies did not
change during this follow-through.

Actual saved screenshots were opened and inspected for late-hit highlight and
focus, Library star/family/filter states, Trash failed/partial/empty states,
English/Chinese source guidance, and Runtime source/related-session return.
The final Runtime rerun screenshots are in `runtime-i18n-final/`, with the
previous verified set retained in `runtime-final/`; other screenshots are at the
evidence-directory root. Viewport captures establish the restored
position; the full-page Runtime capture is supplementary, since its fixed
header is painted at the capture scroll position. The prior screenshot blocker
is resolved for these desktop flows. `npm run review` and `git diff --check`
passed on the completed follow-through. Task-owned native processes were
cleaned up; the original port-3457 PID 7436 remained the only Viewer process.

### Initial build and automated checks (retained evidence)

- `npm --prefix v3/ui run build`: passed on the final implementation (149
  modules; final JS asset `index-DPNg9JLP.js`).
- `cargo build --manifest-path v3/Cargo.toml --locked --bin agentsession-v3`:
  passed. The debug binary embeds the built UI and was restarted on isolated
  port 3468. The existing release executable on 3457 was preserved.
- `cargo test --workspace --manifest-path v3/Cargo.toml --locked`: 244 passed,
  18 explicitly ignored private-source/benchmark tests, zero failed. This
  evidence covers the final Rust changes; subsequent fixes changed UI only.
- `npm run review`: passed (governance, Rust formatting and locked compilation).
- Native Node integration suites: `library-family-http`, `library-partial-source`,
  `library-title-sort`, `reader-search-slice`, `mcp-search-slice`,
  `mcp-search-json-boundary`, `meta-slice`: 17 passed, one frozen private-corpus
  check skipped. These include actual native stdio MCP calls and source-hash
  preservation assertions.
- Native Node integration suites: `protocol-events-http`,
  `protocol-projections-http`, `reader-target-bootstrap`,
  `reader-content-snapshot`: 15 passed. These cover real Axum pagination,
  cross-provider search, strict source revisions and bounded Reader snapshots.
- `node --test --test-name-pattern='search destination URLs|Runtime history'
  v3/test/ui-content-search.test.mjs v3/test/ui-runtime-history.test.mjs`:
  two passed. The bootstrap assertion verifies that UI-only search fields are
  not forwarded to Rust's strict bootstrap query. Vite test WebSockets were
  disabled after a port-24678 conflict warning; the rerun had no warning.
- Changed browser scripts passed syntax checks. Their agent-browser suites were
  not executed in this run; the desktop evidence below comes from CUA directly,
  not from those scripts.

### Initial desktop functional evidence (retained evidence)

The final native process used public Codex/DeepSeek Harness fixtures and
task-owned synthetic copies, isolated metadata/index/cache, and disabled terminal
launch. Browser interactions used the Codex in-app browser on Windows. No
personal provider source was mutated.

| Requirement | Observed result |
| --- | --- |
| SEARCH-01 | Searching `LATE-SEARCH-AUDIT-20261011` and clicking the result revealed the match at UTF-16 offset 6500 in a 6569-character message. The bounded match region was focused and the original body retained its Show more control. |
| SEARCH-02 | Reload and a new tab using the result's actual href retained the precise reveal. Back restored the submitted query, result and focused result link. |
| STAR-01 | Reader star returned as a starred Library row; Only starred reduced the list to that session, including after Reader return. A task-owned native restart retained `starred: true` and one match from `/api/v3/library/sessions?starredOnly=true`. Core family HTTP regression covers starred child/context parent, filter propagation, unstar and stale cursor rejection. |
| RUNTIME-01 | `tool` / `tool.call` filters survived source jump, Back and Forward. A synthetic 100-call source exercised a real second page (calls 026–050). Returning from call 037 restored the same 25 rows, filters and scroll position 1575.333 CSS pixels. |
| RUNTIME-02 | Public three-level Codex fixture: Sessions lens → child Reader → Back restored the Sessions lens, encoded selected node and keyboard focus on the child link. |
| Runtime failure/cancel | CUA Fetch injection returned a 409 source-changed locate response: an explicit error remained in Conversation with a Conversation URL. Tab switching and reload retained a consistent view. A separately held locate was cancelled by entering Technical details; releasing a late 409 did not change Runtime or publish the error. |
| TRASH-01 | Blocking all five Trash reads showed unknown count `—`, an explicit failure and Retry Trash, without an empty claim. Blocking only OpenCode preserved one readable task-owned row and `1+`. Retry after unblocking restored complete `1`; restoring the row led to confirmed empty `0`. |
| Trash cancellation | Held an old OpenCode empty read while other reads completed, returned to Reader and deleted the task-owned synthetic session, then released the old response. The count remained `—`; a fresh read found the newly deleted row and `1`. The row was restored afterward. |
| SETUP-01 | Source issue → Configure source · OpenCode navigated to `/settings#source-opencode` and focused that article. It showed the actual startup path, `dbPath`, `--opencode-db`, `AGENTSESSION_DB_PATH`, precedence and restart/recheck steps. |
| UI-01 | English controls and Settings Chinese translations were inspected through live accessibility/DOM state. Search and source destinations and the related-session return restored keyboard focus. |

Task artifacts are retained under ignored `tmp/reader-journey-repair-20261011/`
(including the direct-link accessibility snapshot and the pagination fixture
manifest). CUA fault injection was cleared after each scenario. Tests checked
public fixture immutability; no tracked public fixture diff was introduced.

### Review and corrections

Three workers implemented bounded search, Runtime history and Library/Settings
work. The orchestrator integrated shared App/API/Reader boundaries and inspected
the final diff. A fresh-context independent reviewer inspected core ownership,
navigation, errors and tests. The following concrete findings were corrected:

1. UI search hash fields were being forwarded to Rust's `deny_unknown_fields`
   bootstrap query; the API client now sends only the owning query fields.
2. A failed/pending Runtime source jump could save a Runtime hash as the
   Conversation return address. Successful and failed navigation now maintain
   the appropriate address, and cancelled responses cannot overwrite it.
3. A previously confirmed empty Trash count survived a new exclusion. Deletion
   invalidates that read, and a generation check prevents an older in-flight
   empty response from publishing afterward.

The reviewer rechecked these corrections and reported no remaining P1/P2
source findings. The main agent confirmed the affected flows in CUA.

### Initial evidence boundary and follow-through

The screenshot interface repeatedly returned `Unable to capture screenshot`,
including a fresh visible tab; the browser screenshot CDP alternative timed out.
Live accessibility trees, DOM, focus, geometry and requests remained available.
Therefore functional browser validation is complete within the stated fixtures,
but visual screenshot review and the newly authored browser scripts remained
open at that handoff. Both are now completed by the follow-through above;
the original capture failure remains part of the execution history.

This is a local unreleased implementation. No stable-release, private-corpus,
large-archive performance or other-host gate is closed by this evidence. The
task-owned validation process is stopped at handoff; the prior 3457 service
remains running with its original executable.
