---
status: implemented
date: 2026-09-09
decision: Use deterministic round-robin allocation for the provider-neutral Execution primary collections under one global maxItems construction bound, deduplicate repeated normalized task/run status labels in the Work task table, and synchronize user-triggered top-level detail tab switches to the URL hash with history replacement.
---

# UI v2 P5: bounded fair Execution and task status deduplication

## Context

The rebuilt real Codex session `01a0576a-98e2-7c31-a265-6d98d5fbff12` exposed
50 actors and 49 runs. With the default `maxItems=100`, the previous fixed
actors → runs → relations → usage order consumed the complete construction
budget before reaching any of its 152 request usage records. The resulting
`usage.requestCount=0` obscured real observed work. The Work table also
rendered a task and its only run as `completed · completed`, adding no
information.

## Decision

`projectExecution` visits actors, runs, and usage records with a deterministic
round-robin scheduler. Each visit increments the shared projection counter;
when the counter reaches `maxItems`, unvisited primary entries set
`truncated=true`. Actor member/run relationship rows are then flattened from
the projected actors and charge the same counter, preserving the existing
single hard bound. The selected raw usage records are retained alongside their
public records and are the only input to both `sumUsage` and `originAccounting`.
When `maxItems` is at least the number of non-empty primary collections, each
such collection receives at least one item; smaller bounds remain deterministic
and explicitly incomplete.

The Work task renderer maps task and run states to their normalized labels,
keeps the first occurrence in recorded order, and renders each distinct label
once. Protocol task/run states are unchanged. User-triggered Work, Conversation,
and Events switches replace the current hash with the selected top-level panel id
without navigation; initialization still accepts only a valid direct panel deep
link, and the separate Runtime lens controller remains hash-neutral.

## Alternatives considered

- Keep fixed collection order: rejected because long actor/run collections can
  completely starve request usage under the global bound.
- Enumerate all usage records and truncate only the returned array: rejected
  because it bypasses the required construction bound and can misrepresent
  inspected usage/origin coverage.
- Infer one combined task/run status: rejected because it rewrites recorded
  protocol semantics; only duplicate presentation labels are removed.

## Consequences

Long Execution projections expose a bounded, non-zero lower bound for request
usage whenever request records exist alongside actors/runs, while preserving
the global construction limit and truthful truncation/origin completeness
flags. Sparse and tiny budgets remain stable by source order. Work rows are
shorter when task and run states agree and still show all distinct states.
Top-level tab links remain refreshable and copyable because the selected panel
is reflected in the hash without a page reload; nested Runtime lens changes do
not overwrite that top-level hash.

## Verification

- Focused v3 projection regressions cover 50 actors, 49 runs, 152 usage records
  at default `maxItems=100`, sparse collections, `maxItems=1/2`, deterministic
  selection, a strict total construction bound, and usage/origin accounting
  over the identical projected record set.
- Focused Work SSR regression covers repeated equal run states and distinct
  task/run states.
- Focused static UI regression covers hash replacement on top-level tab
  switches, no reload navigation, and isolation from nested Runtime lenses.
- `npm run build`, `npm run typecheck`, `npm run check:governance`,
  `npm run review`, and `npm run pre-push` passed; `npm test` passed 501/501.
- After rebuilding and restarting the local server, the real Codex Execution
  API returned at `maxItems=100`: `truncated=true`, 34 actors, 33 runs, 33
  usage records, `requestCount=33`, `complete=false`, and
  `origins.inspectedRecords=33` with `recordsTruncated=true`. At
  `maxItems=300` it returned 51 actors, 50 runs, 199 usage records, and
  `requestCount=199`, still within the same bound.
- No provider adapter/parser/protocol builder or OpenClaw file was changed.
- Real browser checks covered 1280/768/320, light/dark, and zh/en. At 320px
  Chinese dark, Work → Conversation inspector navigation changed the hash to
  `#tab-conversation`, a reload restored Conversation, returning to Work set
  `#tab-work`, and selecting the nested Execution lens left that hash unchanged.
  An invalid hash retained the Work default. The checked pages had no horizontal
  overflow or browser errors.
