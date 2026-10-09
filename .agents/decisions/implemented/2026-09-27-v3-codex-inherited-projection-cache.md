---
status: implemented
date: 2026-09-27
decision: Reuse the parsed Codex inherited-context projection only after exact selected-source validation.
---

# Codex inherited projection cache

## Context

The inherited-context list and content routes reparsed a child transcript on
every page. A public 10,001-item fixture needed 251 list requests and seven
content requests; the list traversal took 90.35 seconds before this change.
Inherited context must still reflect provider source rewrites immediately.

## Decision

The Codex adapter selects the source on every request and reads its raw bytes.
It reuses a normalized inherited projection only when selected path, source
scope, canonical session ID, raw SHA-256, and inherited parser version match.
The cached events are shared through an `Arc`; list responses clone only the
requested page, and content responses access one ordinal. Entries are bounded
to four and about 64 MiB of source plus normalized projection data. A source
rewrite or different selected path parses again. Reader revision and cursor
validation retain their existing exact-source behavior.

## Alternatives considered

Caching by file metadata alone would miss same-length rewrites with unchanged
timestamps. Caching the entire Reader session would retain unrelated owned
history and make the inherited endpoint's memory cost harder to bound.

## Consequences

Repeated pages hash the selected raw source but skip JSON parsing and inherited
normalization. Memory use is bounded by the small cache; sources above its
limit continue through the uncached path.

## Verification

A focused Rust test was RED with two normalizations for two identical requests,
then GREEN with one. It also checks a same-length rewrite with restored mtime,
a changed selected path, and a distinct source scope. The public inherited
HTTP contract, opt-in frozen child check, and Rust workspace pass. On the same
public 10,001-item benchmark, list traversal is 9.55 seconds with 36.50 ms
median page latency; seven content pages take 0.26 seconds. Source hashes and
all returned items/content remain exact.

## Limit

This cache does not cover a long parent's owned Reader bootstrap or relations.
The frozen 753 MB root still took 20.58 seconds for bootstrap and 19.99 seconds
for its first relations page in a separate run; that path needs its own
bounded projection design before long three-level reading performance is
considered complete.
