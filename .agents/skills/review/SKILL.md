---
name: opensession-review
description: Review an AgentSession change against repository architecture, decision records, and the affected-surface validation matrix before handoff.
---

# Review Skill

Use this read-only workflow before handing off a change. It is deliberately
small and complements, rather than replaces, the validation matrix in the
repository `AGENTS.md`.

1. Inspect `git status --short` and the complete diff. Preserve unrelated dirty
   work and never edit `dist/`, `tmp/`, or `logs/`.
2. If the change is non-trivial, verify that a decision record exists in the
   right lifecycle directory and that its verification section matches the
   actual commands.
3. Apply evidence-bounded defensive engineering while reviewing: check
   untrusted provider/config/HTTP/subprocess boundaries at their owner, trust
   typed same-process contracts after normalization, and reject abstractions
   without consumers, compatibility layers without source evidence, silent
   fallbacks, duplicate copies/checks, and tests for impossible states.
4. Run `npm run review` (governance checks plus TypeScript typechecking).
5. Run focused tests, `npm test`, or live/browser checks according to the
   affected-surface matrix. Treat a helper or model review as advisory until
   source and tests confirm it.
6. Report findings with file paths, evidence, and any validation not run.

This Skill does not authorize commits, pushes, provider-data writes, or broad
cleanup.
