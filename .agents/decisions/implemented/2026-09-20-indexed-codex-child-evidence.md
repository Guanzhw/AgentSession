---
status: implemented
date: 2026-09-20
decision: Retain self-contained Codex child protocol facts with their indexed source version
---

## Context

The current Reader already shares one root snapshot and paired v2/v3 input.
On the fixed 129-file real corpus, a cold HTML route still reads 1,298,671,441
bytes after indexing, including 799,238,590 bytes beyond the root. CPU sampling
attributes about 2.28 seconds to child input preparation, mostly reparsing
records already read during indexing. Protocol consumers use only the child
model, task identity, terminal time and completed-turn source identifiers.

## Decision

Project these existing facts during Codex indexing when the child's recorded
ownership boundary is self-contained. Associate them with the immutable indexed
session object in a provider-local WeakMap. Compute them using the same
ownership classifier and child-fact projector as the current protocol path.
The captured Reader and standalone protocol routes consume that version's facts.

Children requiring parent records for copied-prefix or fork ownership retain the
existing parent-aware path. Changed indexed sessions receive new facts; held
Reader snapshots retain the facts of their captured version. Full child history,
search, token accounting and inherited-background reading keep their own paths.

## Alternatives considered

Lazy child message construction removes some unused computation but still reads
and parses the entire child body. Increasing the transcript cache retains private
raw history without reducing the required fact projection. A new shared index
field would spread Codex-specific evidence into a schema-neutral store.

## Consequences

The metadata lifetime also retains compact, already-consumed protocol facts, not
source bodies. Facts stay associated with the owning entry rather than a name,
time window or mutable latest revision. No UI, public API or protocol shape changes.
The large root's initial parse and HTML/browser costs remain separately measurable.

## Verification

The unchanged 129-file corpus contains 1,329,667,016 bytes. Three cold HTML
route runs after indexing took 7671/6655/6812 ms before and 3520/2688/2386 ms
after (median 6812 to 2688 ms). Index medians were 5380 and 5175 ms; that small
difference is not evidence of an indexing speedup. Combined index-plus-route
median fell from 12192 to 8559 ms. Route reads fell from 1,298,671,441 to
499,432,851 bytes, avoiding 118 child rereads.

All six complete HTML responses were 15,272,332 bytes; after only relative-time
label normalization their SHA-256 was
`95ab7f4d647fc7b8f20266c535c0373ca056d76362128f5959215d88a21a6206`.
The stable real sample's v2, v3, owned Reader, messages and inherited projections
also matched in full (protocol revision excluded). Local reports are under
`tmp/runtime-performance/p9-indexed-facts-*`.

Regression tests cover captured versions, source replacement/append, retained
metadata after the body cache evicts, inherited lifecycle records and the
parent-dependent path. The final Stage 1 suite passed 948/948; minimum Node
22.15.0 provider/content/context regressions passed 36/36. Seven-provider live
Reader/API checks and desktop E2E passed. Large-page complete-history search,
late tool continuation and child navigation were checked in the real browser.
See the staged acceptance record for surface coverage and final CI status.
