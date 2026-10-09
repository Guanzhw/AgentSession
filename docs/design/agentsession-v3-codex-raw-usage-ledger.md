# Codex raw usage occurrence ledger

`scripts/v3-codex-usage-ledger.mjs` is a full-scope evidence extractor for CORE-14. It streams every file in an explicit frozen manifest, independently of the Viewer and Rust parsers. The command requires the expected file count, so an accidental subset fails before any output is created. Each manifest entry must contain its relative source path, exact byte length, and SHA-256. The source bytes are hashed during extraction; a changed, short, malformed, or oversized source stops the run. This count and hash check confirms the supplied scope and bytes; the separate inventory check below establishes that the manifest includes every eligible source under its declared frozen root.

Run `scripts/v3-verify-codex-usage-inventory.mjs` as that separate gate. It enumerates only the absolute `root` declared by the manifest, requires that directory to be named `frozen-codex`, and compares the exact relative path set using the Codex adapter's regular-file, `.jsonl`/`.jsonl.zst`, compressed-sibling, and no-symlink rules. It reports counts and path-set digests without reading or hashing transcript bytes:

```powershell
node scripts/v3-verify-codex-usage-inventory.mjs `
  tmp/v3-delivery/codex-usage-census-840-manifest.private.json > `
  tmp/v3-delivery/codex-usage-inventory-proof.private.json
```

The 840-entry manifest matched all 840 eligible files under its declared root, with zero omitted paths, extra paths, or duplicate entries. The root and manifest path-set SHA-256 values both equal `2cbdd5c9eced3c7703e264fb59097c354c73a86a7663ebdf76f4e78857997357`; the ignored JSON proof is `tmp/v3-delivery/codex-usage-inventory-proof.private.json`. This establishes inventory completeness for that frozen root only, not for other files elsewhere in the active Codex home.

For the private 840-file snapshot, after shared resource measurement has ended:

```powershell
node scripts/v3-codex-usage-ledger.mjs `
  tmp/v3-delivery/codex-usage-census-840-manifest.private.json `
  tmp/v3-delivery/codex-raw-usage-840.private.jsonl `
  840
```

The output must be under ignored `tmp/`. It is created atomically only after all sources match the manifest. Existing output is retained; a new run needs a new output name or an intentional removal of the prior private artifact. The script rejects source, manifest, and output aliases and duplicate source file identities. It keeps one file and a bounded line buffer in flight, with a 16 MiB default line limit. It does not resume: after interruption, rerun from the beginning to avoid treating a partial stream as complete.

The JSONL begins with a manifest record and ends with a `complete` record. Every canonical `token_usage_record` and legacy `event_msg/token_count` produces exactly one `usage` record. Each includes the manifest index, source SHA-256, raw-line SHA-256, one-based line, zero-based byte offset, raw byte length (excluding the newline), hashed explicit response and owner IDs, hashed active session metadata ID, and six fields each for request and cumulative usage. A field is `missing`, `invalid`, `zero`, or `positive`; valid fields retain the numeric value. Relevant session metadata, spawn, `NEW_TASK`, turn, task, settings, and compaction records produce positioned `boundary` entries. Each verified file ends with a `file-complete` record and its occurrence counts. Transcript bodies, arguments, outputs, source paths, and plaintext IDs are omitted.

The ledger is an occurrence inventory, not an ownership verdict. Equal vectors do not prove a mirror or parent copy. Missing owner or response evidence remains explicit. Request and token gold still requires independent adjudication of canonical and legacy occurrences against cross-file identity and boundaries, and comparison of independently owned requests with the runtime stats projection. The ledger is privacy-sensitive working data even though identifiers are hashed.

## 2026-09-29 frozen corpus extraction

Against worktree revision `50a32e7c5b3fdaa1d335771da80d6c919d4ab536` plus the uncommitted extractor, the private manifest SHA-256 was `29e3cff3ac5f0178e8dca1883bcb0c8b99fca2b5cb4e510747eb86725ba8b010`. Its 840 entries declared 3,400,267,634 bytes. The one-pass extractor matched every declared source SHA-256 and byte length and published `tmp/v3-delivery/codex-raw-usage-840.private.jsonl`: 41,373 canonical and 73,997 legacy occurrences, 12,517 relevant boundaries, 840 file-complete records, and one terminal complete record. The private ledger is 142,637,168 bytes with SHA-256 `ae3c0082387b47536ba56d7c155ac16a09ba812788bc210d0aced50ace04e0a8`.

After extraction, an independent `runCensus` checkpoint reuse pass rehashed all 840/840 files, totaling 3,400,267,634 bytes, with zero changed sources; its canonical and legacy counts matched the ledger. A separate streaming validation of the ledger checked its header, final record, strict file order, monotonic byte positions, per-file source SHA and occurrence counts against the census, and total bytes: all passed. This post-measurement source check does not claim that the earlier resource measurement itself performed two full content-hash passes. The script and four focused usage test files passed 44/44; `npm run review` passed governance and TypeScript checking. The private 840-file extraction does not classify any row as a proved request, mirror, parent copy, or context snapshot.

## First ownership adjudication slice

`scripts/v3-adjudicate-codex-usage-ledger.mjs` consumes the frozen manifest,
its complete declared-root inventory proof, and the private occurrence ledger.
It checks the manifest and proof digests, the explicit ledger SHA-256, exact
file order and `file-complete` counts, monotonic and non-overlapping positions,
unique occurrence positions, and the terminal counts before publishing a
disposition. It reads the ledger twice and never opens provider transcripts.
The private output must be under this repository's ignored `tmp/` directory;
the command rejects an existing output or a path, symlink, or hardlink alias of
the manifest, inventory proof, or ledger before creating the output. Exclusive
temporary creation preserves any preexisting temporary file on failure.

This first pass calls a canonical occurrence a `proved-request` only when its
explicit thread ID matches the active metadata epoch, that metadata identity
appears in only one source file, and its response ID occurs exactly once in the
whole ledger. A `session_id` remains a separate field: it can name a parent
without displacing the explicit thread ID. Conflicting or missing witnesses
leave canonical rows unresolved. Every legacy occurrence remains unresolved
because the ledger alone does not prove whether it is an independent request,
replay, inherited copy, or context snapshot. Each private disposition retains
the six request and cumulative field states (`missing`, `invalid`, `zero`, or
`positive`) and valid values. Public output contains aggregate counts and
digests only.

```powershell
node scripts/v3-adjudicate-codex-usage-ledger.mjs `
  tmp/v3-delivery/codex-usage-census-840-manifest.private.json `
  tmp/v3-delivery/codex-usage-inventory-proof.private.json `
  tmp/v3-delivery/codex-raw-usage-840.private.jsonl `
  tmp/v3-delivery/codex-usage-dispositions-840-v2.private.jsonl `
  840 ae3c0082387b47536ba56d7c155ac16a09ba812788bc210d0aced50ace04e0a8 > `
  tmp/v3-delivery/codex-usage-adjudication-840-v2.public.json
```

At worktree revision `50a32e7c5b3fdaa1d335771da80d6c919d4ab536`
plus the uncommitted adjudicator, all 840 files completed and all 115,370
usage occurrences received one disposition: 41,373 canonical and 73,997
legacy. The conservative rule proved 26,650 canonical requests; 14,723
canonical and 73,997 legacy occurrences remain unresolved (88,720 total).
There were 32,211 occurrences under metadata identities seen in multiple
files and 1,048 canonical thread/active-metadata conflicts; reasons can
overlap. The private disposition file is 149,630,239 bytes with SHA-256
`b968437c10c60079c17a979096ad82de070c224211747e86409253eff202b8bb`.
An independent output stream count found 115,370 disposition records, 840
file-complete records, and one terminal complete record; `Get-FileHash`
confirmed the disposition digest. The command verified the input ledger
SHA-256 again after its second pass. The focused adjudicator, ledger, and
inventory tests passed 13/13, with one optional symlink test skipped because
this Windows host disallows symlink creation; `npm run review` passed governance
and Viewer typechecking. The new output-boundary tests were RED (outside path
accepted and hardlink alias detected only at publication) before the fix.
The output is an occurrence-level classification, not a full request or token
gold or a runtime Stats reconciliation; CORE-14 remains open.
