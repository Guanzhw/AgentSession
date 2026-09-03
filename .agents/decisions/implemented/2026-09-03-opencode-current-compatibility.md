---
status: implemented
date: 2026-09-03
decision: Refresh the OpenCode SQLite protocol boundary for the current
1.18.27 source shape while retaining the message/part projection as the
read-only conversation source.
---

# OpenCode current compatibility

## Context

The installed OpenCode CLI is older than the newest npm release. The adapter
already reads the provider's projected `session`, `message`, and `part` tables,
but its Work Graph projection did not consume native todo rows, compaction or
subtask parts, or the current task tool's background/result state.

## Evidence

Verified 2026-09-03:

- `opencode --version` reports `1.17.11`; npm `opencode-ai` latest reports
  `1.18.27`.
- Official release tag `v1.18.27` is commit
  `4b7e19e315cca414121ba1d61523fef74bb3ae8b`. Separately checked official
  repository HEAD is `b578b7261fc9ec4917fe272df5cc4bd8a056cd5d`. Official
  install and product documentation is <https://opencode.ai/docs/>.
- Official `packages/core/src/session/sql.ts` retains `message`/`part`
  projections and defines `todo`; official schema defines `subtask` and
  `compaction` parts. The official task tool records child `sessionId`,
  `background`, `jobId`, and bounded `running`/`completed`/`error` result
  envelopes.
- `CompactionPart` source keys are `type`, `auto`, optional `overflow`, and
  optional `tail_start_id`; `SubtaskPart` keys are `type`, `prompt`,
  `description`, `agent`, optional `model { providerID, modelID }`, and
  optional `command`. The task tool source records `metadata` keys including
  `parentSessionId`, `sessionId`, optional `background`/`jobId`, plus the
  ToolPart envelope (`id`, `type`, `tool`, `callID`, `state`), where state has
  `title` and an output envelope with `task id` plus `state`. The checked-in
  `test/fixtures/opencode-current-v1.18.27-synthetic.jsonl` uses exactly
  these bounded source keys and is source-derived synthetic data, not a live
  capture.
- The local provider-owned SQLite database was opened read-only. Its bounded
  shape had 131 sessions (73 with `parent_id`), 182 todo rows, 2,968 messages,
  and 13,091 parts. `session_context_epoch` and `session_input` were empty;
  no background task result envelope appeared in the inspected tool parts.

## Decision

Keep the provider's `message`/`part` projection as the conversation boundary.
Attach todo rows to the OpenCode tree and expose them as recorded Work Graph
Tasks. Preserve native subtask and compaction parts as provider-owned task and
metadata-only context events. Parse the task result state before the generic
tool state fallback, and map recorded `background=true` to a background
AgentRun while retaining child session linkage. Do not create context
artifacts or token-origin attribution without populated source evidence. Since
todo rows have no independent source id, use a bounded fingerprint of stable
recorded fields for Task identity; only link a compaction tail when its message
anchor is present. A `subtask` part remains an independent recorded
`task.requested` event; without an official correlation key it is not bound to
a later task-tool part.

## Alternatives considered

- Reading event-sourced `session_message` as the primary transcript was
  rejected: the official release still uses the normalized `message`/`part`
  projection for session reads, and the local event rows do not contain the
  projected part payloads needed by this adapter.
- Treating every todo or task tool as completed was rejected because official
  task results explicitly distinguish running, completed, and error states.
- Treating the documented Todo status strings as a closed runtime enum was
  rejected because the official schema uses a descriptive string; unknown
  values are skipped rather than assigned a fabricated Task status.
- Inferring memory, context epochs, or inherited/shared token ownership from
  ordinary messages or token columns was rejected because neither the source
  schema nor the local snapshot records that evidence.

## Consequences

OpenCode Runtime Work now includes recorded todo Tasks, compaction/task-request
events, and background task execution mode. Todo content remains provider data
shown through the existing normalized protocol contract. The fingerprint is
collision-safe within one source snapshot, with source-order/position
tiebreakers for duplicate rows; OpenCode provides no upstream row id that can
guarantee identity across edits. Legacy databases without a `todo` table remain
readable with an empty todo projection. The current refresh remains bounded:
attempts, scheduling, mailbox/team coordination, memory artifacts, and
token-origin slices stay unknown.

## Verification

- Bounded synthetic regression covers todo status/identity, task-request
  linkage, compaction metadata/anchors, background task state, and background
  AgentRun mode; the final focused OpenCode/SQLite run passed 3/3 tests.
- Read-only local OpenCode adapter/protocol smoke loaded the current SQLite
  source; no provider-owned files were written.
- `npm run build:core`, focused OpenCode tests, and the real local API protocol
  smoke passed.
- `npm test` passed with 369/369 tests; `npm run review` passed governance and
  typecheck; `git diff --check` passed.
