# AgentSession 2.0 provider scope and delivery plan

**Status:** implementation and real-surface verification in progress. The
five-provider decision record remains proposed until the final boundary checks
pass. Version 2.0.0 has not been released.

## Objective

Complete AgentSession 2.0 as a breaking five-provider release. Narrow both the
Viewer and MCP to OpenCode, Claude Code, Codex CLI, Pi, and DeepSeek Harness,
without retaining retired-provider compatibility or modifying provider-owned
records and Viewer metadata. Then make the two product lines correct
independently: complete and predictable cross-provider search; explicit
thinking-content access; bounded, useful excerpts that navigate to the source
message; and preserved query/result position on return. Accept MCP behavior
through real protocol calls and Viewer behavior through the live browser.
Measure search, cold startup, and long-session loading before deciding whether
Rust would improve a remaining bottleneck. Finish versioning, migration and
architecture documentation, quality gates, and reviewable release evidence.

## Support boundary

AgentSession 2.0 ships one consistent provider set across the Viewer and MCP:

| Provider ID | Provider |
|:---|:---|
| `opencode` | OpenCode |
| `claude-code` | Claude Code |
| `codex` | Codex CLI |
| `pi` | Pi |
| `deepseek-harness` | DeepSeek Harness |

OpenClaw and Hermes Agent are retired from both v2 products. The last published
v1 release was 1.10.1, which included those providers; that is historical release
information, not a 2.0 compatibility path. AgentSession 2.0 has no legacy
provider fallback or route aliases.

Provider-owned databases, transcripts, and event logs remain read-only.
Upgrading must not delete or migrate user-owned Viewer metadata or stored
retired-provider index rows. Startup may refresh derived index rows for the five
supported providers. Existing OpenClaw/Hermes URLs and MCP references are
incompatible with v2 and do not resolve there; retained retired-provider index
rows are not exposed as successful v2 results.

The v2 CLI and configuration expose only the five current providers. When
preparing a v2 configuration, remove retired-provider entries while preserving
all unrelated settings:

- remove `openclawDir` and `hermesDir`;
- remove `projectPaths.openclaw` and `projectPaths.hermes`;
- remove `resumeCommands.openclaw` and `resumeCommands.hermes`;
- remove retired-provider path variables such as `OPENCLAW_STATE_DIR`,
  `OPENCLAW_HOME`, and `HERMES_HOME` from the v2 launch environment.

Saving v2 settings writes the normalized five-provider configuration and drops
retired-provider path, project, and resume-command entries. In v2,
`--openclaw-dir` and `--hermes-dir` fail with a clear unsupported-provider
message. `--config <path>` and `AGENTSESSION_CONFIG` still select the v2
configuration file.

The MCP installer currently writes `@acetamido/agentsession-mcp@latest` as the
server launcher. The host resolves that tag when it starts the MCP process, so
existing launcher entries can advance to the current major automatically after
publication. Once the v2 MCP package is current, OpenClaw/Hermes provider
references no longer resolve. This release intentionally does not add a
compatibility layer for those references.

## Confirmed issues and items awaiting real-surface verification

These are current implementation findings and acceptance requirements, not
claims that the fixes have shipped.

| Area | Evidence state | Finding or required check |
|:---|:---|:---|
| MCP `session_search` | Implemented; real protocol acceptance passed, further loading work remains | The old 100-candidate ceiling is gone. File providers now stream one search pass. On the local 775-session Codex store, the original query took 61.3 seconds; after the change an all-provider call took 10.4 seconds of search after a 22.9-second cold MCP connection, and a separate Codex query took 20.3 seconds. These timings vary with file-cache state and do not establish a general latency guarantee. |
| Viewer provider-wide content search | Implemented; real browser paging and source navigation passed | The old 500-message candidate ceiling is covered by a 601-hit fixture. A live cross-provider search produced more than 30 results; the browser loaded a second page, opened its 36th result at the recorded Codex message, and returned to the same card and query. Provider-specific content pages use the same excerpt/source contract. |
| MCP thinking previews | Implemented; real protocol acceptance passed | Thinking stays out of ordinary search and session previews. A real Codex thinking event was rejected by default `session_get_event`, returned with `includeThinking: true`, omitted from default context, and present in opted-in context. Timeline thinking remains an explicit segment. |
| Cross-provider content and child-session meaning | Automated boundary coverage and live calls passed; lineage review remains | Viewer global `/sessions/search` searches only message content across selected providers, including non-archived OpenCode child sessions. Viewer exclusions apply; MCP separately searches all provider-stored sessions. Both use canonical `{ provider, sessionId }` identity. Real MCP search/get/timeline/context calls succeeded on all five providers, and a Codex cursor returned six distinct sessions across two pages. |
| Viewer search excerpts and source navigation | Real browser acceptance passed for a Codex later-page hit | A bounded excerpt links to a source-message anchor. The Reader preserves original source-message anchors when it groups fragments under a response; the detail back link returns to the exact result-card anchor on its page. Repeat across other available provider shapes before release handoff. |
| Long-session first load | Measured baseline; loading optimization remains | A real 2,686-message Codex page transferred about 23.47 MB and constructed about 179,601 DOM elements; browser DOM interactive took about 12 seconds. The large server-rendered document and DOM are an independent loading problem that a backend language change alone would not solve. |

On a later warm local run against the same isolated v2 server, separate HTTP
downloads and browser navigations gave the following samples. `DOM interactive`
is navigation timing, not a guaranteed time to readable content:

| Provider | Largest indexed local sample | HTML download | DOM elements | DOM interactive |
|:---|---:|---:|---:|---:|
| OpenCode | 278 messages | 1,076,697 bytes | 10,708 | 256 ms |
| DeepSeek Harness | 1,219 messages | 2,431,237 bytes | 21,583 | 665 ms |
| Codex | 2,686 messages | 23,498,218 bytes | 179,823 | 7,160 ms |

The largest local Claude Code and Pi samples have 8 and 2 indexed messages,
respectively, so they do not exercise long-session loading. The earlier Codex
browser load was about 12 seconds; cache state and machine load affect these
numbers. First-readable timing and incremental-history behavior remain to be
measured and improved before claiming the long-session acceptance complete.

## Verification snapshot — 2026-09-26

- `npm run ci:quality` passed with 1,055 tests. `npm run qa:e2e` passed against
  a real OpenCode v2 session on the isolated v2 server at port 3457, with no
  browser errors. Real browser content hits reached source-message anchors for
  all five providers; the global Codex search also loaded a second result page
  and returned to its exact result card.
- Local 2.0.0 Viewer and MCP tarballs were packed and installed in an isolated
  directory. The packed Viewer returned exactly the five provider IDs, five
  content hits with source references, and 404 for a retired-provider route.
  The packed MCP completed search/get/timeline/context calls on each real
  provider. Codex cursor pages returned six distinct sessions; thinking was
  readable only with explicit opt-in. Windows 2.0.0 SEA binaries built and
  passed the Viewer/static-asset/MCP smoke.
- Five sampled provider-owned source files retained identical lengths and
  SHA-256 hashes. The real Viewer `session_meta` row and token bucket/state
  tables retained their baseline row counts and hashes. Two derived tables,
  `session_index` and `token_stats_session_revision`, retained row counts but
  changed hashes; an MCP test transport had not inherited its intended
  isolated metadata path. The stdio test and binary smoke now pass that path
  explicitly. The hash-only baseline cannot identify the changed rows.
- The user's existing port-3456 process still serves the pre-v2 seven-provider
  build. The isolated port-3457 server and installed 2.0.0 artifacts were used
  for v2 acceptance; the normal listener has not been switched over. The
  packages are not published, and long-session incremental loading remains
  open.

## Delivery phases

### Phase 1 — Establish the five-provider boundary

Remove OpenClaw and Hermes Agent from the v2 Viewer registry, routes, search,
indexing, settings, and terminal resume surface, and remove them from the v2 MCP
registry and tool results. Keep explicit diagnostics for unavailable members of
the five-provider set. Preserve historical v1 evidence in documentation and
decision records.

**Acceptance:** `/api/providers`, settings, search, and installed-provider
diagnostics identify only the five target IDs; all five can be individually
selected by canonical ID. Old OpenClaw/Hermes Viewer URLs and MCP references do
not resolve in v2, and no v2 alias or compatibility fallback is added. The two
retired CLI flags fail with a clear message. Existing source data and user-owned
Viewer metadata remain unchanged; retired-provider index rows are retained.

### Phase 2A — Make MCP history operations complete and evidence-correct

Work this as an independent MCP line. Make search reach every qualifying
record. The current branch pages the metadata and message sources in 100-item
batches; verify that this removes the baseline silent candidate ceiling. Any
remaining limits must be explicit in the response and continuation state; a
cursor over an already truncated candidate set does not satisfy this
requirement.

Keep thinking out of previews and default timeline/search output. A caller must
opt in at the event-read boundary to receive thinking. Preserve tool input and
output opt-in and bounded continuation. Across the five providers, keep search
matches, session references, event references, timestamps, and child-session
summaries tied to the owning source evidence.

**Acceptance:** call the running MCP through an actual supported client or MCP
protocol client. Test more than 100 qualifying records and a late unique match
with deterministic fixtures, then use real local sessions from each available
provider to verify that paging, ranking, and source references retain those
semantics. State when a provider's available real data is too small to exercise
the 100-record boundary. Exercise
multi-provider results with the same query and verify canonical provider/session
and event references. Exercise recorded parent/child histories and confirm the
MCP returns the provider's established relationship summaries without
inventing or blending lineage. Read the session preview, context, and timeline
without opt-in; then read context and event with `includeThinking: true` and the
timeline with `segments: ["thinking"]`. Thinking must appear only in those
explicit reads. Record provider availability, call inputs, returned cursors,
and the exact session/evidence checked, with sensitive transcript text omitted
from the report.

### Phase 2B — Make Viewer content search useful and measure long sessions

Work this as a separate Viewer line. Remove the silent provider-wide 500-match
ceiling or expose a continuation that reaches later matches. Return a bounded
matching excerpt and a stable source anchor with each hit. The user must be able
to open the exact message/content block from a result and return to the same
query and result position.

Measure first-load behavior on real, representative long sessions from the five
providers. Use the browser and live server, not fixture-only or source-only
claims. Record time to first readable content, page-ready time, response and
content volume, and what the user can do before the full session is loaded. Use
the measurements to identify a concrete bottleneck before tuning pagination,
search, parsing, or rendering.

**Acceptance:** prove access beyond the former 500-message candidate window
with deterministic fixtures, then verify excerpts and exact visible anchors
against real available provider content. Search across providers and
verify provider/session identity, child-history semantics, and query/back
position. Profile at least one long real session per available provider, state
which providers had no suitable local sample, and demonstrate that a user can
start reading and navigate while the remaining content is loaded or continued.
Keep timings, volumes, sample/session identifiers (redacted where needed), and
browser observations with the release evidence.

### Phase 3 — Integrate both lines and clear the 2.0.0 release gates

Run the full five-provider acceptance set against the assembled Viewer and MCP
packages. Confirm that both interfaces expose the same provider boundary while
retaining their separate user and machine-oriented behavior. Recheck localized
support claims, retired CLI/config migration guidance, links, and package
versioning. Do not describe a package as released until the published artifact
and installation have been checked.

**Acceptance:** build and repository governance pass; the required project test
and E2E checks pass for the final implementation. Restart the built Viewer and
check its real API and browser surface. Install or run the packed Viewer and MCP
artifacts at the release versions and make real Viewer and MCP calls. Confirm
all five providers are correctly identified, retired-provider paths are absent,
and the two search-ceiling regressions, thinking opt-in, excerpts/source
navigation, child history, and long-session first-load acceptance all pass.
Check before/after hashes or equivalent read-only evidence for provider source
stores and user-owned Viewer metadata; inventory retained retired-provider index
rows separately from supported-provider rows that startup may refresh. Confirm
no automatic deletion or migration. Inspect the saved `@latest` MCP
launcher to confirm that it resolves the current release at process start.
Confirm that old provider references fail clearly under v2. Preserve CI,
package install, browser, MCP-call, and data-preservation evidence with the
release.

## Rust follow-up gate

The current evidence does not justify a Rust backend rewrite for 2.0. MCP
search latency fell substantially when repeated prefix scans were replaced by
one streaming pass, without changing languages. Its remaining cold cost is
dominated by Codex file-index initialization and transcript resolution. The
long Reader page's 23.47 MB response and roughly 180,000 DOM nodes point to a
browser rendering and incremental-loading problem; Rust would not shrink that
DOM by itself. Continue with targeted Node indexing/cache work and Reader
pagination while preserving full history and navigation. Profile the necessary
single-pass parse and measure memory before reconsidering a narrow native
parser or index worker. A later Rust decision record must show the workload,
baseline, measured improvement, cross-platform packaging and maintenance
cost, and data-compatibility implications.

The next Viewer loading experiment is lazy conversation segments: keep the
global message/compaction placement and TOC projection, send the first segment
batch, and fetch later rendered segments when the reader or a source anchor
needs them. Preserve the existing source-anchor and child-history behavior.
This would reduce transfer and DOM construction first; it would not by itself
remove full server-side parsing. Measure those costs independently before
considering a native worker.

## Review links

- [Proposed five-provider decision](../../.agents/decisions/proposed/2026-09-26-five-provider-v2-scope.md)
- [Runtime presentation contract](runtime-presentation-contract.md)
- [Runtime delivery plan](runtime-delivery-plan.md)
- [Provider contribution guide](../CONTRIBUTING-PROVIDER.md)
