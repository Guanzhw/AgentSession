---
status: implemented
date: 2026-09-30
decision: Restore cross-provider Library batch management with canonical provider/session identity and absolute star state updates.
---

# Cross-provider Library batch management

## Context

The 2.0 Library supports batch actions across providers through `POST /api/sessions/batch`. An earlier 3.0 candidate rejected that route, leaving a Library-wide management task unavailable. In 3.0 the loaded Library includes roots, children, and unlinked readable sessions, while unavailable-source rows carry diagnostics. On 2026-09-29 the user chose to keep diagnostic rows visible and disable their selection.

## Decision

Restore the global batch route and Library controls. Identify every item by `provider + canonical session ID`; allow selection only for loaded, readable sessions whose provider supports local management. Group requests by provider, deduplicate IDs for writes, and split each provider group into chunks of at most 100 IDs. The response count reflects the original requested IDs for manageable providers. Write star/unstar as absolute state within one SQLite transaction per provider chunk.

## Alternatives considered

- Keep only provider-specific batch calls: this would not restore the 2.0 cross-provider Library workflow.
- Hide unavailable-source diagnostics in management mode: the user chose visible, disabled rows so their status remains clear.
- Toggle star state from a pre-read value: this leaves concurrent requests able to overwrite one another; absolute star/unstar writes remove that race.

## Consequences

Selection preserves canonical identity across roots, children, and unlinked sessions. Diagnostic rows remain visible but cannot be selected. Duplicate requested identities are written once per provider chunk, while `affected` reports the original request count. A star/unstar chunk commits atomically; a cross-provider request spanning multiple chunks is not a single transaction. Viewer management writes only local metadata and leaves provider-owned files read-only.

## Verification

- The exact Windows `524f612a` package passed its 410-case serial Node regression (381 pass, 0 fail, 29 conditional skips); both HTTP-08 batch tests passed. The UI batch test covers loaded-row selection, diagnostic gating, a 104-row case, request errors, and refresh behavior. See full regression log (`../../../tmp/v3-delivery/full-v3-node-524f612a-atomic.log`, local evidence), [UI test](../../../v3/test/ui-library-batch.test.mjs), and [HTTP-08 test](../../../v3/test/http08-cross-provider-batch.test.mjs).
- The exact Windows package's initial real-browser run loaded five Reader pages and exercised a 40-row Codex Library: 39 rows were selectable, one diagnostic row was disabled, and star/unstar, delete confirmation/cancel, and restore passed. The 846-source-file digest was unchanged and the scratch process stopped. See browser evidence (`../../../tmp/v3-delivery/browser-524f612a-atomic/evidence.public.json`, local evidence).
- The Linux x64 archive audit reports offline Cargo tests of 172 core and 6 app cases (14 ignored), plus 53 focused Node cases against both the release and extracted executable (45 pass, 8 skipped each). Isolated OpenCode reported seven tools; MCP and Web HTTP reads passed across five providers. The provider corpus digest was unchanged. See Linux audit (`../../../tmp/v3-delivery/linux-x64-absolute-star-final-20260929/FINAL.md`, local evidence).
- Independent source review found no actionable regression. Extended WEB-16 acceptance (`../../../tmp/v3-delivery/browser-524f612a-web16-full/FINAL.md`, local evidence) covers five-provider management, 137 selected roots/children across pages, a disabled diagnostic, a real unlinked row, locked-metadata HTTP 500/retry, and submitted-search refresh. It explicitly combines the preserved workflow attempt with remaining checks in the same scratch state.
- Exact HTTP-08 acceptance (`../../../tmp/v3-delivery/http08-524f612a-closure/http08-524f612a-closure.public.json`, local evidence) covers 30 individual requests, seven mixed-provider batch requests, concurrent same-action star, stable repeated-star timestamps, rejected mutation boundaries, metadata/schema preservation and isolated fixed-2 rollback. WEB-16 and HTTP-08 are P under their recorded contracts; provider source digests remained unchanged.
- Desktop locale/theme supplement (`../../../tmp/v3-delivery/web16-locale-theme-524f612a/FINAL.md`, local evidence) passed 20 real five-provider English/Chinese light/dark cases, four keyboard focus/Space cases and the reduced-motion check without management mutations.
