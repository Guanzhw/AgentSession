---
status: implemented
date: 2026-09-27
decision: Expose selected Codex stage1 memory rows as versioned context artifacts with on-demand bounded bodies.
---

# Codex recorded memory artifacts

## Context

Codex retains `raw_memory` and `rollout_summary` in `memories_1.sqlite`, keyed by canonical thread ID. The 2.0 provider exposes their recorded metadata and complete content independently of transcript discovery. A matching `memory_stage1` job can establish one recorded production result, but the job table is not a complete generation history.

## Decision

The Codex Rust adapter selects only `stage1_outputs.thread_id = ?` and its exact `jobs` key through a read-only SQLite connection. It publishes two stable hash and timestamp based artifacts plus an explicit source state in Session Protocol v2/v3 and a Reader artifact endpoint. Body access reselects that row in one SQLite read transaction, checks the metadata revision and artifact ID, and returns bounded UTF-16 pages. The direct artifact endpoint accepts a stored canonical thread even if its rollout transcript is absent; Library and Reader session discovery remain transcript based. The Reader shows recorded artifacts and fetches bodies only when opened.

## Alternatives considered

- Treat memory as transcript messages: the database row has its own identity and content revision, and a retained row may outlive the transcript.
- Infer all production steps from the current job: that mutable row only proves the exact matching completed stage1 result.

## Consequences

Selected body changes invalidate the artifact ID and revision; unrelated rows do not. Missing, unreadable, incompatible, and invalid stores produce explicit source states. The protocol retains the transcript revision for event navigation while carrying the separate memory source state and content identity. This slice does not reconstruct unrecorded production history, phase 2 consumption, or a full context lifecycle. SQLite read-only WAL access may update the `-shm` coordination sidecar without changing source records.

## Verification

The public Axum test first failed on the missing route, then covered metadata, v2/v3 protocol source state, content continuation, stale revision and ID, unrelated rows, a retained no-transcript row, invalid timestamp and schema, and Reader browser continuation. The selected current Codex row was read through the isolated Axum binary and compared with independent read-only SQLite hashes across 14 memory and 13 summary pages; DB, WAL and transcript hashes were unchanged within the run. Commands, hashes, and remaining scope are in the [delivery plan](../../../docs/design/agentsession-v3-delivery-plan.md).
