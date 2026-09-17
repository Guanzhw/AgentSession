---
status: implemented
date: 2026-09-14
decision: expose recorded context-change result bodies through a provider-owned reader accessor while preserving metadata-first protocol projections
---

## Context

The [reader completeness audit](../../../docs/design/runtime-reader-completeness.md)
found a real Codex checkpoint with an empty plaintext summary and 141 retained
history entries. The protocol's summary-only checkpoint cannot expose that
result. Its summary normalizer also collapses recorded-empty and absent text.
The existing inherited-context accessor represents copied parent background,
not this session's own compaction result.

## Decision

Add an optional `getContextChangeResult(sessionId, checkpointId)` on the
provider adapter, consumed only by the reader/content routes. Use the existing
canonical protocol checkpoint event ID. Codex must reuse its owned-record
selection and logical-compaction pairing, with one shared identity helper;
paired low-level records must not produce duplicate disclosures.

The result identifies its checkpoint and normalized source provenance,
preserves the complete plaintext summary and its availability (readable,
recorded-empty or not-recorded), and carries ordered retained content with
explicit omitted encrypted fields. Provider-native history group names and
record shapes stay in the adapter; the shared contract carries displayable
normalized content and source labels, not a union of Codex field names.
Source positions must be labeled according to their provenance, not presented
as provider-recorded identifiers merely because an adapter can count records.

Observed image data URLs are represented as metadata-only attachments with
source paths, not raw encoded plaintext. Existing normalized compaction summary
fields remain available to their current protocol consumers; this decision
keeps the newly exposed retained-history arrays out of those payloads.

Reuse the existing bounded progressive renderer through an explicit
`context-result` content scope. Large result bodies are fetched on demand.
Keep result disclosures at the existing checkpoint position, outside owned
message turns and the ToC. The result is a recorded retained-context snapshot,
not an assertion about the exact next model request. Source-order positions
refer to normalized owned records or their retained groups, not raw file lines.

## Alternatives considered

- The current metadata-first protocol and graph do not need retained bodies.
  Expanding their payloads would duplicate large content for unrelated readers.
- The inherited-context accessor has different ownership and exclusion rules.
  Reusing it would misclassify context generated within the current session.
- Moving Codex JSON field interpretation into the browser would bypass the
  provider normalization boundary and repeat parsing between UI consumers.

## Consequences

The reader gains a concrete on-demand body source while existing protocol
consumers retain their metadata-only payloads. Result availability and source
identity are normalized once by the provider. Adapters without recorded result
content continue to expose their existing checkpoint evidence.

## Verification

Test canonical identity without a provider payload ID, paired compaction
records, recorded-empty versus absent summaries, full long-summary
continuation, ordered retained groups and omitted ciphertext. Verify copied
parent prefixes remain outside the child's owned result accessor. Confirm
owned transcript/search/export/token data and metadata-only protocol/graph
payloads are unchanged. The reader exposes retained entries at their
checkpoint while preserving source and availability.

The accessor, normalized result contract and reader disclosure are implemented.
The current implementation has 704/704 local tests passing. The latest
complete real-API validation across seven providers finished with 0 errors;
whole-site `qa:e2e` exited 0 with `ok:true` and no browser errors, and the
Windows final binary build and smoke check passed. Real desktop and mobile
checks confirmed child-history open, refresh, close and return to the
canonical sidebar entry with focus restored and both nested details expanded.
Visual acceptance remains stage-gated: compact task overview/purpose and return
excerpt, metadata density, and the follow-up Library work remain open.
