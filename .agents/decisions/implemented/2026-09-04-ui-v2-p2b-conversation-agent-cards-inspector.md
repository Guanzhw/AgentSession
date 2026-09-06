---
status: implemented
date: 2026-09-04
decision: Implement the UI v2 P2b Conversation surface as one provider-neutral
  server-side view model over the finalized Session Protocol v3 plus its
  bounded Execution/Coordination/Context projections — compact agent cards
  with channels replace nested subagent blocks only where real
  Task/AgentRun/Actor evidence binds them, the main thread keeps dispatch and
  result anchors plus lightweight references, and a truthfully bounded
  inspector sits beside the conversation.
---

# UI v2 P2b: Conversation agent cards, channels, and inspector

- Status: implemented
- Date: 2026-09-04
- Scope: Conversation agent cards + channels, main-thread dispatch/result
  anchors and references, conversation inspector (session id, coverage,
  usage, relationships, scoped assets), disclosure keyboard behavior,
  responsive layout
- Blueprint: `docs/design/ui-v2.md` §4.3, §4.6, §4.7 scenarios 1/2, P2 in
  `docs/prompts/frontend-implementation/03-p2-conversation-threading.md`
- Visual contract: `docs/design/ui-v2-visual-system.md` §4.3
- This is the second of two P2 deliverables; P2a (thread skeleton + compaction
  checkpoints) shipped separately and remains untouched.

## Context

P2a threaded the conversation spine by user turn and bounded compaction
checkpoints, but subagent activity still rendered as expanded nested session
blocks on the reading spine, agent-to-agent traffic (message / mailbox /
interrupt / handoff / result delivery) had no bounded home, and the
conversation lacked the inspector the design calls for. The Session Protocol
v3 already provides actors, task/run records, coordination observations,
session relationships, usage origin accounting, and scoped context artifacts;
the Execution/Coordination/Context projections already bound these domains at
`maxItems`. P2b must consume those facts without extending the protocol,
without provider-id branches, and without fabricating communication,
acknowledgement, responsibility, lifecycle, memory contents, or token-origin
ownership.

## Decision

### View-model boundary

- New `src/conversation-view-model.ts` derives one small provider-neutral
  `ConversationViewModel` server-side from the finalized v3 snapshot plus the
  four bounded projections (work/execution/coordination/context). It reads
  only normalized protocol/projection facts, never provider raw fields, and
  never branches on provider id. All bounds come from the shared
  `maxItems`-style caps: 50 cards, 50 channel items per card, 50 references,
  5 inspector relationships.
- The view renderer (`src/views/session.ts`) consumes the model; placement of
  cards and references is resolved against the canonical spine entries by
  recorded ids (task `toolCallId`, run/actor `childSessionId`,
  observation `turnId`), the same anchoring language P2a uses for checkpoints.
- A replaced task part preserves every recorded child-session anchor from that
  part. Card Open/MD/JSON actions use only the card's recorded child ref, so a
  multi-child part keeps all ToC targets without changing the selected child.
- A valid task `toolCallId` binds at its task-part position even when that part
  has no child session. Non-task and unbound task parts keep their existing
  rendering fallback.

### Agent cards and channel ownership

- A card replaces the nested subagent block **only** on the main reading spine
  and only when a task `toolCallId`/run child session/recorded turn binds that
  part to a Task/AgentRun/Actor in the model. Without a binding the existing
  nested-session rendering (summary, token chips, embedded messages, export
  actions) is unchanged. Card fields render only when recorded: name (actor
  name, run agent, or task assignee), responsibility (task title/agent path),
  lifecycle state (recorded status mapped to active/waiting/queued/blocked/
  completed/failed/cancelled; `interrupted` only when an `interrupt`
  observation is recorded and the status is non-terminal; cancellation is
  never renamed), bounded observation count, last activity, child-session
  canonical link, result-arrival label.
- The expanded card contains exactly one channel disclosure listing
  source-ordered Coordination observations of kinds message, mailbox-delivery,
  interrupt, handoff, result-delivery, result-acknowledgement — only when
  recorded. Channel rows show kind, recorded state, timestamp, and recorded
  sender → recipient names; nothing is inferred, and `spawn`/`delegate`
  observations are dispatch evidence, not channel traffic.
- Main thread keeps the dispatch position (the card itself at the part
  anchor) and adds exactly one lightweight reference row per recorded
  result-delivery/result-acknowledgement/message/mailbox observation whose
  `turnId` names a spine entry; unanchored observations stay in the channel.
  Reference rows are not message groups and contribute zero ToC entries.
  Dispatch/result/deep-link anchors (`part-<id>`, `session-<childId>`,
  `agent-card-<id>`, `agent-ref-<id>`) stay stable, so ToC jumps and return
  paths keep working.
- Observation assignment uses explicit `runId`/`taskId` first. Actor-only
  fallback is used only when there is no explicit identity and exactly one
  card matches; ambiguous or unresolved observations remain unassigned and
  cannot duplicate across card channels or main-thread references.

### Unplaced fallback (correction, 2026-09-04)

Real evidence contradicted the consequence "sessions with task/run evidence
render cards": the DSH session `session-a9f5b448-9851-4872-a266-fdc3381a5061`
normalizes three Task/AgentRun records, yet Conversation rendered zero agent
cards because the renderer consumed only cards bound to a transcript task
part (and DSH exposes no session tree). The correction keeps the binding rule
truthful without inventing a causal position:

- A card with a real transcript/part binding (task `toolCallId` matching a
  part id, run child session present under the part, or a recorded `turnId`
  naming the message) still renders at its causal position and replaces the
  nested block. Placement is exactly-once: once a card is consumed by a part,
  later parts matching the same card keep the nested-session fallback instead
  of duplicating the card.
- Every remaining view-model card renders exactly once in an explicitly
  unanchored/unplaced agent section on the main Conversation surface
  (`data-agent-cards-unplaced`, after the thread inside `#session-messages`).
  The section carries an explicit "no transcript position" note; it never
  emits invented `part-`/`session-` anchors, uses the card anchor as the only
  target, keeps channels inside the cards, stays inside the existing 50-card
  view-model cap, and contributes zero ToC entries.
- Standalone cards render the canonical child-session Open/MD/JSON actions
  from the recorded `childSession` ref; the renderer input was refactored so
  `renderAgentCard` accepts an optional `SessionPartNode` instead of requiring
  a fake one.

### Inspector truthfulness

- The inspector (280–320 px, sticky beside the thread; in-flow section at
  ≤1100 px, per-width no-thread-squeeze rules) shows the canonical provider
  session id, bounded coverage/completeness (5 domains from the v3 coverage +
  projection-truncation note), usage totals from the Execution projection
  (requests/input/output/cache/reasoning/total, "not recorded" per
  unrecorded field), and the direct/inherited/shared breakdown **only when
  the existing origin aggregate reports `complete`**; otherwise the truthful
  incomplete label is shown instead of a pseudo-partition.
- Relationship rows dedupe by other-session reference, render the recorded
  relationship type, cap at five, and add a Work/Coordination overflow entry
  when more are recorded. Context assets group by recorded scope
  (session/agent/project/user/organization), show public metadata only
  (kind/title/summary/origin/content access/provenance/source session links,
  run-evidence link to Work when present), never use raw protocol entity ids
  as primary copy, and hide empty groups.
- The normalized `AgentRun.childSessionAvailable` fact is provider-neutral and
  tri-state: explicit `false` renders an unavailable child state and removes
  Open/MD/JSON links; `null` remains unknown. Inspector relationship links use
  the same gate when that explicit evidence identifies a dangling child.

### Interaction and visual

- Cards, channels, and inspector disclosures are native `<details>` —
  keyboard reachable, with `aria-expanded` synced by the browser enhancement
  and focus preserved on toggle. Hierarchy stays at three levels (turn >
  card/reference > channel). Same semantic tokens as the rest of the visual
  system; no new palette.

## Alternatives considered

- Rendering agent cards from provider-structured views (per-provider): rejected;
  one provider-neutral view model over finalized projections keeps the
  provider/ownership boundary and remains testable with fixtures.
- Showing the origin breakdown whenever classified slices exist: rejected; the
  Execution projection's `origins.complete` is the only truthful gate, and a
  partial partition would present a lower bound as a partition.
- Rendering all coordination observations on the main spine: rejected; the
  design rule puts agent-to-agent traffic in channels and keeps only
  dispatch/result anchors plus lightweight references on the spine.
- Keeping nested sessions inside expanded cards: rejected; the card's expanded
  state is the channel timeline, and the child session remains reachable
  through its canonical link and export actions (fallback unchanged for
  unbound parts).
- Always-sticky inspector: rejected; sticky applies only when the viewport
  leaves room, otherwise it becomes an in-flow section so the thread is never
  squeezed below usable width.

## Files

- `src/conversation-view-model.ts` — provider-neutral view model derivation
- `src/views/session.ts` — card/channel/reference renderers, inspector SSR,
  placement inside the thread pipeline
- `src/routes/session-detail.ts` — derives and passes the view model
- `src/static/style.css` — card/channel/reference/inspector visuals + responsive
- `src/static/app/session-workbench.js` — disclosure state sync, Work-tab
  evidence bounce
- `src/locales/en.ts`, `src/locales/zh.ts` — P2b keys
- `test/conversation-p2b.test.mjs` — focused view-model/SSR/bound-hook tests
- `test/deepseek-harness-protocol-v2.test.mjs` — DSH dangling workflow child
  availability regression
- `scripts/qa-agent-browser.sh` — guarded real-data assertions (card/channel/
  inspector/reference containment; fallback path retained)
- `docs/design/ui-v2.md` — P2 status block + §7 binding note

## Consequences

- Sessions with recorded task/run evidence render compact agent cards instead
  of expanded nested blocks; sessions without it keep the nested fallback.
  Both paths carry export/open actions and stable anchors.
- When task/run evidence names no transcript part (DSH-style records without a
  session tree, or foreign bindings), every view-model card still renders
  exactly once in the explicit unplaced section; nothing is silently dropped
  and no causal position is invented. Fixes the DSH evidence gap above; the
  P2 gate consequence "DSH child/background evidence renders cards" now holds
  through the unplaced fallback rather than relying on spine binding alone.
- Every conversation tab now carries the layout wrapper and inspector; the
  `#session-messages` element and its anchors are unchanged, so P2a browser
  assertions continue to resolve.
- The page adds one bounded derivation pass over the projections on the detail
  route (same cache the Work Graph already uses).
- Agent-to-agent traffic is visible only in channels and reference rows;
  Events and the Coordination lens remain the complete record.

## Verification

- `npm run review` (governance + typecheck): pass
- `npm test`: 420/420 pass, including the P2b focused tests (card/
  channel derivation and source order, reference dedupe and
  one-result-anchor, bound card SSR + anchors, ToC containment, fallback,
  complete vs incomplete origin accounting, relationship cap/overflow,
  scoped asset grouping and empty-scope hiding, degraded inspector,
  disclosure/responsive hooks, channel truncation bounds) plus the unplaced
  fallback regression tests (unbound run/task card renders once with no
  invented anchor, exactly-once when a bound card coexists, raw-path/no-tree
  placement, canonical child-session actions, ToC containment)
- `git diff --check`: clean
- Focused P2b and DSH protocol suites: green, including multi-child anchors,
  explicit/actor assignment, zero-child task binding, and unavailable-child
  link gating.
- Real-data check: Codex and OpenCode sessions with subagent activity render
  cards with child-session links; a session without coordination evidence
  renders the fallback nested blocks unchanged; the DSH session
  `session-a9f5b448-9851-4872-a266-fdc3381a5061` renders its three
  Task/AgentRun cards once in the unplaced section.
- `npm run qa:e2e`: pass against the live server and real OpenCode session
  `ses_1ddf03616ffeTE5c6cbpUPMY3n`, with no browser errors.
- Live Codex `01a0576a-98e2-7c31-a265-6d98d5fbff12`: 17 unique cards,
  synchronized disclosure focus/ARIA, canonical Open/MD/JSON actions, zero
  ToC leakage, and zero horizontal overflow. Axe WCAG A/AA reports zero
  violations.
- Live DSH at 1280 px and 320 px: three unique unplaced cards, three scoped
  context assets, in-flow narrow inspector, zero ToC leakage, and zero
  horizontal overflow.

## Evidence gaps

- Real providers rarely record all channel kinds; the channel is only as full
  as the recorded Coordination observations (Codex records spawn/message/
  result-delivery; mailbox/handoff/acknowledgement stay absent where not
  recorded). Guarded browser assertions therefore preserve truthful empty
  states for providers without actors or artifacts.
