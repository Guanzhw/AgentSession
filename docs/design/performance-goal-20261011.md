# Sustained page and MCP optimization, 2026-10-11

## Objective and baseline

Continue improving AgentSession 3 page and MCP performance until the marginal
benefit of the remaining candidates is clearly small relative to added
complexity. Start from `1087db7d43bc643fb267112b112639ae41215e29` and the
[first performance pass](performance-pass-20261011.md).

Keep provider data read-only, exact content and canonical references intact,
complete Reader outline hydration automatic, and source freshness checks valid
for rewrites, truncation, append, child dependencies and source selection.

## Measurement and acceptance

- Freeze task-owned inputs before comparing executables. Retain source hashes,
  executable hashes, ordered output digests and individual measurements.
- Measure fresh-process / derived-state first Reader bootstrap (OS file-cache
  state is not controlled), repeated bootstrap, complete outline traversal,
  bounded MCP timeline/context/content, CPU time and peak working set.
- Use alternating baseline/candidate runs in a quiet task window. Distinguish
  product measurements from parser/algorithm microbenchmarks and retain noise
  and unsuccessful experiments. OS file-cache state is uncontrolled, so do not
  treat latency values from different rounds as a direct before/after series.
- Accept changes only with matching output and relevant affected-surface checks.
  A reduction in returned information does not qualify as a performance gain.
- Prefer subtraction and ownership transfer before introducing retained caches,
  new contracts or additional parser modes.

## Iteration and stopping rule

Rank candidates from the measured remaining cost. Implement independently
measurable changes, compare them with the previous accepted version, and repeat.
An improvement must exceed observed paired noise or show a clear reduction in
allocation/peak memory or code complexity.

Treat two successive promising small candidates with at most roughly 5% latency
or CPU improvement, inconsistent paired wins and no meaningful memory or
simplification benefit as evidence of diminishing returns. This is a practical
decision rule rather than a guaranteed statistical threshold. Check the largest
remaining bottleneck before stopping; record why further candidates would need
disproportionate state, freshness or protocol complexity. Do not infer saturation
from a single fast fixture or an exhausted work session.

## Current candidate order

1. Move owned Codex payloads into normalized events and avoid parsing irrelevant
   tool arguments in process tracking.
2. Reuse the Reader outline's canonical-event map across batches and avoid
   redundant expansion reconciliation when all turns are collapsed.
3. Measure compaction string construction, repeated timestamp parsing and
   repeated child-header reads.
4. Reconsider parser consumer modes or retained snapshots only if measured
   residual work justifies their additional contracts.

## Results

### Round 1 — accepted payload and outline changes

The source was a frozen real Codex session of 917,848,369 bytes with SHA-256
`878ae36e1999eb615856bf96a458357e15803e4e839b4788ba784e2edcd8c4db` and
29,305 events. The comparison starts at `1087db7` and measures the payload
ownership move plus the name guard. The source remained read-only.

| Surface | Baseline → candidate | Output and scope |
| --- | --- | --- |
| Isolated projection, same test binary, 3 pairs | Median 375.756 → 244.348 ms; peak working set 627.535 → 500.145 MiB | All 29,305 events; ordered digest `45dad09fd20b1c5dac1452b76132cb97e7a25b143ce910230e640145ac8b7b0c` matched in every run. |
| HTTP full bootstrap, 3 pairs | Fresh-process / derived-state first bootstrap median 5,389.031 → 5,292.665 ms; peak working set 628.926 → 500.832 MiB | All 29,305 TOC entries matched. The OS file cache was not controlled. |
| MCP, 14,015,495-byte frozen source, 5 pairs / 120 calls | Timeline 10: 129.775 → 125.798 ms; timeline 50: 131.203 → 128.965 ms; filtered query: 131.840 → 126.771 ms; context: 128.643 → 124.650 ms. Median peak working set 105,951,232 → 94,781,440 bytes. | Source SHA-256 `4f282a1a0f131502dffff30a4bced3e920db9dac6376b7ea6fe6307584216509`; all four structured gold results matched exactly. Response sizes stayed 5,120 / 26,760 / 5,198 / 2,851 bytes. |
| Reader UI merge algorithm | 373.808 → 44.899 ms, 11 paired trials | 29,145 entries in batches of 512; exact entries, groups, and expansion state were preserved. This measures the merge algorithm only, not browser paint or end-to-end UI latency. |

The persistent UI Map retains canonical key strings and entry references; it
does not copy message payloads. Browser heap and paint time were not separately
measured, so the algorithm result does not establish an overall browser-memory
or page-latency reduction.

### Round 2 — compaction direct-append rejected

The direct-append compaction candidate was reverted. Across 3 HTTP pairs,
candidate bootstrap times were 5,403–5,421 ms against baseline 5,337–6,012 ms;
there was no stable latency improvement and peak working set changed by only
about 1–2 MiB. The bounded MCP source contained no compaction. Its 0–2% timing
differences serve as a noise control, not evidence for this candidate.

The header-fanout probe ran 72 calls over 3 pairs with 500 unrelated headers;
paired results repeatedly flipped. It does not support removing freshness
scans. A timestamp parsing microbenchmark on the 14 MB source measured an upper
budget of about 2.5 → 0.8 ms for repeated parsing; this is microbenchmark-only
evidence and does not establish a product-level gain.

### Round 3 — observer timestamp reuse retained as a small mechanical change

Against Round 1, HTTP first-bootstrap medians were 8,381.098 → 8,405.511 ms.
The three paired candidate-minus-baseline differences were +410.958, −416.087,
and −71.267 ms, so the result is unstable and shows no HTTP gain. All 29,305
ordered entries still matched.

On the same bounded MCP source and 5-pair / 120-call workload, medians were:
timeline 10, 149.210 → 143.002 ms; timeline 50, 149.881 → 147.958 ms;
filtered query, 146.094 → 148.373 ms; context, 145.798 → 141.759 ms. Median
peak working set was 94,838,784 → 94,748,672 bytes and workload CPU was
1.78125 → 1.734375 s. All structured outputs matched exactly and the source
hash was preserved. These small, mixed timings do not establish a material
product performance gain. Keep timestamp reuse as a small mechanical change
without retained state.

### Round 4 — lazy evidence retained; optimization pass stopped

Deferring Evidence construction and avoiding lowercase temporary strings reduced HTTP first-
bootstrap median from 6,593.051 to 6,350.233 ms (about 3.68%) across 3 pairs.
Baseline times were 6,927.628 / 5,609.957 / 6,593.051 ms; candidate times
were 6,887.765 / 5,478.794 / 6,350.233 ms. Median workload CPU was
7.875 → 7.953 s and median peak working set was 500.016 → 500.613 MiB, so
there was no CPU or memory improvement.

On the same bounded MCP workload, medians were timeline 10, 123.180 → 119.949
ms; timeline 50, 124.602 → 120.581 ms; filtered query, 125.785 → 120.265 ms;
context, 123.104 → 120.167 ms, about 2.4–4.4% lower. Workload CPU was
1.46875 → 1.4375 s and median peak working set was 94,851,072 → 94,912,512
bytes. All 120 structured results matched exactly and the frozen source hash
was preserved. Retain this small evidence-allocation change; its bounded MCP
improvement and simpler evidence handling do not warrant a retained cache.

The fresh-process figures vary across rounds and OS file-cache state was not
controlled, so the Round 1, Round 3, and Round 4 HTTP medians are not a direct
cross-round speedup series.

### Final equivalence and stopping decision

The frozen real session remained 917,848,369 bytes with the same source SHA-256.
After the source-path migration, same-path baseline and final snapshots both
produced digest
`9ea3ded5100db1fbd961b917a2afed691852d933cf2172a4e0690bfbcab518a3`. The
earlier digest
`45dad09fd20b1c5dac1452b76132cb97e7a25b143ce910230e640145ac8b7b0c`
reflects the source-path/scope revision during migration. The final oracle was
rerun at the matching source path, with no output fields removed or
normalized away. On the real session, baseline `1087db7` and Round 4
returned identical structured results for timeline-10 and context (before 2,
after 2): 4,121 and 1,311 response bytes respectively, with unchanged hashes
and source hash.

Stop this optimization pass after the payload ownership move, timestamp reuse,
and lazy evidence change. Round 2 was rejected, Round 3 was marginal and
unstable, and Round 4 showed small bounded MCP gains alongside a modest HTTP
improvement without lower CPU or memory. The largest remaining work is parsing,
hashing, and freshness validation, which must continue to preserve exact facts
for rewrites, truncation, appends, child dependencies, and source selection.
Removing those checks or introducing retained caches / parser consumer modes
would require substantial new memory, invalidation, or protocol contracts;
the header-fanout result does not justify that tradeoff. This is a practical
diminishing-returns decision for the measured scope, not proof of an absolute
performance optimum or closure of all acceptance and platform gates.

### Verification status

The final real-source native acceptance comparison matched both structured
outputs exactly for baseline and Round 4. After the navigation correction below,
the rebuilt executable SHA-256 was
`9fa1825d31b32dc27c3cfdb3dbf7351ce6ef691c46fb99f8c3ae09e76f7af6ab`;
the same real-source MCP comparison again matched both complete structured
results and preserved the source hash. The Codex release test evidence reports
109 passed and 12 explicitly ignored.

The first full gate exposed a compaction-disclosure test reading its preview
before Svelte finished rendering after native close. Wait for the closed
disclosure and restored preview, then keep the original canonical-ID and full
text assertions. The corrected reading-experience suite passed in the next gate.

Initial full-gate attempts also timed out before child search results and on a
Claude Runtime Context return link. Child click diagnostics preserved the input
node and query, but recorded the native click landing on an article/body during
scrolling, with no submit or search request. Remove the root's global smooth
scrolling so automatic focus and positioning finish immediately. Temporary
diagnostics were removed; the original keyboard/mouse search test is unchanged.
Six sequential paired child checks passed (12/12), and the original Claude
checkpoint return check passed three times with the rebuilt native executable.
The initial Claude failure had no click trace, so its exact cause is not claimed.
These navigation checks do not add a measured performance gain to the tables.

Desktop browser QA used the existing regression-test workflow. The final
`npm run ci:quality` run exited nonzero: Rust passed 237 core and 5 app tests
with 16 ignored; Node reported 713 passed, 1 failed and 46 skipped. All original
child keyboard/mouse navigation, Claude checkpoint return, compaction disclosure,
complete ordered outline and late-target collapse checks passed in that run.

The sole failure was `standalone tool cards continue loading complete multi-page
input and output`: `agent-browser open` timed out before target-page navigation
or any behavior assertion. Its unchanged focused rerun passed 1/1, including
complete input/output content and pagination-offset assertions. That test builds
the same unchanged UI source and dependencies against mock API data; it does
not consume the native executable. Matching successful full-run checks and the
focused rerun cover the 714 non-skipped Node cases individually. They do not
establish a fully successful `ci:quality` run or long-suite browser startup
stability. The startup timeout's cause remains unknown; skipped and ignored
checks retain their stated scope gaps.

Independent implementation and evidence-reuse reviews found no unresolved
product-code issue in this delta. The existing instance on port 3457 still runs
the prior build. Automatic approval rejected this task's instance replacement
without a detailed reason, so activation on that instance requires a restart.

### Cleanup result

The verified cleanup freed 11,548,101,369 bytes (about 10.755 GiB). Repository
size excluding `.git` fell from 16,662,474,903 to 95,234,439 bytes. Historical
unique-session/provider/evaluation evidence was archived under
`D:/CodexArtifacts/OpenSession/20261011-cleanup`; current performance evidence
was moved to `D:/CodexArtifacts/OpenSession/20261011-performance`. The
unrelated `Skills-evolve.md` was deleted. A final sweep after validation archived
25 regenerated test-output files (168,403 bytes) with matching SHA-256 hashes.
The repository then occupied 111,635,094 bytes (about 106.46 MiB), excluding
`.git` and including the current release/UI build and dependencies. Its `tmp/`
retains only the executable used by the active instance. Historical fixtures,
migration checks and source-linked design evidence still have consumers and
remain; the 3.0 runtime is the sole implementation. These storage results are
separate from the performance candidate measurements.
