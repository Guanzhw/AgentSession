---
name: opensession-pre-push
description: Validate an AgentSession branch immediately before a user-authorized push or release handoff without changing repository history.
---

# Pre-push Skill

Use this workflow immediately before a user-authorized push or release handoff.
It does not itself push or modify repository history.

1. Confirm `git status --short`, the branch, remotes, and the intended diff.
2. Use the [review workflow](../review/SKILL.md) to confirm the intended changes
   have the validation required by the affected surface.
3. `npm run pre-push` is an alias for `npm run review`: governance checks plus
   Rust formatting and compilation. Reuse a successful run of either command from this
   task when its inputs still match; otherwise run `npm run pre-push` once.
4. Check `git diff --check` and generated-file status. Stage only intended work
   when committing is authorized, then verify the staged diff.
5. Report the intended commit and validation, including reused evidence. After
   an authorized push, verify remote branch/commit alignment and the relevant CI
   result before claiming remote delivery is complete.

The complete local gate is `npm run ci:quality` (review followed by `npm test`).
`.github/workflows/quality.yml` checks review and root helper tests;
`.github/workflows/v3-native.yml` checks native Rust, UI, integration tests, and
unpublished portable artifacts on its declared platform matrix. A local
pre-push handoff does not claim either CI workflow passed.

If a check fails, fix or explain it before pushing. This Skill never permits
rewriting history, moving tags, or mutating provider-owned data.
