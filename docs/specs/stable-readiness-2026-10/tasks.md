# Stable readiness task ledger

Updated: 2026-10-12. Goal: **3.0 stable**. See
[requirements.md](requirements.md) and [design.md](design.md).

| Work package | Owner | State |
| --- | --- | --- |
| Freeze stable rubric and candidate scope | Orchestrator | Frozen; user selected stable and later authorized immediate publication with the remaining evidence limits recorded |
| SRC-01/02 real-source evidence | Source workers | All five current producers and required rare shapes captured; final5 authentic Claude/DSH desktop and native source oracles pass |
| Historical STATE-01 attribution | State worker | Historical F remains unattributed; same legacy index-write mechanism reproduced on isolated copies |
| Stable packaging/publication path | Release worker | Implemented; final5 Windows/WSL offline npm installation and Web/MCP launch pass; same-commit four-target CI passes |
| Optimized candidate and complete regression gate | Orchestrator | Final5 built; 251 Rust passes, 18 explicit ignores and review pass; full Node historical run ended with one repaired harness failure and scoped reruns pass |
| Complete desktop/resource validation | Desktop/resource workers | Final5 authentic desktop delta passes; current resource/search attempts fail the live legacy state guard; remaining measurements stay open under the user's direct-publication decision |
| Human UX feedback | User + orchestrator | Passed for the presented desktop tasks; user explicitly confirmed actual task completion and acceptable reading/return behavior |
| Final independent review and release judgment | Independent reviewer + orchestrator | Broad and final-delta reviews completed; DSH and test-harness findings repaired and independently verified; final evidence judgment pending |

## Starting state

The working tree contains the earlier prerelease follow-through and Reader
journey repairs from this chat. Their spec ledgers retain scoped passing
results, failure baselines and independent reviews. Those changes remain local
and unreleased. The previous journey follow-through ran 33 browser cases and
two SSR helpers, with 244 Rust tests and relevant native checks available for
scope-based reuse. None independently closes the stable gate table.

The existing port-3457 listener is PID 7436, running the original release
executable. It is preserved. New evidence belongs under ignored
`tmp/stable-readiness-20261011/`; historical archives and original worktrees are
read-only evidence sources.

## Observations and next checks

- The original release workflow rejected stable versions. The implemented
  [release-channel decision](../../../.agents/decisions/implemented/2026-10-11-stable-release-channel.md)
  now derives npm/GitHub channels from one version identity. Focused Windows
  Node 22.15.0 results are 15 pass and one Linux-only archive skip; WSL Linux
  Node 24.16.0 passes all 16. No registry or GitHub publication occurred.
- The stable gate table still includes source freshness/rare cases, complete
  Reader/resource evidence, human feedback, and historical state attribution.
  Workers are inspecting original evidence before assigning closure or blockers.
- Full candidate checks must select the actual isolated optimized executable;
  the root test script's default binary path points at the preserved existing
  build. Explicit equivalent commands will record the selected artifact.

## Candidate and new evidence

The first optimized local `3.0.0` binary has SHA-256
`1073a6569bc40bec635f41280307a15c77c6c2d74eaf13d8ac8ff54776333069`.
An immutable copy under `tmp/stable-readiness-20261011/regression-initial/`
owns the initial full Node run. Its embedded assets are
`index-BDTiHtKF.js` and `index-Do7tiR2L.css`. This build precedes the newly found
DSH generation-4 repair, which requires a new artifact and affected revalidation.

Two genuine generation-4 DSH copies are missing from the Library and return
`session_not_found` from Reader/Protocol on this initial binary. The installed
producer format codec accepts their 11,579 source records. The repair belongs
to the DSH adapter; current producer-version pairing and other rare source
shapes remain separate SRC evidence requirements.

The original state evidence and database snapshots are still available.
Independent replay of the hash-matched legacy 1.10.1 MCP on the preserved
metadata copy changes only `session_index` on each startup; schema, user
metadata and token tables stay unchanged. Historical failing byte versions
and per-write process evidence are absent, so this mechanism does not identify
the historical writer. STATE-01 remains F. Current isolation and any proposed
release disposition must be judged separately; local detailed evidence is in
`tmp/stable-readiness-20261011/state-audit/REPORT.md`.

The full retained five-provider inputs and independent search/root gold were
located in the original validation worktree. The old complete shared-load
controller is being rebound to fresh task-owned state and the current candidate.
The repository's shorter shared-state smoke only checks two pages and cannot
by itself close complete DEL-03.

## Initial full regression and observed repairs

The immutable initial optimized binary completed the full serial Node gate:
787 tests, 734 pass, seven fail, 46 explicit skips. The original failures remain
in `regression-initial/full-node.log`.

- Three pane-search failures exposed initial layout/restoration ordering.
  Actual keyboard child-source Back also restored the query but lost insertion
  focus. Reader now waits for initial layout and restores the child insertion
  on persisted browser history returns. All 19 pane-search checks pass,
  including Back/Forward, fresh reload and preserving a moved reading position.
- Two older navigation assertions expected Runtime to be absent from browser
  history. They now test the accepted Runtime → source → Back-to-Runtime →
  Back-to-prior-Conversation sequence. Both focused cases pass.
- The Stats test's browser-open timeout and the process-level multiprocess
  failure did not reproduce in focused reruns. These are retained transient
  failures, with cause unresolved; the final gate must run them again.
- A real missing canonical parent exposed misleading service-failure guidance.
  The strengthened real native/browser case fails on the initial artifact with
  `Check the local service`. App now handles `session_not_found` with explicit
  bilingual guidance, collapsed technical details and a return-to-Library
  action. Integrated-artifact validation is pending.

The [DSH generation-four decision](../../../.agents/decisions/implemented/2026-10-11-dsh-generation-four.md)
records the owning format change. Feature-gated resource probes now record
actual capture/build/commit counts, positioned-reader work and lock wait, with
process/invocation entry and exit on stderr. The auxiliary build passes its
cold/warm/force/explicit-failure checks; its instrumented timing is separate
from ordinary optimized resource measurements.

## Integrated regression and independent findings

The next immutable candidate, SHA-256
`ec63a41c463623d2df03e52228f2b2df786faa59ff8534ebc87ce053a98ddaad`,
embeds `index-Cz7ytYvG.js` and `index-Do7tiR2L.css`. Its Rust workspace check
passes 247 tests with 18 explicit ignored private-source checks. Governance,
Rust formatting and compilation pass. The complete serial Node 22.15 gate,
including an actual Windows portable bundle for npm installation, is running
in `final-candidate/`; its outcome remains pending.

The canonical missing-session browser check now passes in English and Chinese,
including retry, collapsed technical details and returning to Library. An
explicit inherited-context click returning no copied prefix previously made
the disclosure disappear; it now stays open with the existing translated empty
message. Four focused inherited-context browser checks pass, including keyboard
focus and no duplicate request on reopen.

Fresh independent review reproduced a producer-valid v4 unknown event with
`ignorable: true` returning HTTP 500 on `ec63a41c…`. The owning admission rule
now preserves that opaque Protocol record while rejecting unknown required
events. The regression failed before the repair; 27 DSH Rust tests now pass
with three explicit private-source ignores. Exact native revalidation belongs
to the next candidate. Desktop review also reproduced a fresh child-search URL
without saved browser state losing its highlight/focus; its correction and
focused revalidation are in progress. Neither immutable earlier executable is
overwritten by these changes.

The selected real DSH v4 oracle on SHA `464bd525…` verifies 8,222 owned Protocol
event tuples, 223 Runtime pages, 106 owned queue records, 701 complete mailbox
body pages on each Web/MCP surface, and complete longest tool bodies of 38,772
and 49,932 UTF-16 units. All reconstructed hashes match independent source gold,
sources remain unchanged, and task processes exit. Later catalog-label changes
have controlled native tests plus a real reread; the selected real captures
contain no owned catalog-v1 rows. A separate frozen five-provider native run
passes all 17 selected real-source checks without skips. These are bounded
source results, not latest-producer or rare-case closure.

No historical failure or missing latest/rare source requirement is closed by
these bounded results. No commit, push, tag or publication has occurred.

## Current final4 artifact and source evidence

Final4 Windows SHA-256 is
`202a264c9e9d1b14b2cc6ae75ccf2cc58f6c6290148f0904117bc93b65da527b`;
WSL Linux x64 SHA-256 is
`7e5be9f913714bb6f6c79db13a0be864c3e9ffa73a4ee6aec54220d462c04831`.
Both embed the final Reader assets `index-IHAsUOXF.js` /
`index-Do7tiR2L.css`. Both packed candidates install offline and launch Web and
native MCP (two focused tests per host, zero skips). Rust workspace results are
244 core plus five app passes, 18 explicit ignores; `npm run review` passes.
Evidence belongs to `tmp/stable-readiness-20261011/final-candidate-4/`.

The earlier fresh child-search highlight/focus repair is complete. Real native
depth-two long-body navigation on final3 waits for the existing asynchronous
body load before final positioning, then highlights and focuses inside the
viewport. Nineteen pane cases and the strengthened real three-level case pass.
Final4 changes only DSH production parsing after final3; these Reader results
reuse the identical UI inputs and embedded assets.

User-authorized task-local current CLI installs produced authentic sources:
Claude Code 2.1.296, OpenCode 2.0.26, Pi 1.1.0, Codex 0.162.1, and DeepSeek
Harness 0.2.0-rc.2. Claude/Pi/OpenCode on final3 reconcile seven sessions, 100
raw records, 106 Protocol events, 38 Runtime pages and all 30 timeline bodies
through complete HTTP/MCP continuation. Current Claude sidechain, notification
and compact, and Pi compact, branch summary and fork parent evidence are real
producer outputs. These unchanged adapter scopes are reusable on final4.

Codex's official current compression worker produced a genuine `.jsonl.zst`
from the new task-owned session. Only that session's mtime was aged eight days
to exercise the producer's seven-day policy. Decoded bytes equal the original;
final4 reconciles all 15 raw events and the exact two request/reply identities,
order and complete bodies. DSH's current actual workflow exposed required
`tool-workflow/run-start/end` missing from the modern admission table. The
owning fix preserves these as raw log observations, with no invented AgentRun.
Final4 now reconciles the basic and workflow captures' 68 raw events and all
110 HTTP / 110 MCP body pages. The producer's Windows worker failed with an ACL
provisioning error; the recorded `error` conclusion remains visible and does
not establish successful workflow/member execution. A bounded ordinary WSL
producer attempt is checking that remaining sample gap.

Current-source originals and frozen semantic bytes remain stable through the
Viewer checks. A preliminary OpenCode `auth list` unexpectedly auto-started its
task-installed service using default paths; the verified task service was
stopped. Its incidental default runtime files had no before/after guard, so no
preservation claim is made for that producer-side startup. All subsequent
capture-producing commands used isolated homes. Detailed capture proofs and
preserved failures are under `current-captures/`.

The complete Node 22 run on immutable `ec63a41c…` exposed mock-server teardown
deadlocks: an earlier after-hook awaited `server.close` while a later after-hook
owned the still-open browser. Exact task-owned browser sessions were closed to
unblock the run; all interventions are recorded. The HTTP mocks now close
their connections after stopping the listener. Independent review found two
TCP port-probe sites mistakenly included in that repair; both were corrected,
and the actual unavailable-source browser check passed independently on final4.
The original full-run failure and interventions remain explicit. Seven UI files
loaded before the teardown correction are being rerun cleanly on final4; later
full-run files use the corrected HTTP cleanup. No complete green claim is made
before these outcomes are recorded.

## October 12 integration followthrough

The full Node run on `ec63a41c…` ended with 790 tests: 743 pass, one fail and
46 explicit skips. The sole final failure is the TCP port reservation helper
mistakenly changed during the HTTP teardown repair; independent exact-Node-22
revalidation of that helper and the affected native unavailable-source browser
case passes after correction. The prior Stats and multiprocess failures did
not recur. Seven browser files loaded before the cleanup change reran with
40/41 passing; the remaining browser-daemon configuration/startup error passed
in an isolated retry. The intervened full run and transient failure remain
recorded; this is scoped repair evidence, not an uninterrupted green full run.

DeepSeek Harness 0.2.0-rc.2 also produced a successful ordinary Linux workflow
and a six-member team using its shipped experimental team profile. Nine frozen
sources contain 248 raw events. The independent source oracle reconciles all
Protocol/Runtime events, 160 complete body pages per HTTP/MCP surface and 20
queue-body pages per surface on final4. The one queue body is 3,738 UTF-16 units;
the earlier 106-queue and 49,932-unit body evidence retains its older producer
scope. The requested larger message was not actually produced, and its model's
size claim is not used as gold. Captured sources, existing authentication file
hashes and post-Viewer source hashes are unchanged. All capture processes exit.

Current five-provider desktop inspection on final4 opened ten authentic session
routes, with no page errors or horizontal overflow at 1440×1000. Claude compact,
Pi branch/compact, child-to-parent links and the actual DSH Windows workflow
failure are readable. It also exposed a Claude task-only collaboration panel
with no visible contents and a missing recorded Agent dispatch from the parent.
The owning provider normalization and generic task rendering repair are covered
by an implemented decision, a failing native baseline, seven targeted Rust
passes and four browser passes. Fresh source review found no actionable issue;
final5 must prove the repaired authentic parent/child path and empty-child state.

The single quiet current metadata-import retry passes on final4, including
logical schema/table comparison, legacy and retired-provider metadata,
historical indexes, Web/MCP reads, restart and duplicate-import refusal. The
before/after protected user endpoint comparison is equal and all task processes
exit. This is reusable for unchanged metadata/configuration code in final5.
The earlier prelaunch copy drift and historical unattributed STATE-01 F retain
their original identities. Reports are under `state-audit/current-import-final-002/`
and `current-captures/`; private source text stays in ignored evidence.

## Final5 immutable candidate

Windows SHA-256:
`0b18b773e5baab92746c5d04d45ac88e7863d8830b664235502da0bb5ee92114`.
Linux x64 SHA-256:
`5a63edfecde6c60e57fa9559ab6e32226923d27a978546f15fb9a5fdc607022f`.
Both embed `index-Cw1cA95m.js` / `index-Do7tiR2L.css` and identify as `3.0.0`.
Evidence is under `tmp/stable-readiness-20261011/final-candidate-5/`.

- `npm run build` with the task-owned Cargo target succeeds. The root build
  performs the UI build and locked optimized native build; the existing user
  service executable is preserved.
- `cargo test --workspace --manifest-path v3/Cargo.toml --locked`: 246 core plus
  five app passes, zero failures, 18 explicit private-source ignores.
- `npm run review`: governance, Rust formatting and compilation pass.
- Windows Node 22.15 and Linux Node 24.16 each pass the three selected native
  Claude/DSH and actual offline npm installation/Web/MCP checks, zero skips.
- The genuine current DSH Linux captures also pass the complete source oracle
  on the actual final5 Linux executable: 248 raw/Protocol/Runtime events, all
  160+20 HTTP and 160+20 MCP body pages, 238 HTTP requests and 204 MCP calls.
  Source hashes stay equal and task processes exit. Only harness path mapping,
  state directory and output filename differ from the Windows oracle; gold
  identities, ordering and complete-body assertions remain identical.
- The final empty-child collaboration regression and all five mock-backed
  collaboration browser checks pass after a preserved failing baseline.
  Authentic final5 desktop integration passes as detailed below; formal
  resource repetitions remain pending; current four-host CI passes below.

Final5 authentic desktop QA confirms the recorded Claude dispatch/summary,
canonical child expansion, bilingual empty-child state and Back/Forward return.
The current successful DSH workflow and six-member team are readable. Normal
scrolling inside the intentionally bounded team thread exposes Continue, and
actual pointer continuation reconstructs the full 3,738-unit message with the
source-gold hash. An initial CLI auto-scroll click failed outside the clipped
viewport; the subsequent normal-scroll evidence establishes a harness
limitation, so no CSS change was made. All 32 original/copied source hashes
remain equal; the task server and browser exited and port 3457 remains owned by
the original PID 7436. Main reviewed the saved parent and full-message images.

Independent final5 native MCP followthrough makes nine real calls for the
authentic Claude parent/child: canonical identities, complete timeline order,
all five child events and complete raw-derived Agent input/result bodies agree.
All 32 source hashes remain equal and both MCP processes exit. Recorded
requested/started coordination and canonical placement are independently
checked against raw call/result IDs and source ordinals through HTTP Protocol
and Reader; the native tool set has no `session_protocol` tool. The reviewer's
first string-versus-array oracle mismatch is preserved as a harness error and
the corrected source-owned rendering comparison passes. Fresh final review
reports no remaining actionable implementation finding.

The user authorized committing and pushing the reviewed changes to the isolated
`codex/stable-readiness-20261012` validation branch and running four-platform
native CI. This authorization excludes changing `main`, creating release tags,
or publishing npm/GitHub releases. Commit
`11ec33d57762b96c752473a5b4a8a69e961d7742` was pushed to that branch;
`main` remains at `d74d508`. The [four-platform native run](https://github.com/Guanzhw/AgentSession/actions/runs/38155304737)
completed successfully on that exact commit. Each actual host passed 251 Rust
tests with 18 explicit ignores. Packaged native integration counts were
347 pass / 188 skip on Windows x64, 339 / 196 on each Linux architecture,
and 338 / 197 on macOS ARM64, with zero failures. Browser/private-source/host
skips retain their stated scope; local authentic-source and desktop evidence
supplies the separately recorded checks. All four unpublished portable/npm
validation artifacts were produced; no release was published.

On October 12 the user additionally instructed: publish after completing the
work. Stable publication is now authorized after the remaining acceptance and
final review succeed. The earlier validation-only authorization above retains
its historical scope; no release has yet been created.

Read-only publication preparation confirms source versions already agree on
`3.0.0`, while its remote tag and all three npm package versions are still
absent. The release workflow publishes a pushed `v3.*` tag after validation;
stable versions select npm `latest` and a normal GitHub release. Its required
[3.0.0 release note](../../releases/3.0.0.md) is now prepared and independently
reviewed without actionable findings. Final released-version wording in the
note and READMEs is aligned in the pre-tag delta. The exact publication and
post-install verification sequence is retained in
`tmp/stable-readiness-20261011/release-after-acceptance/HANDOFF.md`.

## Current resource and matched-workload qualification

The first final5 formal resource attempt stopped in repetition one. Its three
services returned all 813 search rows with complete raw-call evidence. The
810 fixed-cutoff rows retain their previous order, count and fields, but each
now includes a source-navigation `target` absent from the old gold. The old
full-object hash mismatch remains a failed attempt; all target fields require
independent raw-source validation before a revised oracle is sealed. Later
normal repetitions and the auxiliary run were not started.

The same window changed the protected live legacy `agentsession/meta.db`
bytes/mtime. Provider-source and owned-copy guards pass, and all three task
services exit. There is no per-write PID trace, so the writer remains unknown;
the current failure is retained separately from historical STATE-01 and the
passing controlled metadata-copy import.

Independent review confirms that shared-resource repetitions alone cannot
close DEL-01. Remaining current evidence includes nine-query five-pair search
and source-verified restart measurements, metadata/long-content paired reads,
source-change repetitions and full-session semantic adjudication. The original
one-second repeat-search and two-second restart thresholds remain unchanged.
Preparation and raw-source oracles are task-owned ignored evidence; no timing
comparison becomes eligible by discarding new fields or unresolved differences.

The [current semantic adjudication](../../design/agentsession-v3-current-semantic-adjudication.md)
now resolves the search targets and all 118 complete-session differences against
independent raw sources. A separately sealed second resource attempt completes
initial, warm, post-refresh and restart phases: each verifies 813 search rows,
357 roots, 507 tool references and the entire 10,577-unit body. Its first
repetition succeeds, but the overall run exits 1 because protected legacy
metadata changes; repetitions two through five and the auxiliary run remain
unstarted. These outcomes do not close the five-repetition resource gate.

The second attempt's observer retained five stable SQLite snapshots. Their
schema and all table contents remain equal except `session_index.last_indexed`:
three bursts update 25, 16 and 17 rows, without adding or removing rows. Every
snapshot passes `quick_check`. A later read-only Windows Restart Manager query
finds ten legacy MCP Node holders and no native candidate holder. This narrows
the current change to legacy index timestamps; the post-run holder list does
not establish which process performed an earlier write. The strict failure
and unknown writer remain recorded. The hash-bound native source has no
`last_indexed` updater and the measured processes receive explicit isolated
state paths; installed legacy 1.10.1 source writes that column during startup
index refresh. This identifies a matching mechanism without attributing an
individual observed write. The retained audit verifies all 987 raw calls and
four phases while preserving the failed execution status. All six task-owned
services exit. Detailed evidence is in
`tmp/stable-readiness-20261011/state-audit/observed-final5-002/REPORT.md`.

A later diagnostic observes six newly launched installed legacy MCP processes
with increasing read I/O, all descending from the Codex app-server, alongside
further legacy index writes. Another newly created process has zero observed
I/O delta; the six active processes are not an exhaustive launch count.
Eight stable SQLite copies change only `session_index.last_indexed`; schema,
row count and all user metadata/token tables remain equal during that observer.
The ten previously known MCP holders remain idle by independent native and WMI
I/O counters. Exact-file writer attribution remains unavailable. This narrows
the recurring interference to a host-launch/index-refresh mechanism without
retroactively identifying the historical writer. The observer stops early on
a sharing violation in its own log; its actual four-minute-twenty-second scope,
failed WMI subscription and all raw evidence remain explicit in
`state-audit/transient-observation-004-analysis/REPORT.md`.

Copy preparation for the remaining matched workloads is complete: ten isolated
source-change copies and ten read-only plans, fixed2 runtime fingerprint,
independent complete search targets and source-adjudicated full-session output
are sealed. Preparation itself launches no product. Its separately observed
legacy-state drift remains failed; only source/copy/controller readiness is
qualified. Timed-stage before/after preservation checks stay strict. The search
attempt and its failed preservation check are recorded below; paired reads and
source-change measurements have not started. The paired Reader controller is
also statically ready; current Linux I/O/count instrumentation passes in the
separate diagnostic below. The user authorized temporary legacy MCP isolation
on October 12. Only the manual `mcp_servers.agentsession` entry was disabled;
the plugin entry and unrelated configuration remain unchanged. Runtime
activation is still required, as the search attempt demonstrates.

Independent static review finds no actionable issue in the matched or Reader
controllers and semantic claims. It verifies the actual seal, twelve relevant
small pins, alternating plans, all 118 full-output differences and Reader
reference hashes. Bulk guards and actual measurements remain execution checks;
the review does not convert preparation or historical results into current
performance evidence.

The current-source crash check uses a separate debug `crash-test-hook` build
(`f7373d4b…`) from all 82 production inputs bound to final5. A controlled
precommit termination preserves the old complete catalog/search/FTS revision;
recovery advances revision 1 to 2, agrees across Web and two MCP processes,
rejects stale cursors and survives restart. Four SQLite integrity checks pass,
19 raw call records settle, all shadow defaults and frozen inputs stay equal,
and all five owned process IDs are confirmed absent afterward. The first
observer attempt failed because Node 22.15 lacks FTS5; its six-call failure
record remains. The unchanged controller passes with the verified FTS5-enabled
Node 26.5.1 observer. This is bound debug-hook evidence, not a claim of forcibly
terminating the ordinary optimized final5 executable. Detailed evidence is in
`tmp/stable-readiness-20261011/crash-final5/`.

Read-only analysis of the retained resource calls attributes 138–152 seconds
per browse/search phase to four `/api/sessions` compatibility-statistics pages.
That endpoint builds source-backed Protocol statistics for each returned row;
the current Library uses `/api/v3/library/sessions?limit=40` and indexed family
summaries. The retained compatibility timings therefore do not establish
Library latency or a fixed2 regression. HTTP-01 retains these statistics but
has no numeric latency threshold. The frozen workload and separate one-second
search/two-second restart thresholds remain unchanged. Detailed call, source
and logical-I/O evidence is in
`remaining-performance-review/web-browse-latency/REPORT.md`.

The current final5 Linux Reader diagnostic now passes over the same 15 frozen
source files (36,116,973 bytes). Actual GDB entries show one capture,
normalization and publication on the cold bootstrap and zero on the six
subsequent unchanged bootstrap/Content requests. The opening, target and final
complete bodies match source gold; final ordinal is 1,497 of 1,498. Fixed2
precise coverage records 15 startup parses and one capture/render per detail.
Strace records 401,408 native startup provider-read bytes, 24,310,353 on the
cold bootstrap and 7,562,779 for each subsequent request in this original
revision-checking sequence. Those are logical syscall bytes, not physical
disk traffic or a browser-paint result. Source/runtime/tool/controller and
copied-membership guards pass; Linux default state is unchanged and all owned
processes exit. Two earlier controller failures (wrong cohort-size constant
and misclassified owned runtime log) remain preserved with their narrow fixes.
The successful run is independently identified in
`del02-final5-linux/RESULT.md`; Windows browser and resource gates remain open.

The October 12 search attempt completes five alternating fixed2/current pairs
over all nine frozen queries. All ten arms pass their complete source-backed
targets; the raw-call audit verifies 1,570 records with no unsettled call.
Current repeat-search p95 values are 87.15–135.04 ms, and unchanged-restart to
first correct answer p95 is 118.95 ms, below the frozen 1,000/2,000 ms thresholds.
Fresh index construction to first correct answer p95 is 11,393.30 ms and remains
a separate descriptive measure. Complete cross-version output is unequal, so
full-output speedup comparison remains ineligible.

The overall search attempt nevertheless exits 1: its protected-state guard
finds the user's legacy `meta.db` changed. Frozen sources, runtime artifacts
and the candidate remain unchanged. Forty seconds of quiet observation before
the run and `codex mcp get agentsession --json` reporting `enabled: false` did
not establish durable runtime isolation. Two exact manual `npx -y
@acetamido/agentsession-mcp@latest` process chains were created by the existing
Codex app-server after the setting changed; both accumulated substantial read
and write I/O. The installed plugin uses a different pinned launch command.
This establishes that the live app continued launching the disabled manual
entry, without attributing an individual database write to a PID. The failed
attempt and its measurements remain in `matched-final5/search-result.private.json`,
with the original preservation packet and raw journals.

Local installed protocol and official app-server documentation identify
`config/mcpServer/reload`, which refreshes loaded threads without a single-server
filter. No supported connection to the already-running Desktop stdio server was
established, and no refresh was dispatched. The next action is a user-performed
Codex restart, followed by runtime activation and quiet-state checks before
resuming the prepared measurements. The manual entry stays temporarily disabled
for that restart and must be restored afterward using the exact-section restore
script, preserving unrelated edits. Remaining paired reads, source changes,
Windows Reader and full resource repetitions stay open; this failed attempt
does not close DEL-01 or historical STATE-01.

## Direct stable publication disposition

The user subsequently stated that restarting was not possible and explicitly
instructed immediate publication. The [release decision](../../../.agents/decisions/implemented/2026-10-12-user-authorized-stable-publication.md)
therefore replaces waiting for that restart and the remaining host-dependent
measurements. This is an authorized release exception, not an acceptance pass.
The current source and desktop checks, human feedback, installed-artifact checks
and four-host CI retain their passing scope. Remaining paired reads, source
changes, Windows Reader measurements, full shared-resource repetitions and
historical STATE-01 attribution retain their incomplete or failed statuses.

The manual MCP configuration was restored by exact-section replacement. Its
complete config SHA-256 returned to the original value, and CLI inspection
reports the manual entry enabled; plugin and unrelated settings are unchanged.
No further blocked measurements are running. The ordinary release pipeline and
post-publication package/asset checks remain required; publication outcome will
be recorded after those operations complete.

Final release preparation passes `npm run pre-push` (governance, Rust formatting
and compilation) and the serial root Node 22.15 test suite: 244 tests, 241 pass,
zero failures and three explicit skips. Fresh independent review finds no
actionable issue in the final release note, disposition, migration commands or
publication contract. The delta since `11ec33d` is documentation only; prior
production, installed-package and real-surface evidence is reused within its
unchanged source scope. The tag's own release workflow will bind rebuilt public
payloads to the final documentation commit.

Documentation commit `f554564e973e045774ad9b0a59b7bbd2539801a6` was pushed to
main. Its [Quality run](https://github.com/Guanzhw/AgentSession/actions/runs/38197248158)
passes on Node 22.15 and 26.5; its [native run](https://github.com/Guanzhw/AgentSession/actions/runs/38197248161)
passes on all four actual hosts. A subsequent release-page rendering check
shows GitHub leaves relative Markdown links unchanged, so the release note's
three documentation links are pinned to the `v3.0.0` source tag before tagging.
This final link/evidence delta changes no application, build or test inputs;
the publication workflow still validates the exact final tag commit.
