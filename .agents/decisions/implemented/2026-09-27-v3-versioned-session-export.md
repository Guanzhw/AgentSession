---
status: implemented
date: 2026-09-27
decision: Use versioned source-backed event exports in 3.0 and return an explicit migration response from the 2.0 export URL.
---

# Versioned 3.0 session export

## Context

The 2.0 export was a Viewer document with provider-specific message parts and
structured Tree/Container/Metrics. The 3.0 Reader and MCP share source-backed
event identity and ownership. Returning 3.0 events from the old URL would
silently change a public response. The user explicitly selected the new event
contract after the [legacy comparison](../rejected/2026-09-27-v3-session-export-compatibility.md).

## Decision

`GET /api/v3/export/{provider}/{sessionId}` owns the 3.0 JSON and Markdown
downloads. JSON has a `schemaVersion`, canonical session reference, source
revision, ordered events with their owner references and full content fields,
and an untrusted-content marker. The Reader uses that URL for both formats.
`GET /api/{provider}/session/{sessionId}/export` returns HTTP 410 with stable
`legacy_export_removed`, the percent-encoded replacement path, and `md`/`json`
format names. Other actions on the legacy route remain unaffected.

## Alternatives considered

Exact 2.0 response compatibility was rejected after source and field-level
comparison. A redirect was rejected because automatic clients could receive
the new schema without recognizing the change. Partial old-shaped JSON with
null projections was rejected as misleading.

## Consequences

External 2.0 export clients need an explicit 3.0 schema migration. The
side-by-side 2.0 baseline can still serve the old format. The event export
currently omits some old provider metadata and per-message model/token facts;
the old structured projections are not part of its schema. These facts must
be mapped to source-backed 3.0 surfaces or separately retired before full
feature acceptance. HTTP-06 remains open for five-provider independent source
coverage, real downloads, statistics, and that fact mapping.

This implemented state was subsequently reversed by the
[session-export purpose decision](../implemented/2026-09-27-v3-session-export-purpose.md).
The versioned export route and Reader links documented here are historical
evidence; current 3.0 no longer offers a dedicated session file.

## Verification

At the time, the [HTTP test](../../../v3/test/export-slice.test.mjs) was RED at old URL 200
versus expected 410, then GREEN for default, `json`, `md`, and unknown format
queries. It checks same-session replacement and encoded IDs; new-version
downloads retain canonical identity, revision, long tool content, and errors.
The [real browser suite](../../../v3/test/dsh-ui-integration.test.mjs) verifies
the root Reader's new links. Together these tests passed 8/8 on debug binary
SHA-256 `2ef9bd642e2e1010d8c4c5eb38962c550d8eb4cab1ed736efdcd78c3ba1`.
Rust workspace tests passed core 105/12 ignored and app 2; source hash checks
in the focused HTTP suite passed. This does not close HTTP-06.
That test and the linked browser suite now assert the later removal decision;
the passing result above is retained as historical evidence, not a current
test claim.
