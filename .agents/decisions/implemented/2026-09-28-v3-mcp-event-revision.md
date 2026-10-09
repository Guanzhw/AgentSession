---
status: implemented
date: 2026-09-28
decision: Bind generated session_get_event continuations to the source session revision.
---

# MCP event continuation revision

## Context

`session_get_event` reloaded the provider session for every request but emitted
only an offset and content opt-in flags for the next page. Rewriting the source
between pages could therefore concatenate content from different revisions.
The existing six-tool 2.0 schema snapshot has no event revision input.

## Decision

The core returns the loaded session revision with an event detail and compares
an optional expected revision before locating or paging its content. The MCP
response exposes that revision and includes it in every generated message,
thinking, tool-input, and tool-output continuation. A mismatch returns the
existing explicit `source_changed` error. The public input schema adds optional
`revision`; the frozen 2.0 schema remains unchanged and a separate 3.0 schema
snapshot records this extension.

Direct requests without `revision` continue to read the current source at the
requested offset, including existing clients that supply their own offsets.
Only requests carrying the previous result's revision have cross-request source
consistency. The opt-in flags remain required on sensitive continuations.

## Alternatives considered

Requiring `revision` on every request would break direct offset calls present
in the frozen 2.0 contract. Encoding a separate opaque cursor would change the
existing reusable argument shape without adding a distinct source guarantee.

## Consequences

The 3.0 `session_get_event` tool schema differs from 2.0 by one optional input
field. Callers can reuse emitted continuation objects without constructing a
revision parameter themselves; callers constructing unbound offsets retain the
documented current-source behavior.

## Verification

The public Codex JSONL oracle was RED on legacy and 2026-07-28 MCP: first-page
results lacked `revision`. After implementation, both eras rejected a
continuation after a test-owned source rewrite and accepted an unbound direct
offset read; unchanged message, thinking, and long-tool pages reassembled
against the source. A frozen real Codex tool output reassembled over 21 pages
with SHA-256 `8018e48fc89ab3e07790a9de804e0da943a21e1679faab02f5936e7db730cd1a`;
the provider snapshot SHA-256 remained
`09a4ffe7602a3bc28988aa862841948d8229b3b0c58698d1f74270b21547bbee`.
`node --test v3/test/mcp-event-source-oracle.test.mjs v3/test/vertical-slice.test.mjs
v3/test/mcp-get-slice.test.mjs v3/test/mcp-output-contract.test.mjs` passed 17/17.
`cargo test -p agentsession-core -p agentsession-v3 --locked --offline`
passed 115 tests with 13 private-data skips; `cargo fmt --all --check` passed.
`npm run review` passed governance and TypeScript checks; `git diff --check`
passed. The tested Windows debug binary SHA-256 was
`55fe3f4cf00691ee173700d8347e6f9f07cb6ddea6971c92c3d21553274622f`.
