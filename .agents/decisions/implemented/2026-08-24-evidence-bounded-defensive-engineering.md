---
status: implemented
date: 2026-08-24
decision: Keep defensive validation at real untrusted boundaries and make local pre-push evidence minimal while CI remains complete.
---

# Evidence-bounded defensive engineering

## Context

The initial governance workflow made `pre-push` run the complete Node suite on
every local handoff, while defensive-engineering guidance was implicit and
scattered across provider and protocol rules. That encouraged repeated checks
and made a local pass look like a complete CI result without adding evidence
for the changed surface.

## Decision

Keep `npm run pre-push` as the fast, universal local gate: governance checks and
TypeScript typechecking. Add `npm run ci:quality` as the complete gate and run
it in the quality workflow. Validate only real untrusted boundaries, trust
typed same-process contracts after normalization, and reject abstractions with
no consumer, compatibility layers without source evidence, silent fallbacks,
duplicate copies/checks, and tests for impossible states.

## Alternatives considered

- Keep the full suite in local `pre-push`: rejected because it duplicates CI
  work without proving that every change needs the entire suite.
- Make `pre-push` infer affected tests from Git diffs: rejected because a
  fragile classifier would become another unverified compatibility layer.
- Add a defensive helper or third-party lint rule for these principles:
  rejected because the repository has no current consumer and the boundary is
  adequately documented and checked by lightweight governance tests.

## Consequences

Local handoffs are faster and report a truthful scope; CI still runs the full
build and Node suite on the declared minimum and current release-build Node
versions. Changes that affect providers, runtime, views, or other surfaces
still require the focused, live, or browser evidence from `AGENTS.md`. Future
defensive code must identify its untrusted boundary and consumer before adding
checks or abstractions.

## Verification

`test/governance.test.mjs` pins the distinct local and CI command scopes. Run
`node --test test/governance.test.mjs` and `npm run pre-push` locally; the
quality workflow runs `npm run ci:quality` on the declared minimum and current
release-build Node versions.
