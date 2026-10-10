---
status: implemented
date: 2026-10-10
decision: Pin Reader navigation and execution facts to a verified opened generation
---

## Context

The actively written Codex conversation took about nine seconds per bootstrap,
then returned HTTP 409. Navigation also hashed its approximately 737 MB source
again for each directory page. The [field snapshot decision](2026-10-10-reader-content-snapshots.md)
already made displayed fields stable, but left bootstrap and navigation strict.
Live UI verification also found that automatic resume availability parsed the
entire transcript only to obtain its directory, duplicating the large read and
reporting a source-change error while new records were appended.

## Decision

Cursor/revision-based Reader navigation reads its matching published SQLite
generation in a read transaction. A fresh bootstrap retains the current-source
boundary and replaces that generation; old generation references then fail
explicitly. Ordinary Codex JSONL bootstrap captures a bounded complete-record
prefix and verifies those exact bytes after gathering child/source evidence.
Subsequent append is allowed; rewrite, truncation and removal are rejected.
Unfinished final records do not enter the capture.
Parent Reader dependencies use only the child header and, for copied histories,
the bytes through their first recorded owned-task boundary. Later child replies
do not change those parent facts. Header/boundary changes still invalidate the
capture; the child's own Reader continues to capture its complete source.

Normalized execution events are stored with the same Reader generation. The
Reader execution endpoint requires its revision and pages 1–200 events with
scope/revision-bound cursors. Strict search, Runtime and MCP source queries keep
their existing freshness behavior. Provider records remain read-only.
Runtime and inherited-context panes establish their own strict-source revision
from their first response and check subsequent pages against it. They do not
equate a complete-prefix Reader revision with a full-source domain revision.
Runtime-to-Reader jumps pass their domain revision as `sourceRevision` to
locate. That path checks the strict source before and after resolving against a
fresh Reader generation, retaining the opened Reader revision requirement.
Ordinary Contents navigation keeps the cheaper published-generation path.
Publication retains unchanged content chunks by normalized field fingerprint;
metadata, changed/removed fields and execution facts publish atomically.
Resume resolution asks the provider for current directory metadata. Ordinary
Codex sources read and verify their canonical header and selected path; composed
source pairs and other providers retain their existing metadata resolution.
This action does not read stale Reader or index metadata, and its trusted local
launch boundary is unchanged.

## Alternatives considered

Rehashing the live transcript for every page both repeats expensive work and
invalidates reading during ordinary additions. Serving an arbitrary old
bootstrap would hide current source availability. Keeping multiple full
generations adds storage without a demonstrated consumer. The existing single
published generation and explicit replacement error meet the reading contract.

## Consequences

Readers can finish an opened conversation snapshot while its source grows.
Opening again checks for current records. Another publication may replace the
generation, in which case navigation requires reopening. Complete directory
collection and execution association no longer repeat source parsing. Cold
capture still reads and verifies the selected source; this change does not
promise constant-time bootstrap for very large transcripts.

## Verification

Core regressions cover append during capture, an incomplete tail, same-stat
rewrite, truncation/removal, navigation before and after replacement, stored
execution equality, cursor bounds and scope isolation. UI checks cover automatic
complete Contents, all-group expand/collapse, compact tool disclosure and
multiple recorded returns sharing one dispatch trunk. `npm run ci:quality`
passed review, build, 234 core and 5 app tests, and 708 Node/browser tests
(46 environment-dependent tests skipped). The final resume delta additionally
passed `npm run pre-push`, the full Rust workspace (236 core and 5 app tests;
15 core tests ignored), and the two resume integration suites (14 passed,
1 installed-provider opt-in skipped).

The active real Codex conversation opened without the previous HTTP 409:
28,882 directory entries arrived across 452 pages in 1.22 seconds; individual
directory, execution and segment reads took 2–5 milliseconds. Its initial
projection rebuild took 16.46 seconds and a later capture with content reuse
took 8.61 seconds. These observations retain the large-source bootstrap cost.
The final native resume endpoint returned HTTP 200 with the canonical session
ID, structured command and current working directory. Browser verification
checked complete Contents, all-group collapse/expand, and loaded Input/Output.
