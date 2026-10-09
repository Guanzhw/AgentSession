# Codex raw usage evidence cohort

`scripts/v3-codex-usage-cohort.mjs` is the second, bounded evidence step after
`scripts/v3-codex-usage-census.mjs`. It reads the same frozen manifest and a
completed census checkpoint. It imports no Viewer or Rust parser and never
writes provider sources. It does not compute corpus totals or request ownership
gold.

Run it with private files outside version control:

```powershell
node scripts/v3-codex-usage-cohort.mjs `
  tmp/v3-delivery/codex-usage-census-840-manifest.private.json `
  tmp/v3-delivery/codex-usage-census-840-checkpoint-v3.private.json `
  tmp/v3-delivery/codex-usage-cohort.private.json `
  > tmp/v3-delivery/codex-usage-cohort-result.private.json
```

The default selection takes the first two eligible file indices for each of
eight census-derived categories: legacy-only roots and children, mixed roots
and children, duplicate-pair excess, missing or zero usage fields, children
with canonical usage and no `NEW_TASK` marker, and session-metadata transitions. Selection is
deterministic, deduplicated, and capped at 24 files; files over 64 MiB are
skipped. `selectCohort(checkpoint, { perCategory, maxFiles, maxFileBytes })`
allows a caller to set smaller bounds. Files with no eligible categories
produce an explicit error.

The private output contains a SHA-256 source-file hash, source line, byte
offset and byte length for each relevant record, and its record kind. The six request and
cumulative usage fields retain explicit `missing`, `invalid`, `zero`, or
`positive` states. Canonical response, turn, `thread_id`, and `session_id`
are separately hashed; metadata IDs, parent and spawn IDs, turn lifecycle and
compaction markers are also hashed or reduced to their kind and position. A
child row's boundary is `before-task`, `after-task`, or `unknown`. No transcript text,
arguments, output, or source paths are emitted.

Each usage row has an adjudication **candidate** with a reason. Exact legacy
and canonical request/cumulative vectors can suggest a mirror; multiple
legacies matching one canonical row remain unresolved as
`duplicate-pair-excess`. A matching request with divergent cumulative usage
remains unresolved as `cumulative-divergence`. Earlier legacy rows, metadata
transitions, child usage before a task marker, and children without a marker
remain unresolved. An explicit matching owner ID is only a candidate, never
an asserted ownership decision. This deliberately preserves the distinction
between a child `thread_id` and a parent `session_id`. Repeated canonical
response IDs and invalid or absent request usage also remain unresolved.

The checkpoint is atomically updated after each complete file. Resume
re-hashes every selected source before reusing a result; changed bytes fail.
Manifest and census hashes must match, and the tool rejects a checkpoint path
that aliases either input or any manifest source. Parsing uses fixed-size
chunks, a 16 MiB line limit, and a default 5,000 usage-row limit per file;
exceeding a bound fails explicitly without a partial per-file result. The
checkpoint and redirected standard output are private data and should remain
under ignored `tmp/`.
