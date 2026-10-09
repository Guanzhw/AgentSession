---
status: implemented
date: 2026-09-28
decision: Add one provider-neutral native MCP tool for queued team-message discovery and exact-revision full reads.
---

# Native MCP team-message access

## Context

DSH records `team/message/queued` outside conversation messages. Its relation card has a bounded excerpt and a provider-owned full-content endpoint, but no conversation `readerEvent`. The six established MCP tools cannot discover or page the body without inventing an event and changing message counts.

This is a seventh tool added in 3.0. The user was asked which MCP shape to use and had not replied when implementation proceeded; the long-running task's stated rule selected the recommended dedicated tool. This records the implementation choice, not explicit user confirmation.

## Decision

`session_team_messages` adds `list` and `read` actions to native MCP. The provider adapter selects owned queued records and emits a canonical session plus opaque provider `sourceId` and recorded `messageId`, from/to session and participant identity, and directly usable `readArguments`. Core owns bounded list paging and a cursor tied to the source scope, session and exact revision. Read delegates the source identity and revision check to the provider adapter, uses UTF-16 `ContentPage`, and returns a complete continuation argument object. The MCP text block remains a short summary; content is in `structuredContent` marked `untrustedContent`.

The DSH adapter recognizes queued vocabulary and reuses its source-backed content read. Other providers explicitly report `content_unavailable`. The six existing tool schemas and outputs stay unchanged. Team messages remain separate from conversation EventRefs and usage counts.

The input schema uses discriminated draft-2020-12 `oneOf` branches. Each action advertises its required fields and rejects fields belonging only to the other action; runtime validation enforces the same contract.

## Alternatives considered

Adding queued records to `session_timeline` would fabricate conversation placement. Fetching every relation page through `session_get` would expose only excerpts and make complete mailbox traversal awkward. One dedicated bounded tool gives agents both discovery and full reading while preserving source identity.

## Consequences

Native clients have a seventh read-only tool. They can page all queued messages and complete bodies without changing the six existing tools or conversation counts. Source rewrites invalidate list cursors and read revisions explicitly.

## Verification

The new stdio test failed with only six tools, then passed after implementation on both MCP protocol lifecycles. A JSON Schema validator first accepted incomplete list/read inputs (RED), then rejected them and accepted the complete inputs after the schema fix. The test traverses the public multi-frame DSH fixture, reads through the final marker, rejects wrong owners and delivered records, checks source and cursor changes, and reconstructs a non-BMP rewrite through UTF-16 pages. It verifies the public source hash remains unchanged. The six original tool definitions are compared with their frozen 2.0 schema in the existing vertical-slice test.
