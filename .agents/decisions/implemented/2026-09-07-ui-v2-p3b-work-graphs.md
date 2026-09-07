---
status: implemented
date: 2026-09-07
decision: Replace the P3a raw Work Graph disclosure with two independent,
  bounded Work structure views over finalized Session Protocol v3 projections:
  Goal to tasks and Agent collaboration.
---

# UI v2 P3b: bounded Work graphs

- Status: implemented
- Date: 2026-09-07
- Scope: provider-neutral goal/task and actor/team graph view models, SSR and
  keyboard switching, narrow relationship lists, bounds/incomplete evidence,
  and removal of the P3a raw relations disclosure
- Blueprint: `docs/design/ui-v2.md` §4.4 and
  `docs/design/ui-v2-visual-system.md` §4.2

## Context

P3a made the Work opening result-oriented but retained the old domain-first
Work Graph disclosure as temporary evidence. The v3 Work, Execution, and
Coordination projections now provide the bounded facts needed for the two
structural views specified by the UI v2 Work design.

## Decision

- Build both graphs in `src/work-view-model.ts` from finalized v3 facts and
  bounded Work, Execution, and Coordination projections. Goal/task nodes and
  actor/team nodes are separate models, each capped at nine visible nodes with
  known totals, omitted counts, and incomplete projection state. Every
  projected goal, including multiple roots and child goals, participates in
  the goal graph total and membership edges.
- Goal membership and task dependency records form the goal graph edges. A
  missing goal remains missing; tasks are explicitly reported as unassociated
  rather than attached to an invented goal.
- Coordination observations aggregate by recorded sender and recipient. Their
  recorded kinds and counts remain visible; dashed async styling is allowed
  only when the observation is bound to a recorded background or scheduled
  run. Observations without both resolvable actor endpoints are counted as
  unplaced and do not create nodes or edges. Team/member records remain
  explicit grouping edges.
- SSR renders both graph panels and the relationship-list fallback. Browser
  code only enhances the graph tab switch, keyboard navigation, task overflow
  View all action, and Conversation inspector entry point. SSR keeps the
  switcher hidden and both panels named/readable; JavaScript adds tab semantics
  and hides the inactive panel.
- Nodes and relationships expose bounded Evidence actions. Membership and
  dependency evidence points to their recorded goal/task records; aggregated
  coordination edges retain the bounded set of their raw coordination record
  ids rather than claiming one synthetic provenance.
- Remove `.runtime-legacy-work` and `renderWorkProjection()` so raw Work
  relation rows are no longer the primary Work evidence. Existing Execution,
  Coordination, and Context lenses remain available; the separate Events
  diagnostic surface owns event evidence after P4a.

## Alternatives considered

- Keeping the raw Work relation list as a fallback: rejected because it mixes
  projection relation rows with the result-oriented Work opening and duplicates
  task/run evidence.
- Combining goal/task and actor collaboration nodes into one graph: rejected;
  task membership and actor communication have different recorded semantics.
- Inferring asynchronous edges from observation kind: rejected; only recorded
  run mode establishes background or scheduled execution.

## Consequences

- Work structure is readable without JavaScript and remains bounded at nine
  visible nodes per view; narrow screens receive a relationship list instead
  of compressed labels.
- Missing goals, actors, endpoints, memberships, and projection completeness
  remain explicit, while existing evidence lenses preserve deeper inspection.
- Conversation remains the destination for the complete agent-card view and
  task overflow is linked back to the bounded Work table.

## Verification

- `npm test` (436 tests passed)
- `node --test test/runtime-workbench.test.mjs` (23 tests passed)
- `npm run qa:e2e` against the real OpenCode session
  `ses_14dd3a011ffeW1Jlye0HNER7TG`
- Real browser checks at 1280, 768, and 320 px against Codex
  `01a0576a-98e2-7c31-a265-6d98d5fbff12`, DeepSeek Harness
  `session-a9f5b448-9851-4872-a266-fdc3381a5061`, and the OpenCode session
  above: both graph views stayed within the nine-node bound, narrow views kept
  node labels without horizontal overflow, graph keyboard switching worked,
  and View all opened the complete task table or Conversation agent cards.
- Axe 4.12.1 WCAG A/AA checks reported zero violations for all three real
  session pages.
- `npm run review`
- `git diff --check`

P3b is the graph switch and raw relation removal. Later visual polish may tune
layout without changing the provider-neutral evidence boundary.
