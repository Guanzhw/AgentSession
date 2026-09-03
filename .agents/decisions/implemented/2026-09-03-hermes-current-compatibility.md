---
status: implemented
date: 2026-09-03
decision: Refresh Hermes state.db reading for active transcript flags and
recorded async delegation lifecycle while keeping compression metadata-only
and token ownership aggregate-only.
---

# Hermes Agent current state.db compatibility

## Context

The installed Hermes Agent predates the current upstream state schema. The
adapter needed a read-only evidence refresh for in-place compression and the
async delegation registry without projecting product behavior absent from the
local database.

## Evidence

- The official `hermes-agent` release `v2026.8.31` (Hermes Agent v0.21.0)
  has annotated tag object `6e8f8418e6378eb2617e4de074e13dedd091b8af`
  and peeled source commit `29112bef099274229cadff79cdff7bf7b99c4b77`.
- The separately checked official repository HEAD resolves to
  `7b72fd12476aedc06a993d92c4337e2ceb214bc7`. Release-tag and HEAD evidence
  are recorded separately; neither is the installed version.
- The installed executable/package is Hermes Agent `0.19.1`; its local source
  checkout is `840fb55a8aaeb69bfcd6f34a80e57f9a5bcd44ce`.
- The local `C:\Users\QQ110\AppData\Local\hermes\state.db` was opened
  read-only: schema version 23, 4 sessions, 21 active messages, 1 child
  session, 1 `async_delegations` row, 4 `session_model_usage` rows, and no
  compacted rows in the inspected snapshot. No memory/experience/user/team or
  handoff tables were present.
- Official current schema/source documents schema version 29, `active` and
  `compacted` message flags, and an `async_delegations` registry containing
  handle, origin/parent, state, timing, delivery, and task metadata. The live
  message reader uses `active=1`; search may intentionally include compacted
  history. Compression therefore remains context lineage, not transcript text
  to re-add to the active conversation.

## Decision

The Hermes store filters live messages by recorded `active=1`, with a bounded
legacy fallback that excludes `compacted=1` when `active` is unavailable. This
keeps compacted history out of `getMessages()`, message counts, the table of
contents, and linear views while preserving the source database unchanged.
Validated `parent_session_id` compression edges continue to produce
metadata-only `context.compaction` evidence and `compacted-into` relationships.

Rows in the recorded `async_delegations` table are normalized in the Hermes
protocol only when their handle and recognized lifecycle state are present.
They produce one recorded asynchronous Task and a metadata-only
`delegation.async` event; the task goal is bounded from `task_json`. If a
persisted delegate child also exists, it produces one separate unbound
subagent AgentRun with `taskId: null` and its recorded child session id.
Because the two tables have no exact correlation key, no handle-to-child
binding is claimed. Without async registry evidence, legacy delegate children
retain the derived Task/Run pair. Unknown states remain event-only. Existing
delegate-session completion requires a recorded `ended_at` value; an open row
is not marked completed.

Hermes exposes only session and `session_model_usage` aggregate token
components in the observed source. The adapter keeps those aggregates at the
session boundary, does not assign inherited/shared ownership, and does not
double-count a background child without a recorded ownership slice. Memory,
experience, user-info, team, continuing-interaction, and handoff mappings stay
unknown for this snapshot.

The checked-in fixture
`test/fixtures/hermes-current-v0210-synthetic.json` is source-derived,
bounded synthetic data based on the official v0.21.0 schema; it is explicitly
not a live transcript or a copy of local provider bodies.

## Alternatives considered

- Keep `SELECT * FROM messages` and rely on timestamps. Rejected because the
  official current reader uses `active=1`, while compacted history can remain
  searchable in the source database.
- Infer background child sessions or ownership from delegation goals and UI
  behavior. Rejected because the local registry records no child session id or
  request-level token slices for this snapshot.

## Consequences

Active transcript consumers remain linear and do not leak archived compacted
content into messages or ToC. Recorded async handles become inspectable
background work with bounded metadata; persisted children remain separately
inspectable without double-counting a second Task. Unsupported lifecycle and
ownership semantics remain unknown. Message/compression events retain source
row anchors; async events retain only table-local order because cross-table
source ordering is not recorded.

## Verification

- Focused provider/protocol run: 51/51 passed.
- Full `npm test`: 374/374 passed.
- `npm run review`, `npm run pre-push`, `npm run check:governance`, and
  `git diff --check` passed.
- Real read-only adapter smoke: 4 sessions, 21 messages, 1 Task, 1 AgentRun,
  22 events; the Hermes database mtime was unchanged. API smoke returned the
  actual async owner with 1 Task and 1 child AgentRun whose `taskId` is null.
- Official HEAD was rechecked immediately before handoff as
  `7b72fd12476aedc06a993d92c4337e2ceb214bc7`.
