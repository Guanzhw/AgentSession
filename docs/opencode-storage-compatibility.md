# OpenCode storage compatibility

AgentSession selects the OpenCode reader from the configured database schema,
not the version of an installed CLI. Provider databases are always read-only.

| Storage | Reader | Support |
| --- | --- | --- |
| `session`, `message`, `part` | Existing v1 reader | Existing behavior retained |
| `session_v2`, `session_message` | v2 reader | Upstream v2.0.10 source contract and local OpenCode v2.0.16 data checked |
| Missing, incomplete, unreadable | None | Diagnostic; other providers can still start |

When both generations exist, the v2 schema takes precedence. An incomplete v2
schema is diagnosed, not silently replaced with potentially stale v1 data.
The database path remains configurable with `--opencode-db`, `AGENTSESSION_DB_PATH`
and the existing JSON configuration. No source migration or manual table creation
is required.

## v2 support

- Session lists and live Library identities retain canonical IDs and parent IDs.
- Messages are ordered by `seq`; the separate `id` and `type` columns override
  neither payload identity nor ordering through JSON guesses.
- User text, assistant text, reasoning and tools are readable. Content fragments
  stay within their producing assistant message. Tool running/error state and
  structured result metadata are retained. File attachments remain metadata.
- Compaction records retain their recorded summary/status; original history
  before compaction remains available. System, shell and control records remain
  visible instead of being silently discarded.
- Parent and fork source relationships are projected separately. v2.0.10 copies
  settled history into forks with `msg_<fork-event>_<source-seq>` IDs and resets
  session usage. Copied records are disclosed as paginated inherited context,
  and excluded from owned messages, search, exports,
  protocol events and daily usage. Nested copied prefixes follow the same rule.
- Child sessions with a recorded `parent_id` appear in the Reader. A child is
  attached to a parent subagent tool only when that tool records the exact
  child ID in `state.metadata.sessionId` or a `task_id:` result line. Children
  without this binding remain separately accessible without guessing which
  tool launched them.
- Search, JSON/Markdown routes and the read-only MCP use the selected reader.
- Daily usage uses assistant/compaction records and mutually exclusive token
  components. The stats overview counts distinct sessions with usage in the
  selected period; indexed totals use the provider's session-level counters.
- Viewer-only management remains available; it never modifies OpenCode data.
- WAL changes participate in protocol/stat revision detection.

The first v2 reader deliberately does not reconstruct tasks/agent runs, replay
the event log, or treat pending/inbox entries as delivered conversation. It does
not claim v1 system-prompt reconstruction or native Session Protocol v3 domains.
These limits are exposed in storage diagnostics and protocol capabilities.
The existing protocol runtime supplies its documented v2-to-v3 projection.

## Evidence and verification

The reported database DDL came from a Windows OpenCode v2.0.10 installation.
Implementation was checked against the upstream tag, commit
`b8cedc1a7a5e2916bbb65dc1d4b620729c261638`:

- [Storage columns](https://github.com/anomalyco/opencode/blob/v2.0.10/packages/core/src/session/sql.ts)
- [Message payloads](https://github.com/anomalyco/opencode/blob/v2.0.10/packages/schema/src/session-message.ts)
- [Message reading and ordering](https://github.com/anomalyco/opencode/blob/v2.0.10/packages/core/src/session/store.ts)
- [Fork copies and usage reset](https://github.com/anomalyco/opencode/blob/v2.0.10/packages/core/src/session/projector.ts)
- [Token totals](https://github.com/anomalyco/opencode/blob/v2.0.10/packages/schema/src/token-usage.ts)

Automated coverage is in `test/opencode-v2.test.mjs`, alongside existing v1
scan/protocol tests. It covers schema selection, malformed/missing storage,
source hashes, sequence ordering, response boundaries, live tool status,
compaction, fork accounting, WAL revisions, and live HTTP startup/read/export.
The Windows test suite passed 1,080/1,080. Local OpenCode v2.0.16 data indexed
151 sessions. A real parent with 34 children showed 31 exact inline launcher
bindings and three detached child links; Reader preview, complete child history,
return navigation, usage, API, protocol and read-only MCP access were checked.
The source database SHA-256 remained unchanged after validation.
