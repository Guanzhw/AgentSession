---
status: implemented
date: 2026-09-27
decision: Stream Codex source records during cold Reader publication.
---

# Stream Codex source records during cold Reader publication

## Context

The 3.0 release Reader on a frozen 753,294,971-byte Codex root used a full
`fs::read` plus JSONL normalization. Two isolated cold Web runs on the same
source reached 1,050,320,896 and 1,052,811,264 bytes of process working set.
The second run was an explicit RED check requiring cold peak working set below
the source's byte size; it failed. Both runs returned 14,243 Reader items and
1,972 relations, but that correct output did not justify retaining the raw
source in memory throughout projection construction.

## Decision

`load_codex` now hashes the selected **raw** plain file as it parses JSONL
records through `BufRead::read_until`. Compressed sources hash raw bytes through
a fixed 64 KiB buffer and stream decoded records through the same parser;
their raw revision is checked again after parsing. Plain sources now also
rehash raw bytes after parsing to reject an in-place rewrite during the stream.
Plain and `.jsonl.zst` sources use the same normalization and retain physical
line indices, source revision, canonical identity, trailing partial-line
diagnostics, and provider
ownership. Only a child with a recorded owned boundary rereads its inherited
prefix for its separate projection. The existing inherited-context cache path
continues to use its own source buffer and is not covered by this memory claim.
Compressed decode failures remain parse errors, verified by a truncated-frame
regression test after an initial RED error classification.

## Alternatives considered

The persisted Reader model already avoided reparse on later requests, but it
could not reduce the first publication's raw-file allocation. Retaining the
whole-file buffer would leave the observed cold working set unchanged.

## Consequences

On release binary SHA-256
`1f213e649f102e8e69a83e62f457a9ab5d867c12c66e7291b76b987a096435f1`,
four isolated cold Web runs returned the same 14,243 items and 1,972
relations with sampled peak working sets from 304,160,768 to 431,845,376
bytes, below the predeclared threshold. Cold bootstrap took 3.64–3.71
seconds against 3.84 seconds in the second prechange run. Fresh-process hot
bootstrap remained about 0.48–0.49 seconds, and a whole-session no-hit pane
search about 1.05–1.06 seconds. Source
SHA-256 `a374ee2f3329627c806958b14ae8ae31545386459a7b3a701174cf60ccfc8cd6`
was identical before and after. These are unpaired release runs with likely-warm
OS cache, not a final speed claim. Private raw timing/RSS samples and
binary details are under `tmp/v3-reader-final-release-*`.

Repeated source hashing on each hot Reader request, child inherited-context
buffering, and full protocol projection on each execution page remain separate
performance work. A deterministic same-length, restored-mtime rewrite at the
plain stream's second read made direct `session_get` return success with mixed
early/late source rows before the post-stream check. The focused test was RED
on that result and GREEN after the provider check; it also exercises
`session_timeline` and cold Reader publication. The new check adds one bounded
full raw-byte read to each plain root Codex load, so the earlier cold timing samples
do not measure this final path. A source that changes again after the final
hash is outside this in-flight check.

## Verification

The Rust workspace suite and focused Axum/MCP/real-browser Codex tests pass
after the stream change. The full 3.0 Node suite and five-run matched resource
report still require a final integrated replay.
