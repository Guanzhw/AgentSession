---
status: implemented
date: 2026-10-01
decision: Put existing provider default path discovery in the owning Rust adapters
---

# Provider default path ownership

## Context

Independent inspection of the exact 4267345b source inputs found that app
configuration owned the five provider-native environment variables, default
directories and OpenCode OS-specific candidate order. The existing paths
worked in process tests, but the placement violated the provider ownership
contract in repository guidance and CORE-03.

## Decision

Each of the five [provider modules](../../../v3/crates/core/src/providers/mod.rs)
now owns its existing `default_data_path`. `ProviderDefaultPaths::discover`
registers those five static selections for the application's real config
consumer. The shared [path helper](../../../v3/crates/core/src/providers/paths.rs)
contains only schema-neutral OS app-data and existing-path probing.

[Application config](../../../v3/crates/app/src/config.rs) retains the existing
CLI, AgentSession environment and saved-file precedence. Candidate order,
provider-native environment names and fallback path values are unchanged.
Viewer-derived state paths remain application-owned.

## Alternatives considered

Keeping defaults in app config would retain the actual ownership violation.
Moving config parsing into adapters would mix user override precedence with
provider storage conventions. Adapter instance discovery would require a
resolved source config before the paths needed to construct that config exist.

## Consequences

Web and MCP still resolve the same effective source configuration. Provider
storage conventions can now change at their owner. This refactor changes no
parser, revision, indexing, source-writing or persistence behavior.

## Verification

The six existing CLI/config tests passed against the new debug build, including
default discovery, explicit overrides, non-checkout cwd, invalid config and
stdio MCP discovery. Debug executable SHA256 was
`b1a636b87e81fd606c5b5ad8594fc0d7d702dc09f699baa1828888413f1aeb50`.
The integrated Rust workspace passed 176 core and five app tests, with 14
explicitly ignored core cases. The existing provider probe test moved to the
owning helper; it was not duplicated. Logs are retained under ignored
`tmp/v3-delivery/provider-default-path-config-20261001.log` and
`tmp/v3-delivery/reader-target-bootstrap-20261001/`.

The exact 4267345b package predates this move and remains unchanged. A later
release build and its native installation checks must bind the final source
inputs separately.
