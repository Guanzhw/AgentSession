---
status: implemented
date: 2026-09-27
decision: DSH publishes a validated same-source partial protocol foundation
---

## Context

The Rust DSH adapter already exposes source-ordered events for readable v0/v3
storage, but protocol documents and Work returned unavailable. Its Reader team
and workflow observations do not establish AgentRun identity. The 2.0
[native protocol tests](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/test/deepseek-harness-protocol-v3.test.mjs)
explicitly retain a null run ID for workflow coordination.

## Decision

Build DSH protocol observations from the same loaded snapshot and event candidates
in the [provider adapter](../../../v3/crates/core/src/providers/deepseek_harness.rs).
Finalize the event stream and observations once at their existing boundaries;
publish v2 facts and the shared v2-to-v3 upgrade with partial completeness.

Only header `parentSession` becomes a recorded parent relationship, anchored to
the header event. This does not assert that the parent is locally readable or
that the relationship is a spawn. Tasks, AgentRuns, execution, coordination,
context, usage, ownership, and branches remain explicitly unknown/unported.
Provider capabilities advertise partial recorded events and relationships.

## Alternatives considered

Converting Reader workflow tasks into AgentRuns would invent run identity and
misuse the current session-turn model. Re-reading sources independently for
observations would risk mixing revisions. Leaving all protocol documents
unavailable would hide the finalized event and header relationship foundation.

## Consequences

DSH v2/v3 documents preserve identical source facts and revisions; Work can return
an empty partial page while the document states that work projection is unknown.
This closes the DSH foundation slice, not full CORE-09/10 domain parity. Runtime
Work now displays the source-aligned domain coverage from its bounded Work page;
the separate [Work page decision](2026-09-27-v3-work-page-domain-coverage.md)
records that later UI/API change.

## Verification

- Before implementation, the five new
  [HTTP tests](../../../v3/test/dsh-protocol-foundation-http.test.mjs) failed on
  the frozen release's document-unavailable response. The updated
  [capability cross-check](../../../v3/test/protocol-events-http.test.mjs)
  separately failed on the missing DSH relationship capability.
- `cargo build --manifest-path v3/Cargo.toml -p agentsession-v3` passed.
- The foundation and protocol-events HTTP files passed 8/8 tests. Public root
  and children preserve 29/8 events, header parent provenance, and same-source
  v2/v3/Reader/events facts. Generation selection and malformed source errors
  remain explicit; source SHA-256 ledgers are unchanged.
- `cargo test --manifest-path v3/Cargo.toml -p agentsession-core`: 67 passed,
  six explicitly selected private-source tests ignored.
- Serial DSH Rust/legacy/frozen-v0, protocol-work, MCP get and MCP timeline
  HTTP/stdio regression files passed 18/18. Runtime Events/Work browser
  regression files passed 2/2.
- A read-only HTTP/raw-source probe on the two selected frozen DSH sessions
  verified v0's 54 physical rows expanding to 303 events and v3's 3,251 rows/events,
  complete event pagination, Reader revision equality, v2/v3 equality, header
  parent evidence, and unknown work. All three frozen source file hashes stayed
  unchanged. This is a debug-build functional check, not a performance result.
- A separate public DSH child browser check opened Conversation, Runtime Events,
  and Work without browser errors; Work showed zero entries with partial
  coverage. The isolated server and browser were closed.
