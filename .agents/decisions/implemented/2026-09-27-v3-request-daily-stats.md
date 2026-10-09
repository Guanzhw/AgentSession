---
status: implemented
date: 2026-09-27
decision: Daily statistics aggregate validated owned requests while unknown totals and incomplete coverage remain explicit
---

# Request-owned daily statistics

## Context

The first Rust statistics report exported complete active session counts but
left usage empty. Session summary token counters cannot establish which
request or UTC day owned a token, and child sessions can carry copied parent
usage. The five provider adapters now emit validated request usage records
with canonical session ownership.

## Decision

[Statistics](../../../v3/crates/core/src/stats.rs) aggregate each active
session's validated protocol request records once. The report keeps the full
canonical session inventory in JSON and groups timed requests by UTC day.
The Web route defaults to 30 UTC days and accepts 7, 90, or a bounded custom
date range. The daily CSV preserves the established composition and token
columns. Its `Requests` column counts provider request records, because one
provider request may span multiple source messages. It appends the selected
usage-range scope, report and usage coverage, and daily known-token subtotal
and unknown-request count. Missing totals or token components remain
null/blank; the known token sum only includes explicit consistent request
totals. Full token totals remain unknown, and coverage remains partial even
when request records exist. Untimed requests are reported separately and
cannot enter a dated daily export. Arithmetic overflow is an explicit
protocol diagnostic. The `scope=root` query filters normalized sessions with
a recorded parent before aggregating their owned requests; the OpenCode
Statistics page offers this filter and applies it to both downloads.
The `directory` query selects normalized, recorded working directories. The
`model` query selects the provider's recorded request model ID, within that
provider's route. OpenCode's `project` query selects its recorded `project_id`
through a read-only provider adapter hook; it remains distinct from working
directory. All three compose with date and root scope before request totals
are aggregated. JSON includes source-backed facet options, and CSV uses the
same selected daily requests with filter identity columns appended after the
existing coverage columns. When a model is selected, session rows contain
only sessions with a matching request in the selected date range. Their
`messageCount` remains the whole-session source count; request and token
fields use only selected requests. Usage coverage is `not-observed` when the
selected range has no requests.

## Alternatives considered

Summing session summary counters would assign derived or copied usage to a
request without source evidence. Filling absent cache fields or an
inconsistent total with zero would turn unknown values into invented totals.

## Consequences

JSON contains the selected active session list plus the selected daily usage
range. CSV contains every day in that range, including empty days whose token
values remain unknown. The OpenCode `project_id` facet is available when the
source schema records that column, including the explicit empty-project
selection. The later `2026-09-28-v3-opencode-model-provider-statistics.md`
decision restores the recorded OpenCode provider/model pair in 3.0 statistics.
Other Token Explorer ranking fields remain open for HTTP-06 and CORE-14. An all-source report
currently re-reads protocol observations per session; larger provider roots
still need performance evidence.

## Verification

- Public HTTP stats test was RED against the prior binary because request
  counts and daily rows were absent. The isolated Rust build made it GREEN,
  including child ownership, inconsistent total, archived exclusion, 30-day
  export, custom date range, and invalid date behavior.
- The frozen OpenCode snapshot returned 151 active sessions and 3,112
  user/assistant messages, matching independent read-only SQL counts; its
  DB/WAL hashes were unchanged. A second frozen test checked all five
  provider reports against selected same-source protocol request records and
  kept frozen source file hashes unchanged.
- The frozen five-provider HTTP probe returned successful reports for
  Codex, Claude Code, OpenCode, DeepSeek Harness, and Pi. These checks do not
  prove full request coverage or all 2.0 export fields.
- The final isolated debug binary SHA-256 was
  `85f8832feab09c07f56a9524edd0ed8959c072011b197a60683732eeca345be1`;
  the frozen manifest SHA-256 was
  `42aea7462be66121f0ba4b491847741f8294b8041470a77e3a5f824287b443f8`.
  `cargo test -p agentsession-core --locked --offline` passed 102 tests with
  12 source-gated tests ignored; `npm run review` passed.
- On 2026-09-28, a focused HTTP test for OpenCode `scope=root` first returned
  400 from the prior binary, then passed after the filter was added. On frozen
  OpenCode SQLite SHA-256 `c9df86b1ab86eace661e8d0e608b48df83aa87fdc9ec5448efa760cd5fbf3429`,
  JSON export matched the complete read-only SQL root ID set (78 sessions) and
  root message count (2,511); DB/WAL hashes were unchanged. The frozen manifest
  SHA-256 was `42aea7462be66121f0ba4b491847741f8294b8041470a77e3a5f824287b443f8`.
  `node --test v3/test/stats-slice.test.mjs` passed 8/8 with the private manifest
  selected; Rust core passed 113 with 13 private tests ignored, Vite UI build,
  `cargo fmt --check`, and `npm run review` passed. The rebuilt debug binary
  SHA-256 was `a0e9bcb662b437d701f299477305b6f3462689b2e6bf4665811bd35281480d4e`.
- On 2026-09-28, the CSV parity test first failed against the prior debug
  binary because its header omitted scope and coverage fields. After adding
  `Usage Range Scope`, `Coverage`, `Usage Coverage`, `Known Token Count`, and
  `Unknown Token Request Count` after the existing columns,
  `node --test v3/test/stats-slice.test.mjs` passed 6 tests; 3 private-manifest
  cases were skipped. The test compared JSON and CSV for `all` and `root` scope
  and covered a mixed day with 6 known tokens and 1 unknown request. Its inline
  fixture source SHA-256 is
  `6f452fe598fd53e3c98626332f5740d40812b58b22c4bd8d56c61a559efc7d93`; no
  private corpus was selected. On worktree HEAD
  `50a32e7c5b3fdaa1d335771da80d6c919d4ab536`, the rebuilt debug binary SHA-256
  was `ad070b7109e85fc532ef53a3e1e2ba1b359da75a8bdb805b36247c902e5815be`.
  `cargo build -p agentsession-v3 --bin agentsession-v3 --locked --offline`
  succeeded, `cargo test -p agentsession-core --locked --offline` passed 113
  tests with 13 private tests ignored, and `cargo fmt --check --all` passed.
  These checks cover the synthetic HTTP fixture; frozen-source and packaged
  release verification were not run for this additive CSV change.
- On 2026-09-28, the directory/model HTTP test was RED with 400 for the new
  query, then GREEN after filtering. Its inline OpenCode fixture covers two
  directories, two models, an unknown total, root scope, dates, JSON export,
  CSV, and per-session request counts. A dated selection with zero requests
  reports `not-observed`. The browser test selects both facets and checks the
  API and download URL. Independent read-only SQL on the frozen OpenCode
  snapshot selected 6 canonical root sessions and 71 assistant request rows;
  JSON IDs, request count, known subtotal, and unknown count matched, with
  DB/WAL hashes unchanged. The frozen Codex model selection matched a session's
  version 3 protocol usage records. The final private stats suite passed
  12/12 after the coverage change; the integrated UI embed is recorded in the
  delivery plan.
- A separate OpenCode `project_id` test was RED with 400, then GREEN against
  two project IDs sharing one working directory. It checks distinct canonical
  session/request selections under a model, date, and root scope, plus JSON
  and CSV exports and unsupported-provider behavior. A frozen read-only SQL
  comparison for the selected directory/model/project checked the same IDs,
  request count, known subtotal and unknown requests with DB/WAL bytes intact.
  The Project ID control uses source values; working directory remains a
  separate control for all providers.
- Independent review found that changing project or working directory cleared
  a previously selected model, a model-filtered report omitted untimed request
  diagnostics when no dated request matched, and filtered reports loaded
  unrelated sessions before applying their session-owned facets. Browser and
  Rust regressions failed on each behavior before the repair. The UI retains
  the model even if the newly selected project has no matching model option;
  the core counts selected untimed requests while keeping sessions without a
  dated match out of the result, and applies directory/project filters before
  protocol loading. The UI regression suite passed 23/23, and the Rust
  workspace passed 116 core and 2 app tests with 13 source-gated tests ignored.
