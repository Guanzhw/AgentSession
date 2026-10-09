# Independent raw-source search verification

The JSONL fixtures are handwritten Codex records; the metadata trio is stored
in an order different from search ordering. The expectation in
[the test](../../v3-verify-search-golden.test.mjs) is also handwritten: title
precedes directory, update time descends, and canonical IDs break ties. All
matching fields are shorter than 40 UTF-16 units, so the complete field is the
expected excerpt. Tests reject omissions, reordering, wrong session/event
references and wrong snippets.

[The verifier](../../../scripts/v3-verify-search-golden.mjs) imports no
production parser, search implementation, index, or candidate-derived
expectations. It reads raw JSONL itself, queries the historical OpenCode
`session` table through a read-only SQLite connection, and uses only the
independent raw Zstd decoder for DSH. Its Codex reader uses 64 KiB chunks,
rejects lines over 32 MiB, validates UTF-8 and JSON, and retains only metadata,
hashes, first-hit expectations and hit counts across files. It retains only
search-relevant text and ID evidence for the current Codex file, omitting tool
arguments/results and unrelated payloads. DSH decoding and the two small JSONL
providers are currently bounded by the frozen small-provider input, rather
than by a streaming DSH implementation.

Run the public controls:

```powershell
node --test test/v3-verify-search-golden.test.mjs
```

Run against a frozen private performance input, passing a complete captured
trial record (not the candidate golden digest file):

```powershell
node scripts/v3-verify-search-golden.mjs tmp/v3-performance/manifest.private.json tmp/v3-performance/v2-candidate-20260926-a/rep-1-v2/record.private.json tmp/v3-performance/source-search-new-run
```

Source roots must resolve under this checkout's ignored `tmp/`; output must
be a fresh ignored directory outside every source root. The candidate is
loaded only after source derivation. Source signatures are checked before and
after scanning. Raw paths, IDs, source hashes and partial expected metadata
stay in `source-verification.private.json`; `summary.public.json` contains
labels, counts and aggregate hashes. Attempt and progress files preserve
subsequent failures. Scanner time and memory are preparation cost, not either
product's benchmark result.

The verifier intentionally reports a partial source verification artifact,
not an accepted `agentsession-v3-search-golden/v1` file. It never edits or
upgrades the existing candidate, and always keeps `searchSpeedupEligible`
false. Its supported proofs are:

- Complete Codex body-query absence when a superset of all possibly searchable
  user/assistant bodies has no match. This includes copied and untagged user
  text, concatenated response blocks, legacy messages, and synthesized task
  text. Filtering inherited/duplicate records only removes elements, so zero
  hits in this superset proves an empty complete result. A positive superset
  hit proves neither owned membership nor a correct result.
- Direct metadata membership, field precedence, canonical session references,
  roles, timestamps, full ordering and short excerpts. Long excerpt windows
  remain unverified. Duplicate canonical IDs require an independently derived
  source-selection rule. The frozen Windows 2.0 discovery chooses the last
  discovered segment; the verifier retains the selected path, first sorted
  path, source hashes and conflict witnesses in its private report. Unresolved
  conflicts still block provider verification.
- DSH highest recorded generation is selected per canonical ID; inherited
  title events are excluded and packed-chunk timestamps are accounted for.
  Missing stored title/descriptor fails explicitly because fallback visible
  user selection is outside this verifier's current support.
- Positive Codex body membership and first hit: the independent source
  interpreter reads tagged `user.text`, legacy requests/replies, task envelopes,
  reasoning and tool calls. It excludes injected context and inherited text
  before a child task envelope, suppresses hybrid/progressive duplicates, and
  counts non-searchable reasoning/tool records when deriving fallback event
  IDs. Question replies search the recorded questions/answers, excluding IDs.
  Explicit message and tool call IDs remain canonical. The frozen 2.0 copied
  body-prefix rule requires an immediately repeated parent header; a legacy
  fork without that header can have token replay but no body-prefix removal.
  A repeated parent header without an envelope remains explicitly unresolved.
- Literal single-term or exact-phrase excerpts use the frozen service's
  UTF-16 context window (40 units before, 80 after, ellipsis at omitted edges).
  Dispersed multi-term windows remain missing evidence. Comparisons include
  ordered complete results, all semantic fields, snippets, unknown candidate
  IDs and timestamp-cutoff violations. Private mismatch witnesses preserve
  both sides. Fully verified queries receive independently derived complete
  and first-page semantic digests.
- Codex tool names use the same ownership and first-hit rules, retain canonical
  call IDs and the `tool` segment, and exclude tool arguments/results from the
  searched name. The other four tool-name provider projections remain open.

The handwritten positive fixtures cover mixed legacy/new records, inherited
task context, progressive reasoning, generated IDs, question replies, missing
parent evidence, and tool names. Public negative controls reject omitted or
invented results, wrong event IDs, title whitespace changes and wrong excerpts.

`agent-final.jsonl` isolates 3.0's recorded collaboration search behavior.
The source places a matching agent answer before a later assistant answer and
includes a wrong-call acknowledgement, a premature answer, a forged sender,
and an outgoing envelope. The accepted answer has a recorded spawn call,
matching `call_id` acknowledgement, matching actor/recipient, and a complete
`FINAL_ANSWER` envelope. Its payload is searchable through the assistant field
while the returned role remains `agent`. The test fixes its first source event,
fallback event ID, excerpt, and the spawn/ack/answer line evidence.

On the frozen 840-file / 3,400,267,634-byte input, the 2026-09-27 positive
verification covers all 833 canonical Codex sessions. Five positive queries
are fully source-verified: `codex-user-assistant` (689), `chinese-one` (340),
`chinese-two` (46), `literal-percent` (90), and `common-one` (830). The sixth,
`multi-term`, verifies all 260 ordered semantic rows and 9 excerpts, with 251
dispersed-term excerpts remaining. Codex contributes three verified tool-name
rows; the complete cross-provider tool-name query remains partial. Together
with no-hit, six of nine workload queries are complete. Metadata still has
66 unverified long excerpts. All nine are required before speedup eligibility;
the verifier continues to emit `searchSpeedupEligible: false`.

The initial positive attempt is retained under ignored `tmp/v3-performance/`
as `source-search-positive-20260927-a`. Its three apparent query mismatches
were oracle title trimming errors: the source title is trimmed before its
120-unit truncation, so the final title can end in a space. The service keeps
that space. The second attempt corrected the oracle and completed the five
positive queries; `source-search-positive-20260927-c` adds explicit mismatch
witnesses and unknown-ID/cutoff controls, and the final
`source-search-positive-20260927-d` also rejects an unexpected provider in a
Codex-only result. These preparation attempts
are not product performance trials.

The partial counts above describe the earlier 2.0 oracle development stage.
The completed 3.0 source verification, including recorded agent answers, is
documented in [the 3.0 search golden report](../../../docs/design/agentsession-v3-search-agent-golden-20260927.md).
