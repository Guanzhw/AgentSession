---
status: implemented
date: 2026-10-11
decision: Route explicitly selected native commands through the npm Viewer while retaining its default serve behavior.
---

# npm native command routing

## Context

Published rc.4's `agentsession --help` exposes native subcommands, including
`migrate-meta`, but the wrapper inserts `serve` before their arguments. An
actual registry installation rejects `agentsession migrate-meta --help` with
exit code 2. This interrupts the metadata-copy upgrade path for npm users.

## Decision

The Viewer wrapper forwards explicit `serve`, `mcp`, `migrate-meta` and `help`
commands to the existing native CLI. It skips only the native global `--config`
prefix while selecting the command, including its equals form. Default and
option-only invocations still select `serve`. The native parser continues to
own validation and errors, and arguments remain a structured array. The separate
MCP entrypoint keeps selecting `mcp`.

Metadata import continues to preserve its input and reject existing targets.
The upgrade guide explains import-before-edit and a separate metadata root
when both old and new Viewer state must be retained. The implementation and
acceptance are tracked by the [follow-through spec](../../../docs/specs/prerelease-followthrough-2026-10/requirements.md).

## Alternatives considered

A separate migration npm executable would add an entrypoint while leaving the
advertised native commands unusable. Moving wrapper defaults into Rust would
change the native CLI for a launcher-only problem. Inferring commands from any
argument would misinterpret source paths and option values.

## Consequences

The wrapper gains the native command routes already shown by its help. Explicit
new native commands or global options will need the wrapper mapping updated.
Published rc.4 remains immutable; this is an unreleased source change.

## Verification

The installed-package regression first failed at explicit `serve --help` with
exit code 2, then passed after routing was repaired. It packs and installs the
current wrappers with the selected rc.4 native runtime, imports a task-owned
SQLite copy, verifies input/target hashes and HTTP title/star values, refuses
repeat import, and exercises default/explicit Viewer and both MCP entrypoints.
Final commands, host coverage and review are recorded in the spec's
[execution ledger](../../../docs/specs/prerelease-followthrough-2026-10/tasks.md).
