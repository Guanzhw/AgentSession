---
status: implemented
date: 2026-10-11
decision: Admit current DSH workflow run records as source observations
---

# DSH workflow run-record admission

## Context

An authentic current `@deepseek-ai/dsh@0.2.0-rc.2` headless capture contains
required generation-four `tool-workflow/run-start` and `tool-workflow/run-end`
events. The native Viewer rejected the first event and returned HTTP 500 for
the entire session. The producer's workflow failed during Windows sandbox
provisioning; the final conversational turn completed and explained that
failure. Those two outcomes have distinct recorded evidence.

## Decision

Admit these required run-record types in the DSH adapter's modern event
vocabulary. Validate the producer's nonempty run id and start name, and the
end's `completed`, `cancelled` or `error` stop reason at this source boundary.
Earlier historical-generation admission remains unchanged.

Keep the records in the ordered Protocol source stream with their exact
recorded provenance. They carry no child assignment and do not create Reader
messages, relationship tasks, coordination facts or inferred AgentRuns.
Existing member start/end projections remain owned by their separate records.
The previous generation-four unknown-ignorable behavior is preserved.

The current producer's `dsh-tool-workflow/lib/index.js` emits run-start and
run-end after engine admission and settlement. Its `lib/invariant.js` owns
the nonempty run id/name and stop-reason vocabulary. A failed run remains a
failed recorded run; accepting its source does not prove successful execution.

## Alternatives considered

Ignoring the required types would hide recorded evidence. Interpreting a run
as an AgentRun or child assignment would create unsupported identity and
ownership. Broadening event admission outside the DSH adapter would violate
provider ownership. Editing the original records would violate preservation.

## Consequences

Current producer-written workflow sessions can be parsed while keeping raw
run lifecycle separate from the existing workflow-member projections.
Successful workflow execution and real current member-lifecycle evidence
remain separate source requirements. This correction changes no decompression
or general resource bounds.

## Verification

The frozen pre-fix candidate `6be31c5b…` returns HTTP 500 on the authentic
48-row session at run-start source sequence 18. Its independently derived raw
gold and native red report are retained in the ignored current-capture task
directory; before/copy/after source hashes match. The separate authentic basic
20-row session passes Protocol, Runtime, canonical Reader/MCP order and full
body hash checks on that candidate.

The bounded public fixture preserves the two observed run payload shapes and
timestamps with controlled surrounding records. The new Rust regression
reproduced the unsupported-required-event failure before the repair. The
targeted DSH suite passes 28 tests with three existing explicit ignores.
The native public regression also reproduces the pre-fix HTTP 500. The fixed
integrated candidate `202a264c…` passes both public native DSH tests and the
complete real-source oracle: 68 exact Protocol/Runtime events, readable order
and 110 complete body pages on each HTTP/MCP surface match independently
derived raw gold. The authentic workflow error is retained, both sessions have
zero inferred AgentRuns, all source hashes remain stable and the task-owned
Viewer/MCP processes exit. Affected desktop QA remains a separate integration
gate in the stable task ledger.
