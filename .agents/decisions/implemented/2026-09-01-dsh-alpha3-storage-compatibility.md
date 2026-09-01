---
status: implemented
date: 2026-09-01
decision: Track the newest official DSH release directly and normalize its physical JSONL provenance encoding at the provider boundary while preserving older readable logs.
---

# DSH alpha.3 storage compatibility

## Context

Official DSH `0.1.2-alpha.3` keeps session format version `0` but reduces
physical JSONL size by range-encoding `sourceEventSeqs`. It also extends the
required event vocabulary with model-selection, subagent policy, and DeepSeek
log-delivery observations. AgentSession previously accepted the new files but
left encoded ranges in normalized records and would reject sessions containing
the new required event types.

## Decision

The DSH adapter follows the newest official tag rather than treating npm
dist-tags as separate stability channels. It decodes physical sequence ranges
once while reading storage and exposes ordinary sequence arrays to all
same-process consumers. The provider allowlist accepts the new recorded
log-only event types without projecting them as conversation messages.

Existing version-0 JSONL layouts remain readable. Legacy SQLite schema 17
remains an explicit unsupported diagnostic for stores that still exist, while
compatibility documentation records that the tracked DSH version removed that
backend.

## Alternatives considered

- Leave encoded ranges untouched because current views do not consume them.
  Rejected because storage encoding belongs at the untrusted provider boundary,
  and future consumers should not need to understand physical JSONL packing.
- Treat unknown required events as ignorable. Rejected because DSH deliberately
  distinguishes required events from records that explicitly carry
  `ignorable: true`.
- Remove legacy SQLite detection. Rejected because existing provider-owned
  stores must remain visible as unsupported rather than disappearing.

## Consequences

Compatibility refreshes must compare the newest official tag, generated event
catalog, physical JSONL codec, and real written sessions. Range validation is
bounded by the owning event sequence, preventing malformed storage from
expanding without limit.

## Verification

- Focused parser tests cover valid and malformed range encodings and the new
  required event vocabulary.
- The checked-in derived alpha.3 fixture combines the current physical codec
  and required event shapes without claiming to be an upstream snapshot.
- Real `0.1.2-alpha.3` headless and subagent sessions validate adapter, API,
  token, lineage, and browser projections.
- Full test, governance, review, and provider-unavailable checks complete the
  handoff gate.
