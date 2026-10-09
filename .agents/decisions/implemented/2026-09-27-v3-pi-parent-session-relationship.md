---
status: implemented
date: 2026-09-27
decision: Project Pi header parentSession into a derived cross-session parent relationship while keeping entry parentId file-local.
---

# Pi parent session relationship in 3.0

## Context

The Pi adapter already normalizes a canonical parent session from the session
header's `parentSession` path for the Library and Reader summary. Its protocol
left relationships unknown, so Runtime Sessions could not navigate from that
child to the identified parent. Pi entry `parentId` has different meaning: it
connects records within one file, including alternate branches.

## Decision

The Pi provider builds a `parent` relationship only when its existing header
normalization yields a canonical parent session ID. The header event anchors
the relationship at the same source revision. Provenance is `derived` because
the canonical ID comes from a recorded path; the path alone does not prove a
separate parent source is currently available or whether Pi rotated or forked
the session. Runtime marks an unresolved target unverified and offers its
canonical Reader link. An opaque nonempty path keeps relationship coverage
unknown; an absent path reports not observed. File-local entry `parentId`
never creates a cross-session relation, Task, or AgentRun; its branch use is
recorded in [Pi file branch topology](2026-09-28-v3-pi-file-branch-topology.md).

## Alternatives considered

Keeping the relation only in the summary leaves the Sessions graph unable to
show a recorded navigation target. Treating entry ancestry as a session link
would misattribute Pi's in-file branches. Requiring the parent file to exist
before projecting the header would erase valid source evidence when only the
child file is retained.

## Consequences

Pi declares partial derived support for session relationships. Its protocol
v2/v3 facts, Runtime Sessions graph, and Reader navigation can now refer to
the same canonical parent ID. This does not establish that a linked parent
file can be read.

## Verification

The public Pi protocol test first failed because relationships were empty.
After the provider change, all six Pi foundation HTTP tests passed, including
both current/legacy headers, an opaque path, a real frozen parentless source,
and the Runtime graph. A real browser opened a synthetic parent Reader from
the public child fixture and Back restored the child's Sessions lens and
focused link. The public Pi source hash remained unchanged. Rust debug build
and `cargo fmt --check` passed; broader workspace and final release checks
remain part of the 3.0 acceptance plan.
