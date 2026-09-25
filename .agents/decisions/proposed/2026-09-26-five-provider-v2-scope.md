---
status: proposed
date: 2026-09-26
decision: Limit AgentSession 2.0 Viewer and MCP to five providers, remove OpenClaw and Hermes Agent without deleting or migrating local data
---

# AgentSession 2.0 five-provider support scope

## Context

AgentSession 1.10.1 supports OpenCode, Claude Code, Codex CLI, OpenClaw, Hermes
Agent, Pi, and DeepSeek Harness. The proposed 2.0 release narrows the public
provider set while retaining the local-first, read-only source boundary.
Existing source records and user-owned Viewer state must remain unchanged, while the v2
product provides no compatibility path for retired-provider history.

## Decision

Support OpenCode, Claude Code, Codex CLI, Pi, and DeepSeek Harness in both the
2.0 Viewer and MCP. Fully remove OpenClaw and Hermes Agent support from both
interfaces, with no v2 route aliases, compatibility adapters, or provider
fallback. Preserve provider source records, user-owned Viewer metadata, and
retired-provider index rows; do not automatically delete or migrate them during
the upgrade. The derived index may refresh supported-provider rows. Document
that old URLs and MCP provider references are incompatible, explain removal of
retired CLI/config entries and explicit CLI failures, and state that an existing
MCP launcher using `@latest` resolves the current release when the host starts.

## Alternatives considered

- Keep all seven providers in 2.0: preserves the previous support boundary but
  conflicts with the requested five-provider product scope.
- Remove OpenClaw/Hermes and automatically migrate or delete their local state:
  simplifies the new index but risks user-owned metadata and historical data.
- Retire OpenClaw/Hermes only in the Viewer or only in MCP: creates inconsistent
  product behavior and unclear user expectations.

## Consequences

The Viewer registry, APIs, search, CLI/config surface, MCP diagnostics, and
public support tables must agree on the same five provider IDs. OpenClaw and
Hermes URLs and MCP references no longer work in 2.0. Existing provider records,
user-owned Viewer metadata remain unchanged on disk; retired-provider index
rows remain stored but are not exposed. MCP host entries
using `@latest` resolve the current release when launched, so existing entries
can move to the 2.0 provider set after publication.

## Verification

Before moving this record to `implemented/`, verify the assembled 2.0 package
and live Viewer/MCP surfaces against the [provider scope and delivery plan](../../../docs/design/agentsession-v2-provider-scope.md):
the exact five-provider roster, absence of retired-provider routes in both
interfaces, useful migration errors/guidance, clear failure for old URLs/MCP
references, and preservation of provider source data and existing Viewer state.
This proposal does not claim that the 2.0 release or migration checks have
completed.
