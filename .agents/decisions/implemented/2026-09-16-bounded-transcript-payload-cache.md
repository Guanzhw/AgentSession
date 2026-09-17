---
status: implemented
date: 2026-09-16
decision: Bound retained transcript payloads while preserving the full canonical session index
---

## Context

Real Windows startup exited in Node's UTF-8 allocation path while Codex
`parseSession` decoded a whole rollout. The observed corpus had 515 plain
rollouts totaling approximately 1841 MB, with the largest approximately
256 MB. The shared file store retained raw records and normalized messages
for every indexed file; whole-file decoding added another large transient
allocation. These figures and the crash are observations, not a heap profile.

After bounded caching, a separate read-only probe of one real list row with
99 direct children reached V8's 1 GiB heap limit before protocol construction
returned. Metadata initialization read 1.96 GB in 7.92 seconds and retained
approximately 125 MB after GC; the later protocol construction had read at
least 22.6 GB by the last process sample and terminated after 143.9 seconds.
The Codex input assembler normalized the whole descendant family before
filtering direct children, then reread root and child bodies. An oversized
root repeatedly displaced and was displaced by its children. Bounding cached
payload retention alone therefore does not bound the consumer's construction
work or lifetime.

The direct-child-only loader removed the repeated root reads but the same
active-session probe still exhausted the 1 GiB heap. A subsequent diagnostic
stopped intentionally at 750 MiB before its 22nd child body read: the root had
only two total reads (initial indexing and assembly), while the retained heap
grew from about 580 MiB after root loading to 750 MiB. The protocol input kept
all normalized child messages even though the protocol had no consumer for
them, as well as full child records where only task/model/lifecycle evidence
was needed. This is a separate consumer-retention problem.

## Decision

Add an optional source-byte-weighted LRU payload budget to the schema-neutral
file store. Canonical metadata, filename aliases, parent relationships and
file/dependency signatures remain indexed. Records and messages are evicted
together and reread in full on demand. Codex opts into a 64 MiB source-byte
budget; one oversized active payload remains whole. Other providers retain
their current unbounded behavior. Codex reads plain JSONL in chunks, preserving
UTF-8, full records and its existing malformed-line warnings. Compressed
rollouts retain their existing decompression bound.

The Codex protocol input consumer must capture its root and required parent
snapshot once, select direct-child metadata before body reads, and reuse those
captured records while resolving each required child. Preserve complete owned
records and their normalized identities; do not truncate the family or raise
the heap limit to conceal repeated loading.

Project each child's protocol-consumed evidence in the owning Codex module
before retaining it for family assembly. Keep model selection, task-envelope
identity, terminal-message time and child completion source identities/order
exact. Child transcript bodies remain available from the existing message and
inherited-context accessors; the parent's protocol assembly need not retain
those bodies. Compare full v3 facts on a stable real history before and after
this internal projection rather than accepting lower memory alone.

## Alternatives considered

Increasing Node's heap limit leaves corpus-sized retention and the extra
whole-file string. Skipping or truncating large rollouts loses provider
evidence. A persistent metadata index and streaming normalization would add
separate persistence and provider contracts beyond this startup failure.

## Consequences

Evicted bodies cost another file parse when requested. The budget measures
source bytes, not exact JavaScript heap usage, and a requested family can
still require several complete bodies concurrently. Consumers capture raw
record references across parent reads so provenance maps retain object
identity. Search consumes resolved sessions sequentially. Failed lazy reads
remain errors; refresh can retain stale data only while its old body exists.
Payloads are bound to the same file/dependency signature as their metadata.
Evicted lookups refresh changed sources even inside the directory refresh
interval; superseded handles cannot mix metadata with a replacement payload.
Corpus scan logs individual unavailable rollouts and continues with the
remaining sessions.

A real active rollout grew by 4,658 bytes during a 781 ms read, and the
initial post-read stat check rejected all 47,873 parsed records, leaving the
canonical session out of the index. Plain Codex reads therefore capture a
finite descriptor-sized prefix. Its source stat and SHA-256 digest travel
with a provider-owned payload rereader. An append does not invalidate that
prefix: when the initial read observes a stat change, it verifies that the
bytes already parsed remain identical; an evicted reread checks the same
extent and digest. Rewrites and truncation remain explicit failures. The
shared store accepts this coherent snapshot loader without understanding
Codex records; other file readers retain their existing stat checks. No
retry loop or provider write is introduced.

Scan, family and search consumers may retain a snapshot handle while a
different lookup refreshes the index. A superseded immutable snapshot can
still read its verified original prefix, without publishing over the current
entry's path-keyed payload cache. Ordinary handles without a snapshot retain
explicit changed-source errors.

The reader has separate full-family consumers: `prepareReader` requests the
legacy tree, the normal detail shell requests inclusive family metrics, and
source navigation consults the tree for anchor renderability. Repairing
protocol construction alone does not establish bounded live-page loading.
The reader implementation adds an optional provider-owned reader projection:
the complete selected root and explicit lightweight child entry descriptors,
with recorded attachment/identity information. Shared routes select it through
the adapter contract. They do not insert empty child trees or interpret provider
records. Child previews/token details and closed-panel metrics load through
their disclosures. A Codex sequential metrics reduction must preserve exact
family-inclusive totals, root-only steps/direct usage, reported totals and tool
ordering. Legacy structured-tree/container and metrics APIs keep their existing
meaning. Root grouping, exact part anchors and complete child access remain
acceptance requirements.

The all-provider Usage regression exposed the same parent-lifetime problem in
Codex's incremental token-stat consumer. Aggregate changed files in parent
groups, capturing the parent record snapshot once for each group and releasing
it at group changes and at the end of the call. Keep this lifetime wrapper in
the Codex adapter; the shared incremental aggregator needs no lifecycle API.
Publish a group's key only after its snapshot was captured successfully.
Daily buckets, parent-dependent signatures and owned-usage classification keep
their existing meaning; the grouping changes read order, not usage ownership.

A later isolated scan exposed another consumer: `resolveEntry` loaded the
declared parent even when a recorded `NEW_TASK` envelope already determined
the child ownership boundary. Both copied-parent prefix detectors explicitly
ignore parent records in that case. Let the Codex parser expose this existing
dependency rule; consumers load parent payloads only when provenance can use
them. Preserve the recorded parent link and child-owned inherited text.
Legacy forks without an envelope still use their parent's records. Scan order,
per-entry errors and yield behavior remain unchanged; no larger cache or
permanently pinned parent is introduced.

The shared structured-view cache measures its existing one-second reuse window
from builder completion. Measuring it before a slow builder returns makes a
fresh tree expire before the immediately following container accessor.

## Verification

Focused regressions cover multibyte/long-line parsing, complete record order,
read-only source preservation, cache eviction/reread, canonical aliases and
families, source/dependency invalidation, and explicit unavailable-body errors.
They also cover changed evicted sources, old handles, changes during a lazy
read, and a rollout disappearing between two successful scan yields.
Additional active-source regressions cover finite-prefix appends, growing
rewrites, truncation, verified rereads after eviction, and coherent refresh
to include later records.
`npm run build`, `npm run review`, and `git diff --check` passed. The focused
cache/parser suite passed 16/16 tests, and the broader Codex/context/provider
selection passed 70/70. A read-only single-entry store probe of the active
262,851,252-byte real rollout retained its canonical session, 48,060 records
and 8,504 normalized messages in 881 ms of parse/normalization, with process
RSS approximately 670 MB. That patched real read occurred between appends;
the deterministic fixture covers append during the read. At that checkpoint,
official startup and whole-suite results still awaited main-agent acceptance.

The final direct-child/fact-projection integration passed the local suite,
`npm run review`, and `git diff --check` on 2026-09-16. Independent source review
found no remaining findings in this projection slice. Regressions cover two
direct children contributing protocol facts, no grandchild payload reread,
bounded root/parent reads, first-match model/task/terminal selection, raw
multiline terminal matching, and ownership-filtered fallback source indices.

A stable real v3 history produced exactly the same 722,574 serialized bytes
and SHA-256 before and after the change, excluding only the revision field.
The previously failing active-history list-row probe then passed with the same
1 GiB V8 heap limit: 101 direct children, 8,766 v2 events, and 101 tasks and
relationships, with complete validation and no errors or warnings. Cold
metadata initialization took 7.59 seconds; protocol assembly took 4.93 seconds;
the complete row finished in 12.58 seconds. Total observed transcript reads
were 2.91 GB including the 1.98 GB cold index, and the 273.8 MB root was read
twice in total (index and assembly). Heap used after the explicit final GC was
109 MB. A separate cold v3 probe also passed at the same heap limit in 13.94
seconds, with 9,320 events and 1,748 coordination observations and complete
validation. The active source continued growing between probes; these are
independent acceptance observations, not byte-identical timing benchmarks.

The owned-reader slice subsequently passed real detail-route, child-reader and
native-source checks with the legacy full-family accessor replaced by an
explicit failure. A stable nine-child history retained the exact root grouping,
parts, attachment identities and complete metrics hashes from before the
change. Its direct usage remained root-only and its inclusive totals unchanged.
The active long history also completed those routes plus sequential metrics
under a 1 GiB V8 heap limit without an intervening explicit GC: cold metadata
7.34 seconds, HTML ready at 25.30 seconds, native source at 44.04 seconds,
selected child at 53.07 seconds, and inclusive metrics at 59.77 seconds.
These are sequential cold-process observations, not browser interaction times.
Official service startup and real desktop/narrow inline-reading checks passed
on 2026-09-17. Desktop and mobile child-history open, refresh, close and return
restored the canonical sidebar entry focus with both nested details expanded.
The latest complete real-API validation across seven providers finished with 0
errors; whole-site `qa:e2e` exited 0 with `ok:true` and no browser errors, and
the Windows final binary build and smoke check passed. The current
implementation has 704/704 local tests passing. Visual acceptance remains
stage-gated around compact task purpose/return presentation, metadata density,
and the follow-up Library work. Current checkpoint evidence is recorded in
the [reader slice](../../../docs/design/runtime-reader-slice.md).

An isolated 2026-09-17 diagnostic measured Codex `getTokenStats(30)` at
159,625 ms, while SQLite refresh took 3 ms and its queries took 13 ms. The
largest parent exceeded the cache budget and had 104 direct children. A new
oversized-parent/four-child regression checks exact aggregate values and at
most one parent reread after indexing; it passes after grouping. The corrected
adapter returned 23 daily rows in 17,429 ms in a separate real-data probe of
528 files with a 291.8 MB largest parent and 105 children. The corpus grew
between probes, and the latter probe read transcript metadata before timing;
these are observed adapter timings, not an identical-input cold-I/O benchmark
or a real-data equality claim. Independent review also re-ran both Codex
token-stat regressions successfully and found no new blocking issue.

The subsequent parent-dependency and cache-window correction passes 763 tests,
independent Codex review (46 focused tests), seven installed-provider Reader
checks, full live E2E and Windows binary smoke. An oversized-parent regression
preserves legacy parent-dependent usage, inherited content, complete normalized
messages and v2/v3 raw-event ownership. Four clock-controlled cache tests cover
slow construction, exact non-sliding expiry, session replacement and null views.
A stable nine-child real history has identical tree/container/metrics hashes.
Separate growing-corpus scans of 535 sessions measured 209.3 seconds / 59.66 GB
before and 15.1 seconds / 4.16 GB after; production indexing took 28.0 seconds.
The huge root's tree took 8.7 seconds, its next container accessor reused the
result without file reads, and metrics took 5.5 seconds. The full API still
exceeds V8's string-length limit at serialization, and initial HTML independently
measures 35.2 MB / 19.7 seconds. Those remain explicit P9 acceptance gaps; this
correction neither changes full export semantics nor claims whole-page success.
