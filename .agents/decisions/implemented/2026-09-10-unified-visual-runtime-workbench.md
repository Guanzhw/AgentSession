---
status: implemented
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
Production now uses two primary modes, a secondary Events entry, linked work
selection, grouped run lanes, and phase-aware Conversation disclosure. The
complete test suite passed 545/545; subsequent CSS/keyboard corrections passed
52 focused tests and the real OpenCode E2E suite. Independent review findings
on page-specific actor bindings and inspector behavior were addressed.
Real Codex hash/disclosure and DSH desktop/narrow selection were inspected.
This records the implemented navigation and disclosure mechanism; the broader
visual refinement and complete acceptance matrix remain tracked in the design's
acceptance notes rather than being implied by this lifecycle status.
