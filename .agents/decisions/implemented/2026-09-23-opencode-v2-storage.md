---
status: implemented
date: 2026-09-23
decision: Select read-only OpenCode v1 and v2 readers by source schema and isolate startup failures
---

## Context

A Windows OpenCode v2.0.10 database contains session_v2/session_message, not
session/message/part. The old file-exists detector admitted it, indexing failed,
and a second startup statistics query terminated the entire viewer. The supplied
DDL and upstream v2.0.10 source establish the compatibility boundary.

## Decision

Keep v1 as a separate unchanged reader. Add a provider-owned v2 reader selected
by table/column inspection, preferring v2 when both exist and diagnosing incomplete
v2 rather than silently falling back. Optional methods and capabilities are
selected with the reader. Registry identity remains configuration-free.

Normalize v2 seq-ordered message projections, not event replay. Preserve live tool
status in the common loop. Recognize provider-recorded fork-copy IDs and disclose
those records separately from owned history/usage. Mark unsupported protocol
domains explicitly. All provider source access remains read-only.

Only successfully indexed providers enter the HTTP routing map. Startup totals
come from the viewer index rather than issuing another source-specific query.

## Alternatives considered

Replacing v1 outright breaks older machines and backups. Renaming tables ignores
payload, tool and fork semantics. SQL compatibility views would couple v2 to
legacy native-query assumptions. Replaying events adds unnecessary complexity
because upstream exposes session_message as the transcript projection.

## Consequences

Core v2 reads coexist with v1 without new configuration or dependencies. v2 task/run
reconstruction, pending inbox and event replay remain unsupported and disclosed.
No hidden/system prompt evidence is claimed for v2. Real Windows data verification
remains a release gate, not something synthetic fixtures can establish.

## Verification

Upstream tag v2.0.10 commit b8cedc1a7a5e2916bbb65dc1d4b620729c261638 was inspected
for schema, serialization, ordering, fork projection and token totals.
Focused OpenCode/MCP tests, full npm test, npm run review/pre-push and live HTTP
checks are run for this branch; exact results are recorded in the PR handoff.
Source hashes are checked before/after read tests. No real conversation database
or Windows desktop/browser QA was available in this environment.
