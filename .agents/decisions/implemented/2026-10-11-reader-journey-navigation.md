---
status: implemented
date: 2026-10-11
decision: Preserve normalized search targets and user investigation state across Reader navigation
---

## Context

The rc.4 desktop audit reproduced successful searches whose hit text remained
hidden, and technical-evidence navigation that discarded the prior view/filter.
Library metadata actions and source failures also lacked complete return paths.
The approved [spec](../../../docs/specs/reader-journey-repair-2026-10/requirements.md)
defines the user-visible repair.

## Decision

Core search exposes a target for normalized message-body hits: canonical event,
`body` field, original UTF-16 offset/length and the SHA-256 body content revision.
The UI reuses bounded Reader content reveal. A shared URL builder preserves the
target in ordinary links; the bootstrap transport forwards only its own strict
query fields, while content retrieval validates the body revision.

Runtime history holds a typed, session-scoped snapshot of lens, applied filters,
current page cursor, source revision, selected relationship node and scroll.
Restoration rereads bounded facts and preserves stale/revision failures. Failed
source navigation keeps a Conversation address; request generations prevent
cancelled work from overwriting the current view.

Library exposes each row's actual star state and uses the existing core star
filter for families and children. Star state participates in cursor revision.
Trash distinguishes unread, complete, partial and failed reads, provides retry,
and invalidates old reads after exclusion. Source setup links to a specific
Settings article describing the existing public startup configuration contract.

## Alternatives considered

Loading full long messages or searching only loaded DOM text cannot satisfy
bounded late-hit navigation. Filtering only loaded Library rows cannot preserve
family pagination semantics. Treating metadata read failures as empty results
does not establish whether recoverable rows exist.

## Consequences

Rust contracts, Svelte consumers and regression assertions must move together.
Navigation snapshots must retain existing source revision and cursor failures.
Provider data and the pre-existing Viewer service remain unchanged.

## Verification

The [tasks ledger](../../../docs/specs/reader-journey-repair-2026-10/tasks.md)
records UI/native builds, repository review, 244 Rust tests, 34 focused Node
checks and actual native API/MCP/desktop functional flows. The authorized
follow-through ran 35 browser/SSR checks and inspected saved screenshots,
repairing a source-anchor occlusion and a stale-language Trash summary.
Private-source skips retain their original scope. The initial independent
review closed its P2 findings. The post-validation independent review found a
Chinese dynamic-error visibility P2; known-message translation with raw
diagnostic preservation repaired it, and 25 affected search/Runtime checks
passed again. Source, logs and screenshots were independently rechecked with no
remaining actionable findings.
