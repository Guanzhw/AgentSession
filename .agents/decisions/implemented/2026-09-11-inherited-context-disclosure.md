---
status: implemented
date: 2026-09-11
decision: bounded provider-neutral disclosure of explicitly recorded inherited context
---

## Context

Codex child transcripts can contain a copied parent prefix. The existing
parser removes records classified as inherited from owned messages, preserving
correct child token/index/search/export/runtime semantics, but the copied text
was not reachable from any page or search/hash target. Real rollouts include
developer context and user text in this prefix; the available evidence does
not imply that every parent message or assistant/tool response was copied.

## Decision

Add optional `ProviderAdapter.getInheritedContext()` returning at most 40
normalized messages, a recorded total/truncation flag, and the canonical
parent session reference. Codex obtains records only through its existing
record-level `inherited-parent-context` boundary, maps developer/system rows
and untagged copied response-item user rows to normalized `system` messages
with source-role metadata, and leaves inherited usage unattached. A
missing parent file does not erase a child’s recorded parent reference or
boundary-marked messages.

Render the result as an independent, collapsed conversation disclosure using
the existing normalized message/part renderer. Prefix message/part IDs to
avoid collisions, retain transcript search/hash reveal, and resolve
progressive continuation with an explicit projection scope through the same
optional accessor. Keep the
disclosure out of owned message counts, ToC, token totals, exports, and
Session Protocol projections.

## Alternatives considered

- Reinsert copied records into `getMessages()` or the runtime protocol: would
  change owned transcript counts, token attribution, and runtime ownership.
- Reconstruct parent messages by matching text or reading the parent session:
  would guess across missing/changed source data and could claim context that
  was not copied.
- Add a separate provider-specific page/API: would duplicate the existing
  conversation renderer and make long-content/search behavior inconsistent.

## Consequences

The session page can disclose recorded background while stating its bound and
limited evidence. Developer context is represented truthfully as `system`
because the public normalized role set has no `developer` variant. A parent
link remains canonical even if the parent file is unavailable. The optional
adapter surface is consumed only by SSR and the existing continuation route;
providers without explicit inherited evidence remain unchanged.

## Verification

`npm test` passed 565/565; review and pre-push gates passed. Parser, adapter,
SSR and route tests cover the 40-message bound, missing parents, inherited
developer/user/reasoning/tool content, scoped continuation and owned isolation.
Two real Codex child sessions retained identical owned message/token/protocol
counts while exposing four recorded background messages each. Browser checks
covered collapsed defaults, keyboard expansion, search/hash reveal, long text,
ToC exclusion and all 12 language/theme/viewport combinations. Real OpenCode
E2E passed with no browser errors. See the
[acceptance evidence](../../../docs/design/runtime-workbench-v3-acceptance.md).
