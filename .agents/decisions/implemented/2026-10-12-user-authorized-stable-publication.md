---
status: implemented
date: 2026-10-12
decision: Publish 3.0.0 under explicit user direction while retaining incomplete acceptance evidence
---

## Context

The current candidate has passing five-provider source, desktop, human-feedback,
installed-artifact and four-host CI evidence. Its remaining Windows performance
and resource measurements encounter changes to the protected legacy index
while Codex starts installed legacy MCP processes. Their startup writer matches
the observed index-update mechanism, but individual writes and historical
STATE-01 remain unattributed. Persisting a disabled manual MCP entry did not refresh
the running Codex process; a restart was requested.

The user then explicitly stated that restarting was not possible and instructed
immediate publication. This replaces the earlier instruction to finish the
remaining acceptance before publishing.

## Decision

Proceed with stable `3.0.0` publication using the existing version-derived
release pipeline. Retain its exact tag/commit, four-host build/package,
provenance and immutable-publication checks. Restore the temporary manual MCP
configuration change before publication.

Record the user's release disposition separately from measured acceptance.
Keep failed state-preservation attempts and historical STATE-01 as failed or
unattributed; keep unexecuted paired, Reader and resource measurements open.
The public release note links these limits. Do not replace missing evidence
with an all-gates-passed or comparative performance claim.

## Alternatives considered

Continuing to wait for a Codex restart contradicts the user's latest direction.
Repeating measurements under the same known interference would not establish
the required state preservation. Publishing another prerelease contradicts the
explicitly selected stable release. Publish the requested stable version with
the actual evidence boundary visible.

## Consequences

Stable publication is a user-authorized release decision with incomplete
performance/resource acceptance and unresolved historical writer attribution.
It does not close those technical findings. Future work needs new evidence;
the original rubric, failures and raw records retain their identities.
The publication outcome is recorded separately in the task ledger.

## Verification

The [stable task ledger](../../../docs/specs/stable-readiness-2026-10/tasks.md)
records current passing checks, failed preservation attempts and unexecuted
measurements. The [release note](../../../docs/releases/3.0.0.md) describes this
scope. Before publication, validate documentation with governance checks and
independent review; verify the final release workflow, registry versions,
checksums/provenance and a fresh isolated installation afterward.
