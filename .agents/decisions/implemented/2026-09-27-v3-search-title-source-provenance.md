---
status: implemented
date: 2026-09-27
decision: Keep display title fallback separate from searchable source title in AgentSession 3.0.
---

# Search title source provenance

## Context

Some Codex transcripts have no locally recorded title. The Reader displays the
canonical session ID in that case, but indexing that display fallback as a
title creates a search hit absent from the source. The old derived search
document generation also survives unchanged source signatures after a parser
fix.

## Decision

`SessionSummary.title` remains the display value. Its private `search_title`
contains only a provider-supplied searchable title, or `None` when unavailable.
Viewer custom titles become searchable while applied. The shared search path
uses `search_title`; the search sidecar stores it separately from the public
summary JSON and omits a title document when absent. Search document version 3
forced a full recapture of existing version 2 documents; version 4 also
recaptures unchanged sources to include recorded Codex agent replies in the
assistant content field without changing their source role.

## Alternatives considered

- Exclude any title equal to its canonical ID: this would suppress a real title
  that happens to equal the ID and loses provenance.
- Keep the display fallback searchable: it fabricates a source title match.

## Consequences

Adapters explicitly supply title search provenance. A version 2 sidecar is
rebuilt under the current source scope even if provider source bytes are
unchanged; provider data and Viewer metadata remain read-only. Public summary
responses retain their prior shape.

## Verification

Rust tests cover display-only title absence in both direct search and durable
documents, plus outdated-document backfill with unchanged source. Public Web
and both stdio MCP client eras find the recorded Codex agent return under the
assistant field and return its exact event with `matchRole: agent`. The independent
five-provider source oracle records the absent-title boundary in
[`test/v3-verify-search-golden.test.mjs`](../../../test/v3-verify-search-golden.test.mjs).
Final binary search and matched performance validation are tracked in the
[`delivery plan`](../../../docs/design/agentsession-v3-delivery-plan.md).
