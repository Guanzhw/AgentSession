---
status: rejected
date: 2026-09-27
decision: Rejected exact 2.0 session-export response compatibility for the 3.0 public export URL.
---

# Exact 2.0 session export compatibility

## Context

The 2.0 `GET /api/:provider/session/:id/export` URL returns JSON with
`session/tree/container/metrics/messages` or a conversation-oriented Markdown
document. [The route](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/routes/session-detail.ts) uses
[`getSessionDocument()`](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/session-queries.ts), including a separate
raw SQLite OpenCode path. Its message parts and structured projections belong
to the 2.0 Viewer model. The 3.0 event export has canonical event references,
owners, source revision, and complete event body/tool fields at
`/api/v3/export/{provider}/{sessionId}`.

Five-provider 2.0 JSON/Markdown responses were frozen in ignored
`tmp/v3-export-http06-20260927-a/`: ten HTTP 200 responses with source hashes
unchanged. Old JSON message counts were OpenCode 712, Claude Code 8, Codex
1,490, Pi 2, and DeepSeek Harness 1,219; all five had populated Tree,
Container, and Metrics. An experimental, unconnected Codex source projection
returned 1,538 messages, differed at ID index 19, and lacked old per-message
tokens/model, session metadata, and structured views. Pi's tool result updates
an earlier message in 2.0, and Claude Code uses different message IDs and
reasoning attachment. Flattened 3.0 Reader events cannot safely recreate this
old response. The experimental code was removed after recording that RED.

## Decision

The user chose a versioned 3.0 event export and an explicit migration response
for the old URL. Exact 2.0 JSON/Markdown shape compatibility is rejected.
The old GET URL returns HTTP 410 with `legacy_export_removed`, a same-session
replacement URL, and supported formats. Reader links use the versioned URL.
The fixed 2.0 installation remains available for old-format downloads during
side-by-side comparison.

## Alternatives considered

- Reimplement the 2.0 Viewer message and Tree/Container/Metrics models in all
  five Rust adapters. This would duplicate an old model solely for response
  compatibility and require an additional OpenCode SQLite branch.
- Return old top-level keys around new events or empty structured views. That
  would advertise compatibility while losing recorded facts.
- Redirect the old URL. Clients that follow redirects could silently parse a
  different JSON schema, so an explicit 410 is clearer.

## Consequences

External consumers of the public 2.0 route must adopt the new event schema;
no repository-local parser of the downloaded old JSON was found, but external
consumers remain unknown. Format redesign does not retire the underlying
facts: provider metadata, per-message model/tokens, and old structured
projections require a source-backed destination or an explicit later decision.
HTTP-06 stays open until content, ownership, migration, and statistics pass
their independent acceptance checks.

The later [product-purpose decision](../implemented/2026-09-27-v3-session-export-purpose.md)
removed the dedicated 3.0 session export altogether. The replacement URL and
event-document migration described above record the intermediate contract,
not the current route behavior.

## Verification

The public Codex 2.0 source and five frozen private sources established the
old response. The experimental Codex comparison was RED at 1,538 versus 1,490
messages; its public fixture projection test was GREEN but did not establish
compatibility. The [3.0 export test](../../../v3/test/export-slice.test.mjs)
then went RED against the prior binary (old URL 200 instead of 410) and GREEN
after the route change, with the versioned JSON/Markdown checks intact.
[Browser checks](../../../v3/test/dsh-ui-integration.test.mjs) verified the
Reader links on a public DSH session. The combined focused suite passed 8/8;
Rust workspace tests passed core 105 with 12 ignored and app 2. Final release
and five-provider independent source checks remain delivery gates.
