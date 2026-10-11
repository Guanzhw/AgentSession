---
status: implemented
date: 2026-10-11
decision: Derive stable and prerelease publication channels from one validated version identity
---

## Context

The user selected AgentSession 3.0 stable readiness. The current publication
pipeline only accepts prerelease versions and always selects npm `next` plus a
GitHub prerelease. Version changes alone cannot produce a stable release.

## Decision

Implement the version-derived release identity described in the
[stable readiness design](../../../docs/specs/stable-readiness-2026-10/design.md).
Stable versions map to `latest` and a normal GitHub release; prereleases retain
their existing channel. Preserve immutable artifacts, exact tag/commit checks,
four-host evidence and explicit validation-only behavior.

## Alternatives considered

Manually overriding channels independently of the version can publish an
inconsistent identity. Duplicating the complete pipeline would duplicate its
artifact and provenance checks. Share the existing checks and derive the small
channel-specific behavior from the validated version.

## Consequences

Workflow triggers, packaging metadata, npm publishing and GitHub publication
must agree. Existing prerelease regressions remain required. This change does
not authorize publishing the current local candidate.

## Verification

`test/prerelease-publish.test.mjs`, `test/release-channel.test.mjs` and
`v3/test/npm-prerelease-packaging.test.mjs` cover stable and prerelease channels,
exact tag/commit identity, validation-only conditions, immutable retries and
offline packing. Windows Node 22.15.0 passed 15 cases with one explicit
Linux-only archive skip; WSL Linux Node 24.16.0 passed all 16 cases. These use
task-owned staging and fake external publication commands; nothing was
published. Full candidate regression and independent review remain tracked in
the [stable task ledger](../../../docs/specs/stable-readiness-2026-10/tasks.md).
