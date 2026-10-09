---
status: implemented
date: 2026-10-04
decision: Carry provider-owned recorded reply model and exact request usage into the bounded Reader projection
---

# Recorded reply metadata in Reader

## Context

The [presentation contract](../../../docs/design/runtime-presentation-contract.md)
requires compact model and usage facts in reply context. The before-change
[Reader DTO](../../../v3/crates/core/src/lib.rs) and
[EventCard](../../../v3/ui/src/lib/EventCard.svelte) discard those facts.
The caffb72b before candidate fails all nine source-backed and controlled
metadata assertions in the
[new regression](../../../v3/test/reader-recorded-metadata-http.test.mjs).

A bounded current-candidate API check also found that an OpenCode or Claude
usage event may lack a Reader event link. A universal protocol-event join is
therefore insufficient. DSH messages can record a model without request usage.

## Decision

Add nullable `ReaderItem.replyMetadata`, with independent recorded model,
provider and provenance, plus nullable request usage retaining its identity,
existing nullable token components and provenance. Owning provider parsers
associate facts through the exact source message and existing request selection.
Each proved request has one primary readable assistant owner; other text parts
may retain the same recorded model. Unattributed requests remain available in
the session's existing runtime view. Missing amounts stay missing and explicit
zero stays zero, following the
[component-presence decision](../implemented/2026-10-01-v3-token-component-presence.md).

Persist those normalized facts through the
[Reader read model](../../../v3/crates/core/src/reader_model.rs), advance its
projection version, and keep durable and source-backed Reader paths consistent.
Advance the durable projection from version 4 to 5. The UI renders known facts
compactly in reply context, including outside a closed process, and locates the
canonical readable owner when selected. Expanded process cards suppress the
duplicate presentation. Inline child facts locate within their own pane.
Codex reply metadata remains null where exact request ownership is unproved;
session-level facts do not fill that gap.

## Alternatives considered

Session statistics have aggregate scope and cannot identify a reply's usage.
Nearest timestamps, carried model settings, or a protocol event with no Reader
owner cannot establish request-to-reply attribution. Gating all model display
on usage would lose genuine model-only records.

## Consequences

This adds bounded Reader API facts without changing request selection, token
amounts, canonical events, source files, or the Session Protocol. Context values
remain at their explicitly recorded checkpoints until a separate reply-context
meaning is established. The existing recorded-model and usage projections keep
their own semantics.

## Verification

On 2026-10-04, `AGENTSESSION_V3_BIN=<identified executable> node --test
v3/test/reader-recorded-metadata-http.test.mjs` produced nine expected REDs on
caffb72b and nine passes, no failures or skips, on the current native10 binary
d138e749. Intermediate candidates retain their own logs and identities. Cases
cover four attributed providers, exact source/settlement ownership, multiple
text parts, model-only records, null versus zero, bounded paging, and Codex null
metadata after a durable warm read.

The current seven relevant HTTP/browser suites pass 52 tests with no failures
or skips using the frozen native10 executable; controlled UI harnesses build
the current Svelte source. Earlier core checks passed 192 tests with 14
explicitly ignored cases, and eight HTTP suites passed 57 tests with three
private-data skips. All 41 backend build-input hashes are unchanged from
native9, so those backend results remain supporting evidence. `npm run review`
passes governance and Viewer core types; it is not a Svelte or MCP runtime test.

Current native CUA observation at 1280 by 720 confirms the real OpenCode PONG
reply's exact model/provider, input 8575, output 26 and recorded zeros against
the configured read-only SQLite source and canonical mother-message provenance.
The distinct Simple pong reply source case retains input 8546/output 33.
The current source oracle also confirms the genuine Codex HTTP 503 diagnostic.
Controlled Svelte cases cover compact metadata outside closed opening/later
processes, exact owner location without duplicates, and child-pane location.

Four existing browser screenshot hooks now run on current native or controlled
surfaces. Their actual scopes and remaining real-scene/four-combination visual
gaps are recorded in the
[usability ledger](../../../docs/design/agentsession-v3-usability-plan.md).
Current native CUA capture still fails. Raw logs, source/build/served-asset
identities, image hashes and private fact/interaction records remain under
`tmp/v3-usability-20261004/`. No user visual approval is claimed.
