---
status: proposed
date: 2026-09-10
decision: Replace nested runtime lenses with a unified linked visual workbench and progressively disclosed conversation internals.
---

# Unified visual runtime workbench

## Context

The user explicitly requested visualization-first runtime inspection and
endorsed separating concise conversation reading from internal calls. Current
Execution shows actor ID inventories before runs and requires navigating four
technical lenses. UI v2's existing structure no longer meets this direction.

## Decision

Follow [the design](../../../docs/design/runtime-workbench-v3.md): linked work
structure and execution lanes with contextual coordination/checkpoints, one
selection inspector, Workbench and Conversation primary modes, and secondary
event inspection. Preserve the four backend projections and canonical sessions.
Create and visually inspect an interactive prototype before production changes.

## Alternatives considered

Keeping four equal lenses preserves the current navigation burden. Replacing
lists with unconnected cards does not explain relationships. An all-entities
graph hides the user's current work in visual density. None is the default.

## Consequences

Navigation and disclosure rules change together with browser selectors and
tests. Missing provider evidence stays missing. Existing event deep links,
search, export and resume remain accessible. No provider is removed.

## Verification

The main agent inspected the interactive prototype in a real browser at
1280/768/320px, including graph/run selection, Conversation disclosure,
secondary History, and mobile Escape/focus restoration. The revised narrow
composition uses connected branch nodes rather than flat relationship rows.
Production implementation, real-provider acceptance and independent review
remain open, so this record stays proposed. See the design's acceptance notes.
