---
status: implemented
date: 2026-10-17
decision: Require indexed inventories and publish known ambiguous DSH sessions as diagnostic rows
---

# Indexed provider diagnostics

## Context

All five native providers implement durable inventory and capture. The old
non-indexed list path has no production caller, while tests still exercise its
separate error policy. DSH discovery already knows the canonical IDs of
ambiguous generations, but previously dropped those IDs after logging errors.

## Decision

Require an inventory collection from every adapter and return a published
catalog directly. Remove the optional non-indexed listing path and move its
behavior assertions to real index publication. Keep provider-owned source
selection, capture validation and rebuild hooks.

DSH publishes an unavailable diagnostic row for each known ambiguous ID.
Its signature covers all candidate generations, paths and existing file
signatures; diagnosing ambiguity does not read transcript bodies. Capture and
inventory validation reject changes during publication. Healthy sessions stay
readable; ambiguous direct reads keep their explicit source error and never
fall back to an older generation.

Library, search and statistics consume the existing diagnostic-row contract.
Unknown directory, time and token values remain unknown. Known excluded IDs
do not become `source_uncertainty`, which denotes an unknown collection scope.

## Alternatives considered

Keeping stderr alone hides incomplete collections from consumers. Failing the
whole provider hides healthy sessions. Preserving unused non-indexed adapters
would retain a second list policy without a current runtime requirement.

## Consequences

DSH lists may gain diagnostic rows; statistics exclude and count them and
search reports partial coverage. Candidate changes or ambiguity resolution
update summary and search documents in the existing publication transaction.
The adapter interface is internal; public canonical references remain intact.

## Verification

- DSH focused Rust tests passed 24 tests with three private-source tests ignored.
  Public HTTP tests cover diagnostic rows, collection diagnostics, excluded
  counts, candidate changes, force refresh and ambiguity resolution.
- Final isolated `npm test` passed: Rust core 266 and app 10 tests; Node 771
  passed, 49 explicitly skipped. Eighteen source-dependent Rust probes remain
  ignored. This includes migrated publication, unavailable-source, OpenCode WAL,
  native Web/MCP and public DSH browser integration checks.
- No provider-owned or existing Viewer data is migrated by this change.
