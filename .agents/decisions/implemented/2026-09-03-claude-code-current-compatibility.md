---
status: implemented
date: 2026-09-03
decision: Refresh the Claude Code transcript boundary for the currently
published 2.1.259 format by recognizing recorded compact_boundary metadata and
normalizing the observed cache_creation usage object without changing linear
message semantics.
---

# Claude Code current transcript compatibility

## Context

The Claude Code adapter reads provider-owned project JSONL transcripts. The
installed CLI is older than the current npm release, so the provider needed a
fresh official-format check before claiming current compatibility. The refresh
also needed to distinguish recorded compaction and usage facts from UI-only
background, teammate, and memory behavior.

## Evidence

Verified 2026-09-03:

- `claude --version` reports `2.1.207`.
- npm `@anthropic-ai/claude-code` reports `latest`/`next` `2.1.259` and
  `stable` `2.1.236`.
- Official repository `HEAD` and release tag `v2.1.259` both resolve to
  `f173a697aa6486945f1b9c4aa9ce5383d2c87db6`.
- The installed release tag `v2.1.207` resolves to
  `d4d8fbbb333c627d8fe2c1c583a5ccc26fdb1aed`.
- Official session docs describe project-scoped JSONL and show subagent
  compaction as `{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":...}}`.
  The docs also describe separate subagent transcripts, task/team directories,
  mailbox delivery, and cache statistics; those are not transcript records in
  the audited local snapshot.
- Read-only local inspection found 11 project transcript files, 132 parseable
  records, 21 assistant usage records, 14 distinct response ids, and no
  sidechain, task-notification, or compaction-boundary records. Usage records
  include the `cache_creation` object shape (with zero values in this sample).
  A real adapter/protocol smoke loaded 11 sessions.

## Decision

1. Extend `claudeCompactionRecord` to recognize `system` records with subtype
   `compact_boundary`, read only the documented `compactMetadata.trigger` and
   `preTokens`, and emit the existing metadata-only compaction event/artifact.
   A missing trigger remains `unknown`; no manual/automatic state is inferred
   from the record type. Event and artifact IDs include the source record index
   so PreCompact/PostCompact records sharing a compact UUID remain distinct.
2. Normalize `cache_creation_input_tokens` once at the parser boundary, falling
   back to the observed `cache_creation.ephemeral_5m_input_tokens` plus
   `ephemeral_1h_input_tokens` only when the scalar is absent. A scalar value
   wins, so a response carrying both shapes is never double-counted. Anthropic
   `output_tokens` is inclusive of thinking: expose visible output after
   subtracting recorded reasoning, and retain explicit `total_tokens` only when
   it matches the normalized component sum.
3. Keep background/foreground mode, teammates, mailbox messages, goals, memory,
   prompt-cache status, and task outcomes unknown unless a provider transcript
   record or existing consumer establishes their shape. Do not add them to
 linear `recordsToMessages`, ToC, or token ownership from docs-only behavior.

## Alternatives considered

- Rewrite the parser around the latest npm bundle or infer background/team
  state from directory names. Rejected because the official docs call the
  JSONL entry format internal and the local snapshot contains no such records.
- Treat `compact_boundary` as a visible message or include prompt-cache status
  in token totals. Rejected because both would pollute the linear conversation
  or double-count request usage; the existing context artifact and usage
  boundaries are sufficient.

## Consequences

Current documented subagent compaction is visible in Runtime context evidence
with source order and recorded provenance, while ordinary system metadata stays
out of the conversation projection. Cache creation usage remains compatible
with both scalar and nested API shapes; inclusive output/reasoning is counted
once per assistant response fragment. Missing compaction trigger and unsupported
post-token metadata remain unknown. The repository still does not infer team or
background execution from session layout alone. Current 2.1.259 support is
docs/upstream-verified; no live 2.1.259 transcript was available.

## Verification

- Focused Claude parser/protocol tests pass, including four new regressions for
  cache variants, inclusive output/reasoning, `compact_boundary` metadata, and
  unique shared-UUID compaction identities.
- `npm run build:core` and the real local adapter/protocol smoke pass.
- Full `npm test` passes 367 tests; `npm run review` passes typecheck and
  governance; `git diff --check` passes.
- Any compact-boundary test data is bounded, source-derived synthetic data; no
  provider transcript body is copied into fixtures or documentation.
