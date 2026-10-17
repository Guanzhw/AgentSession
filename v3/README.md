# AgentSession 3.0 native runtime

This directory contains the sole AgentSession implementation in this workspace.
The repository root build and start commands use this native runtime. The [delivery plan](../docs/design/agentsession-v3-delivery-plan.md)
records its current stage, evidence, and remaining acceptance gates. The Rust
core reads OpenCode, Claude Code, Codex, Pi, and DeepSeek Harness sessions into
the Library and bounded Reader. A scope-isolated SQLite catalog publishes
search documents with the source summaries; the six existing read-only stdio
MCP tools and native team-message tool work with both tested client protocol
eras. The Viewer has content search,
single and cross-provider batch stars and deletion, titles, Trash, statistics
exports, and seven bounded Runtime views.
Historical Windows/Linux x64 candidate evidence covers actual Web, native MCP,
desktop Reader and offline npm installation. The local handoff report (`../tmp/v3-delivery/CURRENT-CANDIDATE-20261002.md`, local evidence)
identifies those exact binaries, fixed 2.0 comparison and measured tradeoffs.
The [workspace consolidation decision](../.agents/decisions/implemented/2026-10-09-sole-v3-workspace.md)
records the current default. The [3.0.0-rc.4 release notes](../docs/releases/3.0.0-rc.4.md)
describe the prerelease distribution and upgrade from public v1.10.1.
Remaining acceptance gates retain their recorded evidence scope.

The current source version is **3.0.1, a stable release candidate**.
The [3.0.1 notes](../docs/releases/3.0.1.md) describe the included repairs and
evidence boundaries; final integrated CI and public publication checks are pending.
The [stable-readiness ledger](../docs/specs/stable-readiness-2026-10/tasks.md)
owns its current validation and release decision. Stable publication uses npm
`latest` and a normal GitHub release; prerelease versions continue to use `next`.

Library **Manage** selects loaded, readable sessions across the five providers
by canonical ID. Rows with unavailable history remain visible but cannot enter
a batch. Manage can star, unstar, or move selected sessions to Viewer Trash;
delete asks for confirmation. `POST /api/sessions/batch` accepts
`{action,items:[{provider,id}]}` for these Viewer-only changes and reports
`{ok,affected,skipped}`. Provider transcripts are never changed.

## Reader journey changes (released in 3.0.0)

Library rows expose each node's own `starred` state. **Only starred** sends
`starredOnly=true` to both `/api/v3/library/sessions` and
`/api/v3/library/children`, combining with the existing provider, project, time
and sort filters. Matching children retain their contextual parents, whose
displayed star state remains their own. Stars are Viewer metadata.

Global message-content search adds a `target` containing the event, `field`,
`offset`, `matchLength` and `contentRevision`; title/directory hits retain ordinary
session navigation. Positions use original normalized UTF-16 units, including
Unicode case-fold expansions. The result link encodes the target in `#event?`,
so ordinary clicks and new-tab links open the same bounded Reader body window
and highlight the match. `contentRevision` binds the target to its normalized
field snapshot; replacing that field rejects its old fingerprint. Back restores
the submitted Library query, loaded results and selected result context.

The Reader's **Technical details** tab preserves its Runtime lens, applied Events
filters, current page and scroll position when following source links. Browser
Back restores the investigation; Forward returns to the source event. The
Sessions graph retains its selected related node across related-session
navigation. Restored pages keep the existing source-revision and cursor checks.

Trash reports complete, partial and failed metadata reads separately. Partial
reads preserve readable rows and show a lower-bound count (`N+`); failed or
unread listings show an unknown count (`—`). Only a complete successful read of
zero rows displays **Trash is empty**. Partial and failed reads offer **Retry
Trash**. Source issues link to the provider's focused Settings source section,
with the startup path and restart guidance described below.

These changes shipped in 3.0.0. The
[repair specification](../docs/specs/reader-journey-repair-2026-10/requirements.md)
defines scope; the [execution record](../docs/specs/reader-journey-repair-2026-10/tasks.md)
owns actual validation. Published rc.4 and existing acceptance gates retain
their recorded scope.

## HTTP contract migration

The 3.0.1 release candidate preserves invalid Reader execution
evidence as HTTP 422 `protocol_invalid`. Its error object additionally includes
`diagnostics` (existing `code` / `event_id` shape, at most 20 entries) and
`diagnosticsTruncated`. Readable conversation content remains available. Reader
schema 1/2 caches upgrade to schema 3; summary schema 16 and projection version 11
recapture older derived data on the next bootstrap; provider records and Viewer metadata are not migrated. See the
[Reader decision](../.agents/decisions/implemented/2026-10-17-reader-protocol-failure-persistence.md).

Known ambiguous DSH sessions now appear as diagnostic rows with unknown
counts, search partial coverage and excluded-source statistics. Direct reads
still reject ambiguous generations. All five adapters use the same indexed
publication path; see the [inventory decision](../.agents/decisions/implemented/2026-10-17-indexed-provider-diagnostics.md).

Native MCP keeps its existing error responses and writes tool, stage and safe
failure details to stderr. I/O and storage errors retain their local causes.
Parse diagnostics carry a static cause chosen at the source boundary; JSON
errors also retain parser-supplied line and column, with JSONL file offsets.
Provider structural errors use safe adapter categories when a precise position
is unavailable. Original provider error text can embed raw record fields and
is not logged. Blocking failures distinguish panic from cancellation without
logging their payload. Batch Viewer actions preflight
each source once and retain their existing transaction and partial-commit rules.

The Linux x64 native/release jobs require public browser regressions using
locked agent-browser 0.39.1. Optional local browser tooling has its own Node 24+ manifest and lockfile under
`v3/test/browser-tools`; root development still supports Node 22.15. Set
`AGENTSESSION_V3_AGENT_BROWSER_BIN` to the native browser executable and
`AGENTSESSION_V3_REQUIRE_BROWSER=1` to require browser prerequisites locally.
Linux x64 CI explicitly selects the installed Chrome executable, checks its
version and runs `v3/test/browser-smoke.mjs` before the suites. The smoke verifies
navigation and actual launch arguments. Fresh-mount navigation tests keep the
same launch arguments for every command in their session; ordinary sessions
retain the browser's default cache behavior.

AgentSession 3.0 publishes native Reader, pane-search, Protocol and Runtime JSON
under `/api/v3`. Recognized published 2.0 session endpoints return HTTP 410 with
`error.code: "http_contract_migrated"`, the canonical `session`, and
`migration.api`, `migration.page`, `migration.documentation` and
`migration.restartFromFreshRevision`. Replacement links encode each path segment;
old event IDs and cursors must be replaced by references from a fresh native
snapshot. Unknown endpoints retain HTTP 404.

Here `P` is `/api/:provider/session/:id`, `R` is
`/api/v3/reader/:provider/:id` and `T` is `/api/v3/runtime/:provider/:id`.

| Retired 2.0 GET | Native 3.0 replacement |
| --- | --- |
| `P/reader` | `R/bootstrap`, followed by `R/segments?cursor=` |
| `P/reader/coordination` | `R/relations?cursor=` and `T/coordination?kind=&limit=&cursor=` |
| `P/reader/event/:eventId` | `T/events`, then `T/events/:eventId?revision=` with a native event ID |
| `P/inherited-context` | `R/inherited-context?limit=&cursor=` and its `/content` endpoint |
| `P/context-result` | `T/context?kind=&limit=&cursor=` and the recorded Reader references |
| `P/search` | `R/search?q=&revision=&limit=&cursor=` |
| `P/protocol` | `/api/v3/protocol/:provider/:id?version=2|3` |
| `P/runtime/summary` | `T/summary` |
| `P/runtime/events` | `T/events?category=&kind=&executionOnly=&limit=&cursor=` |
| `P/runtime/graph` | `T/graph?maxNodes=` |
| `P/runtime/work` | `T/work?kind=&status=&limit=&cursor=` |
| `P/runtime/{execution,coordination,context}` | Same domain under `T`, with `kind`, `limit` and `cursor` |

Native Protocol versions 2 and 3 name the Rust fact-document schemas. Native v3
preserves its same-source native v2 facts; these integers do not promise the
old TypeScript envelope or field layout. Native event category/kind filters are
scalar exact matches. General event `phase`, `taskId`, `runId`, `correlationId`,
multi-value event selectors, recursive graph `depth`, and old `maxItems`
projection shapes have changed. The native Runtime query boundary rejects
unsupported parameter names. The graph returns observed topology with a
1–200 node bound; its query has no recursive depth selector. Work and the other
domains use typed pages with revision-bound continuation. Recorded task/run
bindings and provenance remain available in their owning facts where observed.

Pane search returns native source references and UTF-16 occurrence offsets.
It requires `q` and the current `revision`; the old `query` alias, result-count
envelope, part IDs and offset pagination are retired. Reader content uses
`messageId`, `segment`, `field`, `offset`, `maxChars` and `revision` to retrieve
bounded source text. Items also expose `contentRevisions`: an optional
`contentRevision` request reads that exact normalized field from its published
snapshot, so new records do not interrupt expansion or continuation. A newer
publication replacing the field rejects its old fingerprint. Matching cached
fields remain readable even if the live source disappears; this does not assert
current source availability. Requests without the fingerprint keep strict
whole-session revision checks. `R/locate` requires `messageId`, `segment` and `revision`.
TOC takes a continuation `cursor` and an optional `limit` from 64 through 512,
in multiples of 64 (default 64). Automatic full-outline hydration uses 512;
bootstrap and source-target lookup retain 64. Segments and relations take a
continuation `cursor` without a `limit` parameter. Navigation with a cursor or
explicit revision reads the opened,
published Reader generation. Source additions therefore do not interrupt
continuation or directory navigation. A fresh bootstrap checks current source
evidence and replaces the generation; references to a replaced generation
return `source_changed`. Search and Runtime/MCP retrieval retain their source
freshness checks.

The [Reader and MCP performance pass](../docs/design/performance-pass-20261011.md)
records bounded outline batching, projection checks, measurements and remaining
source-loading costs.

For an ordinary Codex JSONL source, bootstrap captures and verifies a bounded
prefix of complete records. Records appended after capture appear on the next
bootstrap. An unfinished final record is excluded; rewriting, truncating or
removing the captured prefix fails explicitly. This permits opening actively
written sessions without mixing records from different captures.

`R/executions?revision=&limit=&cursor=` pages the captured Reader generation's
normalized tool execution events (1–200 events per page). The Reader uses these
facts to associate recorded starts, background yields, polls and returned
results. The endpoint does not weaken the separate Runtime freshness contract.
Runtime and inherited-context panes use their own first response's revision
for continuation and evidence/content inspection.
Runtime conversation jumps supply that source revision to `R/locate` as
`sourceRevision`; the boundary verifies both current source evidence and the
opened Reader revision before returning a location. A source rewrite with the
same message ID therefore requires reopening, rather than jumping to old text.
Reader publication reuses unchanged normalized content chunks by field
fingerprint while replacing metadata and execution facts in one transaction.
Contents automatically collects its remaining pages and provides **Collapse
all** and **Expand all** for request/reply groups. Context checkpoints and later
agent/assistant replies stay in their request's group until the next request;
checkpoint anchors retain their own position and reveal the group when opened.
Compaction checkpoints use distinct cards with a short preview; the recorded
context opens on demand and retains bounded continuation. Tool ownership uses
indentation alongside the colored agent collaboration connections.
Tool calls default to compact rows with a recorded command or task summary,
agent model and reasoning level, and background/result phase where
available; input, output and recorded execution links remain inside their
disclosure. Codex `exec` headers decode literal commands from supported recorded
wrappers; arbitrary JavaScript remains in the full input.
Resume availability resolves current provider-owned directory metadata; ordinary
Codex headers avoid another full transcript parse while preserving canonical
identity and selected-source checks.

The public `/sessions/search?q=` and `/:provider/search?q=` pages open the
current content search, retaining the query and source scope across refresh
and Reader Back. Global search accepts repeated/comma-separated `provider`
values; a provider page uses its path's provider. Native continuation submits
the same scope as a comma-separated `provider` value. A valid nonzero old HTML
offset displays an explicit first-result/Load more notice; invalid old offsets
require a new submission. This major-version pagination change does not
translate legacy offsets into native cursors.

Legacy list JSON, settings, Viewer management, prompt evidence and resume have
their separately documented contracts. The
[versioned HTTP decision](../.agents/decisions/implemented/2026-10-01-v3-versioned-http-contract.md)
records the recommendation used after the user's unanswered feature question.

## Legacy list route migration

The 3.0 candidate keeps the four list paths documented by 2.0 as JSON-only
migration adapters. Historical 2.0 HTML fragment behavior does not describe
these native responses. The Svelte Web
client uses the versioned `/api/v3/library` routes.

Successful `GET /api/sessions` and `GET /api/:provider/sessions` requests return
`{sessions,total,offset,hasMore}`. Flat rows retain `href` and their list
statistics and omit the old `html` field; content search may add `searchMatch`.
An unavailable provider on the provider-scoped route returns a JSON diagnostic.
When a selected source has
partial coverage, these responses add `diagnostics` using the content-search
shape `{provider,status,sourceDiagnostics}`; source details contain diagnostic
codes and affected-session or affected-source counts, not source paths. Affected
flat rows expose `diagnostic`, and their message, token, duration, and protocol
statistics remain unknown when history is unavailable.

`GET /api/library/sessions` returns
`{sessions,total,offset,hasMore,matchingSessions}`. Each family row contains
`id`, `provider`, `title`, `directory`, `time_created`, `time_updated`,
`parent`, `href`, `matched`, `matchingCount`, `childCount`,
`totalChildCount`, `familyRootId`, `familyUpdated`, and `parentBoundary`.
`GET /api/library/children?parentProvider=&parentId=&offset=` returns
`{children,total,offset,shown,nextOffset}` with at most 20 children per page.
Partial source coverage adds the same bounded top-level `diagnostics`; affected
family and child rows expose `diagnostic`. The existing filters, sorting, and
offset paging remain available.

The Reader's **Find in session** searches complete owned content, including
late messages, reasoning, and tool input/output. Each inline child has its own
**Find in child** control and source scope. Results page by literal,
case-insensitive occurrence and open the exact event and content offset;
Library and MCP search retain their separate multi-term semantics.

The Reader's **Technical details** tab loads Runtime Summary, Events, Work, Sessions graph,
Execution, Coordination, and Context on demand. The HTTP API exposes validated
summary, bounded graph, and paged execution, coordination, and context projections at
`/api/v3/runtime/{provider}/{session_id}/{summary,graph,execution,coordination,context}`.
Their partial coverage and unresolved related sessions remain explicit. Each
view reports source coverage and provenance; full cross-provider visual
acceptance remains open.
`GET /api/v3/runtime/{provider}/{session_id}/events` accepts exact
category and kind filters; `/work` accepts exact kind and status filters. Both
return bounded pages with revision-bound continuation cursors. Work shows native
assignments and Codex turn lifecycles, including pairing, status, times, and
links to exact source-event evidence. A conversation jump appears only for an
event with a Reader reference at the same source revision. The Work slice
includes Codex native observations and recorded DeepSeek Harness team tasks;
other work domains remain explicitly incomplete.
`GET /api/v3/protocol/{provider}/{session_id}?version=2` exposes a validated,
partial Session Protocol v2 foundation for the five supported providers;
`version=3` preserves those same-source facts and reports actual domain
coverage. Full v2/v3 parity remains open.

For unanchored root Codex chats with multiple same-ID files, the adapter can
read the current rollout recorded by native `state_5.sqlite` when its path and
header match the scanned sources. Explicit history-base pairs retain precedence;
unsupported mappings remain unavailable. Other files stay preserved, and their
continuity with the current rollout remains unknown in protocol coverage.

Codex Reader lists recorded `raw_memory` and `rollout_summary` artifacts when
`memories_1.sqlite` contains the selected canonical thread row. The artifact
metadata and source state are available at
`GET /api/v3/reader/codex/{session_id}/artifacts` and in the Session Protocol
document. Open an artifact in the Reader to fetch its body; the
`/artifacts/{artifact_id}/content` endpoint requires `revision`, `offset`, and
`maxChars` (1–8192 UTF-16 units) and returns `nextOffset` for continuation.
A stored memory row remains directly readable by canonical thread ID after its
transcript is unavailable. Production evidence appears only when the recorded
stage1 job matches that row's input and completion times.

The Settings page at `/settings` and `GET /api/settings` show the effective
source paths, Viewer state paths, port, and selected configuration file for the
running process. The page also edits `projectPaths`, `resumeCommands`,
`resumeShell`, and `tokenPricing` as JSON. `POST /api/settings` accepts these top-level fields, requires
same-origin loopback JSON, and replaces each supplied field in the selected
configuration file. The forms send only edited fields, so another open Settings
page can edit a different field without reverting the first change. The server
validates the complete merged file using the startup schema, preserves other file
fields, atomically saves before applying the update, and returns the same snapshot
as GET. New Reader capability
checks and terminal launches use the update immediately; reopening a Reader
refreshes its preview. `resumeShell: null` uses the default shell, and an empty
`resumeCommands` object restores provider defaults. Invalid updates and failed
saves leave the running configuration unchanged.

In the unreleased workspace, source diagnostics open
`/settings#source-{provider}` and focus the matching source section. Each section
shows the effective startup path, its public
configuration field, CLI option and environment variable:

| Provider anchor | JSON field | CLI option | Environment variable |
| --- | --- | --- | --- |
| `source-codex` | `codexDir` | `--codex-dir` | `AGENTSESSION_CODEX_DIR` |
| `source-opencode` | `dbPath` | `--opencode-db` | `AGENTSESSION_DB_PATH` |
| `source-claude-code` | `claudeDir` | `--claude-dir` | `AGENTSESSION_CLAUDE_DIR` |
| `source-pi` | `piDir` | `--pi-dir` | `AGENTSESSION_PI_DIR` |
| `source-deepseek-harness` | `dshDir` | `--dsh-dir` | `AGENTSESSION_DSH_DIR` |

Source paths use CLI values first, then environment variables, JSON fields and
provider defaults. The configuration file itself is selected by global
`--config`, then `AGENTSESSION_CONFIG`, then the platform default. To repair a
source, check that the displayed path exists and is readable, update the
applicable startup option or selected config field, and remove or update any
higher-priority override. Restart the Viewer, confirm the effective path in
Settings, then reopen Sessions with that provider selected to recheck it.

`serve --open` or `"open": true` opens the Viewer in the system's default
browser after the loopback listener is ready. Browser-launch failures are
reported on stderr while the Viewer continues serving. The launcher passes
the numeric loopback URL as an argument to the platform launcher.

Existing 2.0 configuration fields `lang`, `reindex`, and `allowTerminalLaunch`
remain in the selected file through unrelated Settings edits. Language follows
the browser's language preference; indexing remains incremental; terminal
permission follows process startup and `--disable-terminal-launch`.
`resumeShell: {}` uses the default shell. A saved resume command's
`"stdin": "prompt"` remains accepted and retained in the file, with the same
command behavior as 2.0, whose launcher did not consume that field.

`tokenPricing` maps recorded model-provider/model keys to your per-million rates:
`{"vendor/model":{"currency":"USD","inputPerMillion":2,"outputPerMillion":4}}`.
Rates are finite, non-negative numbers; `currency` is a three-letter code.
Optional rates are `reasoningPerMillion`, `cacheReadPerMillion`, and
`cacheWritePerMillion`; optional source metadata is `sourceLabel` (up to 200
characters), `sourceUrl` (absolute HTTP/HTTPS URL), and `asOf` (`YYYY-MM-DD`).
Saving pricing applies to new Stats requests immediately, across the five
providers. Select an exact recorded model-provider/model pair to see the cost
estimate and dimension breakdown. The provider key identifies the model vendor,
not the session storage provider. Missing vendor attribution prevents a pricing
match; missing token dimensions or rates are listed as omitted. With no priced
token evidence the estimate's `totalCost` is null. Existing source-coverage
diagnostics still qualify the estimate. The application includes no price catalog.

Source/state paths, port, and terminal-launch permission remain startup-owned;
Settings rejects writes to them. `--disable-terminal-launch` cannot be undone
by a saved resume override. `projectPaths` preserves mappings for the five active
providers; each project key must be nonempty and each value an absolute path.
The current adapters expose no recorded opaque project key for resolving these
mappings into a session directory or resume working directory.

The selected JSON file also accepts startup-only MCP limits:
`"mcp":{"searchLimit":20,"timelineLimit":50,"eventMaxChars":4000,"contextWindow":5}`.
Each field is an optional positive integer with a maximum of 100, 200, 20000,
and 20 respectively. The values set the default and maximum for search,
timeline, event content, and each side of context. Browse uses `searchLimit`
as its default page size, but an explicit browse limit can reach 100. Valid
requests above a tool's limit are capped; invalid numbers are rejected.
Changing these settings requires restarting the MCP process.

`session_get_event` includes a source `revision` in each result and in every
generated continuation argument. Reusing that continuation returns
`source_changed` if the provider session changed before the next page. A direct
request may omit `revision` to read the current source at a chosen `offset`;
cross-request source consistency is guaranteed only when the caller supplies
the result's `revision` on subsequent requests. Thinking, tool input, and tool
output continuations retain their required opt-in flags.

On Windows, the Reader's **Resume in terminal** button launches a PowerShell
terminal using the provider's default structured command (OpenCode, Claude Code,
Codex, and Pi). DeepSeek Harness has no source-supported default command; an
explicit `resumeCommands` override is required. `serve --disable-terminal-launch`
disables launching for that process. Both `/api/v3/resume/:provider/:sessionId`
and `/api/:provider/session/:sessionId/resume` provide a GET capability/command
preview and require same-origin JSON POST `{}` to launch. Commands are resolved
only for existing sessions and absolute existing working directories. Linux and
macOS report terminal launching unavailable.

Windows launch requires PowerShell 7.3 or newer (`pwsh.exe`). Provider defaults
for Claude Code, OpenCode, and Pi can resolve an npm `.cmd` installation to its
package's declared executable without running the shim. The recognized packages
are `@anthropic-ai/claude-code`, `@opencode/cli`, and
`@earendil-works/pi-coding-agent`; their matching `package.json` bin entry must
stay inside the package and name an existing `.exe` or `.js` file. JavaScript
entries run through the npm prefix's `node.exe`, or `node.exe` found on PATH,
with the absolute script path as the first argument. Unknown installations and
missing entries report a diagnostic in the GET preview.

An explicit `resumeCommands` override takes precedence and is used as written.
Custom `.cmd`/`.bat` commands remain unavailable because batch processing cannot
preserve arbitrary session arguments safely. Configure a direct executable or
`node.exe` with its JavaScript entry point for those overrides.

A startup override has the form below. `false` or `null` disables that provider;
`{sessionId}` and `{projectPath}` are substituted only in argument values. The
executable is literal. `cwd` overrides the session's recorded directory.

```json
{
  "resumeCommands": {
    "codex": {"executable": "codex", "args": ["resume", "{sessionId}"], "cwd": "D:\\WorkSpace"}
  },
  "resumeShell": {"executable": "pwsh.exe", "args": ["-NoExit", "-NoLogo"]}
}
```

A successful launch reports the newly started terminal process; it does not
assert that a provider's subsequent interactive resume completed.

Build the native release from the repository root:

```powershell
npm install
npm --prefix v3/ui ci
npm run build
```

Package that existing release executable into a new portable directory. The
package contains the binary, license, public Codex sample, standalone Web/MCP
instructions, and SHA-256 manifest. The Web and MCP binary needs neither Node nor
Cargo to run.
Choose an output path that does not already exist:

```powershell
node scripts/v3-package-portable.mjs `
  --release-bin v3/target/release/agentsession-v3.exe `
  --output-dir tmp/agentsession-v3-win32-x64-portable
$env:AGENTSESSION_V3_RELEASE_BIN = (Resolve-Path v3/target/release/agentsession-v3.exe).Path
node --test v3/test/standalone-release.test.mjs
```

The same packager accepts a Linux release executable when run on Linux. Build
the UI before the Rust release binary so the embedded frontend matches the
source under review. On Linux, set equivalent Rust path-prefix remapping for
the build home and source checkout. The packager rejects an executable that
still contains the current builder's home or checkout path. Each final binary
and package needs its own checksum and standalone verification after later
source changes.

For the local 3.0 npm Viewer/MCP install candidate, explicitly select the
Windows and Linux x64 portable bundle directories during preparation; see
[the npm candidate instructions](npm/README.md). The staged tarballs stay
under ignored `tmp/`; the workspace contains only native package templates.

Register the native stdio MCP with an installed host using the one-time Node
installer in `scripts/v3-install-mcp-host.mjs` (also included as
`install-mcp-host.mjs` in the portable bundle). Select exactly one of `codex`,
`claude-code`, or `opencode` per invocation. Pass the absolute native binary and
the host configuration file explicitly; `--server-config` selects an existing
AgentSession 3.0 JSON file containing the intended source and state paths. The
portable demo's empty `state/config.json` is only a starting point; write the
absolute `codexDir`, `dbPath`, `claudeDir`, `piDir`, `dshDir`, `metaDir`,
`indexDir`, and `cacheDir` paths you want the MCP host to read before
registering it. The installer rejects an incomplete `--server-config` so it
cannot silently read personal default roots. It pins those eight paths in the
registered command, so ambient provider environment variables cannot replace
them. For example:

```powershell
node scripts/v3-install-mcp-host.mjs `
  --target codex `
  --binary C:\absolute\path\to\agentsession-v3.exe `
  --host-config C:\absolute\path\to\codex\config.toml `
  --server-config C:\absolute\path\to\state\config.json
```

The installer adds a separate `agentsession-v3` entry, preserves unrelated host
settings, and leaves an identical entry untouched on repeat runs. If that entry
already has different settings, it reports a conflict; use `--replace` after
reviewing the selected file. The host launches the binary directly with `mcp`.
OpenCode CLI 2.0.16 reads named servers directly under `mcp`, for example
`mcp.agentsession-v3`, using its native `type: "local"` command array. The
installer preserves other direct `mcp` entries. If an earlier experimental
installer wrote the unsupported `mcp.servers` wrapper, the installer stops and
requires a manual correction before registration.
Node is needed for installation only, not for Web or MCP runtime. Keep the binary
and server configuration at their registered paths, or rerun the installer with
the new paths and `--replace`. Re-register after changing any source or state
path in the server configuration.

Native MCP exposes seven read-only tools. `session_team_messages` lists
provider-recorded queued team messages by canonical session and pages their
full content. Call `{"action":"list","session":{"provider":"deepseek-harness","sessionId":"..."}}`,
then call the returned `readArguments` object directly, or pass its `message`
reference and `revision` to `action:"read"`.
For long content, pass the returned `continuation` as the next arguments.
Queued mailbox records have their own source identity; the six existing
conversation tools retain their schemas and event semantics.

Run the public Codex and DeepSeek Harness fixtures on a separate loopback port.
These paths use task-owned state, separate from user metadata:

```powershell
New-Item -ItemType Directory -Force -Path tmp/v3-demo/meta,tmp/v3-demo/index,tmp/v3-demo/cache,tmp/v3-demo/claude,tmp/v3-demo/pi | Out-Null
.\v3\target\release\agentsession-v3.exe serve --port 3457 `
  --codex-dir v3/fixtures/codex `
  --opencode-db tmp/v3-demo/opencode.db `
  --claude-dir tmp/v3-demo/claude `
  --pi-dir tmp/v3-demo/pi `
  --dsh-dir v3/fixtures/deepseek-harness `
  --meta-dir tmp/v3-demo/meta `
  --index-dir tmp/v3-demo/index `
  --cache-dir tmp/v3-demo/cache
```

Open `http://127.0.0.1:3457/sessions`. The same executable runs `mcp` with
the same source/state flags instead of `serve --port 3457`. It writes protocol
messages to stdout and diagnostics to stderr. The release executable embeds
the built UI and has been tested from outside the checkout; it does not need
Node or Cargo at runtime on the validated Windows host.

The source and state flags in the demo make its isolation explicit. The CLI also
supports 3.0-specific defaults, `--config`, and environment variables; command
line values take priority over environment values, then JSON configuration,
then defaults. Provider-owned source files are opened read-only.

### Viewer metadata import

Import the old Viewer metadata **before the first star, title or Trash edit** in
the selected 3.0 source scope. Opening and reading the Viewer alone does not
create its metadata database; an edit does. An existing target is refused even
when it contains only one new edit.

1. Preserve the old configuration and a consistent SQLite **backup copy** of
   the old Viewer database. Stop its writers before making a filesystem copy;
   when a live database has committed WAL rows, use a SQLite backup that includes
   them rather than copying only the main `.db` file.
2. Prepare the intended 3.0 JSON configuration with absolute source paths and
   separate `metaDir`, `indexDir` and `cacheDir` paths. Use the same effective
   source paths for import, Viewer and MCP. CLI values override environment
   values, which override the file; source identity determines the metadata
   scope. Check any existing overrides before importing.
3. Run the migration command, then start the Viewer with that configuration.
   Verify the effective paths in Settings and an expected old title or star
   before making new edits. Point MCP at the same selected configuration.

For **published `3.0.0-rc.4`**, download and extract the matching standalone
bundle from the [release](https://github.com/Guanzhw/AgentSession/releases/tag/v3.0.0-rc.4).
Its native command provides migration; the rc.4 npm Viewer wrapper cannot route
`migrate-meta`. For example, from the extracted Windows bundle:

```powershell
.\agentsession-v3.exe migrate-meta --from C:\backups\old-meta-copy.db --config C:\AgentSession\config.json
.\agentsession-v3.exe serve --config C:\AgentSession\config.json
```

Linux/macOS use `./agentsession-v3` instead. The npm Viewer may also be used after
that import: `agentsession --config <the-same-config.json>`.

**Starting with 3.0.0**, the npm Viewer entrypoint supports the same migration:

```sh
agentsession migrate-meta --from /absolute/old-meta-copy.db --config /absolute/config.json
agentsession --config /absolute/config.json
```

Explicit `serve`, `mcp`, `migrate-meta` and `help` commands are forwarded to the
native CLI; invocations without a command default to `serve`. Global `--config` may also precede
the command. The separate `agentsession-mcp --config <file>` entrypoint retains
its stdio behavior. These corrected wrapper commands require 3.0.0 or newer;
rc.4 retains its original wrapper behavior.

The import prints the selected source scope and creates
`<metaDir>/scopes/<scope>/meta.db` only when that target does not exist. It copies
the complete SQLite database, including retired-provider rows and the v1 index,
without changing the input. Configuration and derived indexes require separate
3.0 setup.

If import reports **`target ... already exists`**, preserve the current 3.0
metadata root and configuration. Create another configuration with the same
source paths and a new `metaDir`, such as `C:/AgentSession/imported-legacy-meta`,
then import and inspect that copy. Both databases remain available under their
respective configurations. Import does not merge old and new edits; keep both
until you have selected which state to continue using. Removing the existing
target to force an import would discard its newer Viewer edits.

The prerelease validation also imports a real legacy database whose
`session_meta` schema matches public v1.10.1, with full-table content and schema
comparisons before and after read-only Web/MCP access and restart.
The former runtime is recoverable from Git revision
`50a32e7c5b3fdaa1d335771da80d6c919d4ab536`; its startup and rollback harnesses
are historical and are not part of this workspace.

The Statistics page is available at `/stats` or `/{provider}/stats` for each
of the five active providers. It defaults daily trends, Harness comparisons and
model shares to known token subtotals; the metric control switches all three to
requests. It also displays recorded request counts, unknown request totals,
UTC daily rows, and JSON/CSV downloads.
It also ranks recorded request model IDs by known token subtotal, with request
and unknown-total counts. Opening a UTC day lists sessions with matching
request, consumption or observation evidence under the current filters, with per-session counts and known
token subtotals. The daily drill keeps the report range and filters; JSON and
CSV downloads reflect the selected report filters.
The partial statistics endpoints are `/api/v3/stats/{provider}` and
`/api/v3/stats/{provider}/export.json` or `.csv`. JSON exports every active
source session, its message count, and a UTC daily series of validated
request usage and verified consumption. CSV exports the daily series, with one row per day in the
selected range and a `Requests` column. It also repeats the selected usage
scope and report/usage coverage on each row, with daily known-token subtotals
and unknown-request counts so blank totals remain interpretable. The default
range is the last 30 UTC days; `days=7`, `days=90`, and
`days=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` are supported. Sessions and
message counts describe the full active source inventory; request counts and
daily rows describe the selected usage range.
Missing request totals or token components remain `null` in JSON and blank
in CSV. `knownTokenCount` includes recorded request totals and separately
verified Codex cumulative consumption increments, and does not claim full
coverage. Consumption observations do not increase request counts.
Requests without a usable timestamp
are counted separately as `untimedRequestCount`; a dated export cannot
assign them to a day or include them in its recorded request total. Full usage
coverage is not asserted. OpenCode's root-session (`scope=root`) and recorded
`project_id` filters, plus working-directory and recorded request-model filters,
compose across JSON, CSV, and the Statistics page. Project ID is available only
when the OpenCode source schema records it; working directory is a separate
cross-provider facet. A model-filtered session row keeps its whole-session
message count while request and token counts use matching attributed usage.
Observation counts retain the other selected source and range filters.

Codex Session Protocol v3 separates `usageRecords` from `usageObservations`.
Only canonical usage with a response ID and explicit thread ownership enters
request counts. Each owned legacy `token_count` occurrence, and any canonical
row lacking request proof, retains its source position, last-usage vector, and
recorded cumulative vector as an unresolved observation. Runtime `execution`
pages expose these facts under `kind=unresolved-usage`. A recorded `NEW_TASK`
boundary excludes earlier child-file rows;
matching parent usage vectors do not erase later anonymous occurrences. A
canonical row whose explicit `thread_id` belongs to another session remains
in raw events and enters neither child usage collection. Stats JSON/CSV reports
observation counts and marks usage coverage partial. Legacy-only sources now
expose `consumptionTokens` on observations when a complete cumulative advance
matches the recorded last-usage vector. Repeated cumulative snapshots add no
tokens. Verified consumption contributes to known token subtotals, daily/model
buckets and Library/list `tokenCount`, while request counts stay unchanged.
Missing, inconsistent, synthetic context-size and ambiguous reset snapshots
retain unknown consumption. Mixed canonical/legacy sources retain canonical
request accounting until their mirror relationship can be established.
An unproved cumulative reset ends the known consumption epoch; later anonymous
records remain observations. Excluded parent history supplies the last baseline
without limiting a child's own epoch.
The [current decision](../.agents/decisions/implemented/2026-10-12-codex-recorded-token-consumption.md)
extends the [original request-identity decision](../.agents/decisions/implemented/2026-09-29-v3-codex-unresolved-usage-observations.md).
Current full-corpus request
verification and provider coverage are tracked separately in the acceptance
contract.
The historical Windows `ec320284` package merged requests that share
`modelID` but have different recorded `providerID` values. The fix was included
by Windows candidate `8a2a1d7d`: on the frozen OpenCode Statistics
report for 2026-05-01 through 2026-07-31, `deepseek-v4-flash` appears as 1,018
`deepseek` requests and 119 `opencode-go` requests. The preceding `53a55168`
package's real browser selected both buckets; each CSV's daily request count
matched its selected bucket and retained `modelProvider`. The `8a2a1d7d` package
retained the identical embedded UI asset fingerprint and reproduced the API
split. Its DeepSeek Harness v0 projection also retained 508 owned requests
and 102,197,093 recorded tokens from a frozen source in an isolated HTTP run.
At that historical checkpoint, five-provider known/missing semantics and
HTTP-06/CORE-14 were still open. Current status is tracked in the
[acceptance contract](../docs/design/agentsession-v3-acceptance-contract.md).
The `8a2a1d7d` Windows package passed 324/327 serial Node tests, with
three conditional cases skipped, and matched all 45 source-verified search
results over five rounds. The [delivery evidence](../docs/design/agentsession-v3-delivery-plan.md)
records the exact package hash, timings, and remaining acceptance work.

The historical `8a2a1d7d` candidate retained the `53a55168` UI fix for real Codex
Reader scroll restoration after reload/back. It waits for loading to finish
before restoring position and again after a UI tick; the earlier real-browser
run completed six reload/back cycles with saved `scroll=800` and
`window.scrollY=800`, without browser errors. Both packages embed the same UI
distribution fingerprint; the build produced 134 modules.

Codex all-scope statistics now reuse validated request usage through a derived
cache only after checking the selected source bytes; directory, project, and
root-scope filters and the other four providers keep their source-backed path.
On the frozen 3.4 GB Codex corpus, release binary `2d9f6d33` returned the same
complete JSON digest as the earlier uncached binary: the first request took
47.2 seconds, a repeated request 4.53 seconds, and the first request after a
process restart 4.58 seconds. The source content hashes were unchanged. The
[measurement record](../docs/design/agentsession-v3-delivery-plan.md) states
the uncontrolled filesystem-cache limit and remaining first-request cost.

The dedicated 2.0 session JSON/Markdown download has no identified 3.0 user
workflow. The Reader and MCP expose complete source-backed content for review
and retrieval; statistics JSON/CSV downloads remain available. In a local
comparison, the fixed 2.0 historical export URL returned HTTP 200; the 3.0
legacy URL returned 410 with `session_export_removed`, and the separate 3.0
new removed URL returned 404. The [product decision](../.agents/decisions/implemented/2026-09-27-v3-session-export-purpose.md)
records the scope and the conditions for revisiting it.

`/api/{provider}/session/{sessionId}/system-prompts` returns source-backed
prompt evidence. Recorded prompt text and currently resolvable local
instructions have separate provenance; current files do not prove historical
use. Hidden or unrecorded provider prompts remain explicitly unavailable.
OpenCode agent/config instruction resolution is still incomplete.

Focused verification from the repository root after building the debug binary:

```powershell
node --test --test-concurrency=1 v3/test/dsh-ui-integration.test.mjs v3/test/protocol-events-http.test.mjs v3/test/mcp-search-slice.test.mjs v3/test/meta-slice.test.mjs v3/test/meta-migration.test.mjs v3/test/export-slice.test.mjs v3/test/stats-slice.test.mjs
node --test --test-concurrency=4 v3/test/*.test.mjs
cargo test --workspace --manifest-path v3/Cargo.toml --locked --offline
npm run review
```

The controlled four-file concurrency is used for local integrated validation;
unbounded parallel tests previously caused browser and descendant-process
timeouts under load.

The standalone release test also requires the release binary. Browser tests
use agent-browser supplied by the test environment. The frozen real-source
corpus is private and ignored by Git; public tests do not depend on it.

## Private-source validation

The frozen Pi and Claude Code source checks are ignored in normal test runs.
To run them, select the corresponding private manifest explicitly. The manifest
and its referenced source files must be available as read-only frozen copies;
the checks verify the recorded snapshot hash, full event traversal and unchanged
source bytes. They report test outcomes without printing private transcript text.

From the repository root in PowerShell:

```powershell
$env:AGENTSESSION_V3_PI_PRIVATE_MANIFEST = 'D:\path\to\manifest.private.json'
cargo test --workspace --manifest-path v3/Cargo.toml --locked frozen_private_pi_events_cover_all_rows_without_source_mutation -- --ignored

$env:AGENTSESSION_V3_CLAUDE_PRIVATE_MANIFEST = 'D:\path\to\manifest.private.json'
cargo test --workspace --manifest-path v3/Cargo.toml --locked frozen_private_claude_native_stream_full_pagination -- --ignored
```

Each explicit run fails with a prerequisite message if its manifest variable is
missing. A successful public-fixture suite does not validate these private
sources.
