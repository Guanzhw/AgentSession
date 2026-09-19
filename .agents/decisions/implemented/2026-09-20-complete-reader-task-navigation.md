---
status: implemented
date: 2026-09-20
decision: Page the complete canonical task directory and link a local relationship map to exact task content
---

## Context

The first Reader render mirrors at most 50 cards. The live root's first directory
check found 143 canonical task groups; group 51 was `ui_p5_hash_worker`. Later relationships
can appear in the main history but their task detail cannot be selected from the
truncated sidebar. Bounded Work projections also cannot supply late directory
entries. The user asks for each kind of information to use its most useful
presentation: a relationship map for collaboration, a timeline for exchanges,
and prose for complete content.

## Decision

Build the Reader task universe from finalized protocol task/run/actor facts,
retaining current canonical card keys and grouping the same recorded child as
the existing Reader. Materialize only the requested directory page or selected
task group, keeping per-run channels and child histories. Directory entries expose
the first run; further runs of the same child continue within the same task detail,
with their own bounded, prefix-identified page. The read-only directory
supports search and prefix-bound cursor continuation; selected task details reuse
the same SSR components and source/child navigation paths.

Display a local relationship map above the optional searchable directory. Each
visual window contains at most four actor-task relationships; recorded assignment and received-result
edges have distinct directions and labels. Actor identity comes from recorded actor
IDs, with assignment senders and result recipients kept distinct. Ordinary delivered
mailbox messages retain their message meaning. Selection of a node or relation opens
that task's chronological exchanges and complete content. The browser owns only
layout, paging and selection, not provider meaning. Ordinary question-answer
history does not receive an empty graph.

Graph summaries scan assignment/result facts for the selected task groups separately
from their paged run bodies. Repeated same-child runs retain all distinct coordinator
identities in the diagram while their message channels remain unloaded. Each visual
window deduplicates the task node and presents at most four relationships.

Codex alone maps its recorded collaboration `task_name` to the normalized Task
title; internal paths remain available in details. Initial Reader preparation
continues to preserve complete main-history source positions and deferred content.

## Alternatives considered

Raising the 50-card constant delays the same omission and increases initial
content work. A full-session force-directed graph obscures task identity and
the reading order. Using bounded Work projections as the directory source loses
later tasks before pagination. Replacing exact histories with graph summaries
would remove the product's primary reading content.

## Consequences

The directory and graph become alternative entrances to the same task identity.
The new API and cursor identity are shared provider-neutral contracts. Current
readonly provider boundaries and existing child-history namespaces remain intact.
Team membership and process/background execution retain their separate later
stages rather than being inferred from ordinary parent-child task edges.

## Verification

- `npm test`: 972/972. Node 22.15.0 focused directory, graph, provider and
  navigation regression tests: 133/133. Final desktop `npm run qa:e2e` passed.
- Live directory: 146 tasks over 50/50/46 pages, no duplicate canonical keys;
  task 51 and its complete child Reader returned 200. Browser Back restored
  the task, expanded directory, sidebar and original child-history link focus.
- Real nine-task EN/light and ZH/dark pages exercised graph arrows, selection,
  groups, complete exchanges, keyboard closing and child-history navigation.
- An explicitly synthetic browser fixture exercised 120 same-child runs with
  1 + 50 + 50 + 19 loading, unique run IDs, and nine distinct same-name actors
  over three graph windows. Final-page nodes did not overlap. No JS errors.
- Seven installed providers passed real Reader/directory API checks; four
  unavailable provider/session paths returned 404.
- Independent review findings were fixed and covered: pane namespaces, visible
  retry, mailbox semantics, bounded run bodies, latest-wins search, prefix
  insertion cursor invalidation, and graph relationships across paged runs.

Detailed evidence and local artifact paths are in
[the acceptance record](../../../docs/design/runtime-acceptance-evidence.md).
