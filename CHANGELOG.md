# Changelog

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
