---
status: implemented
date: 2026-10-12
decision: Count source-verified Codex cumulative token consumption separately from request identity and default Statistics to tokens.
---

## Context

Ordinary Codex `event_msg/token_count` events lack response IDs. The
[request-identity decision](2026-09-29-v3-codex-unresolved-usage-observations.md)
therefore left legacy-only sessions with zero known tokens. Users need the
recorded consumption even when request identity is unavailable. The
[rejected legacy request promotion](../rejected/2026-09-29-v3-codex-legacy-accounting-chain.md)
remains relevant: token consumption does not prove a request count.

OpenAI Codex revision `6e5f665feb9b71e1500a5721036fbdb8e871f4b0`
[accumulates total usage and replaces last usage](https://github.com/openai/codex/blob/6e5f665feb9b71e1500a5721036fbdb8e871f4b0/codex-rs/protocol/src/protocol.rs#L2433),
and [rate-limit updates resend the existing token info](https://github.com/openai/codex/blob/6e5f665feb9b71e1500a5721036fbdb8e871f4b0/codex-rs/core/src/session/mod.rs#L4996).
Summing every last-usage occurrence overcounts these snapshots.

## Decision

Codex owns a consumption projection on `usageObservations`. A complete,
arithmetically consistent cumulative advance contributes only when its token
vector equals the recorded last-usage vector. Unchanged snapshots contribute
nothing. Source ownership and recorded child boundaries remain mandatory.
An inherited prefix supplies a baseline without contributing child tokens.
Direct spawned children can establish a zero origin; recorded forks require an
inherited baseline. Copied parent model settings are cleared at the owned task
boundary, while already recorded child settings are preserved.
Unknown or inconsistent transitions preserve missing consumption rather than
inventing requests. An unproved rollback or partial cumulative snapshot ends
the owned consumption epoch; later anonymous snapshots are retained without
extending its known subtotal. Parent prefix discontinuities affect only the
inherited baseline, not the child's own accounting epoch.
Mixed canonical/legacy streams retain canonical accounting
until mirror membership is proved.

`consumptionTokens`, recorded model settings and model provider accompany the
observation. Consumption is derived from the anchored recorded vectors; model
settings retain `turn_context` or `thread_settings_applied` provenance, rather
than asserting server-confirmed model selection for every response.
Shared Stats consumes normalized contributions, including them in
known token subtotals and day/model/export totals without increasing recorded
request counts. Codex Library summaries include the same contributions. Derived
catalog, provider and Stats cache versions change with this projection.

Statistics defaults to tokens for daily trend, Harness comparisons and model
distribution. The metric switch updates all three; activity insights that use
request counts retain explicit request labels. Token subtotals lead the KPI row.
Codex canonical header parsing also restores the supported `session_id` alias
after `id`, consistently across discovery and source authority.

## Alternatives considered

Requiring response identity for consumption hides the ordinary Codex format.
Summing last-usage events repeats rate-limit snapshots. Promoting each increment
to a request conflates consumption with identity. Combining canonical and
anonymous totals without a source link can count mirrors twice.

## Consequences

Legacy-only sessions can expose useful, auditable token subtotals while request
counts remain zero. Observations and partial coverage remain visible. The
changed contract does not resolve ambiguous mixed sources or prove full-corpus
coverage. Fresh-machine tests reproduce the legacy-header failure; actual
new-machine configuration has not been supplied.

## Verification

`npm run review` and the final locked Rust workspace tests pass: 258 core and
5 app tests, with 18 explicitly ignored private/source-specific cases. The full
serial Node run executes 799 cases: 750 pass, 48 conditional skips and one
portable-artifact failure from the task's initially unremapped binary. After
correcting the isolated build's parameter construction, the four standalone
artifact cases pass against the final remapped release. The successful
unaffected source/transport checks are reused; the final UI/locale browser
checks pass 10/10 against the remapped release.

The [read-only real-source oracle](../../../tmp/token-accounting-20261012/report.json)
(local evidence) compares Library, Stats overview, UTC daily disjoint components,
recorded model, model filter, all-Harness composition, JSON and CSV at
4,847,217 tokens. A naive last-usage sum is 4,987,301: two repeated snapshots
overcount 140,084. Original and frozen source SHA-256 stay equal. The final
release also returns the same `tokenCount` through actual native stdio
`session_browse` and `session_get`.

Fresh-machine default home, `CODEX_HOME`, legacy-header and archive-only HTTP
checks pass without a Codex state DB. Direct-history-base alias combinations
pass with revision v6. Independent review closed the owner/model, fork/prefix
baseline, rollback and provenance findings. Desktop English/Chinese QA checks
the token default, metric switch, model/Harness shares and day drill. Runtime
and public fixtures remain source-read-only. These are bounded Windows/source
results; mixed streams and the user's actual new machine remain outside them.
