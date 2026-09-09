---
status: implemented
date: 2026-09-09
decision: Keep long-session detail readable through bounded rail search, width-aware Work overview layout, explicit metric label/value hierarchy, truthful recorded-span wording, compact shared duration formatting, and existing English/Chinese localization.
---

# UI v2 P6: visual readability for long sessions

## Context

The 2026-09-09 browser review of the real Codex session
`01a0576a-98e2-7c31-a265-6d98d5fbff12` at 1280×768 found an isolated 34px rail
search input, a Work context/task split that left only about 586px for five
columns, and adjacent metrics such as `messages2,155` and
`runtime13257m 18s`. The same review found English-only metric, token-detail,
and top-tools copy in Chinese, while 768px and 320px had no page overflow and
correctly hid rail search.

## Decision

Constrain the desktop rail search form and input to the rail and let the label
wrap. Keep the Work context and task table side by side only when the task
table has a 560px minimum; stack them through the 1240px breakpoint. Keep task
state and Evidence cells unbroken while canonical paths remain wrap-capable.
Render metrics as labelled cards, use “Recorded span / 记录跨度” for the
timestamp-derived `runtimeMs`, and share a two-non-zero-unit duration helper
across session and Work task elapsed values. Route metric labels, token detail
components, and top-tools text through the existing locale tables.

## Alternatives considered

- Keep the rail search as a horizontal label/input row: rejected because the
  recorded desktop rectangle showed the input escaping the 176px rail.
- Keep the Work split at every desktop width: rejected because five task
  columns become unreadable at the observed intermediate width.
- Continue rendering raw minutes or hardcoded English labels: rejected because
  the result overstated the meaning of a timestamp span and failed Chinese UI.

## Consequences

At wide desktop widths the search control is fully visible and focusable; at
intermediate widths Work remains readable by stacking, and narrow layouts keep
the existing responsive table and hidden rail search. Duration values retain
their source milliseconds and become shorter (for example `6h 35m` and
`9d 4h`). Provider, protocol, token calculations, and canonical identifiers
are unchanged.

## Verification

- Focused duration, SSR localization, hierarchy, and layout-hook tests cover
  seconds/minutes/hours/days, invalid and zero inputs, the shared localized
  helper in both session metrics and Work elapsed, English/Chinese metric
  output, and the 1280/1240/768 CSS boundaries. A live Chinese browser check
  then exposed the remaining English `9d 5h` session-metric value; the helper
  now closes that gap while keeping the English library-card contract.
- `npm run build`, `npm run typecheck`, `npm test`,
  `npm run check:governance`, and `git diff --check` passed for the P6 source
  and test changes. `npm run qa:e2e` completed against real OpenCode session
  `ses_14dd3a011ffeW1Jlye0HNER7TG`, including Work, Conversation, Events,
  reasoning, tools, subagent exports, responsive detail, and browser errors.
- Live browser checks after restart covered 1280/1024/768/320 across English
  dark and Chinese light/dark views. The rail search stayed within its 176px
  rail with a visible focus outline, Work stacked at 1024px, status and
  Evidence stayed intact, and every checked viewport kept document scroll
  width equal to viewport width. Chinese metrics rendered `9天 5时` and Work
  elapsed rendered `6时 35分` from the shared localized helper. A reviewer
  reproduced a 6px overflow at the former 1101px boundary; the Work-only
  breakpoint was raised to 1240px, then 1101/1240/1241 were rechecked with no
  overflow and the expected stacked/side-by-side transition.
- The E2E run also exposed that an absent deep ToC target was serialized as
  `""` and treated as non-empty by the shell. The QA guard now uses a boolean,
  so active-parent assertions run only when a deep target actually exists.
- No `src/providers/**` or provider fixture was changed.
