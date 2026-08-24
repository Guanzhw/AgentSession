---
status: implemented
date: 2026-08-24
decision: Keep agent-native maintenance governance as small checked-in records, Skills, and repository scripts.
---

# Agent-native maintenance governance

## Context

AgentSession already documents provider ownership, Session Protocol boundaries,
and a validation matrix in `AGENTS.md`, but agents had no durable place for
cross-cutting decisions or a single mechanical review entry point. DeepSeek
Harness demonstrates that agent notes, scoped Skills, and executable gates can
make agent work legible without putting every detail into the root guide.

## Decision

Use `.agents/decisions/{proposed,implemented,rejected}` for the narrow class of
non-trivial decisions described in `AGENTS.md`. Provide `review` and `pre-push`
Skills as reusable workflows. Make `npm run check:governance` the small,
dependency-free gate for decision shape, local Markdown file targets, and two
existing architecture boundaries: shared provider code must remain
provider-neutral and the runtime projection must not branch on provider IDs.

## Alternatives considered

- Copy DeepSeek Harness's larger documentation tiers, generated catalogs, and
  archival tooling: rejected because AgentSession is a small Node viewer and
  those tiers would add maintenance without a current consumer.
- Require a decision record for every change: rejected; it would create noise
  and make the lifecycle less trustworthy.
- Add a third-party linter: rejected; the repository intentionally has no
  runtime dependencies and the checks are easy to keep deterministic in Node.

## Consequences

Agents gain a durable rationale trail and repeatable review commands. The gate
is intentionally conservative: it catches structural drift, not semantic
correctness, so normal type, unit, provider, and browser validation remains
required. A future reversal is represented by a new decision and link.

## Verification

Run `npm run check:governance`, `npm run review`, and the validation command from
the affected-surface matrix in `AGENTS.md`. The initial implementation is
covered by `test/governance.test.mjs` and the pull-request quality workflow on
the declared minimum Node version and the current release-build Node version.
