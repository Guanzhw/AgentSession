---
status: implemented
date: 2026-09-27
decision: Project OpenCode parent and fork fields as distinct recorded Runtime session relationships.
---

# OpenCode recorded session relationships

## Context

OpenCode session rows already carry `parent_id` in v1/v2 and
`fork_session_id` in v2. The 3.0 Reader summary and its fork coordination could
expose parts of these facts, while Session Protocol/Runtime still reported
relationship coverage as unknown and showed no graph edge. A fork is not a
child, and the source row does not establish an AgentRun or a tool trigger.

## Decision

The OpenCode adapter projects a `parent` relationship from `parent_id` and a
separate `forked` relationship from `fork_session_id`, preserving the canonical
session IDs and a provenance pointer to the owning SQLite field. A recorded
session metadata event anchors each relationship to the same protocol stream.
Relationship coverage is `observed` when a field is present and
`not-observed` otherwise. A graph endpoint whose session is outside the current
snapshot remains `unverified`, even when its canonical ID is recorded. No
task, AgentRun, or trigger is synthesized from either field.

## Alternatives considered

Treat `fork_session_id` as a parent link; that would collapse two recorded
SQLite meanings. Derive relationships from the Reader's current display or
from existing database rows outside the current source revision; either would
weaken provenance and consistency. Project an AgentRun from a fork row; the
row does not record an agent execution.

## Consequences

Runtime can display and navigate an OpenCode parent or fork with distinct edge
kinds. The adapter owns the SQLite schema interpretation; shared graph and UI
code do not branch on provider. Native message source order remains stable;
only a record-zero collision with the metadata anchor shifts message records.

## Verification

The focused public v1/v2 HTTP expectations were RED with unknown relationship
coverage, then GREEN with exact kind, endpoints, provenance, graph edge and
unverified missing-parent assertions. Twelve public OpenCode Node tests passed,
and a frozen real OpenCode database produced a recorded parent edge through
protocol and graph with source bytes unchanged. The final targeted Rust app
build passed; broader integrated tests remain part of S4.
