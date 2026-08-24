---
name: opensession-pre-push
description: Validate an AgentSession branch immediately before a user-authorized push or release handoff without changing repository history.
---

# Pre-push Skill

Use this workflow immediately before a user-authorized push or release handoff.
It does not itself push or modify repository history.

1. Confirm `git status --short`, the branch, remotes, and the intended diff.
2. Apply evidence-bounded defensive engineering: validate only real untrusted
   boundaries, trust typed same-process contracts after normalization, and
   reject no-consumer abstractions, unsupported compatibility layers, silent
   fallbacks, duplicate copies/checks, and impossible-state tests.
3. Run `npm run pre-push`. This is the local fast gate: governance checks plus
   TypeScript typechecking. It intentionally does not repeat the full suite.
4. For user-visible, provider, runtime, or release changes, perform the live
   or artifact checks required by `AGENTS.md` as well.
5. Re-run `git diff --check`, inspect generated-file status, and report exact
   results. Do not stage unrelated work.

The complete CI gate is `npm run ci:quality` (the fast review gate followed by
`npm test`) and is run by `.github/workflows/quality.yml` on the declared Node
minimum and current release-build version. A local pre-push handoff does not
claim the full CI suite passed.

If a check fails, fix or explain it before pushing. This Skill never permits
rewriting history, moving tags, or mutating provider-owned data.
