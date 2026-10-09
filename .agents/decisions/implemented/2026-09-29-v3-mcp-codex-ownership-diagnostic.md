---
status: implemented
date: 2026-09-29
decision: Keep a copied-parent child with no owned task boundary unavailable, and expose its provider-owned diagnostic through the existing MCP protocol-error channel.
---

# Codex child ownership diagnostic in native MCP

## Context

A Codex child transcript can copy parent history before the child's first owned
task. If that task boundary is missing, the reader cannot safely claim those
copied messages as the child's own. The Rust adapter already identified this
condition as `child_ownership_boundary_unavailable`, but returned a generic
`CoreError::Unavailable` from the snapshot path. Native MCP mapped that error
to `provider_unavailable`, hiding the ownership reason and incorrectly
describing an available provider as unavailable.

## Decision

The Codex adapter returns `ProtocolError::Unavailable` with the stable
`child_ownership_boundary_unavailable` code and canonical `codex/<sessionId>`
target when this boundary cannot be established. The existing MCP error
mapping then returns `protocol_error` with that diagnostic. A healthy
`session_get_context` response retains its bounded event summaries and
canonical `EventRef`; it does not gain a duplicate owner field or unrelated
provider inventory diagnostics.

## Alternatives considered

Adding an `owner` field to every successful context item would duplicate its
canonical `EventRef` and leave the failing child unreadable without explaining
why. Mapping all `CoreError::Unavailable` responses to a detailed message
would change unrelated provider-availability behavior. The adapter-level
protocol diagnostic fixes this recorded boundary alone.

## Consequences

The unverified child remains unreadable, so inherited parent content is not
presented as child-owned history. Existing `EventRef` fields continue to
identify the owner of each context item. Other provider-unavailable errors
retain their previous mapping.

## Verification

The [stdio regression](../../../v3/test/mcp-codex-ownership-diagnostic.test.mjs)
copies a public Codex fixture, removes its child task boundary, and checks
that native MCP reports `protocol_error` with the diagnostic and no inherited
body. The provider unit test checks the same boundary. The
MCP-06 evidence (`../../../tmp/v3-delivery/mcp06-final-f2a3feb5-remapped/README.md`, local evidence)
checks the corrected release candidate and preserves the earlier red/green
comparison. It verifies healthy Codex/Claude context ownership, bounds,
source order, and unchanged source hashes.
