---
status: implemented
date: 2026-09-03
decision: Add current-format OpenClaw per-agent SQLite (agent schema 19) as the
canonical session source, keep legacy/archive JSONL readable, and prefer the
SQLite representation exactly once per canonical session when both exist.
---

# OpenClaw current SQLite + legacy JSONL coexistence

## Context

The OpenClaw provider adapter was JSONL-only: it discovered
`agents/<agentId>/sessions/*.jsonl` plus the legacy `sessions.json` registry
and read branch-aware transcript JSONL. Official upstream moved sessions and
transcripts into the per-agent SQLite database at 2026.7.2-beta.1 (agent
schema 4), and the current release train is agent schema 19; `sessions/*.jsonl`
plus `sessions.json` are now legacy/archive artifacts (doctor-only migration
inputs; Gateway startup does not import them). The plan in
`docs/prompts/backend-evolution/04-provider-freshness-refresh.md` listed
OpenClaw current SQLite as the next provider-freshness stage.

## Evidence

Verified 2026-09-03 against the official upstream repository clone at
`/tmp/openclaw-repo`, and recorded in
`tmp/openclaw-evidence-summary.md`:

- Recorded HEAD `f92a12c5813fb880ed6a05c4a728fd5f4ccc5473` was verified present,
  and the newest main HEAD `2d9796d66c4358d7175761b581077fbd8fe16116` was also
  checked: the only change is package.json test-fixture metadata — the agent
  schema SQL is byte-identical (sha256
  `54fa65dc23576fcb20bc77f714d10598a7240ad28b7edd4fe4c39995dc96f61e`).
- Release tag `v2026.8.2` = `2e2aa1136152d8462f242270825cbfad63d9c6dc`
  (npm `latest` dist-tag = `2026.8.2`); package.json `schemaVersions` =
  `{ state: 15, agent: 19 }`; `OPENCLAW_AGENT_SCHEMA_VERSION = 19`.
- Official docs (`docs/reference/database-schemas.md`, HEAD): current session
  rows/transcripts live in `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`;
  `sessions/*.jsonl` are legacy/archive.
- Canonical session identity = `session_nodes.session_key` (e.g.
  `agent:main:main`); `session_nodes.current_session_id` points at the live
  `session_windows.session_id`; windows chain via `previous_session_id` +
  `reason` (`initial`/`reset`/`rollover`/`fork`/`rewind`/`switch`/`recovery`/
  `compaction`). "Reset boundaries start a fresh history window ... ordinary
  entry and session lists show only the live mapping."
- `transcript_events(session_id, seq, event_json, created_at)` stores exactly
  the legacy JSONL record shape (`{type:"session"|"message"|..., id, parentId,
  timestamp, message}`), so the existing OpenClaw record parser/presenter is
  reused unchanged. `session_transcript_active_events` + index state are a
  DERIVED projection (`needs_rebuild`), so the active path is recomputed from
  raw events (same `activeOpenClawRecords` walk).
- Parent/spawn recorded in `session_nodes.parent_session_key` /
  `spawned_by`; forks recorded as `fork_source_session_key/session_id/entry_id`.
- Deletion/archive: archived sessions keep rows (`archived_at`, `entry_valid`);
  deleted ones are removed from `session_nodes` (cold archive only).
- Local machine: installed binary is OpenClaw `2026.7.1-2 (0790d9f)` (pre-flip;
  its agent schema SQL contains no session tables) and there is no OpenClaw
  state directory on the WSL side; `%USERPROFILE%\.openclaw` on Windows was not
  reachable from this session (pi access guard). Real local data validation was
  therefore NOT possible; validation is fixture-based against the official
  schema (the full v19 `CREATE TABLE` SQL runs cleanly under node:sqlite).

## Decision

1. Add `src/providers/openclaw/sqlite-store.ts`: a read-only (`readOnly: true`)
   per-agent SQLite snapshot store for current-format sessions.
   - Agent DB location: `<openclawDir>/agents/<agentId>/agent/openclaw-agent.sqlite`
     (`openclawDir` already honors `OPENCLAW_STATE_DIR` / `--openclaw-dir`).
   - Accept agent schema 14..19 (the session_nodes/session_windows/
     transcript_events shape, verified 19); every higher version is diagnosed
     `unsupported` (never silently treated as empty); missing session tables
     (pre-flip memory-only stores) are diagnosed `legacy-only` and stay on
     JSONL; unreadable/corrupt stores are diagnosed `unreadable`.
   - One viewer session per `session_nodes` row, canonical id = `session_key`.
     Window generations are recorded lineage metadata (`metadata.windowLineage`,
     bounded 20), not separate sessions. Live transcript = current window's
     raw events, active path via the existing branch walk, bounded at
     `maxEventsPerSession` (tail kept; `metadata.truncated` when exceeded).
   - Legacy window/session ids resolve to their canonical session key in
     `getSession`/`getMessages` (recorded window id alias, never a new ID).
     Every recorded `session_windows` generation resolves that way — an old
     generation that deduplicates its legacy JSONL stays reachable by its
     window id exactly once. Aliases and coverage are scoped per agent
     whenever discovery supplies an `agentId`; a bare lookup collision
     between agents keeps a deterministic first-claim resolution (sorted
     agent order) and is surfaced via `getStorageDiagnostic().aliasAmbiguities`
     instead of silent last-write-wins.
   - Column selection is bounded: reads project only consumed columns
     intersected with the discovered schema (`consumed ∩ discovered`), so
     additive columns and the 14..18 shape ladder never break a read and
     nothing outside the consumed shape is fetched. Read-only open
     (`readOnly: true`) and the event tail cap/truncation evidence unchanged.
   - Schema-version gate and column-shape validation (required tables/columns)
     happen before any row read; a bad individual agent store never hides the
     other agents or legacy sessions.
2. Keep the legacy JSONL reader for every session not covered by SQLite, and
   deduplicate: a JSONL file is skipped exactly when its window/session id is a
   recorded SQLite window (any generation) or its registry `sessionKey` is a
   recorded `session_nodes.session_key` in the SAME agent — coverage is
   agent-scoped, so an identical id in another agent never hides its legacy
   sessions. SQLite wins, exactly once. Legacy-only sessions (never migrated,
   unavailable SQLite agent) stay fully readable.
3. Detection/diagnostics truthfully distinguish current SQLite, legacy-only
   JSONL, unavailable, unreadable, and unsupported schema/version states via
   `getStorageDiagnostic()`; `detect()`/`getUnavailableReason()` unchanged.
4. Protocol: current-format sessions use
   `buildOpenClawSqliteSessionProtocol` (same active-path event projection,
   sourceTypes `openclaw.sqlite.*`). Relationships are built only from the
   recorded field: `parent_session_key` yields a `parent` edge (child →
   parent), `spawned_by` yields a `spawned` edge (spawner → child); both edges
   are emitted when the two fields name different sessions, they deduplicate
   to a single `parent` edge when both name the same session (structural-
   parent precedence, matching `RawSession.parentId`), and neither is
   fabricated when absent. Forks use `fork_source_*`. Tree/family views use
   the documented structural-parent precedence (`parent_session_key` ||
   `spawned_by`). No native v3 domains were added: task and agent-run domains
   are `none` — both current SQLite and legacy builders always emit empty
   `tasks`/`agentRuns` arrays, and no verified mapping exists in the verified
   agent schema (only message-tool outcome receipts), so the existing v2→v3
   upgrade path remains the runtime boundary.
5. Resume stays `openclaw tui --local --session <sessionKey>`, canonical key.

## Alternatives considered

- Expose every `session_windows` row as its own viewer session. Rejected: the
  provider's own session lists show only the live session-key mapping, and old
  window generations are retained history, not separate conversations.
- Trust `session_transcript_active_events` as the message projection. Rejected:
  it is a derived index with `needs_rebuild`; raw `transcript_events` are
  canonical ("Raw transcript JSON stays canonical").
- Open SQLite read-write or run PRAGMA migrations to normalize versions.
  Rejected: provider data is strictly read-only (viewer invariants), and
  versions outside 14..19 are diagnosed instead.
- Remove the JSONL reader. Rejected: legacy-only installs (the locally
  installed 2026.7.1-2) and pre-flip archives remain readable.

## Consequences

- `scan()` yields SQLite sessions first, then uncovered legacy JSONL.
- Mixed installations surface exactly one representation per canonical session.
- Revision-aware caching: per-agent signature = stat of the main db + `-wal` +
  `-shm` (provider runs WAL) plus the agent directory itself, so adding or
  removing a legacy-only agent refreshes diagnostics; config-directory change
  forces re-discovery so tests/relocating state dirs never serve stale
  entries. There is no time-window refresh bookkeeping: every accessor
  re-checks the signature (cheap stat compares) and no cached result is older
  than the last filesystem check.
- Unsupported-future or unreadable stores are explicit diagnostics; JSONL
  fallback stays available, never hidden.
- Documented in README (zh/en), `docs/CONTRIBUTING-PROVIDER.md`, the evidence
  matrix, and the provider-freshness plan. Pi current v3/0.84.4 remains next.

## Verification

- New suite `test/openclaw-sqlite.test.mjs` (15 tests): official v19 schema
  fixture (upstream schema body plus an AgentSession provenance header; the
  upstream file sha256 is recorded there), canonical lookup + active path +
  tools + reasoning + usage, recorded
  lineage (parent/spawn/fork + window generations), SQLite+JSONL dedup and
  legacy-only fallback, legacy-only/unsupported/unreadable diagnostics,
  read-only guarantee (DB bytes unchanged; write probe fails read-only), and
  the bounded follow-ups: old-generation window id lookup plus JSONL dedup,
  parent-only/spawned-only/both-different relationship sourceTypes,
  cross-agent coverage collisions and deterministic ambiguous bare lookup with
  explicit diagnostics, cross-agent registry-key ambiguity (unresolved parent
  plus diagnostic), legacy-only agent add/remove diagnostic refresh, and
  bounded column projection (missing non-consumed columns tolerated, missing
  consumed columns diagnosed unsupported).
- Full `npm test`: 353 tests pass (338 existing + 15 new).
- `npm run review` (governance + typecheck) and `git diff --check` pass.
- Live local validation against real OpenClaw current-format data was NOT
  possible on this machine (no current-format install/state dir; recorded
  explicitly, not claimed as success).
