---
status: proposed
date: 2026-09-03
decision: Add an optional read-only capability that correlates a session with git commits by its session time window against local repository history (bounded, derived viewer evidence); path-based matching is deferred until bounded extraction of recorded file paths from session tool/edit evidence is researched and proven.
---

# Session ↔ git commit association (proposed)

## Context

The UI information design (`docs/design/ui-v2.md`) surfaced a user question the
current product cannot answer: "会话和 git(如果是 git 管理的仓库)之间是否有联系?"
Sessions already carry a project directory and recorded file-change statistics
(`Files +N −N` on the detail header), but no file paths are recorded in the
session summary — only counts — and there is no linkage between a session and
the commits it produced. The server is loopback-only, treats provider data as
strictly read-only, and the repository is plain local git state that can be
read without mutating anything.

This capability would be **derived viewer evidence**: a viewer-side correlation
from session time window and recorded file paths (paths are not currently
available — see below) against local git history, never a provider-recorded
fact, and it must be displayed as such. It is bounded and read-only, and it is
**lower priority than the explicit product goal** (usable Work Graph evidence /
token ownership); it is considered only after the core provider/ownership work.

**Path provenance is unproven.** The file paths needed for path-based matching
do not exist in today's session summaries. Whether a bounded extraction from
session-recorded tool/edit evidence is possible is **not established**: it
requires research first, and must be proven before any path-based correlation
is claimed. Until such an extraction is researched and proven, the capability
can only correlate on the session time window, and a pure time-window
correlation must **not** be presented as commit association; it must be
displayed as ambiguous window overlap, at best.

**"User question is real" ≠ "existing implementation consumer".** The question
is genuine, but that is not a demonstrated consumer: nothing in the UI or API
uses this capability today. It stays `proposed`, low priority, read-only,
derived, and bounded until a real consumer exists.

## Decision

Propose an optional, read-only capability:

- For a session whose project directory is a git working tree, read local git
  history (`git log --since/--until` bounded to the session time window, plus
  `--name-only` paths) and correlate commits in that window;
- Path-based matching is **deferred**: file paths are not in the session
  summary, and bounded extraction from session-recorded tool/edit evidence
  must first be researched and proven (recorded shape scan, bounded extraction
  rule, evidence of what tools record) before any such matching may be
  described as commit association;
- Until that research lands, the display can only state time-window overlap
  (ambiguously matched candidates), labeled as derived viewer correlation, and
  must not claim a commit was produced by the session;
- Surface "相关提交" on the session detail (检查器): commit subject, time,
  hash, and — only once paths are proven available — the matched files, marked
  as derived evidence (viewer-side correlation, not provider-recorded fact);
- Never write to git or provider data; a session without a git repo shows
  nothing (not an error); matching is time-window based (path-based only after
  research proof), bounded, and never claims a commit was "made by" the
  session beyond the evidence shown.

This proposal stays `proposed`; nothing is implemented at HEAD. No opt-in
config toggle, API, or security surface may be added until a demonstrated
consumer exists (there is none today).

## Alternatives considered

- Do nothing (keep file stats only). Rejected: the question is real, but that
  is a user question, not a demonstrated implementation consumer — no UI/API
  consumes this capability today; the record stays `proposed` until one exists.
- Full git integration (branches, diffs, blame views). Rejected: out of scope
  for a session viewer; adds mutation-adjacent surface without a user case yet.
- Wait for providers to record commit associations. Rejected as the sole path:
  no current provider records this, and local read-only correlation can answer
  the question today without protocol changes. Time-window overlap alone is
  weak evidence and is presented exactly as that — never as commit association.

## Consequences

If ever implemented: a new server module reads git history read-only;
correlation is derived and labeled as such. Sessions outside a git tree, or
with no matching commits, show no section. The capability must respect the
loopback/same-origin rules like all other management surfaces. It must not add
an opt-in config toggle or a new API/security surface without a demonstrated
consumer; until one exists, this record stays `proposed` and after the core
provider/ownership work, not before. No path-based matching may be claimed
until bounded extraction from session-recorded tool/edit evidence is
researched and proven: the session summary today carries only file counts
(`+N −N`), no paths.

## Verification

- `npm run check:governance` passes for this record (proposed state).
- If ever implemented: real-data check on this repository — a session whose
  edits produced known commits shows them in the section; a session with no
  matches shows nothing; a non-git project shows nothing.
- Until implemented, no verification beyond the record shape is expected.
