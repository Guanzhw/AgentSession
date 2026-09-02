---
status: implemented
date: 2026-09-03
decision: Expose bounded usage-origin accounting on the Execution projection (per-component total/classified/unclassified/complete), keeping authoritative totals, usageRecords, and the Session Protocol v3 provider input contract unchanged; provider-native origin mapping stays pending because the seven-provider audit (2026-09-03 snapshot: then-current adapters/fixtures/local snapshots) found no per-request context-origin evidence, with newer upstream versions (OpenClaw SQLite, DSH alpha.5, Pi 0.84.4) still pending/unknown.
---

# Bounded usage-origin accounting

## Context

`SessionProtocolV3.UsageRecord.contextOriginSlices` (`direct | inherited |
shared`, per input/cache component) was defined by the protocol and validated,
but the bounded Execution projection exposed neither the raw slices nor an
aggregate, so origin ownership could not be consumed by any UI. The Codex
native v3 mapping (2026-09-02) records usage components only and confirms Codex
records no request context origin slices. The next core backend stage
(`docs/prompts/backend-evolution/01-usage-origin-slices.md`, task A) requires
the projection side to deliver first, without inventing a three-way split when
provider evidence is absent.

Product semantics that drive the contract (unchanged from the spec):

- A `UsageRecord` is one real model request and is counted exactly once;
  inherited/shared input and cache reads are still the request's consumption
  and never removed from authoritative totals.
- Inherited copied history is not a new request and must never become new
  background/child tokens.
- Origin slices apply only to input/cacheRead/cacheWrite, never
  output/reasoning.
- Missing origin slices must not be treated as authoritative zero.

## Decision

Add an `origins` object to the Execution projection's `usage` aggregate
(`src/protocol-runtime-v3.ts`, `UsageOriginAggregate`), computed over the same
projected request record set the authoritative totals use:

- Per component (`input`, `cacheRead`, `cacheWrite`):
  - `total: number | null` mirrors the aggregate component value (null when
    the projected records have unknown components or unknown coverage).
  - `classified: { direct, inherited, shared }` sums only inspected recorded
    slices — a known lower bound; `0` means "no slices recorded/inspected",
    never "usage has no origins". The field name documents that it is
    classification, not a claim of full partition.
  - `unclassified: number | null` = `total - sum(classified)` only when the
    whole protocol usageRecords set was inspected (`recordsTruncated` false),
    the slice scan was not cut (`slicesTruncated` false), and `total` is
    known; otherwise null.
  - `complete` true only when nothing was omitted, total is known, and
    `unclassified === 0`. A known-zero component with no slices is complete.
- Top-level `origins.complete` requires all three components complete. It
  states only the completeness of the origin partition over
  input/cacheRead/cacheWrite; it does not mean the aggregate knows
  `usage.total` or that the whole usage aggregate is complete. Consumers must
  check `usage.complete` (aggregate-level completeness) separately.
- Flags kept small: `inspectedRecords` (identical to `usage.requestCount`),
  `recordsTruncated` (protocol usageRecords omitted by the global maxItems
  bound), `slicesTruncated` (the slice scan stopped at maxItems).

Bounded construction: the slice scan is independently capped at `maxItems`
slices across all inspected records, stops on the first bound hit, and never
enumerates `sourceSessionRefs`; the aggregate output is fixed small size.
Raw `contextOriginSlices` stay off the public `usageRecords` (unchanged
`publicUsage`).

Coverage semantics:

- `observed` + records with no slices + nonzero components → `classified`
  zero lower bound, `unclassified` = known component total, `complete` false
  (exactly the current Codex expectation).
- `not-observed` + 0 records → totals/classified/unclassified known zero,
  `complete` true.
- `unknown`/`unsupported` + 0 records → totals null, `unclassified` null,
  `complete` false.
- Full slices → exact classified totals, `unclassified` 0, `complete` true.
- Partial slices, null components, request omission, or slice truncation →
  `complete` false; no fabricated full partition ever.

The Session Protocol v3 provider input contract is unchanged: no validator gap
was found for this stage (slice bounds, forbidden components, coverage
contradictions are already enforced).

## Provider audit (evidence only, no mapping written)

No provider-native origin mapping was added: the audit of all seven providers
within the **2026-09-03 snapshot scope** (then-current adapters, fixtures, and
locally verified samples) found no per-request input/cache context-origin
slice evidence. This negative conclusion holds only for that snapshot: newer
upstream versions not yet schema-refreshed (OpenClaw `openclaw-agent.sqlite`,
DSH alpha.5, Pi 0.84.4, others in the evidence-matrix freshness snapshot)
remain **pending/unknown**, not "no slices".

- Codex: confirmed none in the 0.151 alpha verified snapshot — usage records
  carry normalized components and an explicit empty `contextOriginSlices`
  array. 0.152.1 refresh pending.
- DeepSeek Harness (alpha.3): `seedLength`/`inheritedEventCount`/session
  `end-seed` and the owned suffix are session/context inheritance boundaries,
  not per-request token origin slices; not mapped. alpha.5 refresh pending.
- Claude Code (2.1.207 evidence), OpenCode (1.17.11 evidence), Pi (0.80.10
  evidence), OpenClaw (JSONL evidence), Hermes (v0.19.1 local `840fb55a`
  evidence): per-message/session token components only (input/output/cache
  read/cache write/reasoning); no request-context-origin record in the
  snapshot.

## Alternatives considered

- Expose raw `contextOriginSlices` on public `usageRecords`. Rejected: a
  request with many slices would bypass the projection bound; the protocol
  spec already excludes nested relation arrays from public entities.
- Interpret recorded zeros (`classified` 0 on origin-less records) as
  authoritative. Rejected: it violates "missing evidence is not 0"; the
  Codex-style row stays `unclassified = total, complete: false`.
- Compute `unclassified` from the projected prefix even when later protocol
  records were omitted. Rejected: a remainder claim requires a fully inspected
  record set.

## Consequences

`GET /api/:provider/session/:id/runtime/execution` now carries `usage.origins`
with the semantics above; existing `usage` totals and `usageRecords` are
unchanged, so no UI/static change is required. Current providers report
`complete: false` with `unclassified = total` where recording exists, exactly
as the spec requires. Provider-native mapping (evidence-driven, per
`evidence-matrix.md`) remains open and is not blocked by this stage.

## Verification

- `npm run build` clean; focused `test/protocol-runtime-v3.test.mjs` (12/12,
  including exact full partition across records/origins, partial slices with a
  known remainder, origin-less Codex-like records, null component,
  not-observed vs unknown/unsupported empty, request omission by the global
  maxItems bound, and a 1000-slice record proving the bounded scan).
- Broader protocol/route suites (protocol-runtime-v3-routes, protocol-integration,
  session-protocol-v3, runtime-workbench, codex-v3) pass; `npm test` full suite
  and `npm run review` (governance + typecheck) pass; `git diff --check` clean.
- Real-data spot check (**2026-09-03 observation**, for that build, on
  `GET /api/codex/session/01a0576a-98e2-7c31-a265-6d98d5fbff12/runtime/execution?maxItems=300`):
  version 3, domain `execution`, completeness `complete`; projection
  `truncated=true`; `usageCoverage` `observed`; `usage.requestCount=260` and
  `usage.complete=false` with `input=979115`/`cacheRead=32689536`/
  `cacheWrite=0`/`output=48594`/`reasoning=27029`/`total=33744274`;
  `origins.complete=false`, `inspectedRecords=260`, `recordsTruncated=true`,
  `slicesTruncated=false`, all three `unclassified` null, and `classified`
  direct/inherited/shared all zero recorded lower bounds. Interpretation: the
  global `maxItems` bound was consumed by actors/runs/relations, leaving only
  260 usage records — an honest records truncation (not origin slice
  truncation), so no complete three-way partition can be claimed. These
  totals are an observation of that day and will grow; they are not protocol
  constant facts.
- `docs/specs/work-graph-protocol/design.md` (API semantics + Evolution backlog
  item 1 status), `evidence-matrix.md` (provider audit), `docs/design/ui-v2.md`
  §7, and `docs/prompts/backend-evolution/01-usage-origin-slices.md` /
  `docs/prompts/README.md` are updated to the realized facts.
