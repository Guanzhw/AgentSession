---
status: implemented
date: 2026-10-09
decision: Accept observed released DSH generation-3 control events at the provider boundary
---

## Context

The normal DSH source root contains a generation-3 session whose required
`agent-preset/selected` event at sequence 3 prevents capture. Its data is the
single `agentPreset` string field. The installed producer
`@deepseek-ai/dsh` 0.1.7-rc.2 includes this name in the released v3 event
vocabulary in `dsh-session-format-v3-to-v4/lib/index.js`, and
`dsh-agent-preset-registry/lib/types/session.d.ts` declares the payload as
`{ agentPreset: string }`. Its writer records the selection before the first
turn to preserve the composition used by later turns.

After admitting selection, the normal source root exposed a required nested
PTC dispatch start. A read-only inventory of all 10 generation-3 files at that
time covered 5,011 events and found five more missing released event kinds:
`approval/asked` (5), `approval/decided` (5), `deliverables/presented` (1),
`tool/ptc-dispatch-start` (105), and `tool/ptc-dispatch` (105). Every name occurs
in the installed released-v3 vocabulary. Published owning declarations are
`dsh-user-approval/lib/types/types.d.ts`,
`dsh-tool-present/lib/types/types.d.ts`, and
`dsh-tools/lib/types/types.d.ts` under the same installed producer.

## Decision

Accept these six observed control event kinds for generation 3 in the
[owning DSH parser](../../../v3/crates/core/src/providers/deepseek_harness.rs),
validating published payload field types there. Selection requires its string
preset. Approval audit records require declared identifiers and the closed
decision outcome vocabulary. Presented files require their declared path and
optional description fields. PTC dispatch records require pairing identifiers,
tool name and recorded arguments; settled dispatches require a boolean outcome
and an array of tagged content blocks, plus declared error fields when present.
PTC arguments retain their producer-declared unknown value type, and content
retains the producer's merge-extensible block vocabulary. Retain each existing
generic protocol source event with its sequence and provenance. These log-only
events create no Reader message or collaboration relationship.
Generation-0 vocabulary and generation-1/2 handling remain unchanged.

## Alternatives considered

Skipping all unknown required events would hide source failures. Adding all
currently installed producer events would expand support beyond the observed
blocker. Changing source files would violate provider ownership. The known
generation-3 events and their declared fields are sufficient for this repair.

## Consequences

The selected conversation becomes readable with its original message identity
and order. Missing or non-string preset fields fail at the provider boundary.
Unsupported future required events still fail explicitly. The installed
producer also writes generation 4; this repair establishes only the observed
generation-3 control event contracts.

## Verification

Three focused Rust regressions first failed on the unsupported selection
event. After the repair, they validate readable user/assistant messages,
preserved protocol source provenance without invented Reader or relation
entries, malformed selection rejection, and explicit future-event failure.
Command: `cargo test --manifest-path v3/Cargo.toml -p agentsession-core --locked agent_preset_selection_v3`.
Result: 3 passed. The full owning provider test filter
`providers::deepseek_harness::tests` also passes: 21 passed, 3 pre-existing
private-corpus tests ignored. Formatting and scoped `git diff --check` pass.
Live default-root verification is performed separately after rebuilding the
native application.

The extended provider suite passes 23 tests with the same 3 private-corpus
skips. Added regressions preserve all five additional recorded event kinds,
their source sequences and following conversation, and reject 12 malformed
declared payload examples, including invalid approval outcomes, missing PTC
pairing/argument fields, malformed outcome/content/error fields, and malformed
presented file paths/descriptions. The existing unknown-required-event
regression still passes. Provider files were read only during inventory.
