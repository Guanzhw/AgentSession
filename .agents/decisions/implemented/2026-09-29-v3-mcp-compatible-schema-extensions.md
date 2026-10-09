---
status: implemented
date: 2026-09-29
decision: Preserve all fixed 2.0 MCP calls while documenting three additive 3.0 event-schema capabilities against a corrected live 2.0 baseline.
---

# Compatible MCP event-schema extensions

## Context

The original [2.0 schema fixture](../../../test/fixtures/v3-mcp-tools-v2.json)
was labeled with the fixed `50a32e7` baseline but already included the 3.0
`context` segment. A fresh `tools/list` from the installed 2.0.0 MCP package
and the fixed source showed that 2.0 allowed three timeline segments, without
`context` in timeline or event references. Comparing 3.0 only to that incorrect
fixture concealed four changes. The exact final Windows executable also adds
an optional event `revision` argument.

## Decision

Keep the six 2.0 read-only tools, their existing input fields, annotations,
output schemas, and old-call behavior. AgentSession 3.0 extends the event
vocabulary with `context` in timeline, context, and get-event references;
timeline accepts four segment selections; get-event accepts optional
`revision` for source-bound continuation. The seventh native team-messages
tool is separate. The user explicitly approved these compatible extensions
and correction of the mislabeled 2.0 fixture on 2026-09-29.

## Alternatives considered

Removing the additions to obtain byte-identical input schemas would make
recorded context checkpoints inaccessible through the native MCP and remove
the source-change check from generated event continuations. Leaving the
incorrect 2.0 fixture in place would understate the public schema change.

## Consequences

Old 2.0 requests remain valid in 3.0, including event continuation without
`revision`; such calls read the current source and do not promise cross-call
consistency. Clients that hard-code the old segment enum may need to handle
`context` when they explicitly select it. The [MCP-01 acceptance row](../../../docs/design/agentsession-v3-acceptance-contract.md)
checks backward compatibility and lists these additions rather than claiming
identical schemas. The independent [event revision decision](2026-09-28-v3-mcp-event-revision.md)
continues to own revision behavior.

## Verification

The corrected [2.0 fixture](../../../test/fixtures/v3-mcp-tools-v2.json)
matches the fixed 2.0 `tools/list`. The [vertical-slice test](../../../v3/test/vertical-slice.test.mjs)
removes exactly five field-level extensions from the six 3.0 schemas and
compares the remainder to that fixture. It also calls the final executable
with old continuation arguments on both tested protocol eras; 15 focused
tests passed. The redacted schema audit (`../../../tmp/v3-delivery/mcp01-final-e2a917876dae49e2b1fd1fe0189306d1/mcp01-schema-audit.public.json`, local evidence)
records actual 2.0 and 3.0 tool lists, structured responses, and stdio purity.
