# Changelog

## 1.5.1 - 2026-07-19

### Fixed

- Corrected the minimum supported Node.js version to 22.13.0, the first Node
  22 release where `node:sqlite` is available without an experimental flag.
- Added a tag-checked GitHub Actions release workflow that tests at the minimum
  supported Node version, verifies publish artifacts, and publishes both npm
  packages in dependency order with provenance.

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
