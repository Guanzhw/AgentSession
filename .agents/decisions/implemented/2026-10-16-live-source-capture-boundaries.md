---
status: implemented
date: 2026-10-16
decision: Publish validated finite Codex JSONL prefixes and protect OpenCode revision sampling with SQLite lifecycle ownership and bounded resampling.
---

## Context

Issues #8 and #9 were reproduced with the `7c48a1e` native artifact. Legal
Codex append invalidated full-file capture or final inventory checks and
blocked healthy catalog rows. Normal SQLite commit/checkpoint/close-open
operations exposed zero-length SHM initialization and WAL truncation between
independent metadata and header reads, while SQL reads and integrity checks
succeeded. Legacy list statistics reported errors only to stderr.

## Decision

The provider boundary exposes an optional typed index observation/capture
batch. Codex constructs its inventory and finite capture receipts together;
shared index code invokes capture, reuse and final validation without
interpreting provider records or signature encodings. Other providers retain
their strict capture path.

For one selected plain JSONL, including a recorded-authority selection, the
batch fixes the complete-record boundary and validates its exact bytes,
identity, selected path, authority/membership, native title and child
dependencies before publication. The single-file signature and boundary use
the same opening metadata. Recorded authority also binds the opening content
hash. Pair/compressed sources keep their strict path. Cached rows retain
their opening observation semantics and publication receipts; persisted
signatures do not claim that a later appended suffix was indexed.

OpenCode keeps its read-only SQLite connection/transaction alive while
sampling revision evidence. A WAL that disappears or becomes shorter after
its metadata was observed invalidates that sample; at most three samples
are attempted. Exhaustion remains `SourceChanged`. Existing DB/WAL headers,
SHM commit headers and source/parse/I/O failures remain meaningful. This
does not turn the existing multi-connection Protocol bundle into a single
SQL snapshot.

Legacy per-session statistics expose availability and a diagnostic using the
existing API error mapping, with retryability for source changes. Protocol
fields stay unavailable rather than zero; summary fields keep their recorded
provenance. Existing stderr diagnostics remain observable. The desktop
Library's inexpensive families contract is retained; its independent
statistics page already has an error and retry path.

## Alternatives considered

Retrying the entire Codex publication still requires an idle writer interval.
Replacing only its parser leaves the post-capture and whole-inventory checks
blocking append. Transient unavailable rows could preserve healthy siblings
but would leave the active conversation unavailable. Prefix receipts match
the existing Reader boundary while retaining rewrite and authority checks.

Ignoring SHM, padding short reads or using a newly opened connection's local
`data_version` would weaken commit detection. A broader transaction-owned
Protocol rewrite is separate from repairing the demonstrated sampling race.

## Consequences

Prefix capture has a finite opening bound, permits suffix append, and rejects
changed prefix facts. Final verification performs real hashing work, including
reused plain sources in a changed batch; large-source desktop latency needs
runtime evidence. Provider records remain read-only. Failure/retry states and
conditional validation gaps remain explicit.

## Verification

Deterministic regressions cover append during capture, scan-to-boundary
append, cached siblings, rewrite/truncate/ABA, authority/membership/title and
child changes, complete/partial/malformed tails, legitimate SQLite checkpoint
and SHM lifetimes, same-metadata WAL commits, and API statistics diagnostics.
Normal concurrent SQLite replay additionally checks both stderr and returned
HTTP diagnostics, so moving an error between surfaces cannot fake success.

Implementation and delivery evidence are tracked in the
[source-consistency ledger](../../../docs/specs/source-consistency-2026-10/tasks.md).
The record describes implemented behavior; PR merge and platform/real-source
acceptance are recorded separately in that ledger.
