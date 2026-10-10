---
status: implemented
date: 2026-10-10
decision: Read an unanchored root Codex session from its native recorded current rollout while preserving unknown continuity with other same-ID files.
---

# Codex recorded current rollout

## Context

A real Codex Desktop root chat has two files with one canonical ID: an old
12-record file and an actively written roughly 737 MB file. Both lack a
`history_base`. The [multiple-source diagnostic](2026-09-29-v3-codex-multiple-source-diagnostic.md)
therefore made the chat unavailable, although Codex's native `state_5.sqlite`
uniquely records the active file in `threads.rollout_path`. Its native title
index independently records the chat's current name. Read-only SQLite queries
verified the primary-key schema, live WAL and Windows extended path spelling.

## Decision

The provider-private [resolver](../../../v3/crates/core/src/providers/codex_rollout_authority.rs)
uses `threads.rollout_path` from `state_5.sqlite` at the Codex root or its
`sqlite/` directory. It opens SQLite read-only and checks that the recorded
absolute path canonicalizes to a scanned file with the same primary header ID.
Conflicting databases, unreadable or unsupported schemas remain explicit errors.
Missing or mismatched authority retains the collision diagnostic. No database
version, filename or timestamp heuristic chooses a source.

The proved [direct history-base pair](2026-09-29-v3-codex-direct-history-base-source-set.md)
keeps precedence. Recorded selection covers unanchored roots only; declared
history bases and child ancestry retain the existing boundary. Reader, catalog,
search, prompts, protocol and statistics share this choice. Native title-index
handling then restores the title. Protocol diagnostics record selection and
`sourceHistory` remains unknown: this reads the current native rollout and
does not establish continuity or combine other files. Stats retains its
existing partial-coverage contract. Provider files and databases stay read-only.

Catalog identity hashes the selected transcript's complete bytes, authority database and
candidate paths. Reader identity includes selected bytes/path and authority
dependency; Stats revisions also include the selected native mapping. Mapping
changes invalidate cached projections and continuations without requiring a
transcript mutation. Publication rereads selection. Unrelated database row
updates do not churn a session's identity. Root inherited-context lookup checks
the header first, avoiding another full read and normalization of this long chat.

## Alternatives considered

Whole-file concatenation lacks an ordering/continuity witness. Choosing the
newest file recreates the earlier omission bug. Removing a duplicate destroys
provider history. Native recorded selection supplies a narrower supported read.

## Consequences

The affected root chat becomes readable under its canonical ID and native
title. Other unsupported collisions retain explicit unavailable diagnostics.
The old file stays preserved; completeness across that file remains unknown.

## Verification

The final Rust suite passed 223 core and five app tests, with 15 intentional
private-source ignores. Ten resolver/adapter tests cover native schema/path/identity
boundaries, conflicting locations, live WAL, stable unrelated updates, mapping
changes during normalization, and equal-size restored-mtime source rewrites. The new
[HTTP/stdio MCP regression](../../../v3/test/codex-recorded-rollout.test.mjs)
passed all three cases: native title and selected
history, mapping-switch cache and stale-continuation invalidation, unsupported
mapping diagnostics, direct-pair precedence, and unchanged source/database
hashes. Full `npm test` passed 700 Node cases with 46 explicit opt-in skips;
the final content-digest delta reused unaffected browser/helper checks and
reran the five affected transport suites (29 passed, four opt-in skips).
`npm run review`, the default `npm run build`, and `git diff --check` passed.

On the real default source, the final packaged binary
`44c14766f1542f51429fef2d539e9476bdfb9e4cd7deee75b797690eef0b674c`
restored the native title and a diagnostic-free catalog row. Reader bootstrap
returned 28,475 items with a bounded 32-item opening page; measured list and
Reader requests took 11.17 and 11.85 seconds for this actively appended roughly
737 MB source. Real native stdio MCP returned a three-event page and continuation
in 4.03 seconds. The original source files remain in place. These timings are
this session's local checks, not a general performance acceptance result.
The existing in-app browser also showed the restored Library row, then opened
the real Reader with its native title, user/assistant messages, collapsed work,
collaboration graph and contents navigation.
