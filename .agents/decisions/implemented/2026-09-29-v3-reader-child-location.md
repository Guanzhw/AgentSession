---
status: implemented
date: 2026-09-29
decision: Restore known child paths through a revision-bound Reader placement locator
---

## Context

The final Windows candidate's real three-level Codex path needed 51 sequential
root relation requests before finding its recorded child placement. Warm open
and reload took 26.65 and 26.18 seconds. Each request rechecked the 753 MB root
source revision. Correct navigation still imposed avoidable repeated source work.

## Decision

Add `GET /api/v3/reader/:provider/:sessionId/child-location` with `revision`,
`childProvider`, and `childSessionId`. The HTTP boundary validates the query.
The Rust Reader returns one canonical child's verified placement and anchor
location, or `child_placement_unavailable` when no such placement exists.
Recorded unverified-parent or unavailable-anchor diagnostics remain explicit.

The published Codex Reader cache is checked against the current source revision
once. Its small placement rows are visited in source order, preserving the same
first-placement rule and parent validation as paged relations. Other adapters
use their existing normalized placement projection. The UI uses the locator to
restore missing root/nested placements; ordinary collaboration browsing stays
paged. Stale revision requests fail with 409, and child content remains owned by
the canonical child while the root URL retains its owner.

## Alternatives considered

Larger pages or eager parallel relation fetching still load unrelated work.
Relaxing source hashing would change freshness guarantees. A new cache schema
or persistent index is unnecessary for this bounded-response lookup over
already published placements.

## Consequences

Deep restoration takes one placement lookup per missing ancestor instead of
one source probe per preceding relation page. Cached placement scanning remains
linear in the small placement projection; it does not decode prior event bodies
or reread provider source per page. Existing cache generations remain usable.

## Verification

`v3/test/codex-three-level-slice.test.mjs` records RED against the previous
Windows package (missing API and three relation requests), then verifies exact
late anchors, a forged root-to-grandchild request rejected by canonical parent
validation, missing targets, actual source append after publication returning
409, and browser recovery without draining unrelated pages. Invalid-to-valid
root and nested path transitions also clear the previous diagnostic. Concurrent
nested-anchor and ancestor-search restoration keeps each loaded segment unique.
Existing three-level continuation, focus,
reload, Back/Forward and pane-search tests run against the updated release.
The exact tested Windows ZIP is
`tmp/v3-delivery/agentsession-v3.0.0-win-x64-2dd3c8ab.zip` (SHA-256
`80441bf3b25ac1a1e8eeadff15029e584b29215d7e1af7f685733d9a72c88b88`); its
unpacked executable SHA-256 is
`2dd3c8ab81c59080924982dd57753386f9bb9ca691bda6256223186f350b2868` and
manifest SHA-256 is
`edbb5ba9b826997acaba63e497eee5eb232fae706e3b49beb6b4c38eba5fc3e7`. All six
manifest payloads and checksum entries were verified. The exact unpacked
binary passed the focused 13-test suite and standalone release suite 3/3; the
exact-package DSH complex Reader passed 1/1.

The real three-level frozen Codex run is documented in
`tmp/v3-three-package-2dd3c8ab/README.md`: open/reload to the deep search changed
from 26,645/26,179 ms on 68f60ac2 to 2,421/1,945 ms, total API calls fell from
66 to 14, and root relation calls fell from 51 to 1. The run retained two
recorded spawn anchors, child-owned 326 cards, grandchild continuation 32→39,
search/refresh/Back/Forward/focus restoration, 11 byte-identical source
replies, and all three source hashes. These are warm local observations, not a
cold-disk or p95 claim. The independent review found no P1/P2; the stale
diagnostic and duplicate-mount P3 findings were fixed and regression-tested.
Windows full Node, a matching Linux build/run, and side-by-side rollover remain
pending. Stats/search/HTTP evidence from 68f60ac2 is not attributed to this new
binary, and overall 3.0 acceptance remains open.
