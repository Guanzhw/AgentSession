---
status: implemented
date: 2026-09-27
decision: Keep recorded prompt text separate from current local instruction sources
---

## Context

The 2.0 system-prompts route combines provider-recorded text, locally resolved
instruction files, and explicit limits on hidden prompt recovery. A 3.0 endpoint
needs the same evidence distinction while the Rust core owns source reads and
provider adapters own schema interpretation.

## Decision

The [Rust core](../../../v3/crates/core/src/system_prompts.rs) returns sections
with full content, a bounded preview, provenance, resolution, source path, and
source metadata. Each adapter selects its own recorded fields and current local
instruction candidates. Codex reads explicit system/developer messages and
recorded `session_meta.base_instructions` with provenance. DSH follows the
validated v3 surface when selecting active system messages and reads the latest
v0 request-header prompt. The [Web route](../../../v3/crates/app/src/web.rs)
only maps this core response to HTTP.

Current instruction files are labeled `current-local`; they do not establish
historical use. Hidden or unrecorded provider prompts remain unavailable. The
OpenCode adapter reports that its current agent/config instruction resolution
is still incomplete instead of inferring it from the database.

## Alternatives considered

One shared provider-ID switch could read all file formats in the core, but it
would move schema knowledge out of adapters. Treating a current `AGENTS.md` or
`CLAUDE.md` as a stored prompt would conflate two different evidence times.

## Consequences

The `/api/:provider/session/:id/system-prompts` response preserves the 2.0
`sessionId`, `mode`, `hiddenPromptStored`, `note`, and `sections` fields and adds
explicit provenance and diagnostics. OpenCode's unresolved config paths and
provider-hidden prompts remain visible gaps. Local instruction content is
limited to 1 MiB per file; larger or unreadable files have diagnostics.

## Verification

- The public endpoint test failed with HTTP 404 before implementation and then
  passed for Codex recorded text, current `AGENTS.md`, DSH replacement, missing
  session/provider status, and unchanged source hashes.
- The frozen Codex source test compared the exact recorded base-instruction
  content and provenance against the raw source. A separate frozen corpus test
  reached the endpoint for all five providers and preserved source hashes.
- `cargo test -p agentsession-core --lib` passed 102 tests with 12 existing
  ignored tests. The isolated Rust app build passed. Root review and governance
  checks are run at handoff.
