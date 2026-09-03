# AgentSession UI v2 visual system

> Status: proposed · Date: 2026-09-04 · Scope: P1-P4 visual implementation
>
> This document turns the information architecture in [`ui-v2.md`](ui-v2.md)
> into an implementation and review contract. It does not add provider facts or
> reinterpret Session Protocol evidence.

## 1. Direction

AgentSession is a calm, evidence-dense work viewer. The interface should make a
large multi-agent run feel legible rather than dramatic: the current goal and
state lead, collaboration and context changes explain it, and raw evidence stays
one deliberate step away.

The visual hierarchy is:

1. **Orientation** — where the user is, which provider recorded the session,
   and whether work is active, waiting, interrupted, or complete.
2. **Narrative** — the current goal, one progress statement, and the most
   important change since the last checkpoint.
3. **Structure** — bounded work, agent, execution, and context relationships.
4. **Evidence** — task rows, conversation threads, events, IDs, and raw payloads
   reached through explicit controls.

Use whitespace, typography, and one-pixel boundaries for hierarchy. Avoid a
dashboard of equally prominent cards, decorative gradients, glass effects,
oversized metrics, and color-only status.

## 2. Visual language

### 2.1 Color roles

Implement semantic custom properties rather than component-local colors. These
reference values define the intended contrast and temperature; implementation
may tune them only when browser contrast measurement requires it.

| Role | Light | Dark | Use |
|:---|:---|:---|:---|
| page | `#f4f3ef` | `#0d1117` | application background |
| panel | `#fffefa` | `#151b24` | rail and bounded content |
| raised | `#ffffff` | `#1b2430` | nodes and interactive rows |
| text | `#191c20` | `#eef2f6` | primary copy |
| secondary | `#5a626b` | `#aab5c2` | metadata and supporting copy |
| boundary | `#e3e0d9` | `#303b48` | dividers and quiet borders |
| accent | `#345d55` | `#83b8aa` | active navigation, links, progress |
| accent soft | `#e3efeb` | `#203a35` | selected background |
| warm signal | `#9b673d` | `#d7a071` | non-text graph border on raised surfaces |

Green-teal is the product accent; it is a navigation and relationship signal,
not decoration. Provider identity may add a small provider-owned accent, but it
must not recolor the page. Success, warning, error, waiting, and interrupted
states always include a word or icon in addition to color.

The warm signal is not normal text on the light page background; any textual use
must select a measured AA-compliant foreground instead.

All normal text and controls must meet WCAG AA contrast in both themes. Muted
text is never represented by opacity alone over an unknown background.

### 2.2 Type

- UI text: system sans (`Inter` when locally available, then platform system
  fonts); no network font dependency.
- IDs, paths, commands, timestamps when alignment matters: system monospace.
- Page title: 27 px / 1.15 / weight 500.
- Goal title: 22 px / 1.2 / weight 500.
- Section title: 16 px / 1.3 / weight 500.
- Body: 14 px / 1.55 / weight 400.
- Metadata and labels: 11-12 px / at least 1.4; never below 11 px.
- Use weights 400 and 500. Structure comes from scale and spacing rather than
  multiple bold weights.

Long provider text, paths, and titles wrap or truncate with an accessible full
value. They must never widen the page.

### 2.3 Geometry and rhythm

- Desktop rail: 176 px. Main content is fluid with a readable maximum width for
  prose and no artificial maximum for graphs or event tables.
- Spacing scale: 4, 8, 12, 18, 24, 32, 44 px.
- Control radius: 7 px. Graph nodes may be square or 4 px; large rounded cards
  are not the default container.
- Control height: at least 34 px on desktop and 44 px for primary mobile touch
  targets.
- Sections use 24-32 px vertical separation. Related rows use 8-12 px.
- Shadows are limited to a subtle one-pixel lift for overlapping nodes or
  floating panels. Standard sections use a border or divider, not a shadow.

## 3. Application shell

The P0 rail remains the stable orientation surface: Library, Statistics, and
Settings in that order. The active item uses the soft accent background and
accent foreground. Provider availability is a quiet rail footer on desktop and
is omitted from the compact rail when the same fact is already present in the
page header.

At 768 px and below, the rail becomes a single horizontal row. The wordmark and
provider footer yield before navigation labels; navigation remains reachable and
the active state remains visible. The page must have zero horizontal overflow at
320 px.

The shared detail header contains one title block and one action group. Metadata
is a wrapping line below the title; operational status and aggregate signals form
a second quiet line separated by dividers. Work, Conversation, and Events are
text tabs with a two-pixel active underline, not pill buttons.

## 4. Core surfaces

### 4.1 Library

- The summary strip is one horizontal sentence of provider, session, message,
  and token counts; it wraps at narrow widths.
- Search is visually primary. Common filters sit beside it as removable chips;
  advanced filters stay behind one control.
- Time buckets are editorial headings, not cards. Session entries are rows with
  title first, provider/time/project second, and one bounded signal line third.
- Star and selection controls appear consistently without shifting row content.
- Empty library, no results, and source unavailable are distinct states with one
  clear next action.

### 4.2 Work

Work opens with the current goal and a human-readable progress statement. A
compact numeric ratio and five-pixel progress rule support the statement; they do
not replace it.

The first structural row pairs the primary bounded graph with current context
state. Work offers two bounded graph views: goal-to-task flow and agent
collaboration. They are separate views of the same normalized evidence, selected
without mixing task and actor node semantics. Each uses thin directed edges,
short labels, and a maximum of nine visible nodes. Overflow becomes a count and
an explicit “view all” action. On narrow screens each graph becomes a stacked
relationship list; do not shrink a desktop graph until labels are unreadable.

The Work context panel is a current-result projection, not another checkpoint
timeline. It may read, for example, “71k tokens after compact; kept goal, open
tasks, and key decisions,” but the retained-content clause is shown only when a
provider records the compact summary or resulting artifact. Otherwise it shows
only the recorded resulting size or an explicit unavailable state. The causal
checkpoint appears once in Conversation and the complete record remains in
Events. Work shows aggregate counts and an entry point for memory, experience,
and user-info; individual assets are shown in the Conversation inspector,
grouped by recorded scope (`session`, `agent`, `project`, `user`, or
`organization`). Missing scopes stay absent.

Task rows use state marker, human title, owner/state, elapsed or last activity,
and Evidence action. The first five are visible; the remainder is an expansion
count. Background and continuing agents retain live states rather than being
styled as completed tool calls.

### 4.3 Conversation

The user-to-main-agent thread is the reading spine. User turns use stronger
section separation; assistant content stays typographically quiet. Tool calls,
reasoning, and agent channels use progressively indented disclosure rows rather
than nested bordered cards.

An agent card has name, responsibility, lifecycle state, message count, last
activity, and result-arrival anchor. Long-running communication opens as a
channel timeline. Compact/checkpoint events appear once at their causal position
and summarize the post-transformation context. Shared inherited context is not
repeated in the conversation ToC.

The desktop inspector is 280-320 px and sticky only when it does not obscure the
thread. At narrower widths it becomes an in-flow section or explicit drawer.
Scope-grouped context assets and the canonical provider session ID belong here;
protocol entity IDs and raw fields do not.

### 4.4 Events

Events is the diagnostic surface. Lead with a one-sentence purpose, then a type
distribution/filter strip and a virtualized or paged event table. Use tabular
numerals for sequence and time. Provenance (`recorded` or `derived`) is a text
label. Event detail is a side panel on wide screens and an in-flow disclosure on
narrow screens.

### 4.5 Statistics and Settings

Statistics use the same section rhythm and surface colors as Work. Charts need
labels, units, and textual summaries; color is secondary. Settings use one
column of labeled groups with help text near the owning control. Neither page
introduces a second visual system.

## 5. State, interaction, and motion

- Task and run labels map directly from `TaskStatus`; a completed task reads
  “completed/已完成,” not “delivered.” Result delivery and acknowledgement are
  separate `CoordinationState` facts shown on the agent card or channel.
- Agent lifecycle is a presentation of recorded facts: `running` → active,
  `waiting_input` → waiting, and terminal task/run states keep their own labels.
  “Interrupted” is used only for a recorded session state or `interrupt`
  observation; cancellation is not silently renamed to interruption.
- Hover may add a quiet raised background; it must not be the only indication
  that a row is interactive.
- Keyboard focus uses a two-pixel accent outline with at least two-pixel offset.
- Loading keeps the final layout dimensions where practical. Skeleton animation
  is subtle and obeys `prefers-reduced-motion`.
- Expand/collapse and tab transitions use at most 120 ms opacity or position
  changes. Graph layout does not continuously animate.
- Density changes row padding and secondary detail, never font size, evidence,
  or control reachability.
- Theme and density preferences preserve the existing local ownership boundary.

## 6. Responsive acceptance matrix

| Width | Required result |
|:---|:---|
| 1280 px | rail + full header; Work graph/context two-column; Conversation thread + inspector |
| 768 px | compact horizontal rail; graph/context may stack; actions wrap without displacing title |
| 320 px | one content column; 44 px primary touch targets; relationship list instead of compressed graph; no horizontal overflow |

At every width test long Chinese and English titles, Windows paths, tool-only
turns, ten or more compact checkpoints, and more than nine agents. Deep links
must activate the containing top-level tab before scrolling or focusing.

## 7. Delivery sequence and visual gates

The P0 information skeleton is complete. Subsequent stages use this document as
their visual contract:

| Stage | Visual delivery | Gate |
|:---|:---|:---|
| P1 Library | tokens, rail polish, summary/search/filter hierarchy, timeline rows, all three empty states | real multi-provider library at 1280/768/320, both themes, keyboard search/filter |
| P2 Conversation | thread spine, agent cards/channels, compact checkpoint, scoped-asset inspector | real long Codex session plus Pi/DSH child or background evidence; for a fixture with N compacts, every user turn occurs once in ToC, inherited/compact inputs occur zero times, and each causal checkpoint occurs once in the thread |
| P3 Work | goal narrative, progress, bounded collaboration/task graphs, current context result, task table | real 13-agent/10-compact session readable in one desktop screen and stacked at 320 px |
| P4 Finish | Events, Statistics, Settings, locale and density consistency | full E2E, screenshot matrix, browser error and WCAG A/AA audit |

Each stage must update SSR markup, browser hooks, source CSS, both locales, and
E2E assertions together. Review compares screenshots rather than source alone.
Existing Runtime Workbench contrast failures are visual debt owned by P3/P4 and
must be eliminated before the redesign is complete.

The current Runtime Workbench lenses migrate without losing evidence:

| Existing lens | UI v2 destination |
|:---|:---|
| Work | goal narrative, progress, goal-to-task graph, task rows |
| Execution | task owner/state/elapsed values and inspector usage summary |
| Coordination | agent collaboration graph, agent cards, and channels |
| Context | Work current-result summary plus Conversation checkpoints and scoped-asset inspector |
| Evidence | Events filters/table plus retained evidence buttons and detail panel |
| coverage/completeness | Events diagnostic header |

## 8. Reference composition

The exploratory composition is tracked at
[`ui-v2-visual-direction.html`](ui-v2-visual-direction.html). It demonstrates
the desktop Work hierarchy, palette, type scale, rail, one of the two bounded
graph views, current context result, and task rows. It is a visual reference,
not production markup; implementation
must bind only normalized server evidence and keep SSR semantics intact.
