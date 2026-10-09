---
status: implemented
date: 2026-09-27
decision: Preserve and edit top-level projectPaths for the five active providers without deriving a session directory from unrecorded project identity.
---

# Project path configuration retention

## Context

AgentSession 2.0 accepts top-level `projectPaths` keyed by provider and opaque
project key. AgentSession 3.0 currently rejects the field at startup. The 2.0
project-directory resolver has no active caller, and the five 3.0 adapters do
not expose a recorded opaque project key.

## Decision

The 3.0 config parser accepts maps for OpenCode, Claude Code, Codex, Pi, and
DeepSeek Harness. Keys and values must be nonempty; values must be absolute
paths. Settings GET returns the selected map, and same-origin POST replaces it
through the existing validated, atomic save path. Session directories and resume
working directories remain source-backed until an adapter records a project key.

## Alternatives considered

- Inferring a key from a source folder or session ID would add provider meaning
  that neither the current source adapter nor the 2.0 resolver establishes.
- Treating the field as an opaque unknown JSON value would fail to enforce the
  existing project-map boundary.

## Consequences

An existing mapping survives use of 3.0 Settings and restart. The field alone
does not change session or resume behavior. Other 2.0-only config fields remain
outside this change.

## Verification

The public settings test first failed because startup rejected `projectPaths`
as an unsupported key. An isolated Windows debug binary passed the new startup,
save, invalid-input, and restart test, the existing Settings API tests (6/6
together), and the real Settings browser test (1/1). The CLI/config and theme
regressions passed 7/7; UI build, `npm run review`, and targeted rustfmt passed.
The test creates only temporary config/state paths, so there is no provider
corpus hash for this configuration-only check. HEAD was
`50a32e7c5b3fdaa1d335771da80d6c919d4ab536` plus the uncommitted 3.0 tree;
the isolated binary SHA-256 was
`87b97e3d3567f09267061f7608d5ce015cfaad7d263fa915cc31a9f7c3939138`.
