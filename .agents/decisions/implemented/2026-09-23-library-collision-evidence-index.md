---
status: implemented
date: 2026-09-23
decision: Retain bounded source text in the viewer index for same-title Library identification
---

## Context

The Library index held titles and timestamps but no content evidence. Same-title Codex sessions therefore could not show an actual difference without parsing whole transcripts on each Library request.

## Decision

Codex's existing startup scan selects up to five short, normalized user texts from messages it already parsed. The viewer-owned `session_index.library_evidence` column stores at most 1,024 characters per selected text, retaining both the beginning and end when the source is longer. The Library compares only visible same-title, same-project rows and shows a short tail excerpt, where observed evaluation records place the concrete question after shared instructions. Repeated attempts of one question may share that excerpt while their time and ID remain distinct. Source records remain read-only; missing or universally identical evidence leaves exact UTC time and canonical-ID prefix as the discriminator.

## Alternatives considered

- Parse transcripts for every Library request: rejected because a collision can involve dozens of large sessions.
- Infer a summary from titles or IDs: rejected because it would not be source-backed content.
- Extend every provider adapter now: deferred until another provider has a concrete same-title consumer and an efficient extraction path.

## Consequences

The viewer metadata database now contains bounded user text for indexed Codex sessions, including text that may be sensitive. The existing loopback-only viewer is the only consumer. Old indexes gain the nullable column on open and receive evidence at the next provider scan. Browser output is HTML-escaped.

## Verification

`npm run review` passed (governance and TypeScript). The final combined suite passed 1,070 tests, including the least-shared-evidence regression. The actual 41-session Codex evaluation project retains independent rows and now displays source question excerpts, exact UTC times and canonical-ID prefixes. Desktop E2E completed 230 steps without browser errors. Publication results are recorded in `docs/specs/reader-feedback-2026-09/tasks.md`.
