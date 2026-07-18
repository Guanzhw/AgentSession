# Changelog

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

### Compatibility and safety

- Provider-owned databases and transcript files remain read-only.
- Existing provider-specific session and statistics URLs remain valid.
- AgentSession-MCP retains exactly five bounded, read-only session-history
  tools: `session_search`, `session_get`, `session_timeline`,
  `session_get_context`, and `session_get_event`.

## 1.4.0

- Initial coordinated release of `@acetamido/agentsession` and
  `@acetamido/agentsession-mcp` under the AgentSession package names.
