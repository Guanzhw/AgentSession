---
status: implemented
date: 2026-09-29
decision: Advertise the AgentSession MCP product name and package version in the native 3.0 initialize response.
---

# Native MCP server identity

## Context

An installed 3.0 candidate advertised the default rmcp library identity,
`rmcp` `3.4.1`, during MCP initialization. Clients should be able to identify
the AgentSession server they connected to. The 2.0 server used the
`AgentSession-MCP` product name and its package version.

## Decision

The native MCP handler sets `serverInfo.name` to `AgentSession-MCP` and
`serverInfo.version` to the 3.0 app package version at build time. The same
identity is returned to both supported MCP protocol eras. This does not change
the separate `agentsession-v3` host registration key used for side-by-side
installation.

## Alternatives considered

Keeping the rmcp default would identify the dependency instead of the running
product. Using the host registration key as the server name would make the
identity depend on how a user installed the same binary.

## Consequences

Clients can report the 3.0 server's product and version from the initialize
response. Host configuration still uses its separate `agentsession-v3` key,
which can coexist with 2.0.

## Verification

The two-era stdio contract test failed 2/2 against the exact prior Windows
candidate, observing `rmcp` `3.4.1`. It passed 2/2 after the change against the
new debug and independently extracted Windows release binary. Rust workspace
tests passed 168 core and 2 app tests, with 14 private-data skips. The exact
release binary is SHA-256
`5edacbcf8fc85528e413e85b25333b19cf7a286eebd1a8def1a544bbb5080329`.
