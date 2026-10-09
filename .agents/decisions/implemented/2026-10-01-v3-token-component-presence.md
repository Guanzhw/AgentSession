---
status: implemented
date: 2026-10-01
decision: Preserve recorded token component presence at provider boundaries before pricing
---

# Token component presence

## Context

User-supplied rates consume disjoint `UsageTokenComponents`. OpenCode normalized
absent input/output/reasoning fields to zero; a recorded cache-read-only request
therefore produced a false zero-cost estimate when only input/output rates were
configured. Claude and Pi also manufactured zero fields, and Codex subtracted
unrecorded cache/reasoning subsets as zero. The checked-in Pi request fixture
and frozen Claude transcript actually omit reasoning breakdowns. Historical DSH
settlements can omit cache-write and total fields.

## Decision

The [owning provider adapters](../../../v3/crates/core/src/providers/) retain
absent components as `None` and explicit zeros as `Some(0)`. OpenCode components
are independent recorded dimensions. Claude/Pi output and Codex output include
reasoning; disjoint output requires a recorded reasoning subset. Codex input
requires its recorded cache subsets. Claude cache-creation subcategories must
both be present before their combined cache-write amount is derived. The
[official Claude usage description](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)
confirms that `output_tokens` includes thinking and that the optional details
provide the subset. Codex's native `TokenUsage` is a verified exception:
[`cache_write_input_tokens` has a serde zero default](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/protocol/src/protocol.rs#L2241-L2254).
That default applies only when its other five required canonical fields establish
the native shape and the cache-write field is absent. Partial historical rows,
legacy aliases and explicit null/malformed cache-write fields stay unknown.

Claude and Pi recorded totals must meet the known lower bound when independent
categories are missing, and match exactly when all independent categories are
recorded. Recorded reasoning is part of that lower bound when inclusive output
is unavailable; a partial Claude cache-creation breakdown also contributes its
recorded subcategories. Other providers retain their existing total validation. Inclusive raw input
and output can still establish a Codex total when their individual subsets are
unknown. Pi and historical DSH only derive an absent total when independent
cache categories are also recorded; unrecorded categories prevent claiming a
complete sum. Historical DSH output follows the same recorded-subset rule as
native v3. Request selection, canonical identity, vendor mapping, provenance,
and legacy Viewer session-sum mechanisms remain unchanged.

Changed provider revision namespaces invalidate their derived projections;
Codex Reader and normalization share one private namespace constant. Its direct
source-set namespace remains separately versioned. Stats projection version 8
is owned by the coordinated pricing change. Existing MCP cursors cannot cross
these changed source revisions.

## Alternatives considered

Filling unknown dimensions with zero or allocating their remainder from a total
would fabricate token categories. Keeping inclusive output as disjoint output
would apply an output price to an unrecorded reasoning portion. Changing legacy
Viewer sums to conceal different evidence would alter an unrelated contract.

## Consequences

Pricing receives unknown dimensions honestly and can return a null amount when
no known dimension has a supplied rate. Missing fields and missing rates stay
explicit in the estimate. Frozen Claude keeps one request and recorded input
30,804 plus zero caches; its formerly fabricated disjoint output 13/reasoning 0
become unknown. A frozen historical DSH child keeps one request and every
recorded component; its formerly derived total 13,362 becomes unknown because
both cache-write and total are absent. Native DSH v3's 508 recorded totals and
the inspected legacy large source's 508 explicit totals remain known.

## Verification

- [Five-provider HTTP presence tests](../../../v3/test/token-pricing-presence.test.mjs)
  were initially RED 0/5 on debug SHA-256
  `360a3a124c4282230527638ed89b700c3831757bd57ea20f469e2f6b3f861e45`,
  then GREEN 5/5 on intermediate debug
  `73c4ba122b24fbef4733ef280d9bb5542bb262e3b4f1e1f6f7cfbaa2ea1cc7a0`.
  They cover unknown versus explicit zero, null/partial cost, inclusive totals
  with absent subsets, and a missing independent cache category.
- The final eight cases include partial recorded totals and the native Codex
  zero default. They passed 8/8 on coordinated debug
  `c8e78e786466ede633eaedbccb0637dcba2975f78110a528d5f4e0ff6b1530b3`.
- The expanded request-usage, pricing/settings, foundation, observations, frozen
  v0 and Stats HTTP suite passed 80 tests with 10 explicitly gated cases skipped
  on predecessor `fddb414e74617da0a9a8d4f47312e0f64a863e995d458b4962df7fba880e0d75`.
  The earlier six zero-derived assertions and frozen v0 total expectation were
  corrected against source fields. This evidence is reused: the final binary
  only updates Codex's owning Stats source revision namespace from v9 to v10;
  these provider normalization functions are unchanged.
- `cargo test --manifest-path v3/Cargo.toml -p agentsession-core --locked --offline`
  passed 173 tests with 14 manifest-gated cases ignored. The first run's 20
  failures are retained: one old DSH derived-total assertion and 19 Codex
  failures exposed a mismatched Reader revision salt, corrected by the shared
  namespace constant.
- Seven frozen selected sources across all five providers were checked through
  isolated HTTP processes. Old shared cached state equals fresh final
  projections. Request IDs, counts, models, provenance and source hashes are
  unchanged; each amount is either unchanged or explicitly unknown. The frozen
  full Codex 1,138 requests, Pi one, OpenCode 252 and native DSH 508 retain
  identical component counts and sums. The separately decoded legacy DSH large
  source has 508 explicit totals summing 102,197,093; it has no inferred loss.
- A real read-only stdio MCP call on predecessor `fddb414e` rejects an old Codex timeline cursor with
  `source_changed`, preserves the first source event, and continues a fresh
  cursor. Commands, all failed attempts, hashes and exact component counts are
  retained under ignored `tmp/v3-delivery/token-presence-boundary/`.
- Independent review then constructed partial Claude/Pi usage with input 10,
  inclusive output 4 and recorded total 20. The prior exact comparison dropped
  that total because missing cache categories were treated as zero. Two added
  HTTP assertions were RED 0/2 on the intermediate `73c4ba12` binary. The owning
  total validator now accepts the recorded total against the known lower bound;
  Claude/Pi revisions also invalidate projections made by that intermediate
  binary. Those failed attempts remain in the same evidence directory.
- Primary Codex schema verification established the zero default above at
  upstream commit `67727e7cf114cf3e1b71db368d74b24e32f6cb12`; the captured source
  SHA-256 is `d3d3d384da91b2824c10091de4331a2bc26ec5474887ed0aef1e3f3c4ae110f4`.
  A canonical native usage object with all five required fields and omitted
  cache-write was RED before applying that owner-defined default. This exception
  does not infer zeros from a vendor/model name or from a partial total.
- Final-debug cache verification repeats both the seven-source frozen
  warm-versus-fresh comparison and the intermediate-cache Claude/Pi partial-total
  recapture. The coordinated Codex v10 Stats source namespace also invalidates
  optimized owned-usage projections; its specifically affected historical-cache
  witness is verified separately by the independent reviewer. Release-binary
  verification belongs to the subsequent release gate.
