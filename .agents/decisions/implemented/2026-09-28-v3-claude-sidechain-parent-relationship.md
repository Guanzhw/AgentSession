---
status: implemented
date: 2026-09-28
decision: Project a Claude sidechain's recorded sessionId into a parent relationship anchored to its source event.
---

# Claude sidechain parent relationship in 3.0

## Context

The Claude adapter already uses a sidechain row's `sessionId` as the child
summary's canonical parent, but the protocol declared relationships unknown.
The public `child-a` fixture records `isSidechain`, `agentId`, `sessionId`, and
`uuid` in the child transcript. Runtime Sessions therefore lacked a parent
node even though the Library and Reader knew the relationship.

## Decision

The Claude adapter projects one `parent` relationship from the first sidechain
record when its `sessionId` is nonempty, differs from the child ID, and the
record has a source ID. The relationship uses the child transcript's captured
bytes and revision, and its evidence points to that record's protocol event.
The direct source field makes provenance recorded. An unusable parent remains
unknown; parent source availability is unverified. Sidechain lineage alone
does not create a Task or AgentRun.

## Alternatives considered

Keeping the link only in the summary would leave Runtime Sessions unable to
navigate to the parent. Correlating task notifications with the sidechain would
claim a task lifecycle that this child file does not establish.

## Consequences

Claude declares partial recorded session-relationship support. The validated
v2/v3 documents and bounded Runtime graph carry the same canonical parent
reference. Generic Runtime navigation opens the parent Reader and restores
the child's Sessions lens and focused link on Back. The child source remains
read-only.

## Verification

The new public child test first failed on empty relationships. After the
adapter change, 15 focused Claude Node tests passed, including protocol,
Reader, MCP, and a real browser parent-navigation and Back/focus check; one
optional private-manifest test was skipped. Six Claude Rust tests, the offline
Rust debug build, `cargo fmt --check`, and `npm run check:governance` passed.
The repository `npm run review` also passed governance and Viewer typecheck.
The public fixture's source hash was unchanged. A whitespace-only parent
kept relationship coverage unknown, and the protocol retained empty Task and
AgentRun arrays. The frozen 26-row Claude source passed the foundation check;
it does not contain a paired sidechain parent case.
