---
status: implemented
date: 2026-09-19
decision: Read downstream consolidation evidence on demand as an artifact protocol extension
---

## Context

Stage1 summaries are readable. Retained Codex diagnostic logs additionally
identify a later Phase2 turn, requests to read a summary and requests to modify
long-term memory. The generator has no readable rollout. Current global jobs
overwrite earlier runs and do not provide a generation-thread foreign key.

## Decision

Extend the existing ContextArtifact inspection contract with optional on-demand
evidence access. Shared protocol types describe downstream activities, request
records, derived artifact bindings and checked coverage; Codex owns discovery,
log parsing and file resolution. Body reading and closed Reader rendering do not
scan logs. Present the later activity beside the summary with source expansion.

Preserve Stage1 production evidence. Recorded read/patch requests and a current
file match do not prove execution success or historical input bytes. Keep missing
generation history explicit and keep diagnostic activities out of message usage,
ToC and canonical session discovery.

## Alternatives considered

Writing a foreign generation ID into local run references breaks snapshot
ownership. Synthesizing a full conversation from partial diagnostics misstates
retention. Inferring linkage from the global job or time proximity lacks an
explicit key. Eager log discovery would burden unrelated Reader requests.

## Consequences

Add one optional adapter evidence method and a bounded artifact evidence route;
source text uses existing progressive rendering. Cursors bind artifact version,
window and log positions. Scope and unfinished work remain visible. See the
[presentation and contract plan](../../../docs/design/reader-memory-followups.md).

## Verification

`npm test` passes 916 tests. Provider, route, render, progressive and client
coverage passes 43 tests on Node 22.15.0. Independent review passed after fixing
retention rechecks and continuation inside multi-file requests. The real saved
summary discovers one generation and seven requests automatically; all nine
source pages match their log text. Arbitrary row selectors are rejected. The
original API fields, selected memory row, summary file and sampled log hashes
remain unchanged. Seven-provider Reader/API checks and the full E2E suite pass.

Real UI checks and publication evidence are recorded with their exact scope in
the [acceptance record](../../../docs/design/runtime-acceptance-evidence.md).
