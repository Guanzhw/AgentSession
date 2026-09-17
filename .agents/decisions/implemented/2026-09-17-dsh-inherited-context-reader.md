---
status: implemented
date: 2026-09-17
decision: Disclose recorded DeepSeek Harness inherited transcript prefixes through the existing reader accessor
---

## Context

DSH already excludes copied prefix events from its owned transcript and usage.
The Reader acceptance audit recorded a real session with 39 readable inherited
messages but no adapter disclosure, leaving those messages unreachable from
the existing inherited-background reader. The adapter now exposes that
recorded prefix through the shared disclosure and continuation path.

## Decision

Expose `ProviderAdapter.getInheritedContext()` from the DSH adapter without
changing the shared schema. The header's recorded `parentSession` supplies the
canonical source reference; no parent file or generation link is inferred.
Select exactly the events before the existing inherited boundary: `seedLength`
for v0/v1, or the last tagged inherited `session/end-seed` marker for v2/v3.
The marker remains on the owned side.

Reuse each generation's existing append-origin transcript normalizer for
readable user, assistant, reasoning and tool content. Keep source message/call
IDs and sequence metadata, mark the disclosure as inherited background, and
leave message tokens unattached. Return all normalized prefix messages so the
shared reader can page them and continue long fields. Owned transcript, search,
export, ToC, protocol and token selection remain unchanged.

## Alternatives considered

- Reinsert inherited messages into owned history: would change existing
  ownership and aggregate semantics.
- Read a parent or an older generation to reconstruct background: would add
  unrecorded content and a new cross-file dependency.
- Introduce a second DSH-specific reader or shared schema: the existing
  accessor and continuation route already consume this projection.

## Consequences

Recorded background becomes readable even when its referenced parent is no
longer locally available. The existing mandatory source-session contract means
seeded records without a parent ID still return no disclosure. This slice does
not guess that source or expand the shared schema. System/plugin context and
replacement surfaces keep the existing prompt/protocol evidence paths rather
than being reinterpreted as append-origin transcript messages.

## Verification

Five focused inherited-context tests pass for v0-v3, exact normalized prefix
equality, canonical source identities, missing parents, finite and over-40
message pagination, a long field on the final page, and unchanged owned
messages, search, metrics, protocol and token totals. Synthetic source hashes
remain unchanged. The five DSH test files pass 37/37 after the shared build;
governance/typechecking and independent source review pass.

The real DSH sample has an inherited boundary at sequence 117, exposes all
39 normalized background messages, and retains two owned messages. The full
background matches its recorded prefix; source bytes remain unchanged.
Before/after SHA-256 fingerprints of the live messages, tree, container and
metrics API projections are identical. The inherited-context response returns
39 messages with no omitted page. Desktop and 390px browser checks verify the
collapsed disclosure, readable expansion and containment.

The real sample does not cross the 40-message page boundary; longer background
pagination and late long-field continuation remain fixture-backed. Private
evidence stays in ignored `tmp/dsh-inherited-before.log` and
`tmp/dsh-inherited-after.log`; the current product acceptance scope is tracked
in [the Reader evidence](../../../docs/design/runtime-acceptance-evidence.md).
