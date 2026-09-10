# Recorded execution lanes and linked checkpoints

Status: implemented and locally validated, 2026-09-11.

## Evidence and outcome

The integrated Workbench at `9949426` has actor-grouped run rows and exact
task/run selection. Production DSH screenshots show three identical “Recorded
run” labels without the recorded execution times. Coordination and context are
still separate disclosure inventories. This does not yet meet the visual-first
design's execution/checkpoint outcome.

`CoordinationObservation` records optional task/run/actor IDs and timestamps;
`ContextTransformation` records optional run ID, result artifact IDs and time.
The v3 projections retain these normalized facts. Consume them directly.

## Implementation

- Give each run a bounded useful label from its recorded label or explicitly
  linked task title, falling back to the existing honest generic label.
- Show recorded start/end and elapsed time when both valid endpoints exist.
  A bounded page may show proportional time segments only for those intervals.
  Missing or partial times remain labelled unknown/partial, outside the time
  scale; array position is display order, not recorded chronology.
- Preserve actor lanes and current-page actor bindings. Keep run identities
  unique in the rendered page; do not repeat a run as separate task inventory.
- Attach small coordination markers only with exact normalized run/task
  bindings. Attach context checkpoints to a run only via recorded runId and
  link their recorded result artifacts. Unbound observations/assets stay in
  the secondary scope browser, never attached by timestamp proximity.
- Selecting work/run/marker/checkpoint highlights its exact recorded links
  and opens the existing inspector. It must show result content or a canonical
  content-access link where recorded, and a clear unavailable-content state
  otherwise. Keep usage/provenance accessible without making IDs primary labels.
- Both initial SSR and page replacement consume the same bounded presentation
  facts. Never use a truncated overview as proof a later page has no bindings.
  Preserve default 50/max 100, canonical cursor identity, revision labels,
  latest-page evidence precedence, and explicit omitted scope.
- Use existing CSS/theme/localization conventions and normalized provider
  fields. Do not add provider ID branches, new protocol entities, dependencies,
  inferred actor relationships, or automatic refresh.

## Validation

Focused tests must cover labelled task runs, recorded versus missing time,
recorded run-bound versus unbound markers/results, HTML escaping, and a later
page beyond the overview bound. Tests must assert semantic output rather than
only renamed classes or exact CSS strings. Keep initial and replacement output
consistent.

Main-agent acceptance includes real DSH task/run links, long Codex pagination,
and OpenCode E2E; desktop/narrow pointer and keyboard marker selection; no
overflow in both themes and languages; full tests plus independent review.
This slice implements the remaining linked-lane requirement, not a substitute
for completed-branch disclosure or the full design acceptance matrix.
