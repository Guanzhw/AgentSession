---
status: implemented
date: 2026-09-30
decision: Restore user tokenPricing configuration and runtime editing, and apply source-backed cost estimates uniformly across the five providers.
---

# User-supplied token pricing

## Context

Confirmed 2.0 accepts top-level `tokenPricing`, applies Settings saves immediately,
and estimates the selected OpenCode `modelProvider/model` pair. Source owners are
`src/config.ts`, `src/stats-cost.ts`, and `src/routes/settings-stats-trash.ts`.
The file-provider Stats builder explicitly returns no estimate in 2.0. The 3.0
startup parser rejected this field with no accepted removal decision.

The user explicitly chose uniform support for all five providers. This extends
the old OpenCode estimate scope while restoring the existing config and runtime
editing behavior. Model vendor attribution remains provider-owned evidence.

## Decision

The app validates user JSON at config/Settings boundaries, including required
currency/input/output rates, optional non-negative finite rates, source metadata,
and exact vendor/model mapping keys. Runtime pricing joins the existing atomic
merged-file save, retaining startup, project-path, resume, and MCP fields.
The app uses `url` 2.5.8 to validate absolute HTTP(S) source URLs with Unicode
hostnames, paths, and spaces, preserving the original user metadata. This
standards parser is needed to retain the 2.0 WHATWG URL boundary; request-URI
parsing was demonstrated to reject accepted 2.0 input.
The core aggregates selected normalized request dimensions in the same loop as
Stats. It estimates each known positive dimension with its user rate; zero-rate
dimensions retain their token count and zero cost. Unknown dimensions and
positive dimensions lacking a rate are omitted explicitly. With no priced token
evidence, `totalCost` remains null. A non-finite arithmetic result fails explicitly.
All-provider routing uses the same schema-neutral core projection.

The existing adapters normalize cache versus input and reasoning versus output:
Codex subtracts cache/read/write and reasoning subsets; Claude and DSH subtract
reasoning subsets; OpenCode and Pi use their separate source dimensions.
Pricing trusts those normalized contracts. It never substitutes a session storage
provider ID for an absent model vendor and includes no vendor price catalog.

## Alternatives considered

- Keeping only OpenCode estimates would preserve the narrow 2.0 scope but would
  not implement the user's chosen uniform support.
- Inferring a vendor from a session provider or model name would fabricate the
  exact pricing identity and conceal missing provider evidence.
- Treating absent token dimensions as zero would turn missing evidence into a
  numerical claim.

## Consequences

Settings renders a JSON pricing editor; Stats renders normalized estimates,
source metadata, dimension costs, and omitted dimensions. No selected model,
missing vendor attribution, absent pricing, and no priced token evidence have
distinct explanations. Coverage and excluded-source diagnostics remain visible.
Known vendor/model identity is required for an estimate in every provider.
Provider-owned vendor attribution restoration is reviewed separately.

## Verification

The new `v3/test/token-pricing-settings.test.mjs` first failed 0/2 because startup
rejected `tokenPricing`; RED is recorded under
`tmp/v3-delivery/token-pricing-restoration/red.log`. The focused HTTP tests then
passed 8/8 with existing Settings and project-path tests: startup/load, same-origin
save, price updates without restart, source metadata, exact vendor/model selection,
rate/dimension omissions, explicit zero rate, no-evidence null total, invalid
input rejection with byte-identical disk state, preservation, and restart.
The core arithmetic test and Svelte production build passed. Source-backed test
input is a synthetic OpenCode v2 SQLite schema; no actual provider source or
default Viewer state was modified. Exact-package real-provider/browser validation
remains owned by the enclosing delivery work and is not claimed here.
Revision: `50a32e7c5b3fdaa1d335771da80d6c919d4ab536` plus the uncommitted 3.0 tree.

Fixed 2.0 `validateUserConfig()` accepted an uppercase HTTPS URL containing a
Unicode hostname, path, query, fragment, and space (`v2-url-oracle.log`). The
restoration test recorded a 400 RED result with the HTTP URI parser
(`url-red.log`); the URL parser and offline lock/build resolved the compatibility
gap. The focused regression run passed 29 tests with 8 existing opt-in tests
skipped. Full Rust tests passed 173 core and 6 app tests, with 14 existing
ignored tests. `npm run review` and `git diff --check` passed. Final exact-package
real-data/browser results belong to the enclosing delivery evidence.

The subsequent exact Windows portable `91f2d58a` passed the complete serial Node
suite (402 pass, 0 fail, 30 explicit skips). Its
browser pricing report (`../../../tmp/v3-delivery/ui-token-pricing-integration-20261001/report.md`, local evidence)
covers Settings/Stats in English/Chinese and light/dark, exact vendor selection,
unknown/omitted dimensions, same-model provider changes, stale-tab preservation,
invalid-save disk preservation, keyboard interaction and zero axe violations.
Earlier contrast and Chinese-label failures are retained as separate attempts.
The five actual-source pricing check (`../../../tmp/v3-delivery/real-pricing-91f2d58a-20261001/report.md`, local evidence)
uses synthetic user rates and independent raw/component arithmetic: four known
vendor/model estimates match, Claude's absent vendor remains unavailable and
DSH's absent cache-write remains omitted. Original/copied source bytes and
protected comparison state are unchanged. These establish selected-record
pricing behavior rather than a vendor price catalog or complete usage attribution.
