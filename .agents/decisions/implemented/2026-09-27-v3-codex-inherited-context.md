---
status: implemented
date: 2026-09-27
decision: Read Codex copied parent context through a separately scoped inherited Reader API.
---

# Codex inherited context

## Context

A Codex child transcript can contain copied parent records before its own
recorded task boundary. Those records are useful background for a human
reader, but do not belong to the child's conversation, ToC, search or usage.
Native message IDs may repeat within that copied prefix and also occur in the
child's owned history. The old Codex parser also deduplicates hybrid legacy
`user_message` and recorded `user.text` copies of the same turn.

## Decision

The provider normalizes only the proven copied prefix into inherited items.
The owned Reader and protocol keep their existing boundary. A separate
`/api/v3/reader/codex/{session_id}/inherited-context` route returns bounded
pages with an explicit `inherited-context` scope, recorded parent reference,
source revision, and list ordinal. Its `/content` route requires that ordinal
together with message ID, segment, field, revision and bounded offset; the
ordinal selects the exact copied row when IDs repeat. Both routes are
read-only. List cursors bind child session, source scope, revision and page
size; changed source rejects a stale cursor.

## Alternatives considered

- Include copied records in the child-owned Reader: this would duplicate
  history and distort child navigation and counts.
- Address copied content by message ID alone: observed repeated IDs resolve
  ambiguously, including two rows within the inherited prefix.
- Reconstruct background from the parent source: that source may be absent;
  the child transcript itself records the copied prefix.

## Consequences

The interface can progressively reveal large inherited context without
altering owned Reader anchors. The optional parent reference explains its
origin, but does not imply that the parent transcript is locally available.
The copied prefix is parsed on request, so large-source latency and memory
remain part of final performance acceptance.

## Verification

`v3/test/inherited-context-slice.test.mjs` first failed with a missing 404
route, then passed with 51 inherited items in 40+11 pages, two distinct
inherited rows sharing one native ID, an owned row with that same ID, hybrid
legacy/recorded user deduplication, exact continuation of a 13,063-character
field, foreign/scope/limit cursor rejection and stale revision handling. The
two collision/dedup cases were added after independent review; the hybrid
case failed at 52 versus the fixed 2.0 oracle's 51 before repair. The
explicitly opted-in frozen child check passed with 7 inherited and 31 owned
items. Public and frozen source hashes were unchanged. Rust workspace tests
passed with 73 core and 2 app tests. Browser presentation and final resource
measurement are separate acceptance work.
