---
status: implemented
date: 2026-10-17
decision: Capture safe parse details at the source boundary for local MCP diagnostics
---

# Safe MCP parse diagnostics

## Context

The existing Parse reason can include provider-controlled event types, field
names or IDs. Logging it verbatim would expose source values. Replacing it with
one generic category loses useful parser and decoder failure information.

## Decision

Attach ParseDiagnostic to the existing CoreError::Parse variant. Its cause is
a static string; its optional line and column are numeric. JSON constructors
take category and location directly from serde_json::Error. JSONL callers use
their existing source-line index rather than scanning or interpreting the
formatted reason. Adapter validation and compression boundaries supply their
own safe static categories.

The original reason and Display remain available to existing consumers. MCP
logs only the safe diagnostic, source path, tool and operation stage. HTTP and
MCP wire error contracts retain their existing behavior.

## Alternatives considered

Printing or truncating the reason still exposes record values. Parsing formatted
error strings in the transport would couple it to provider vocabularies. A
parallel error hierarchy would duplicate the existing source error boundary.

## Consequences

MCP can distinguish JSON syntax, incomplete input and decoder failures, and
report source positions where the parser supplied them. Free-form provider
validation errors retain adapter categories without fabricated positions.
No provider data, Viewer metadata, cache schema or public configuration changes.

## Verification

- Before implementation, the real stdio MCP diagnostic tests failed four cases
  because all parse failures had the same generic cause. After implementation,
  all six passed, including exact JSONL line/column, compression and unsafe event
  type sentinels, I/O and SQLite failures, unchanged wire errors and pure JSON-RPC
  stdout.
- Three app diagnostic/blocking tests passed. Provider Rust regressions passed
  158 tests with 16 explicitly ignored source-dependent probes.
- Final Windows `npm test` passed: Rust 276 passed with 18 ignored; Node 775
  passed with 50 conditional skips. Linux workspace tests also passed 276 tests
  with 18 ignored; the actual portable release passed six MCP diagnostic tests.
- Node 22.15 selected final-release checks passed. A four-provider frozen-source
  MCP oracle matched all required timeline rows and retained source hashes.
- Final integration and available-host evidence are recorded in the
  [delivery plan](../../../docs/design/agentsession-v3-delivery-plan.md).
