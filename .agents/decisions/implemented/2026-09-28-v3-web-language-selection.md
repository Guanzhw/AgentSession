---
status: implemented
date: 2026-09-28
decision: Keep Web language selection in the Svelte presentation layer.
---

# Web language selection

## Context

AgentSession 3.0's Svelte shell and pages had English-only controls. WEB-10
requires desktop Chinese and English operation, while provider records, canonical
IDs, and protocol evidence must retain their original meaning.

## Decision

The Web shell offers English and 简体中文. A small typed dictionary in
`v3/ui/src/lib/i18n.ts` owns product copy. The selected language is saved under
`agentsession-v3-language`; the shell applies it to `document.lang` and shares
it with page components. The default is English. Browser history and Reader
routes retain the same preference without adding language to canonical URLs.

Only presentation labels are translated. Provider titles, message bodies,
snippets, paths, IDs, source event kinds, and free-text diagnostics stay as
recorded. Known protocol status, coverage, fidelity, and graph kind labels have
an explicit display mapping; unrecognized values remain visible verbatim.

## Alternatives considered

Adding language to routes would change canonical session URLs and browser
history identity. Translating rendered DOM text after mount could also alter
provider records and diagnostics. A page-owned dictionary keeps those
boundaries explicit.

## Consequences

Language switches update shared UI copy without reloading a session or
resetting its navigation state. Free-text API diagnostics remain English until
their owning server contract has structured, localizable codes; this slice
does not claim complete WEB-10 visual or accessibility acceptance.

## Verification

`v3/test/ui-locale.test.mjs` first failed because the language control was
absent. After implementation it passed against a built Svelte bundle served to
a real browser, covering Library, Reader, Runtime lens labels, Settings,
Statistics, reload, Back/Forward, `document.lang`, English restoration, and
the unchanged provider-owned fixture title. `npm run build` under `v3/ui`
passed. Final embedded Axum browser and repository review results are recorded
in the 3.0 delivery plan.
