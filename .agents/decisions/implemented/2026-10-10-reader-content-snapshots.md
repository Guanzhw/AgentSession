---
status: implemented
date: 2026-10-10
decision: Read displayed Reader fields by their normalized content fingerprint
---

## Context

On the actively appended Codex conversation, a successful bootstrap was followed
immediately by HTTP 409 for both toolInput and toolOutput. Each content request
rehashed the complete source, while the browser kept its bootstrap revision.
Retry used the same stale revision. The
[original Reader model](2026-09-27-v3-reader-read-model.md) requires a separate
freshness decision before omitting those live-source probes.

## Decision

Reader items include SHA-256 fingerprints of their complete normalized fields.
Content requests may supply `contentRevision` to read the exact displayed field.
The shared core reads the published, scope-isolated SQLite snapshot in one WAL
transaction, checking canonical provider/session/event/field and fingerprint
before paging. A cache miss tries the source-backed path with the same field
check. Whole-session revision checks remain strict for tokenless content,
pagination, search, collaboration, and MCP event retrieval.

## Alternatives considered

Refreshing bootstrap on every 409 still races with new writes and disturbs the
reading position. Ignoring revision could concatenate different versions of a
field. Keeping multiple complete transcript generations would duplicate large
content. The existing single-generation cache plus field fingerprint suffices.

## Consequences

Displayed content remains readable from its published snapshot after additions,
rewrites, or source removal until a newer publication replaces that field.
This is snapshot reading, not a claim of current source availability. Identical
fields survive new generations and ordinal shifts; changed fields reject old
fingerprints. UTF-16 pagination and source read-only ownership stay unchanged.
Search reveals retain their search revision. Fresh bootstrap can still fail
while its source changes during capture.

## Verification

The regression checks cover append between bootstrap and tool expansion,
unchanged fields across publication, changed-field rejection, content pagination,
scope isolation, and a held WAL reader during concurrent publication. The browser
checks open and continue both fields in the main Reader and inline child after
a task-owned source append.
Live verification uses the affected Codex conversation and its canonical tool
event; source mutation tests use task-owned fixtures only.

`npm run build`, `npm run review`, and the complete Rust workspace tests pass
(223 core, 5 app; 15 existing private-data tests ignored). Focused HTTP, strict
Reader/search/MCP, and desktop tests pass, including the main and inline-child
append regressions. One browser launch timeout passed on its isolated retry;
the private frozen MCP corpus case remains skipped. Actual in-app Input/Output
requests return 200; the original 11,990-unit output reconstructs in nine pages
with the matching full fingerprint. Fresh bootstrap still returned 409 during
this actively changing source, consistent with its separate freshness contract.
