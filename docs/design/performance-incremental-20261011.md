# Incremental reading and index reuse, 2026-10-11

The retained change reuses the exact revision calculated during parsing of a
native-authority-selected Codex JSONL. Cold or changed catalog publication reads
the selected file four times instead of six. Unchanged index reuse still avoids
normalization, and final inventory validation still precedes atomic catalog and
search publication. See the [decision](../../.agents/decisions/implemented/2026-10-11-reuse-exact-capture-boundaries.md).

## Paired measurement

All arms use the same independent copy of the frozen real 917,848,369-byte
parent, SHA-256
`878ae36e1999eb615856bf96a458357e15803e4e839b4788ba784e2edcd8c4db`.
A synthetic alternate header and task-owned native authority exercise recorded
source selection. Fresh derived state establishes cold measurements. A controlled
1,024-byte append creates three Reader items and four content fields, then warm
and same-cache process-restart requests verify reuse. Source timestamps and
paths are identical between arms; both the copied and original frozen source
hashes are checked after restoring the append.

Trials run sequentially, without concurrent builds or tests, in B1/C0, C1/B2,
B3/C2 order. The predeclared gate is at least 15% stable improvement in an
affected cold or changed opening path over three alternating pairs, exact
semantic output parity and no material warm regression. Timings end after full
HTTP reception and JSON parsing. They exclude parity walks and do not measure
desktop paint. Filesystem cache and background host activity are uncontrolled.
This isolates one large parent; it does not represent the entire live inventory.

| Trial | Catalog cold baseline / candidate | Append catalog baseline / candidate |
| --- | ---: | ---: |
| B1/C0 | 5,758 / 4,667 ms | 7,897 / 6,052 ms |
| C1/B2 | 5,943 / 4,713 ms | 7,006 / 6,131 ms |
| B3/C2 | 5,774 / 4,803 ms | 7,339 / 6,376 ms |
| Median | 5,774 / 4,713 ms | 7,339 / 6,131 ms |

Cold improvement is 18.4%; each cold pair improves more than 15%. Append median
improves 16.5%, with greater trial variation. Catalog warm medians are 580.8 and
581.0 ms; same-cache process-restart medians are 508.1 and 517.0 ms.

Baseline native artifact SHA-256:
`136c24217edf900d727d5a79f5ca1fc06d5ec3456a630541aae93a25f8166afc`.
The jointly measured catalog and subsequently rejected Reader-hint artifact:
`34aa682b307133a7c902e55824dd720a07d5422d3dcc1c25363f286f89fa5d70`.
The final catalog-only artifact receives an additional ablation below.

## Complete-output parity

Every completed trial checks complete Library and Reader bootstrap JSON,
29,305 base TOC items and 29,308 appended items via all 59 API TOC pages,
26,224/26,227 ordered search rows, complete catalog identity and summaries,
Reader item/relation/placement/execution tables, all content chunks and all
52,234/52,238 reconstructed normalized body/tool fields. Every controlled
appended field is also read through the API and compared with exact expected
Unicode text and its published content hash.

All semantic digests match. The catalog signature intentionally changes to
its private v2 composition; its digest is compared separately from the complete
summary. Public revisions remain equal. Complete body/tool content is digested
from task-owned Reader SQLite, while full TOC and appended content verify the
API surface. This does not claim thousands of HTTP content pages were fetched.

An initial baseline script assertion expected a null diagnostic rather than
an omitted successful diagnostic. That failed run is excluded. Original logs,
scripts, private API payloads, rejected diffs and JSON reports remain outside Git
under `D:/CodexArtifacts/OpenSession/20261011-incremental`.

## Rejected Reader candidates

The negative stat hint kept exact checks for matching hints and old cache rows,
and used an independently verified capture only on a cache miss. Boundary and
atomic-migration tests passed, but cold Reader medians were 6,617/6,261 ms
(5.4%), and appended medians 5,539/5,039 ms (9.0%). Neither meets the gate.
The source, persisted hint, migration and candidate-specific tests were removed.

A separate 32K-content-chunk candidate reduced base SQLite content rows from
75,726 to 53,570, preserving exact normalized content and public output. An
adjacent C0/B4 screening pair measured Reader cold 7,403/7,885 ms and append
6,378/6,825 ms: about 6.1%/6.6% improvement. It did not justify expansion to
three pairs, so the original 4K writer remains. This screening does not establish
a general regression or attribute timings to a particular instruction.

## Final artifact and affected-surface validation

The catalog-only measurement artifact has SHA-256
`d4d273efa7685ea4c04b8159af0cad2488b41287be17fcf1c0c7611e13226526`.
An additional adjacent B4/retained-0 comparison confirms that removing the
Reader experiments preserves the catalog benefit:

| Path | Baseline | Catalog-only artifact | Improvement |
| --- | ---: | ---: | ---: |
| Catalog cold | 6,456 ms | 5,163 ms | 20.0% |
| Append catalog | 8,863 ms | 7,303 ms | 17.6% |
| Catalog warm | 671 ms | 593 ms | 11.7% |
| Same-cache catalog process restart | 512 ms | 523 ms | -2.0% |

Complete parity passes for this artifact too. This single pair is an ablation
check, not another three-pair estimate. Reader source is unchanged:
its cold times are 7,885/8,388 ms and appended times 6,825/6,795 ms. No retained
Reader improvement is claimed. The earlier repeated cold catalog benefit
remains the keep criterion; warm results establish reuse without a material
regression rather than a stable additional speedup.

The delivery artifact is rebuilt with the standard `npm run build` command,
including Rust path remapping. Its SHA-256 is
`cf186e04c09bcd82ba3218cf9999cd0597b8dd21091688d329083cdcc8bc8afc`.
A final sequential final-0/B5 pair again passes complete parity:

| Path | Baseline | Standard delivery artifact | Improvement |
| --- | ---: | ---: | ---: |
| Catalog cold | 5,661 ms | 4,790 ms | 15.4% |
| Append catalog | 6,827 ms | 6,521 ms | 4.5% |
| Catalog warm | 572 ms | 584 ms | -2.0% |
| Same-cache catalog process restart | 489 ms | 498 ms | -1.8% |

Cold catalog gains survive both catalog-only ablations. Append gains vary
substantially: the earlier three-pair median and 17.6% ablation do not establish
a stable 16.5% improvement for the final artifact. The stable cold-path benefit
justifies retaining the change. Final Reader cold is 6,668/7,648 ms and append
5,633/5,615 ms; this run also provides no retained Reader speedup claim.

Validation on the retained source and standard delivery artifact:

- `npm run review` passes governance, Rust formatting and workspace compilation.
- `cargo test --workspace --manifest-path v3/Cargo.toml --locked` passes:
  244 tests, 16 explicit ignored tests, no failures. The two retained capture
  regressions pass, including restored same-size/same-mtime generations.
- `npm --prefix v3/ui run build` passes. UI source and response contracts are
  unchanged.
- Full root/native integration runs cover 761 tests: 710 pass, 46 explicitly
  skip, and five fail because the manually supplied benchmark artifact uses a
  renamed executable and slash spelling different from the standard Windows
  build path. Repeating the two affected files with a canonical executable path
  closes those failures and exposes the initial artifact's missing Rust path
  remapping. After the standard rebuild, all 17 installer/standalone tests pass,
  including the portable bundle from a copied path with spaces. Reuse the other
  710 functional results for unchanged Rust/UI source; compilation-path changes
  are verified by the final artifact's packaging, MCP and Web checks.
- Actual SDK stdio MCP initialization discovers seven tools. Codex browse and
  targeted search return the canonical parent without source diagnostics.
  Two 37-UTF-16-unit `session_get_event` pages match a real recorded assistant
  message and validate revision and continuation. All stdout messages are
  JSON-RPC, the task-owned process exits, and source/authority hashes remain
  unchanged. This is bounded retrieval evidence, not an MCP latency claim.
- The task-owned Viewer is restarted on loopback port 3457 with this exact
  binary. `/api/providers` and `/api/settings` respond; settings compare equal
  to the prior snapshot. The desktop browser opens the real canonical parent,
  displays its title, message count, transcript, grouped execution and hydrated
  TOC. The earlier live Library check also reports pre-existing unmerged-source
  diagnostics and source changes while Codex is writing. That partial response is
  excluded from performance and complete-inventory claims.

Reports and logs are `retained-comparison.json`, `final-comparison.json`,
`retained-0.json`, `final-0.json`, `mcp-smoke-trial-bpZ8h6.json`, `review.log`,
`rust-workspace.log`, `native-tests.log`, `standard-build.log`,
`final-artifact-tests.log`, `final-viewer.log` and `final-viewer-error.log` in the
external artifact directory above. This turn supplies Windows evidence; other
platforms retain their own acceptance gates.

## Remaining cost

Appending still reparses previous JSONL records. Exact chunk reuse occurs after
parsing, projection and field hashing; it saves writes but cannot remove that
normalization cost. A future incremental parser would need provider-owned
pre-finalization state and exact prefix validation, with suffix changes to old
tool outputs, deduplication, compaction and child ownership tested. This work
retains the measured read reduction without introducing that larger mechanism.
