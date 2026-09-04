---
status: implemented
date: 2026-09-04
decision: Implement the UI v2 P2a Conversation thread skeleton on the existing
  canonical SSR spine, with a bounded compaction checkpoint at its causal
  position, a Thread/Linear mode toggle persisted as an explicit user choice,
  and a ToC that only follows user turns, main assistant responses, and real
  task/subtask anchors.
---

# UI v2 P2a: Conversation thread skeleton

- Status: implemented
- Date: 2026-09-04
- Scope: Conversation threaded spine (user turn > assistant response >
  tool/subagent), compaction checkpoints rendered once, Thread/Linear toggle,
  ToC containment
- Blueprint: `docs/design/ui-v2.md` §4.3, P2 in
  `docs/prompts/frontend-implementation/03-p2-conversation-threading.md`
- Visual contract: `docs/design/ui-v2-visual-system.md` §4.3
- This is the first of two P2 deliverables; the inspector, agent channels, and
  agent cards remain in P2b.

## Context

The Conversation tab rendered a flat, chronologically ordered message list. For
long sessions (13 tasks / 13 subagents / 10× compaction) that order is
unreadable because tool noise and subagent branches interrupt the reading
spine, and compactions could be re-projected in more than one place. P2a must
group the spine by user turn, show each recorded context compaction exactly
once at its causal position, keep the ToC message/task-only, and offer a
Linear comparison mode without inventing provider facts. The automatic-mode
threshold (20 rendered top-level conversation entries) resolves ui-v2.md §11
open question 2.

## Decision

### Threaded spine on the same canonical SSR content

- `renderConversationThread()` in `src/views/session.ts` groups the top-level
  message entries into `thread-turn` sections: a prelude for content before
  the first user turn, then one section per user turn that owns the following
  user/assistant/tool messages. Nested (subagent) session rendering inside
  branches keeps its existing behavior; detached (background) children render
  after the thread, as before.
- Maximum visible hierarchy is user turn > assistant response > tool/subagent.
  Reasoning stays attached to the assistant/tool content that produced it (no
  new nesting level). The rendering pipeline for parts, cache warnings,
  progressive loading, and subagent branches is unchanged.
- Thread and Linear are CSS presentation modes over the identical DOM
  (`conversation-thread` / `conversation-linear` classes on `#session-messages`).
  Linear hides the turn headers and flattens the segment wrappers; the SSR
  markup, anchors (`msg-*`, `part-*`, `session-*`), and progressive-load
  hooks are shared, so deep links, transcript search, and export behavior are
  unchanged.

### Compaction checkpoints: once, at the causal position

- `collectConversationCompactions(protocol, maxItems = 50)` in
  `src/protocol-runtime.ts` converts finalized v2 protocol events with a
  `compaction` payload into bounded, provider-neutral checkpoint facts. The
  anchor prefers the compaction event's recorded `turnId` when it names a
  previously seen canonical spine message (OpenCode compaction parts carry
  `turnId: message.id`); otherwise it is the last user, system, agent, or
  assistant spine event in source order. Repeated assistant fragments with
  one `turnId` retain that turn's first source id—the Agent Loop owner—and
  nested tool/part events never replace it. This covers current Codex turns,
  whose reasoning and text envelopes share one turn while tool envelopes stay
  nested beneath it, without a provider-id branch.
- Placement is resolved exactly once in `renderConversationThread()` into
  an explicit `anchored` / `timestamp` / `end` kind: an anchor that names a
  spine message places the checkpoint after it (`anchored`); an anchor that
  names no spine message (e.g. DSH records use sequence ids, not message ids)
  falls back to the recorded timestamp, after the last recorded message at or
  before it (`timestamp`); a checkpoint with neither is placed after all
  segments (`end`). The derived fallback kinds are visibly marked with a
  "position derived" label distinct from event fidelity, which never implied
  recorded placement. The source stays complete in Events.
- The checkpoint renders `before → after` tokens only when recorded, the
  provider-recorded summary/retained text when present, and recorded
  trigger/strategy/continuation-session facts in a collapsed evidence
  disclosure. Unrecorded values stay absent; nothing is synthesized. Checkpoints
  with only a `compaction` payload and no recorded details still render the
  recorded fact ("context compacted").
- Checkpoints are not message groups, are not repeated as
  inherited/shared-context rows, and contribute zero ToC entries. The complete
  event record remains available in Events and the Work context lens.

### Default mode and explicit persistence

- Default is Thread for more than 20 rendered top-level conversation entries
  (messages that actually produce visible thread content; raw tool rows merge
  into their assistant entry, tree rows without markup are excluded, and
  compact/inherited rows count only when they render visible content), Linear
  otherwise (`data-conversation-default`, initial class on
  `#session-messages`). `data-conversation-message-count` carries the same
  rendered-entry count.
- A scoped `localStorage` key `agentsession.conversationView` stores only an
  explicit user choice made through the in-conversation Thread/Linear toggle;
  it overrides the default on load. Both modes reuse the same SSR content.

### Boundaries honored

- No provider-id branches in shared views or browser JS; the anchor uses only
  normalized protocol facts. No protocol contract changes; no dist edits; no
  provider data mutations; no new dependencies.
- The raw fallback message path (no session tree) is segmented with the same
  thread builder under the same anchor rules.

## Alternatives considered

- Timestamp-based checkpoint anchoring as the sole rule: rejected because
  provider timestamps may be absent or equal across records; the compaction
  event's recorded `turnId` plus canonical top-level message-role source
  order is the primary anchor, and the recorded timestamp is only a derived
  fallback when the anchor names no spine message.
- Passing the full v2 protocol into the conversation view for checkpoint
  placement: rejected in favor of a bounded normalized list so the page keeps
  a small, evidence-bounded surface (and the Events view stays the complete
  record).
- Rendering Thread and Linear as two server-side variants: rejected because
  both modes must reuse the same canonical SSR content, anchors, and
  progressive-loading hooks; a presentation class over one DOM is simpler and
  cannot diverge.
- A per-session localStorage key: rejected as over-scoped; a single scoped
  preference (`agentsession.conversationView`) matches the existing
  `agentsession.tocWidth` / `as.library.view` convention.
- Timestamp-null compactions shown at a guessed position: rejected; they keep
  a deterministic explicit `end` placement after all segments (still visible
  once in Conversation, complete in Events) rather than being dropped.

## Files

- `src/protocol-runtime.ts` — `collectConversationCompactions()` (bounded 50)
- `src/routes/session-detail.ts` — passes collected compactions to the view
- `src/views/session.ts` — entries extraction, thread segmentation, checkpoint
  renderer, Thread/Linear toggle markup, panel wiring
- `src/static/app/session-workbench.js` — toggle interaction + persisted
  explicit choice
- `src/static/style.css` — toggle, thread spine, checkpoint, responsive rules
- `src/locales/en.ts`, `src/locales/zh.ts` — conversation keys
- `test/core.test.mjs`, `test/protocol-runtime.test.mjs` — focused regressions
- `scripts/qa-agent-browser.sh` — thread/ToC/toggle/checkpoint E2E assertions

## Consequences

- Long conversations render inside user-turn sections with a Thread/Linear
  toggle in the Conversation panel; short conversations keep the previous
  quiet card rhythm by default. Every session page now carries the toggle bar
  and `data-conversation-*` attributes, and `#session-messages` gains a mode
  class, so browser and E2E assertions that target message structure still
  resolve through `.messages .message-turn-*` selectors.
- Compaction checkpoints appear once in the conversation spine and never in
  the ToC; the Work context lens and Events remain the complete compaction
  record, unchanged. Sessions whose protocol exposes a compaction event now
  get a bounded (50) checkpoint list computed at page render time; this adds
  one pass over the final protocol events on the detail route.
- The explicit view-mode choice is stored under `agentsession.conversationView`
  and overrides the length-based default; clearing the key restores the
  automatic default.

## Verification

- `npm run review` (governance + typecheck): pass
- `npm test`: 398/398 pass (13 new focused tests: collector anchoring
  including repeated assistant fragments and nested tool/part interleaving, bounding, thread
  segmentation, defaults, checkpoint-once placement, explicit end placement,
  rendered-entry default count, ToC containment, raw-path segmentation)
- `npm run review` re-verified after the P2a follow-up fixes.
- `git diff --check`: clean
- Live-browser E2E (`npm run qa:e2e`) passed against real OpenCode session
  `ses_1ddf03616ffeTE5c6cbpUPMY3n`, including the default mode, explicit
  Thread/Linear persistence, top-level user-turn segmentation, stable anchors,
  ToC containment, and the existing Work/Events interactions.
- Real Codex session `01a0576a-98e2-7c31-a265-6d98d5fbff12` rendered all 19
  currently recorded checkpoints once each with `anchored` placement and no
  horizontal overflow. Earlier verification on the same growing session found
  32 top-level user-turn segments and 32 user ToC entries; the explicit Linear
  choice survived reload and switching back to Thread restored the threaded
  presentation over the same DOM.
- Real DSH session `session-a9f5b448-9851-4872-a266-fdc3381a5061` rendered 3
  checkpoints once each with explicit derived timestamp placement and showed
  its recorded post-compaction plaintext beneath the result label.
- Visual checks passed at 1280, 768, and 320 px in light and dark themes with
  no horizontal overflow. An axe WCAG A/AA scan of the real Codex page at
  320 px reported zero violations.

## Evidence gaps

- The real Codex compaction records expose replacement history only through an
  opaque encrypted artifact, so Conversation truthfully reports that no
  readable post-compaction context is available. The real DSH sample covers
  the complementary recorded-plaintext result path.
