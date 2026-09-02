---
status: implemented
date: 2026-09-02
decision: Fix the Codex new-format user-message gap by emitting response_item user rows tagged `user.text`, render recorded goal descriptions in the Work Graph lens, and record the evidence-backed v3 audit outcome (turn lifecycle and world-state remain explicitly unmapped).
---

# Codex new-format user messages and v3 mapping audit

## Context

The native v3 mapping stage
([`2026-09-02-codex-native-v3-mapping.md`](2026-09-02-codex-native-v3-mapping.md))
landed with every v3 domain observed on
`01a0576a-98e2-7c31-a265-6d98d5fbff12` (Codex `0.151.0-alpha.7.2`), but the
session detail page shows no user messages for it (`assistant=336 / tool=1108 /
user=0` in the normalized API). Root cause: this Codex version stopped writing
`event_msg/user_message`; user turns are now `response_item` message
`role=user` rows, and `recordsToMessages` had no branch for that shape.

Real-data facts driving the fix (scan of the rollout file):

- 38 `response_item` user rows, tagged by
  `internal_chat_message_metadata_passthrough.content_item_kinds`:
  `user.text` 24 (real user turns), `goal.internal_context` 7,
  `environments.environment_context` 5, `agents_md.instructions` 1,
  mixed plugin/instructions/environment 1.
- 24 `event_msg/task_started` (one per turn attempt); 20 distinct turns
  carry one or more `user.text` rows (4 turns have two rows each), and 4
  goal-driven turns (goal-internal context rows, no `user.text`) have no
  real user text. 23 `task_complete`, 1 `turn_aborted` (`interrupted`).
- Aggregate across 228 rollout files: 146 files contain legacy
  `event_msg/user_message` (1,115 rows) and every file contains
  `response_item` user rows (1,665 total). In legacy files the
  `response_item` user rows carry **no passthrough** and their text is
  injected context (e.g. `<environment_context>`); real user text lives
  only in the legacy `event_msg` rows. One hybrid file is observed
  (`01a04191-f2d7-7243-8ce9-347971c663cc`, a session spanning a Codex
  version transition): the same turn is recorded BOTH as a `user.text`
  `response_item` row and as a legacy `event_msg/user_message` row with
  normalized-identical text. The parser therefore deduplicates by exact
  normalized content — the `response_item` row is kept (it carries the
  recorded kind and turn id) and the legacy duplicate is skipped; fuzzy
  similarity is never used.

## Decision

1. **Parser** (`src/providers/codex/parser.ts`): a `response_item`
   message/`role=user` row becomes a normalized user message only when its
   recorded passthrough `content_item_kinds` includes `user.text`. Rows
   tagged with injected-context kinds and rows without passthrough are
   never user messages. Hybrid files (a turn recorded in both shapes) emit
   once: the legacy `event_msg/user_message` row is skipped when its
   normalized text equals a recorded `user.text` row. Emitted rows carry
   `id = payload.id` (so protocol anchors resolve), `metadata.turnId`
   (recorded passthrough), and the same usage-target reset as legacy user
   rows (a `token_count` after an interrupted request belongs to the new
   user request). Provenance filtering (`inherited-parent-context`) is
   unchanged: copied parent rows are still excluded by the
   record-provenance boundary.
2. **Title**: session title falls back to the first recorded `user.text`
   row when no legacy `event_msg/user_message` exists (same 120-char
   truncation); child sessions keep `agentPath` precedence.
3. **Work Graph display** (`src/views/runtime-workbench.ts`): goal cards
   render the recorded `description` (the objective) through the
   entity-label chain; goals have `title: null` and previously degraded to
   the ref id. Task/actor/run labels are unaffected (they carry no
   description).
4. **Audit outcome — not mapped, explicitly (evidence and reason)**:
   - `event_msg/task_started|task_complete|turn_aborted` record the
     session's own turn attempts (`started_at`, `completed_at`,
     `duration_ms`, `time_to_first_token_ms`, `model_context_window`,
     `collaboration_mode_kind: "default"`, `last_agent_message`). They are
     **not** mapped to v3 Execution: `AgentRun.mode` is required and the
     only recorded mode kind `default` maps to no protocol `ExecutionMode`,
     so mapping would fabricate execution semantics. The recorded lifecycle
     remains first-class evidence for a future Execution/attempt stage.
   - `world_state` (34 records, 19 keys: `agents_md`, `skills`,
     `host_skills`, `orchestrator_skills`, `apps_instructions`,
     `managed_developer_instructions`, `plugins_instructions`,
     `environments`, ...) records full-text context snapshots. The
     protocol `ContextArtifact` contract is metadata-first (summary-only)
     and mapping would require synthesizing summaries, so it stays
     unmapped; raw text remains in the provider data and raw views.
   - `inter_agent_communication_metadata` (35 in this session): only
     `trigger_turn` observed — no additional typed coordination signal.
   - `event_msg/item_completed` (2,379): per-item completion events whose
     content duplicates `function_call_output`; v2 already consumes the
     output records.
   - `event_msg/token_count` carries no `turn_id` anchor, so usage records
     keep `turnId: null` (no invented anchors).
   - Context lineage is verified closed: the first `compacted` record's
     `previous_window_id` equals `session_meta.context_window.window_id`,
     so the initial context version is included (11 versions, no gap).
   - `thread_goal_updated` (14 updates, one thread goal): final status
     `active`; `tokensUsed`/`timeUsedSeconds` have no protocol Goal field
     and are not fabricated.

## Alternatives considered

- Emit every `response_item` user row and rely on fuzzy text dedup.
  Rejected: injected-context rows would surface as user messages, and
  fuzzy similarity is not recorded evidence. Exact normalized-content
  dedup for the observed hybrid shape is still adopted — it joins rows the
  provider itself recorded for the same turn.
- Emit rows when passthrough is absent (legacy shape). Rejected: legacy
  `response_item` user rows are all injected context in observed rollouts;
  requiring the recorded `user.text` kind keeps the boundary exact.
- Drop the `user.text` row and keep the legacy `event_msg` row in hybrid
  files. Rejected: the `response_item` row carries the recorded turn id and
  is the new-format canonical shape.
- Map turn lifecycle (`task_started`/`task_complete`/`turn_aborted`) into
  v3 Execution runs with `mode: foreground`. Rejected: the only recorded
  mode kind is `default`, which is no protocol `ExecutionMode`; mapping
  would fabricate mode semantics.
- Map `world_state` snapshots as instruction/skill context artifacts.
  Rejected: the artifact contract is metadata-first (summary-only), and
  reducing full-text snapshots to summaries would synthesize content.
- Show the goal objective by copying it into `goal.title`. Rejected:
  recorded semantics keep objective in `description`; the display fallback
  is a presentation concern in the shared view helper.

## Consequences

New-format Codex sessions recover their recorded user messages in the
conversation view, ToC, search, exports, message counts, and protocol
`message.user` events (with recorded `turnId` anchors); session titles for
new-format sessions come from the first real user prompt. Legacy sessions
are byte-for-byte unchanged (no double emission, same title precedence).
The v3 audit confirms the remaining Codex record vocabulary is either
already mapped, duplicates existing evidence, or requires protocol work
(attempt semantics, summary-bound artifacts) that stays documented.

## Verification

- New focused tests in `test/codex-provider.test.mjs`: user.text emission
  excludes injected/untagged rows, usage-target reset on the new row,
  hybrid-format turns emit exactly once (the real `01a04191` fixture:
  response_item `user.text` row + legacy `event_msg/user_message` row with
  identical text), untagged injection rows never suppress or duplicate the
  legacy row, and title fallback from the first `user.text` row.
- `npm run build`, `npm test`, `npm run review`, and `git diff --check`
  pass; governance accepts the updated decision records.
- Real-data checks: `01a0576a-98e2-7c31-a265-6d98d5fbff12` messages now
  include 24 user rows (all `user.text`), session title from the first
  prompt, `/runtime/*` projections still complete with zero diagnostics,
  and the Work Graph lens renders the recorded goal objective;
  `01a04191-f2d7-7243-8ce9-347971c663cc` (hybrid file) renders exactly one
  user message for the turn recorded in both shapes.
