---
status: implemented
date: 2026-09-27
decision: Project recorded Codex compaction as a source-positioned Reader checkpoint with bounded content access.
---

# Codex compaction Reader checkpoint

## Context

Codex records `compacted` separately from ordinary messages. Some records carry a readable summary and retained history; the frozen Codex source has an empty summary, readable replacement messages, and encrypted compaction content. A Runtime event without a Reader reference could not open the recorded checkpoint in the conversation.

## Decision

The Codex adapter creates one `context` Reader item at each `compacted` record's physical source position. It labels recorded summary and readable replacement or guardian history, and explicitly marks absent readable or encrypted content. Adjacent `event_msg.context_compacted` is kept as raw Runtime evidence without a duplicate Reader checkpoint. The native Runtime compaction event carries the exact Reader reference. Shared Reader content pagination accepts the normalized `context` segment under the existing revision and UTF-16 bounds.

## Alternatives considered

- Put compaction text in Runtime event metadata: this would bypass bounded content continuation and mix source text with event identity.
- Treat retained history as a reconstructed context version: the source does not establish that every field is the full post-compaction state.

## Consequences

The Reader outline and source navigation include Codex context checkpoints in source order. Session message counts continue to count conversation messages. The current slice does not reconstruct context lifecycle, decrypt entries, or merge non-adjacent compaction pairs. Provider source files remain read-only.

## Verification

The public Codex fixture and Rust test cover source position, one checkpoint, readable summary/history, and encrypted-byte omission. Axum and browser tests cover bounded content continuation, Runtime to Reader anchor, and Back. The frozen private Codex source test checks three raw positions and unavailable summaries. Commands, hashes, and remaining acceptance scope are in the [delivery plan](../../../docs/design/agentsession-v3-delivery-plan.md).
