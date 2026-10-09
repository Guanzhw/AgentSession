---
status: implemented
date: 2026-09-28
decision: Family Library ordering uses compiled ICU4X data and the server process locale to preserve the 2.0 title and identity comparisons
---

# Family Library title collation

## Context

The frozen 2.0 and 3.0 week-filtered Library returned the same 21 canonical
sessions. Updated-time orders matched, but both title orders differed. The
[2.0 comparator](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/library-families.ts) uses server-default Intl
collation with base sensitivity for effective titles, subtree update descending
for equivalent titles, then default-strength provider and ID collation. Rust
used lowercase codepoint order and skipped the subtree update tie-break.

## Decision

[Core collation](../../../v3/crates/core/src/collation.rs) initializes two ICU4X
collators once per Core, sharing their compiled data across clones. Primary
strength corresponds to Intl base sensitivity; identity comparisons retain the
locale's default strength. [Family ordering](../../../v3/crates/core/src/library.rs)
uses the existing Viewer-overlaid title, restores the subtree recency tie-break,
and shares this comparison between roots and direct children. Only the primary
title comparison reverses for descending order.

Windows reads the user-default locale through the public Windows API. The
initial POSIX process locale reads LC_ALL, LC_MESSAGES, then LANG; C/POSIX maps
to en-US as in V8 Intl. UI language remains independent. Invalid locale input
is diagnosed rather than replaced with codepoint order. Locale and pinned
collation/data version identify the family inventory revision, invalidating
continuations when the ordering changes. The legacy flat lists retain their
separate sorting contract.

## Alternatives considered

Lowercase comparison loses accent equivalence, canonical equivalence, and
Chinese collation. Browser-language ordering would change the 2.0 contract.
Platform collation APIs or dynamically linked ICU would make portable behavior
depend on host library availability and version. ICU4X supplies the sorting
algorithm and data in Rust; only Windows locale discovery uses an OS API.

## Consequences

The Rust binary embeds additional collation data. Versions are pinned in the
manifest and lockfile; collation/data upgrades must update the revision marker
and rerun the oracle. Equivalent locale settings produce consistent ordering
across platforms; different server locales may intentionally produce different
orders. Node ICU and ICU4X data releases can differ, so passing the public and
frozen oracles establishes the checked scope, not every possible Unicode input.

## Verification

- [Public HTTP oracle](../../../v3/test/library-title-sort.test.mjs) first failed
  on the prior binary, then passed against the rebuilt Rust server. It compares
  root and child pagination against Node Intl, including Chinese/Latin titles,
  accents, canonical equivalents, recency ties, case-sensitive IDs, numbers,
  punctuation, and Viewer renames. The synthetic provider database hash stays
  unchanged.
- `cargo test --manifest-path v3/Cargo.toml --workspace`: 122 core and 2 app tests
  passed; 13 existing private-input tests ignored. Focused tests cover explicit
  zh-CN/en-US order, POSIX normalization, and root/child cursor rejection after
  changing the server locale.
- An isolated freshly built Windows process matched the fixed 2.0 server for
  all four week-filtered sorts, 21 IDs each. All 134 frozen source hashes stayed
  unchanged. Private local evidence is retained under ignored
  `tmp/title-sort-frozen-ZjElUW/evidence.json`.
- WSL Node probes confirmed C, C.UTF-8, zh_CN.UTF-8, en_US.UTF-8, and POSIX
  latin/euro/valencia modifier resolution. Linux Rust execution remains
  unverified: installed Snap Cargo
  failed with a timeout waiting for system profiles to update.
- The four focused Library/legacy-list HTTP tests and `npm run review` passed;
  changed tracked files passed `git diff --check`.
