# Runtime Workbench: visual-first detail design

Status: proposed, user-directed redesign, 2026-09-10.

This design evolves [UI v2](ui-v2.md) and reuses its
[visual system](ui-v2-visual-system.md). It replaces the detail page's nested
Work/Execution/Coordination/Context navigation, not the backend projections.

## User outcome

Without reading a transcript, understand the work, its participants, parallel
execution, waits, handoffs, context changes, and recorded results. Default
presentation prioritizes intent and outcome; internal calls are progressive
detail. Visualization carries relationships, rather than decorating a flat
inventory of entity cards.

## Navigation

- Keep Library, Statistics, and Settings as global destinations. Trash remains
  a management utility. Provider sessions remain canonical URL/storage identity.
- Detail has two primary reading modes: **Workbench** (default) and
  **Conversation**. Workbench contains linked visual regions, not four lenses.
- Events are an evidence destination reached from the selection inspector or
  a secondary history control. Preserve direct access to existing event URLs
  when implementing navigation migration; do not silently redirect to unrelated
  content or remove exports, search, or resume actions.

## Default workbench composition

1. Compact orientation strip: recorded work title/goal, last-recorded state,
   update time and attention signals. Do not derive a completion percentage
   from model calls or session turns.
2. Primary work structure: connected task/result nodes using recorded edges.
   Current/selected work is prominent; completed branches collapse into a
   labelled summary with explicit expansion. Unknown relationships are shown
   as unlinked work, not invented dependency arrows.
3. Execution lanes below the structure: rows represent recorded participants
   or session-owned execution when no actor binding exists. Runs appear as
   labelled segments, recorded waits/handoffs as connected markers, and context
   transformations as checkpoints. Both regions share selection.
4. On-demand inspector: selected work/run details, outputs, context assets,
   usage and provenance. Raw IDs live here. Desktop uses a side panel;
   narrow layouts use an accessible detail sheet.

A lane is not automatically a proportional time chart: where timestamps are
missing, show source-order marks labelled as sequence. Never manufacture a
duration, current-running animation, agent name, or delivery confirmation.
Failure and cancellation stay distinct from successful completion. A failed
internal call becomes a visible attention signal only when its unresolved
effect or required action is evidenced; resolved retries remain expandable.

## Selection and navigation

- Selecting a node highlights its exact linked runs, coordination markers,
  results and context checkpoints, and updates one inspector.
- Selecting a run highlights its owning task when recorded. Missing task
  bindings do not create placeholder tasks. Canonical child links open the
  child with a clear path back to the originating selection.
- Pan/zoom may help dense structure but never be required to read labels or
  use keyboard navigation. Bound rendered entities and explain omitted scope.
- On narrow screens, focus the selected branch and adjacent relations; use
  vertical lanes and progressive expansion before falling back to lists.
  Tables/lists remain appropriate for evidence and explicit inventory views.
- Preserve selected identity during explicit refresh. Show which snapshot each
  refreshed region represents. Automatic refresh is a separate, evidence-based
  decision; this design does not imply live provider control.

## Conversation

- The default spine emphasizes genuine user input and agent replies. Group
  internal model/tool iterations under the corresponding recorded exchange.
- A collapsed process summary reports only supported counts/outcomes; expand
  it to inspect messages, calls, reasoning, retries and delegated work.
- Do not infer a final reply from an arbitrary last assistant fragment.
  Preserve meaningful intermediate communication where the provider cannot
  identify an internal-only boundary; never silently lose recorded content.
- Surface pending user questions, approvals and evidenced unresolved failures.
- Compact checkpoints summarize the retained context/result, with source
  evidence on demand. Inherited shared context is collapsed separately and
  does not populate the default ToC as new child work.

## Context and usage

Context is attached to the work it affects when recorded, with a secondary
scope browser for memory/experience/user-info assets. Distinguish global,
project, agent, session and other protocol scopes without inventing a scope.
Show unavailable content access explicitly; metadata is not the full content.

Keep actual request usage separate from copied transcript history and current
context length. Show direct/inherited/shared token attribution only with
recorded component evidence; unknown origin does not imply zero consumption.

## Delivery and acceptance

1. **Interactive design prototype:** demonstrate work/lanes selection, folded
   internal calls, an attention state, a context checkpoint and its scope
   inspector at desktop and narrow widths. Label sample data as illustrative.
   Prototype buttons must work; do not present the sample as a live session.
2. **Shared application view:** compose normalized projections into the new
   navigation and linked visualization without provider-ID branching or new
   protocol entities. Reuse established identity, escaping and paging bounds.
3. **Conversation disclosure:** implement provider-evidence-backed grouping,
   preserving search, export, ToC anchors, questions and results.
4. **Real acceptance:** Codex, OpenCode and DSH source/API/browser scenarios;
   320/768/1280 widths, light/dark, EN/ZH, keyboard-only selection/expansion/
   inspector/back, and long-session bounds. Track unavailable cases honestly.

Each implementation slice requires its own validation and independent review.
The session-turn/anchor-pagination prerequisite shipped separately in
`c530a2b` after 530 passing tests, real API/browser checks and independent
review. Its delivery does not establish acceptance of this visual redesign.

### Prototype acceptance, 2026-09-10

[The standalone illustrative prototype](runtime-workbench-v3-prototype.html)
has passed the main agent's browser interaction and screenshot inspection:
1280px light work graph plus first execution lane in the initial viewport;
768px dark graph/lanes; 320px dark connected vertical branching with no page
overflow. Only Workbench and Conversation are primary tabs. History remains
secondary. Selection links runs to exact task/actor nodes and updates details;
Escape closes mobile details and restores the trigger focus. Conversation
switching hides the work surface, and internal-call disclosure expands.

The prototype uses sample data and is the composition reference, not a live
acceptance fixture. Production must use normalized relationships, retain
bounded browsing and unavailable evidence, and pass the real-data matrix above.
