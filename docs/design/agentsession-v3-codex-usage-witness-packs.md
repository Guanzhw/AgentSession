# Codex raw usage identity witness packs

This bounded follow-up to the [raw usage ledger](agentsession-v3-codex-raw-usage-ledger.md)
derives occurrence-to-request relationships from selected raw records. It imports
no Viewer or Rust parser, selector, or Stats code. Four private packs cover 654
usage occurrences: 316 have explicit, globally unique canonical request identity;
338 legacy occurrences remain unresolved. Of the 316 canonical rows, 107 were
already proved by the first disposition and 209 were previously unresolved.
The existing corpus disposition is unchanged; these are witness-specific findings.

## Scope and independent method

The complete 840-file ledger was searched for explicit legacy response IDs,
same-owner equal six-field request vectors with distinct canonical response IDs,
compaction boundaries, parent metadata, and repeated first-metadata identities.
The ledger SHA-256 was independently rechecked as
`ae3c0082387b47536ba56d7c155ac16a09ba812788bc210d0aced50ace04e0a8`.
It contains 115,370 occurrences: 41,373 canonical and 73,997 legacy. No legacy
occurrence has an explicit response ID; no same-owner, same-six-field-request
group contains distinct canonical response IDs. That negative result applies
to this ledger's recorded fields, not to unrecorded requests or other corpora.
An additional search without the owner restriction also found zero such groups.

Eight ledger-selected source files totaling 66,662,990 bytes were read and
checked against their frozen manifest SHA-256 values. Two small exploratory
files were retained without promotion into a pack. Pack checks used the private
extracted copies; the runtime follow-up reread and rehashed its two selected
original files before and after execution. The full 3.4 GB source corpus was not
rescanned. The preexisting
declared-root inventory proof supplies scope completeness; it does not prove
request identity.

Raw row positions, bytes, payloads, source identities, global search results,
and occurrence-level decisions remain under ignored
`tmp/v3-delivery/codex-usage-witness-packs/`. The four files are
`01-mixed-owner.private.json`, `02-compaction.private.json`,
`03-parent-child.private.json`, and `04-same-id-multi-file.private.json`.
The [public JSON summary](agentsession-v3-codex-usage-witness-packs.public.json)
contains aggregates and pack digests. The original `summary.public.json` and
follow-up `summary-with-runtime.public.json` remain in that directory.
`global-search-proof.private.json` records the complete-ledger search scope.
Private scripts and intermediate source extracts are retained for reproduction.

## Findings

| Pack | Usage occurrences | Proved canonical requests | Unresolved legacy | Raw-source finding |
|:---|---:|---:|---:|:---|
| Mixed owner | 2 | 1 | 1 | Adjacent canonical/legacy records have equal six-field request and cumulative vectors inside one completed turn. This is a positive mirror candidate; the legacy row has no identity link. |
| Compaction | 225 | 106 | 119 | A compaction record explicitly names the preceding canonical response and repeats its entire usage payload. The embedded snapshot is the same request, not an additional ledger occurrence. |
| Parent/child | 6 | 3 | 3 | Eighteen copied parent payloads precede child work; their envelope timestamps differ. No usage occurs in the copied prefix. After the recorded new-task boundary, three canonical rows explicitly name the child thread while session IDs still name the parent. |
| Same ID, multiple files | 421 | 206 | 215 | Two files share the first canonical session ID. Their 147 and 59 canonical requests have disjoint response IDs, all explicitly owned by that session and globally unique in the ledger. |

The compaction pack also preserves a post-compaction legacy row whose cumulative
vector is unchanged, whose input/output/cache/reasoning request fields are zero,
and whose total is positive. It remains a context-snapshot candidate. Subsequent
canonical and legacy request vectors match while their cumulative difference
equals the explicitly linked compaction request. This proves the recorded
cumulative divergence, without proving the legacy-to-request mapping. The
selected file uses both formats before and after compaction; a format switch
was not proved by this slice.

The child pack resolves three active-metadata conflicts using the first child
metadata, explicit parent/fork references, declared inherited-history boundary,
payload equality with the parent file, the recorded task assignment, and each
canonical thread ID. It does not reclassify every later metadata record as the
current owner. Since this prefix contains no usage, it supplies no positive
copied-usage occurrence witness.

The multi-file pack establishes a 206-request raw-source union. A bounded runtime
follow-up rebuilt the current debug binary and started one isolated process
against byte-identical copies of only those two files. It returned one session,
a valid protocol, and 59 canonical usage records matching exactly the later
file's response IDs. All 147 earlier-file canonical response IDs were missing.
The protocol also returned 53 legacy-derived usage rows, so Stats reported 112
recorded requests. Those 53 legacy identities remain unresolved; subtracting
112 from 206 would mix incompatible evidence classes. Reader retained the
same canonical session identity.

The [runtime result](agentsession-v3-codex-usage-witness-runtime.public.json)
records binary, implementation-source, input-source, and HTTP-response hashes.
Original and copied source hashes remained unchanged; the isolated process was
stopped. Full responses, logs, commands, and failures remain in the private
witness directory. The first response classifier incorrectly required an exact
provenance type without its recorded settings suffix and read the wrong Reader
envelope field. Its report is retained and superseded by the v2 result computed
offline from the preserved responses and the independent raw response-ID set.

The owning defect is in Codex inventory/source lookup: sorted paths enter a map
keyed by canonical session ID, with the later segment replacing the earlier
one. The 2.0 shared file store also overwrites its canonical lookup entry; that
is a comparison, not an identity oracle or justification for 3.0 data loss.

The smallest safe interim change is a provider-owned multiple-source diagnostic
before this overwrite. Keep the canonical ID and all source references; mark
its history/usage unavailable or incomplete consistently in Reader, MCP, and
Stats rather than presenting one file as complete. Stats must not silently
publish complete totals for such a session. This requires no invented request
deduplication rule. A subsequent provider-owned source-set implementation can
join the distinct explicit owner/response identities, preserve file-qualified
source positions and revisions, and report conflicting repeated identities.
Legacy mirrors and copied transcript ordering need their own evidence before
a general multi-file history merge. No production fix was applied in this slice.

No positive legacy mirror, same-vector independent-request counterexample,
copied-usage occurrence, or format-switch identity rule is promoted to gold.
No public synthetic fixture was added for these unresolved relationships.
Production parsing, Stats, provider sources, and existing services were unchanged.

## Verification

`build-packs.mjs` under the private directory asserts explicit owner and global
response uniqueness for every proved canonical row, full payload equality for
the compaction snapshot, the compaction cumulative-difference equation, the
18 parent payload matches, the child task boundary, and the 206-request union.
An independent streaming join against the previous disposition found all 316
canonical positions, split into 107 already proved and 209 unresolved. Pack
digests and ignored-path status were checked before handoff. The follow-up
`cargo build --manifest-path v3/Cargo.toml -p agentsession-v3 --bin agentsession-v3`
passed; the isolated four-route check returned HTTP 200 throughout. CORE-14
remains open: this slice supplies a measured multi-file omission, not full
request/token gold or corpus-wide runtime reconciliation.
