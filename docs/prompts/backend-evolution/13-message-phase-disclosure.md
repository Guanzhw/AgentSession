# Message-phase-aware Conversation disclosure

Status: SSR consumer implemented; browser verification remains with the parent
Workbench validation pass, 2026-09-11.

## Outcome and evidence

Conversation emphasizes user input and recorded agent replies. A real bounded
Codex source sample contains 385 `commentary` and 15 `final_answer` messages;
the parser previously dropped this explicit presentation evidence. The shared
UI must consume normalized phase rather than interpreting provider fields.

The prerequisite adds optional `Message.presentationPhase` (`commentary` or
`final`) at the provider boundary. Absence means unclassified communication.
This is distinct from protocol event lifecycle phase. No last-message or
stop-reason heuristic establishes finality.

## Implementation scope

- Carry `turn.data.presentationPhase` into Conversation entries through the
  existing Agent Loop/message-tree rendering path. Distinct commentary/final/
  unclassified assistant text must not merge into one final-labelled turn.
- Within the existing user-turn segment, keep the user input, explicit final
  reply and unclassified assistant communication visible. Fold recorded
  commentary and internal-only process blocks into default-closed disclosures
  only when a later explicit final reply closes that process block. Commentary
  and other meaningful process after the last recorded final remain open and
  visible.
- A segment with no recorded final keeps its meaningful assistant communication
  visible, including commentary. Preserve pending interaction rather than
  guessing which fragment is a final reply. Tool/reasoning bodies remain
  individually collapsed.
- Preserve source order. Group only adjacent foldable process blocks; do not
  move checkpoints, results, references or communication across an intervening
  block merely to make one large disclosure.
- Tools, reasoning, child results and source anchors remain in the HTML and
  accessible on expansion. Unbound subagent branches also default to collapsed
  instead of expanding a second transcript automatically.
- Do not add collapsed commentary to the default ToC as if it were another
  visible reply. Preserve user/final/unclassified reply and task navigation.
  Search and explicit anchors must reveal ancestor disclosures before focusing.
- Compact checkpoints remain once at their recorded/derived causal location;
  inherited shared context keeps its separate provenance and ToC exclusion.
- Add EN/ZH process labels and supported counts. Keep raw full content in the
  expanded original renderer. No browser provider branches, guessed approvals,
  fabricated status or protocol entity changes.

Primary files: `src/views/session.ts`, the existing message-tree projection if
needed for phase propagation, `src/locales/en.ts`, `src/locales/zh.ts`, and
focused Conversation tests. Change browser code only for an observed missing
ancestor-disclosure reveal/focus consumer.

## Acceptance

1. Same response group with commentary and final retains separate text blocks;
   tokens and tool-result identity remain unchanged. Same-phase fragments and
   legacy phase-less messages retain their established grouping.
2. A completed user segment shows user/final/unknown text and a closed process
   disclosure; expansion restores preceding commentary and internal evidence,
   while communication after the last final remains visible.
3. An open segment, question-bearing communication, unclassified messages,
   tool-only turns, nested subagents and interruptions remain inspectable.
4. Checkpoint count/location and inherited-context/ToC tests stay correct.
5. Real long Codex source-to-normalized phase counts, SSR disclosure, search
   reveal and narrow keyboard navigation are verified. OpenCode/DSH without
   normalized presentation evidence retain truthful phase-less behavior.
6. Full tests, API/browser checks and one independent review cover the actual
   consumer before committing the Message contract as implemented.
