---
status: implemented
date: 2026-09-02
decision: Make Work Graph the default session-detail projection, organize it around the four Session Protocol v3 domains plus Evidence, and stop the parent Conversation table of contents at child-session boundaries.
---

# Work Graph-first session detail

## Context

The session detail page opened on a linear Conversation transcript and exposed
Runtime as a secondary five-lens inspector. That hierarchy obscured asynchronous
work, execution attempts, continuing coordination, and context transformations.
It also recursively indexed child-session messages in the parent Conversation
table of contents, so inherited or shared background context appeared as if it
were new parent-session navigation content.

Session Protocol v3 and its bounded Work, Execution, Coordination, and Context
projections now provide a provider-neutral read boundary. The existing v2 event
projection remains the canonical source for detailed evidence and for recorded
compaction summaries while providers adopt native v3 facts incrementally.

## Decision

Make Work Graph the first and default session-detail tab. Its primary lenses are
Work, Execution, Coordination, and Context; Evidence is a cross-cutting fifth
lens for protocol events and provenance. Conversation, Overview, and Raw remain
available as alternate projections over the same canonical provider session.

The server builds all four bounded v3 projections before rendering. Browser code
only controls lenses, filters, and evidence drawers; it does not interpret
provider vocabulary. Unknown coverage and missing usage stay explicitly not
recorded. Context renders the resulting version, artifact, or recorded
compaction summary before collapsed lifecycle and token evidence. Recorded
memory, experience, and user-info artifacts display their provider-normalized
kind and scope. Direct, inherited, and shared request-context slices are shown
without adding them to the session's direct token aggregate.

The parent Conversation table of contents indexes an attached or detached child
session as a task/subsession entry and does not recurse into that child's message
entries. The child transcript remains in the Conversation body and its canonical
session link remains available.

## Alternatives considered

- Keep Conversation as the default and only rename Runtime. Rejected because it
  preserves the transcript-first hierarchy that the Work Graph is intended to
  replace.
- Put raw events beside the four domains. Rejected because events are evidence
  for several domains rather than a fifth work domain.
- Remove child transcripts from the parent page. Rejected because the problem is
  navigation duplication, not the availability of provider-recorded content.
- Infer context transformations or token origins from UI timing. Rejected because
  those semantics belong to provider normalization and v3 protocol evidence.

## Consequences

Users land on a bounded work-oriented view while retaining direct access to the
original transcript and raw export. Background work no longer floods the parent
Conversation table of contents with copied context. Providers that only expose
v2 facts degrade truthfully: existing tasks, runs, lineage, artifacts, and
compaction summaries remain visible, while native coordination, versions,
transformations, actors, and token origins remain unrecorded until mapped.

## Verification

- `npm test` passed 309 tests, including Work Graph, bounded legacy compaction
  results, Session Protocol v3 projections, and attached/detached child ToC
  regressions.
- `npm run review` passed governance and TypeScript checks; `git diff --check`
  passed with line-ending warnings only.
- Live v3 Work, Execution, Coordination, and Context API checks passed for real
  OpenCode, Codex, Pi, and DeepSeek Harness sessions. Each response preserved
  explicit coverage/completeness and reported no truncation for the selected
  sample.
- `npm run qa:e2e` passed against the restarted local server and a real
  OpenCode session, including the default Work Graph tab, all five lenses,
  Conversation navigation, canonical coordination links, and zero browser
  errors.
- Pi WSL reviewed the change read-only with
  `deepseek-v4-flash-vision-exp`. Its actionable findings were resolved by
  bounding the legacy compaction fallback, completing localization, clarifying
  coverage labels, and synchronizing both READMEs and the v3 API list.
