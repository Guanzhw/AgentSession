---
status: implemented
date: 2026-09-28
decision: Read native DSH queued team-message bodies through a revision-checked bounded provider endpoint.
---

# DSH queued team-message content

## Context

The DSH v3 `team/message/queued` source records can contain multiple text blocks. Reader collaboration relations kept only a 240-character excerpt, so a long recorded exchange ended before its final source text. These events have no conversation `readerEvent`; delivery records do not carry the body.

## Decision

The DSH adapter owns a content read keyed by canonical session ID, queued source sequence, and message ID. It checks the selected source path and exact-byte revision before reading the queued record, then pages the joined text blocks with the Reader's UTF-16 offset convention. The Axum route transports this `ContentPage`; the collaboration card expands and continues it. Other providers report unavailable through the adapter contract.

The read does not add conversation events, change message or usage counts, or copy a body onto `team/message/delivered`. A wrong sequence, message ID, or owning session does not return another message's content. A stale source revision fails explicitly.

## Alternatives considered

Adding a synthetic conversation event would make the text appear in the normal Reader and MCP event path, but it would change recorded ownership and counts. Enlarging relation excerpts would not provide bounded continuation or revision safety. The provider-owned content route keeps the existing source identity.

## Consequences

The Web Reader can show a complete queued exchange without loading every body in the relation page. The later [native MCP decision](2026-09-28-v3-native-team-messages-mcp.md) adds bounded discovery and full-body paging without inventing a conversation event.

## Verification

The focused HTTP test was RED with a missing route and GREEN after implementation. It checks the exact two-block public fixture through the final marker, wrong queued identity, delivered-event rejection, wrong owner, and stale revision. A provider unit test checks a non-BMP character across UTF-16 pages and a same-path source rewrite. The real-browser DSH test opens the collaboration card and reads the final marker. The public fixture tests compare source SHA-256 before and after use.

A second browser test kept the parent Reader mounted while rewriting a copied child source. It first failed because the old completed body hid the read action under the new revision. After the cache key included the revision, the new body loaded, and a delayed response from an older revision could not appear in the current panel. The read action now follows the normalized truncated-excerpt fact.
