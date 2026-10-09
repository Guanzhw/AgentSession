---
status: implemented
date: 2026-09-27
decision: Show Codex collaboration from recorded actor and call evidence without inventing child sessions.
---

# Codex recorded collaboration

## Context

Codex records spawn calls, exact `call_id` tool outputs, untargeted waits, and
`FINAL_ANSWER` agent messages in the parent transcript. A spawn acknowledgement
can contain an actor path without a canonical child session ID. Child JSONL
may also copy parent records before its own recorded task boundary. Treating
either as child-owned history would break Reader and protocol ownership.

## Decision

The Codex adapter emits source-ordered coordination observations for spawn
request/acknowledgement, untargeted wait call/return, and matched agent result.
Each observation retains the raw protocol event ID, recorded actor paths,
provenance and an exact Reader source reference. A matched `FINAL_ANSWER`
appears as a separate `agent` Reader card with its full recorded body. Actor
paths do not become `SessionRef`s; the wait has no assigned child. The same
facts appear in the v3 protocol's typed `coordination` domain.

The MCP `session_get` overview keeps its four public role counts: an `agent`
reply contributes to `assistant`, while a distinct `context` checkpoint does
not become a message. Global Viewer and MCP content search include an agent
reply under the `assistant` field, return its canonical event reference, and
retain `matchRole: agent` so its recorded authorship stays visible. Search
document version 4 rebuilds prior derived documents with this field mapping.

The Reader's collaboration panel uses the selected pane's revision-checked
relations. It follows the deepest expanded child, and wide desktop docking is
reserved only when that pane has recorded collaboration; a simple session
keeps the full Reader width. A narrower desktop uses a persistent edge entry.

For a child with a recorded task boundary, copied parent records stay in the
raw source but are excluded from child-owned Reader, protocol events, and
observations. The primary child header and its raw source ordinal are retained.
When a copied prefix has no ownership boundary, protocol construction reports
unavailable rather than publishing the ambiguous prefix as child facts.

## Alternatives considered

- Treat an actor path from `spawn_agent` as a canonical child session ID:
  the source does not establish that identity.
- Assign a global `wait_agent` to the most recent child: its arguments do not
  identify one, so this would fabricate the destination.
- Include the copied parent prefix in child protocol events: those records
  precede the child's own task and would duplicate parent evidence.

## Consequences

The Reader can follow each handoff to the exact saved tool or agent message;
an unresolved child remains clearly unresolved. Work and run lifecycle claims
still require their own provider evidence. Inherited context has a separate
read path and does not enter child-owned Reader or protocol counts.

## Verification

The public Codex fixture and `v3/test/codex-collaboration-http.test.mjs` check
all five observations, four tool references, the agent result reference,
Viewer content search, and v2/v3 source identity. Native MCP tests cover both
client eras searching the agent result, plus four-key `session_get` counts for
agent replies and compaction checkpoints. `v3/test/ui-codex-collab-real.test.mjs` passed 1/1
against real Axum and a browser after clicking all five source links and
reading the complete result; the mock browser test passed 1/1. Rust workspace
tests passed with 72 core and 2 app tests. An explicitly selected frozen
private parent source confirmed the recorded spawn/wait/result chain; a
frozen child source confirmed its task boundary and copied-prefix exclusion.
The collaboration browser suite passes 4/4, including dock/overlay geometry,
manual preference, child-owned facts, and a no-collaboration wide Reader.
All tested source file hashes remained unchanged. These samples establish the
recorded chain and ownership boundary, not every possible multi-child
interleaving.
