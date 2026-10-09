# Bounded public search oracle

[source.json](source.json) contains three handwritten synthetic sessions in
deliberately unsorted order. [expected.json](expected.json) was authored from
those facts, without querying 2.0 or reading a search index.

The fixed query `omega alpha` requires both terms in one field, regardless of
case or adjacency. One result is retained per session: title takes precedence
over directory and messages; otherwise the first matching source message wins.
Results sort by field priority, descending update time, then ASCII session ID.
The older `alpha` session therefore ranks first by title; equal-time message
hits `beta` and `gamma` follow in ID order. `beta-no-hit` has only one term.
`gamma-first` preserves its embedded NUL and emoji exactly.

All strings are at most 40 UTF-16 code units, so the expected excerpt is the
whole field. This model deliberately excludes long excerpt windows, ellipsis,
provider parsing, inherited-message selection, metadata derivation, tools,
cursor handling and locale-dependent non-ASCII ID ordering. The `codex` label
is a synthetic canonical reference, not a claim that this file is Codex JSONL.

Run from the repository root:

```powershell
node --test test/v3-public-search-oracle.test.mjs
node scripts/v3-public-search-oracle.mjs test/fixtures/v3-search-oracle/expected.json
```

The second command checks the positive control. A candidate file must contain
the complete `matches` array. The verifier checks the handwritten expectation
against its independent bounded source model before comparing the candidate;
it rejects omitted sessions, order changes, wrong refs and snippet changes.
It imports no production search code or provider adapter. Its report always
states `privateGoldenVerified: false`: this small fixture cannot verify any
of the nine private performance-query goldens or establish 3.0 equivalence.
