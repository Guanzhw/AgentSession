---
status: implemented
date: 2026-10-17
decision: Preserve captured Protocol failures alongside readable Reader generations
---

# Reader Protocol failure persistence

## Context

Codex conversations can retain readable messages while their Protocol evidence
is invalid. Reader capture previously discarded that error and stored only an
execution availability bit, changing a known invalid source into a generic
unavailable response after publication.

## Decision

Capture the stream or its original Protocol error once. Reader schema 3 adds
the serialized error beside the existing success bit; projection 11 recaptures
older rows without interpreting their old availability bit. Schema 1 and 2
upgrade in the existing schema-lock boundary. Provider records and Viewer
metadata remain unchanged.

Diagnostic codes own their strings so the same Protocol error type can be
serialized and restored. HTTP invalid errors keep status 422 and
`protocol_invalid`, and add `error.diagnostics` using the existing `code` and
`event_id` fields. Responses expose at most 20 diagnostics and set
`diagnosticsTruncated`. Reader displays known explanations and unknown codes.
Valid streams with no execution events still return successful empty pages.

## Alternatives considered

Failing the whole Reader would hide readable conversation content. Keeping the
boolean alone loses the cause. A second persisted error DTO or static-string
lookup would duplicate the existing Protocol error contract.

## Consequences

Cold, warm and restarted readers preserve invalid versus unavailable evidence.
The first bootstrap of an older projection recaptures its source. An older
binary continues to reject a newer cache schema explicitly; rollback needs its
own compatible derived-state directory. Source identities and content
fingerprints keep their existing meaning.

## Verification

- `cargo test --manifest-path v3/Cargo.toml -p agentsession-core --locked reader_model::tests`
  passed 8 tests, with one explicit frozen-source probe ignored. Public generated
  sources cover parse and validation failures, repeat/reopen reads, successful
  empty execution pages, and schema 1/2 upgrades without source changes.
- App error tests cover 0/20/21 diagnostics and unchanged ordinary error JSON.
  Public UI tests cover English/Chinese, unknown codes, truncation and retry.
- Final isolated `npm test` passed: Rust core 266 and app 10 tests; Node 771
  passed, 49 explicitly skipped. Eighteen source-dependent Rust probes remain
  ignored. Native HTTP verifies both failure kinds on cold/warm/restarted
  readers; the desktop UI retains readable messages and source event IDs.
- Validation uses task-owned source and state directories. Real provider and
  other-host acceptance retain their existing evidence scope.
