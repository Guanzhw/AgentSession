---
status: implemented
date: 2026-09-28
decision: Project OpenCode v2 task requests and verified child dispatch from native assistant content
---

## Context

The frozen OpenCode schema-v2 SQLite snapshot contains 59 `task` tool content parts in owned assistant messages. Fifty-eight claim a child session whose recorded `session_v2.parent_id` matches the caller; one error part has no child claim. V2 stores these parts in `session_message.data.content`, unlike the v1 `part` table. The prior Rust V2 projection kept tool events but no task dispatch facts.

## Decision

The OpenCode adapter emits a task request with unknown outcome for each native V2 `task` tool part. It emits a confirmed spawned link and Reader placement at that content part only when `state.metadata.sessionId` resolves to a session whose recorded parent matches the current session, and any recorded `parentSessionId` agrees. The tool part ID identifies the call, while the message row ID remains the protocol evidence source ID. All task, coordination, relationship, and Reader facts come from the same checked source revision. Tool completion does not establish a child run status.

## Alternatives considered

Trusting the metadata child claim without checking the canonical parent could link another session. Reusing the v1 `part` table would miss native V2 content. Parsing `task_id:` from output adds an unobserved fallback to this slice and can be evaluated when a real V2 record requires it.

## Consequences

V2 task requests appear in Runtime work, confirmed children appear in the graph and inline Reader placement, and unconfirmed requests remain visible without a child link. Agent runs remain empty until lifecycle evidence is mapped.

## Verification

`v3/test/opencode-v2-task-dispatch-http.test.mjs` recorded RED before implementation and now checks confirmed and rejected child claims, unknown outcome, Reader placement, graph, and source hashes. `v3/test/opencode-protocol-foundation-http.test.mjs` checks selected frozen V2 sessions against raw owned rows, protocol identity, child parent records, and Reader placement without mutating the source. The frozen DB SHA-256 is `c9df86b1ab86eace661e8d0e608b48df83aa87fdc9ec5448efa760cd5fbf3429`.
Independent review found the Reader relation initially used the synthetic content locator as its provenance source ID. A focused assertion failed on that value; the Reader relation now cites the native message row ID while retaining the content locator for precise placement. The focused test is green after the correction.
The provider capability table also initially still advertised tasks as unsupported. A focused status assertion failed on the stale declaration; it now advertises partial recorded task support for both native schemas.
The frozen read-only HTTP oracle now checks all nine task-bearing parents: 59 task requests, 58 canonical child links and exact Reader placements, one unclaimed error, matching Reader/protocol revisions, and unchanged database/WAL hashes.
