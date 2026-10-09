---
status: implemented
date: 2026-10-01
decision: Return a canonical initial Reader target through one validated bootstrap snapshot
---

# Targeted Reader bootstrap

## Context

Five actual source-navigation HAR captures on Windows426 show bootstrap,
locate, and parallel segment/outline requests on the critical path. Each opens
a current Reader model and repeats the Codex source revision boundary.
Provider discovery completes earlier in all five; outline gating adds only
9ms in one. The target paragraph and complete body match fixed 2.0, but the
426 selected-paragraph median is 940ms versus 444ms. One fixed2 viewer DB
changed bytes during first detail initialization, so that overall preservation
attempt remains failed rather than being relabeled as a pass.

## Decision

Accept optional initial `messageId` and `segment`, with an optional revision,
on the v3 Reader bootstrap endpoint. Open one current provider snapshot,
locate the canonical event, and return its bounded page and outline together.
Keep the opening page for hash-clear/Back and a bounded opening outline only
when the target uses a different outline page. The response contains at most
64 transcript items and 128 outline entries. Absent query keeps the existing
opening response; invalid or missing targets fail explicitly.

The UI uses this snapshot for its initial canonical fragment. Subsequent
source jumps retain revision-bound locate and pagination. Viewer title
overrides stay in the metadata wrapper. Source membership, collision,
same-size rewrite and byte-revision checks retain their current owners.

## Alternatives considered

Dropping outline gating saves little in the measured sample. Stat-only source
freshness would weaken observed rewrite/collision correctness. Client-side
parallel lookup cannot locate a page before the owning current revision exists.

## Consequences

This reduces initial source-navigation round trips while retaining the same
visible target and later navigation semantics. The optional native HTTP shape
must be documented and tested at its owner. A code-path reduction does not
establish a measured latency improvement.

## Verification

Retain the old426 HTTP/browser RED results, verify malformed/incomplete query,
missing event, supplied stale revision, metadata title and bounded pages.
Exercise actual initial fragment, hash-clear/Back, default opening and stale
bootstrap cancellation. Rebuild a release, bind its source/assets/executable,
then repeat the same-paragraph warm matched benchmark with stabilized viewer
metadata before making performance claims.


The retained Windows426 HTTP and browser RED cases are followed by two focused
Rust checks, workspace176 core+5 app pass (14 ignored),15 native Reader/HTTP
checks and5 browser checks. Independent review found noncontiguous active
opening/target pages made the Previous button miss the middle page. The UI now
activates the selected page only, retaining the opening page for Back. Actual
Chromium traverses65–96→33–96→33–101, keeps unique anchors and restores the
opening reply; independent follow-up1/1 passes. Original RED and an obsolete
mock's later404 timeout remain retained.

The final remapped Windows release is d86b23227f6de5a8d5a76fddc3729dfe669d69f61875f90edccf763a54642d5b;
its independent ZIP extraction verifies6 payload files and7 checksum lines.
The70 production inputs are bound by ledger7af871adaa2efe65ccc57638ea8990525ea85474e6be00b7d8bf8d30c010ed94.
Exact extracted release full serial Node:452 total,423 pass,0 fail,29 conditional
skips, including fresh host npm install/Web/native MCP checks. A shell warning
for a nonexistent optional isolation-config path is retained; the test-owned
config/source paths and existing assertions were unchanged. Native frozen
source bootstrap/body checks already establish one bootstrap and zero initial
locate/segments/toc requests. A new matched warm performance run remains open;
no latency improvement is claimed here.

Evidence: independent follow-up (`../../../tmp/v3-delivery/bootstrap-defaults-independent-review-20261001/FOLLOWUP.md`, local evidence),
source/debug contract checks (`../../../tmp/v3-delivery/reader-target-bootstrap-20261001/FINAL.md`, local evidence),
package binding (`../../../tmp/v3-delivery/package-d86b2322-target-verification.public.json`, local evidence),
full release checks (`../../../tmp/v3-delivery/full-v3-node-d86b2322-target.log`, local evidence).
