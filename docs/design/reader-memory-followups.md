# Saved summary to later consolidation

Status: implemented slice, 2026-09-19. Extends the readable saved outputs in
[reader-memory-artifacts.md](reader-memory-artifacts.md); evidence was rechecked
against retained Codex logs after `2ccf51d`.

## Content and presentation

The session summary gains an on-demand “Later consolidation” disclosure. Its
first load searches retained diagnostic records after this artifact was saved.
The original summary and the continuous source history remain independently readable.

```text
Session summary                                      [read]
  Later consolidation                                [open]
    Checked time range                               [change range]
    This summary
      └─ Consolidation · recorded time
           ├─ Request to read the summary             [recorded source]
           ├─ Request to modify MEMORY.md             [recorded source]
           └─ Request to modify memory_summary.md     [recorded source]
    Continue checking records                        [when more remain]
```

The connection means a recorded read request names a file which currently
matches this summary's source identity and body. The log request is recorded;
the artifact binding is derived from the retained file, not a historical byte
snapshot. Modification requests belong to the same recorded generation turn.
They are not labeled successful: the inner requests have no call ID and outer
`exec` completion records do not identify the inner operation's outcome.

Generation thread/turn and log row identity are available in secondary details.
The current sample has retained diagnostic operations but no full generating
transcript; its ID is text, not a broken Reader link. Stage1 producer fields and
the existing matching job evidence keep their original meaning.

Empty results state the checked scope. Truncation, skipped oversized records,
missing files, unavailable storage and a replaced artifact have explicit states.
This material stays outside conversation ToC, message search and token totals.

## Visual plan

Reuse the accepted Reader tokens: page `#f6f7f9`, panel `#ffffff`, text `#202832`,
secondary `#586777`, boundary `#d4dce5`, accent `#245bcc`, and their existing dark
counterparts. Use the existing body type at 18px with 1.65 line height; control
labels use the existing smaller UI scale. Align all prose and controls left.

One thin branching connector expresses summary → recorded consolidation →
operation requests. Source commands are native disclosures with progressive
plain-text reading. The same relation stacks at 390px without indentation
accumulating or requiring a new page. No animation is needed for this evidence.
Each collapsed request shows its recorded time and an expansion indicator so
repeated modifications to the same file remain distinguishable.

Brief review: the branch explains a concrete input/operation relationship next
to the readable summary; it preserves the user's continuous-history product
positioning. It uses evidence-bearing structure rather than a separate report
page or a second copy of the conversation.

## Owning contracts

Types belong with Session Protocol's artifact definitions. An optional
`ContextArtifact.evidenceAccess: "on-demand"` advertises a lookup, not a known
relationship. Codex sets it on retained stage1 summaries only.

`ProviderAdapter.getContextArtifactEvidence(sessionId, artifactId, request)`
is the on-demand evidence extension of that artifact, independent of body reads
and normal Reader/protocol revision preparation. Shared code consumes typed
facts; Codex owns SQLite paths, log grammar, discovery, file identity and budgets.

The shared request has two modes:

- `page`: optional opaque cursor, or an optional explicit `from` / `to` range
  in Unix milliseconds. Default range is the first hour after artifact creation.
- `content`: one evidence record ID. The provider returns its version-checked
  retained source text; the existing progressive renderer pages that text.

Results use `stale`, `not-found`, `unavailable` (source diagnostic), and `invalid`
(bad range/cursor/record selector), plus:

- `page`: `artifactId`, independent `revision`, `coverage`, `activities`,
  `nextCursor`.
- `content`: `artifactId`, `recordId`, `content` (plain text).

`coverage` contains the requested `from` / `to`, `scannedRecords`, `readBytes`,
`complete` for that range, and explicit `issues` when retained evidence was
unavailable or exceeded a read budget. It never claims global history coverage.

An activity has stable `id`, recorded `sessionId`, `turnId`, `timeCreated`,
`provenance`, `historyAvailability: "unavailable"`, a `binding`, and `records`.
The binding carries `sourcePath`, current `fileHash`, `checkedAt`, input history
`sourceSessionId` / `sourceUpdatedAt`, and derived provenance.

Each record has stable content-bound `id`, `kind` (`read-request` or
`modification-request`), `targetPath`, `timeCreated`, recorded provenance and
`contentLength`. Repeated pages of the same activity merge by stable identity.
The original command remains readable separately from normalized labels.

## Discovery and bounds

1. Verify the exact artifact version without preparing its transcript/family.
2. Walk `logs` through the observed `(ts, ts_nanos, id)` index in bounded metadata
   pages; filter candidate submission targets after limiting the visited rows.
   Preflight body bytes with `octet_length` before loading selected bodies.
3. Recognize an explicit Phase2 submission, then use the thread/time index to
   read that generation's retained operations. Parse only observed literal
   request forms; never execute source code or shell commands from logs.
4. Resolve only explicitly requested summary paths inside the provider's
   `memories/rollout_summaries` directory. Check file header source identity,
   input update time and full retained stage1 summary content. Keep this binding
   derived; file state now is not proof of bytes returned by a historical tool.
5. Group requests by recorded thread and turn, not name or nearby timestamps.
   The mutable global job row and `rollout_slug` are not linkage keys.

Bound both metadata rows and loaded bytes per request. A cursor pins the exact
artifact, requested window, log high-water mark and unfinished discovery / thread
position so continuation covers budget-limited work without losing a generation.
New log appends do not invalidate a pinned scan. A content selector pins its log
row and hash; deletion or replacement is explicit. Do not put log WAL churn into
the ordinary artifact/usage revision or scan logs when rendering the closed UI.

## Verification

Fixtures cover the observed log envelopes and nested JSON/string literal forms,
source-file matching and mismatch, same-turn ownership, unavailable outcomes,
pagination/budgets, changed versions, missing/invalid storage and path boundaries.
Use synthetic fixture content, not private memory or prompt text.

The real acceptance chain is the saved summary for input
`01a0aa62-1091-7961-a883-c3e732fe548c`, the retained Phase2 generation
`01a0adc6-d841-7b33-ac46-2a93664198da` / turn
`01a0adc6-d88d-7c12-b475-c4d205cd9d0e`, and its recorded read / modification
requests. Verify automatic discovery without hardcoded generation IDs, all
retained source text pages, keyboard expansion, retry, stale response, source
navigation, 390px, locale/theme pairs, and seven-provider Reader regression.
Full tests, E2E, independent review and CI precede publication.

## Provider evidence freshness

Verified 2026-09-19. The installed CLI reports `0.155.0-alpha.9.2`; Desktop is
`26.915.4065.0`. The public matching CLI tag resolves to
`4607249e430dac1c961df4dc615beae88e33cec8`. Current upstream HEAD is
`78245b47af2a7aafcabe025828ceecca69db4df1`; latest release `rust-v0.155.1`
resolves to `be2951ea34f0d295ed0becf97079f92fa5f6950e`. These current versions
do not identify the build that wrote the September 17 retained sample.

The official [Phase2 configuration](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/memories/write/src/phase2.rs#L294-L308)
sets the consolidation thread to ephemeral. Its
[log maintenance](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/state/src/runtime/logs.rs#L283-L304)
removes expired records; diagnostic retention is not complete transcript storage.
The [memory version contract](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/protocol/src/memory_version.rs#L7-L21)
defaults to V1 and separates `memories` from `memories_v2`.

This slice supports the locally retained V1 stage1 summary and observed legacy
diagnostic envelopes. It does not advertise the unverified V2 storage/grammar.
Missing inner call IDs describe this sample, not every current Codex execution.

## Verified checkpoint

The live summary lookup finds one retained generation and seven requests; all
nine source pages match the diagnostic text. The saved-source API/body hashes
remain unchanged. Closed disclosure, checked-range changes, retry, actual
server-restart recovery, 390px long-source containment and keyboard scrolling
were exercised on the real Reader. English/Chinese and light/dark views were
inspected; scoped evidence-area axe checks pass. Full tests pass 916/916 and
Node 22.15.0 focused tests pass 43/43. Seven-provider checks, E2E and independent
review pass. See the [acceptance record](runtime-acceptance-evidence.md) for the
exact boundaries and retained product gaps.
