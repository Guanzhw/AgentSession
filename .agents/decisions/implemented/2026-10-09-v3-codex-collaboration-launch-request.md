---
status: implemented
date: 2026-10-09
decision: Preserve explicit Codex spawn request configuration beside recorded collaboration observations
---

# Codex collaboration launch request facts

## Context

The Reader already records correlated spawn requests, acknowledgements, actor
paths and returned results. Its relation observation omits explicit `model`,
`reasoning_effort` and `fork_turns` fields from the same spawn tool arguments.
The selected Codex conversation records requested models and fresh-context
requests while reply metadata is unavailable. Those requests are useful facts
with a different meaning from a child reply's actual model or recorded prefix.

## Decision

Add optional `launchRequest` to the
[relation observation](../../../v3/crates/core/src/lib.rs), containing nullable
`model`, `reasoningEffort` and `forkTurns`. The
[Codex parser](../../../v3/crates/core/src/providers/codex.rs) populates it only
on a recorded spawn request, from explicit nonempty string fields in its
arguments. Both currently supported Codex collaboration namespaces use that
owning boundary. Other providers and other relation states leave it absent.
Advance the durable [Reader projection](../../../v3/crates/core/src/reader_model.rs)
from 5 to 6 so older normalized relations are rebuilt.

The [collaboration timeline](../../../v3/ui/src/lib/CollaborationTimeline.svelte)
groups existing observations by their correlation ID in source order, labels
request configuration as requested, and links recorded child sessions and
return events. IDs and provenance are available in a disclosure. A partial
relation page is explicitly partial; absence of a return is not completion or
failure evidence. Context request and recorded inherited-prefix facts retain
their separate meanings.

## Alternatives considered

Session or reply metadata cannot establish the requested launch settings.
Requested model does not establish the model that eventually answered. A
fresh-context request does not establish how many prefix records the provider
later retained. Task text can be encrypted; the projection does not decode it.

## Consequences

The Reader API gains optional bounded facts without changing Session Protocol,
session identity, spawn correlation, provider source files, or request usage.
Existing serialized observations remain readable through the optional field.

## Verification

The focused Rust regression first failed with missing `launchRequest`, then
passed for both supported namespaces, preserving absent request fields and
null reply metadata. Existing recorded acknowledgement/return regression also
passes. The full core suite passes 193 tests with 14 explicit private-data or
environment-dependent ignores. The independent component regression first failed for the absent
component, then passed grouping, requested labels, canonical child/return links,
failure/completion states and the three-pair compact bound. Raw before files,
RED/GREEN logs and incremental patch are saved under
`tmp/v3-reader-feedback-20261009/collaboration/`. A separate read-only Rust
oracle compared all 26 request configurations in the selected frozen Codex
session against exact source arguments, across 203 relations. Non-request
observations keep the field absent; bootstrap reply metadata remains null.
The durable warm projection equals the initial result after restarting Core,
and source bytes retain SHA-256
`6621bfd4646d9abab16198875085ede708e1613f436722d3add089a0a60b716b`.
The independent oracle initially stalled during unpinned standalone dependency
resolution; reusing the repository lockfile and offline mode produced the
reported successful source check. Final native API and browser
verification is coordinated by the parent task after its integrated build.
