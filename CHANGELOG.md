# Changelog

## 1.9.0 - 2026-08-18

### Added

- First-class read-only DeepSeek Harness support: reads DSH v0 event-sourced
  logs under `$DSH_HOME` (or `~/.dsh`), including multi-frame Zstd and packed
  chunks, reasoning, tools, compaction, workflow/subagent topology, stored
  prompt snapshots, runtime inventory, analysis, and the full session protocol.
  The stock headless CLI has no stable default resume argument, so no terminal
  resume command is invented.
- A provider-neutral session protocol (`getSessionProtocol` +
  `protocolCapabilities`) for Codex CLI, Claude Code, Pi, Hermes Agent, and
  DeepSeek Harness: stably sequenced events, explicit session relationships
  (parent/spawned/forked/continued/compacted-into/scheduled-run-of), a
  separated Task/AgentRun model, metadata-first context artifacts, and
  recorded/derived provenance, with per-domain capability descriptors. The
  read-only protocol API `GET /api/:provider/session/:id/protocol` reports it
  and returns 404 for unknown providers, unknown sessions, or unsupported
  protocols.
- Topology-gated Execution view: rendered only for sessions with real
  child-session topology (attached or detached children), covering
  `Agent`/`task`/`subtask`/`spawn_agent`/`delegate_task` launchers and
  provider-marked custom agents, with branch summaries linking directly to
  their canonical conversation pages. Linear conversations no longer render
  the tab.

### Changed

- Refreshed OpenClaw and Hermes Agent provider icons with more recognizable
  marks, locked by a focused regression test.

### Fixed

- Session list cards now show bounded per-session statistics: message count,
  recorded token totals, observed duration, compaction count and last
  compaction time, child/background agent-run counts, active task/agent-run
  statuses, and context-artifact/memory counts, derived through the Session
  Protocol surface without provider-id branches and never fabricating token
  totals.
- Conversation rendering now uses safe GFM rendering and server-backed
  progressive content loading, with evidence-based Codex subagent lifecycle
  correlation and task timing.
- AgentSession MCP treats provider local storage as authoritative: every
  session still present in a registered provider's store stays reachable
  regardless of Viewer-only hidden, soft-deleted, or permanently excluded
  metadata, which now affects only Viewer lists.

## 1.8.3 - 2026-08-02

### Fixed

- Injected the release version into the standalone MCP executable while npm
  installs continue reading their package metadata, keeping protocol version
  reporting accurate without requiring an external file beside SEA binaries.

## 1.8.2 - 2026-08-02

### Fixed

- Read the MCP server version from its published package metadata so protocol
  clients receive the installed release version instead of a stale hard-coded
  value.

## 1.8.1 - 2026-08-02

### Fixed

- Made Flow detail inspectors content-sized and positioned within the visible
  Flow viewport near the selected node, with internal scrolling for long
  content and clearance below the fixed top bar.
- Canonicalized both sides of the analysis run-directory assertion so the
  macOS `/var` and `/private/var` aliases compare as the same location.

## 1.8.0 - 2026-08-02

### Added

- First-class OpenClaw and Hermes Agent providers with full session browsing,
  Token Explorer integration, structured Flow views, runtime-extension
  discovery, and resume commands.
- MCP interactive installer with provider-aware configuration and protocol
  updates for more reliable server setup.

### Changed

- Unified all eight providers under a single immutable registry with consistent
  capability declarations and renamed capability keys for clarity.
- Reclassified Copilot CLI as a legacy, read-only provider for historical
  sessions.
- Normalized provider lifecycle signals so availability, detection, and
  scanning states are truthfully reported across the dashboard and API.
- Dynamic resume command resolution now lets each provider report its native
  shell, token semantics, and runtime evidence without central overrides.
- Moved OpenCode SQLite reads behind the adapter boundary, keeping
  provider-owned access patterns strictly inside the OpenCode adapter.
- Modularized browser JavaScript into self-contained modules (i18n,
  settings-form, session-workbench, enhancements) alongside the main app
  bundle.

### Fixed

- Hermes compression segments are now treated as one logical session in the
  structured views: continuation messages merge into their base session and
  are no longer rendered as detached or ghost subagents, while per-segment
  browsing, messages, and exports stay individually available.

## 1.7.2 - 2026-07-22

### Fixed

- Kept Token Explorer trend tooltips inside the visible chart area at the
  right edge and on narrow screens, so hovering a bar no longer introduces an
  unexpected horizontal scrollbar.
- Restored normal document scrolling when opening a session Flow and suppressed
  the tab bar's accidental vertical scrollbar.

### Changed

- Flow nodes now open their message or child-session details in an in-place
  side inspector, with a direct route back to the source conversation.

## 1.7.1 - 2026-07-20

### Fixed

- Reconstructed file-backed provider detail transcripts into ReAct cards across
  Claude Code, Codex CLI, Gemini CLI, and Pi: tool-only continuations remain
  under the preceding assistant turn, while a new reasoning record never
  crosses an assistant boundary. Codex cumulative reasoning snapshots now
  collapse to their latest state instead of rendering repeated blocks.
- Preserved per-request token accounting after card merging by showing the
  aggregate only with an explicit request count and aggregate-aware tooltips.

### Changed

- Session-list filters now apply as soon as a filter changes; keyword search
  still waits for Enter or Apply, with the search field aligned beside Apply.

## 1.7.0 - 2026-07-19

### Added

- Added Pi as a first-class read-only provider with native JSONL tree parsing,
  active-branch reconstruction, named and forked session identity, reasoning
  and tool-result grouping, Token Explorer data, structured Flow views,
  runtime-extension discovery, resume commands, and AgentSession-MCP access.

### Changed

- Made default MCP search diagnostics report unavailable registered providers,
  added first/last visible-message previews to `session_get`, and returned
  reusable continuation arguments for paginated `session_get_event` content.

## 1.6.0 - 2026-07-19

### Added

- Added Node SEA single-file binaries for the AgentSession Viewer and the
  read-only AgentSession MCP server on Windows x64, Linux x64, Linux arm64, and
  macOS arm64.
- Added embedded Web assets and binary-native analysis helper/validator modes,
  so the Viewer binary does not depend on a Node.js installation or source
  checkout while preserving the proposal-only analysis pipeline.
- Added a four-platform release workflow that runs the full suite and binary
  smoke checks before publishing archives and `SHA256SUMS` to GitHub Releases.

### Changed

- Made the GitHub repository public and restored npm provenance for releases
  from the now-public source repository.

## 1.5.3 - 2026-07-19

### Fixed

- Published from the private GitHub source repository with the configured npm
  token, without requesting npm provenance that only supports public source
  repositories.

## 1.5.2 - 2026-07-19

### Fixed

- Made executable-name extraction independent of the host path syntax, so
  Windows launch diagnostics remain concise when exercised on Linux or WSL.
- Kept the MCP help smoke test strict about application stderr while allowing
  the expected Node 22 `node:sqlite` experimental warning to be suppressed.

## 1.5.1 - 2026-07-19

### Fixed

- Corrected the minimum supported Node.js version to 22.13.0, the first Node
  22 release where `node:sqlite` is available without an experimental flag.
- Added a tag-checked GitHub Actions release workflow that tests at the minimum
  supported Node version, verifies publish artifacts, and publishes both npm
  packages in dependency order.

## 1.5.0 - 2026-07-18

### Added

- Unified `/sessions` and `/stats` entry points across OpenCode, Claude Code,
  Codex CLI, and Gemini CLI, while preserving provider-owned canonical detail
  routes and capabilities.
- Provider filtering directly on the combined token trend, with contribution
  cards for in-place single-provider filtering and provider-specific detail
  navigation.
- Capability-driven, proposal-only session analysis for Codex CLI using
  Codex-owned session evidence and runtime extensions.

### Improved

- Equivalent Windows, slash-normalized Windows, and WSL project paths now
  merge into one cross-provider project filter.
- Session-detail tabs keep a stable desktop content track when the Conversation
  table of contents appears or disappears. The transition respects reduced
  motion preferences and retains the existing narrow-screen layout.
- Unified Usage prioritizes the total token trend and keeps provider filters,
  selected state, date range, and reset actions in one explorer.
- AgentSession-MCP search now supports whitespace-separated AND terms, exact
  normalized project-directory filtering, and cursor continuation over a
  time-bounded result snapshot.
- OpenCode MCP search events now round-trip through `session_get_event`, and
  `session_get` reports the normalized message count instead of a placeholder.

### Compatibility and safety

- Provider-owned databases and transcript files remain read-only.
- Existing provider-specific session and statistics URLs remain valid.
- AgentSession-MCP retains exactly five bounded, read-only session-history
  tools: `session_search`, `session_get`, `session_timeline`,
  `session_get_context`, and `session_get_event`.
- Normal MCP search excludes reasoning parts, and SQLite LIKE metacharacters
  are treated as literal query text.

## 1.4.0

- Initial coordinated release of `@acetamido/agentsession` and
  `@acetamido/agentsession-mcp` under the AgentSession package names.
