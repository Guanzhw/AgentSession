---
status: implemented
date: 2026-10-10
decision: Prefer recorded Codex native titles and expose normalized Reader launch metadata and conversation duration
---

# Recorded Codex titles and readable tool metadata

## Context

Library titles were derived from the first recorded user request. A selected
real request begins with a Codex routing URI and a quoted execution failure;
the same raw text is also in the native SQLite thread title. The provider's
`session_index.jsonl` records a concise current `thread_name`. Reader spawn
cards also exposed encrypted task tokens before their readable launch options.

## Decision

The [Codex adapter](../../../v3/crates/core/src/providers/codex.rs) reads only
`session_index.jsonl` under its configured source root and prefers the latest
valid native `thread_name` by recorded `updated_at` (last row breaks ties).
It preserves transcript text and the existing request/ID fallback. Missing
native titles keep that fallback; malformed rows or an unreadable index produce
an explicit provider storage diagnostic. Valid title rows remain usable.
Title-specific evidence participates in catalog signatures and Reader cache
dependencies, while public identity and transcript content revisions stay stable.
This adds a metadata source alongside the transcript roots established in
[the source-root decision](2026-10-09-v3-codex-transcript-roots.md).

Optional [Reader tool metadata](../../../v3/crates/core/src/lib.rs) carries
explicit task/model/reasoning/context values from supported Codex collaboration
namespaces. Existing launch-option normalization remains the owner. The
[tool card](../../../v3/ui/src/lib/EventCard.svelte) places these values in its
header. Recorded encrypted task input is identified at the provider boundary;
its raw argument field remains byte-preserving and is fetched through the
existing content cursor only from the explicit Raw input disclosure.

Session summaries expose optional `durationMs` using Codex's existing recorded
conversation timestamp range, matching ProtocolListStats. Header times, file
modification times and system records do not establish a conversation duration.
A single distinct timestamp leaves duration unknown. Other providers currently
leave this optional summary field absent.

## Alternatives considered

Stripping routing text would discard real user content. Native SQLite thread
`title` does not solve the observed case. Browser-side parsing would move
provider schema ownership into Svelte. Reading native titles without source
signatures would retain stale cached titles after a provider rename.

## Consequences

Provider source files remain read-only. Catalog summary schema 14 replaces
older summaries; Reader projection 7 includes the new tool fields and the
concurrent process-grouping fix. Native title diagnostics are independent of
transcript availability. A small [Codex tool presentation module](../../../v3/crates/core/src/providers/codex_tool_presentation.rs) extracts bounded command summaries and recorded working directories from supported execution contracts; Svelte receives plain normalized strings. Requested model and context remain launch requests,
not evidence about the model or context that later answered.

## Verification

The focused Rust tests cover native title freshness in a warm Library index and
Reader projection, timestamp-based latest title selection, missing and malformed
native indexes, unchanged transcript text and source bytes, recorded duration,
and explicit launch metadata with preserved raw input. The Codex suite passes
64 tests with eight explicit private-source/environment ignores. The selected
real-source native title oracle passes when explicitly enabled and verifies
both transcript and title-index bytes remain unchanged. The Svelte component
regression passes header metadata, shared child appearance, nested raw input,
plaintext, ordinary tools, and escaped command summaries. The six focused tool-presentation tests and the complete core suite pass (213 passed, 15 explicitly ignored). Main-agent validation owns the affected desktop
browser and full build/review checks.
