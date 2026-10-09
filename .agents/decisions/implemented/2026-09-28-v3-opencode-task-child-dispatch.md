---
status: implemented
date: 2026-09-28
decision: Project OpenCode task tool requests and confirmed child dispatch from v1 SQLite parts
---

## Context

The Rust OpenCode adapter retained task tool parts as Reader and protocol events but exposed no task or dispatch fact. The frozen native fixture records `p-exact` with `callID=call-exact` and a claimed child session; a separate session row records the canonical parent. Other fixture parts omit a child or claim a child belonging to another parent.

## Decision

For v1 SQLite `task` tool parts, emit a recorded task request with unknown outcome and a coordination observation keyed to the part and call ID. Emit a `spawned` relationship and Reader child placement only when the claimed session exists and its recorded `parent_id` matches the current session. A claimed `parentSessionId`, when present, must agree. The relationship evidence refers to the source part event and identifies the paired part/parent fields. Keep `agentRuns` empty because the persisted tool state does not establish a child run lifecycle. This slice does not reinterpret v2 `session_message` content.

## Alternatives considered

Trusting `state.metadata.sessionId` alone would attach nonexistent or unrelated sessions. Treating the tool's `completed` status as the child's outcome would misreport task execution. Adding a shared projection would move OpenCode schema assumptions outside its adapter.

## Consequences

The Reader can open a confirmed child inline at the task tool's exact event. Runtime work and graph views show the assignment and spawned edge. Unconfirmed requests remain visible without a child link. The frozen current OpenCode v2 source still requires separate future handling for its native task records.

## Verification

`v3/test/opencode-task-dispatch-http.test.mjs` freezes the public source lines, checks the first RED result, and verifies protocol, Reader placement, graph, negative claims, and source hashes after the adapter change. Run the OpenCode protocol foundation suite against the frozen real v2 snapshot to guard the unaffected schema path.
