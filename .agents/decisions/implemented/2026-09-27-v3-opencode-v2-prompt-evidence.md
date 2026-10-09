---
status: implemented
date: 2026-09-27
decision: OpenCode V2 prompt evidence separates persisted system rows from current local instruction candidates
---

# OpenCode V2 system prompt evidence

## Context

The Rust OpenCode adapter previously scanned `AGENTS.md` and `CLAUDE.md` and
reported configuration unresolved. The [V2 instructions guide](https://opencode.ai/v2/docs/instructions)
says V2 uses `AGENTS.md`, does not fall back to `CLAUDE.md`, and does not yet
inject `config.instructions`. The [agent guide](https://opencode.ai/v2/docs/agents)
describes `agents.*.system` and Markdown agent bodies; the
[config guide](https://opencode.ai/v2/docs/config) defines JSONC and global,
direct project, then `.opencode` precedence. Frozen V2 SQLite has an optional
`session_v2.agent` column and stored `session_message` rows of type `system`.
The instructions guide continues upward to HOME for workspaces within HOME and
stops at the project root for workspaces outside HOME. The agent guide limits
project `.opencode/agents` discovery to the project root, independently of the
global agents directory.

## Decision

The [OpenCode prompt resolver](../../../v3/crates/core/src/providers/opencode_prompt.rs)
marks only session-owned `system` rows as `recorded`, with the database path,
message ID, and full bounded text. It labels global and project `AGENTS.md`,
the stored selected agent's merged JSONC `system` value, or its Markdown body
as `current-local`. These local files are candidates, not historical-use proof.
An absent agent column or value remains unknown; current `default_agent` never
becomes the recorded selection. JSONC parsing reads only named prompt fields
and never returns the whole configuration. The resolver reports configured
`instructions` as inactive in V2 and omits `CLAUDE.md` from V2 discovery. It
searches project `AGENTS.md` files through HOME for workspaces contained there,
or through the project root for workspaces outside HOME. Selected Markdown
agents are searched only in project `.opencode/agents` locations through the
project root, with the global agents directory kept separate.

Each local file has a 1 MiB read limit; resolved `AGENTS.md` files share a
1 MiB aggregate budget. Recorded system rows have a 128-row, 1 MiB aggregate
response budget and explicit diagnostics when exceeded.
Conflicting JSON and JSONC files at one precedence level or conflicting
Markdown and JSONC agent definitions receive diagnostics rather than an
invented precedence claim.

## Alternatives considered

Treating current files or the current default agent as the historical system
prompt would turn mutable configuration into false session evidence. Reusing
the V1 `CLAUDE.md` fallback or resolving `config.instructions` would contradict
the V2 documentation. Returning the full merged config could expose unrelated
settings and credentials.

## Consequences

The Web API can display exact persisted V2 system text alongside clearly
separate current local sources. Hidden provider prompts and historic versions
of mutable files remain unavailable. A project root without a `.git` marker
limits project agent discovery to the recorded working directory and reports
that boundary; an in-HOME workspace still resolves ancestor `AGENTS.md` files
through HOME.

## Verification

- The [public V2 HTTP fixture](../../../v3/test/opencode-system-prompt-v2.test.mjs)
  first failed because `selectedAgent` was null, then passed 2/2 after the
  resolver was implemented. It covers stored system text, selected agents,
  JSONC precedence, Markdown bodies, `AGENTS.md`, an optional absent `agent`
  column, excluded V2 sources, and unchanged provider/config file hashes.
- A read-only frozen OpenCode V2 check matched one selected real session's
  persisted system row hash and agent ID through HTTP. Its DB, WAL, and SHM
  hashes were unchanged before and after.
- Follow-up regression coverage adds a malformed unrelated assistant row,
  HOME-contained and outside-HOME instruction scopes, project-root agent
  discovery, and a global agent fallback. Against the pre-fix binary, the
  public fixture failed because the prompt request returned HTTP 500 while
  parsing the unrelated row. Rebuilding to the isolated
  `v3/target-opencode-prompt-review` directory and running
  `node --test v3/test/opencode-system-prompt-v2.test.mjs` with
  `AGENTSESSION_V3_BIN` set to that binary passed 2/2.
- A read-only HTTP check against a live OpenCode V2 database returned 200 for
  a session with a stored selected agent and one recorded system item. SHA-256
  checks of the database, WAL, and SHM files matched before and after. That
  session had no current local agent source, so live data confirms the API path
  while the source-scope cases remain covered by the public fixture.
- `cargo test --manifest-path v3/Cargo.toml --workspace --locked --offline --target-dir v3/target-opencode-prompt-review` passed 102 core and 2 app tests with 12 private tests ignored. `npm run review` passed.
