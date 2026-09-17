# Inline task-step reading

Updated 2026-09-17. Implements the local-insert part of the
[presentation contract](runtime-presentation-contract.md), using the selected
[visual direction](runtime-visual-direction.md).

## Real reading task

Follow two review tasks dispatched eight seconds apart. While both are underway,
read the main agent's experiment work. Find each result receipt, then follow the
second task's additional request and next result without losing the main history.

The recorded test segment is 15:30:11.504–15:37:38.797 UTC on 2026-09-10.
Main-agent prose at 15:30:27 and 15:33:08 falls between both dispatches and the
first completion. The source-owned completion and parent receipt remain distinct
records. Exact local IDs and private screenshots stay in the QA artifacts.

## Audit before this slice

| Step | Observed reading experience | Health / action |
| --- | --- | --- |
| 1. Read through collaboration | The real page has 101 inline observations, including 52 ordinary messages. All 52 are visible by default, splitting 137 process disclosures. A desktop viewport can contain only repeated labels and process toggles. | Needs work: fold ordinary exchanges with their owning execution process. |
| 2. Follow a return | The task label opens the sidebar. Readers then find the task sequence and select another source; inline dispatch and return do not link directly to one another. | Needs work: add local previous/next key-step connections. |
| 3. Inspect original evidence | Dispatch and follow-up resolve to native tool bodies. Child completion and parent receipt have independently owned scalar evidence. Some dispatch bodies are encrypted locally. | Preserve the source boundary and show available child history; do not synthesize unreadable instructions or a return body. |

Evidence was captured from the running application in this audit, saved and
visually inspected: `tmp/p4-before-dispatch-20260917.png`,
`tmp/p4-before-sidebar-20260917.png`, `tmp/p4-before-parallel-20260917.png`.
The expanded observations control currently presents a sequence, not the old
full-height lane drawing; the relationship documentation has been corrected.

## Content and presentation

- Main prose stays in its recorded position. Key task records stay visible:
  dispatch, follow-up, interruption/resumption, and each recorded delivery.
- Ordinary `message` observations belong in the owning process disclosure.
  Their identities, exact positions, source links and content remain available.
  A mixed position containing a key record stays visible as a whole.
- Below each key record, a small connected step strip shows the preceding and
  following key records of the same canonical lane. It uses action labels and
  clocks, rather than internal IDs. The current node is labeled “Here”.
- Step controls jump to the actual inline milestone using normal Reader
  navigation, preserving Back/Forward and scoped child-history behavior.
- The strip follows local source order. It does not infer request/result pairs,
  continuous execution, elapsed duration, or a parent location for child-only
  lifecycle evidence. Shared task names do not merge distinct canonical lanes.

## Acceptance

Verified on 2026-09-17:

- The same real page retains all 101 unique milestone anchors. Of 52 ordinary
  messages, 49 now sit inside closed process disclosures; the other three share
  positions with key observations and remain visible.
- The technical task's 15:30 dispatch links to its 15:34 receipt, then its
  follow-up and 15:37 receipt. Each jump focuses the actual milestone. Browser
  Back returns to the departing step control; keyboard Enter follows the same
  source-navigation path. The main agent's experiment and correction prose
  remains in its recorded position.
- Opening an ordinary exchange loads its seven-tool chunk, keeps each milestone
  unique and preserves the selected task's styling. Open source reaches the
  matching `send_message` tool body. Encrypted provider content is preserved as
  recorded, not interpreted as a readable instruction.
- Desktop, 390px and 320px were inspected in dark and light themes. The first
  narrow screenshot exposed overlapping step labels; reserving space for the
  current node fixed it. Final views have no page-wide horizontal overflow.
  Saved screenshots were inspected, including `tmp/p4-after-return-20260917.png`,
  `tmp/p4-after-narrow-dark-20260917.png`, `tmp/p4-after-narrow-light-20260917.png`
  and `tmp/p4-after-320-dark-20260917.png`.
- `npm test`: 830/830. The same full suite passes on Node 22.15.0; the four focused
  Reader rendering/client/route files pass 32/32. `npm run review` and
  `npm run pre-push` pass. The full live `npm run qa:e2e` suite passes against
  the restarted final build, with no browser errors. An independent review
  identified stale milestone references after chunk replacement; the client
  now refreshes only the owning pane, with a regression test.

This verifies P4/P5 local task tracing, P3/P9 ordinary-process access and the
affected P10/P11 navigation/layout paths. P4's broader parallel overview and
user visual acceptance remain open. These checks do not claim a complete
accessibility or multilingual acceptance pass.
