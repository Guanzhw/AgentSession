---
name: opensession-review
description: Review an AgentSession change against repository architecture, decision records, and the affected-surface validation matrix before handoff.
---

# Review Skill

Use this workflow to assess the intended diff before handoff. The
[repository validation matrix](../../../AGENTS.md#validation-matrix) determines
the required checks.

1. Inspect `git status --short` and the intended diff, preserving unrelated
   work. Identify what changed since the last review and validation.
2. If the change is non-trivial, verify that a decision record exists in the
   right lifecycle directory and that its verification section matches the
   actual commands.
3. Apply the repository's
   [ownership and defensive-engineering rules](../../../AGENTS.md#evidence-bounded-defensive-engineering)
   to the changed code and its affected consumers.
4. Reuse successful checks when their covered files, dependencies, configuration,
   and relevant runtime state still match. A result needs an identifiable scope
   and outcome; a documentation claim alone is not evidence of execution.
   Review the new delta and rerun checks whose inputs or affected behavior changed.
5. For documentation-only changes, check content and run
   `npm run check:governance`. For code changes, run `npm run review` (governance
   plus Rust formatting and compilation) and the matrix's affected tests/live checks,
   unless matching results from this task are already available.
6. Use an independent reviewer when risk or a fresh perspective warrants it.
   Batch small related corrections; a documentation or version-only follow-up
   can reuse the implementation review while checking its own changed surface.
   Treat helper findings as advisory and verify them against source and results.
7. Report the reviewed scope, findings, checks run or reused, and remaining gaps.

This Skill does not authorize commits, pushes, provider-data writes, or broad
cleanup.
