---
status: implemented
date: 2026-09-27
decision: OpenCode publishes a validated same-source partial protocol foundation
---

## Context

The Rust OpenCode adapter already exposes v1 message/part and v2 session-message
events with native identities, order, persisted tool states, and verified Reader
links. Protocol documents remained unavailable. The
[2.0 builder](https://github.com/Guanzhw/AgentSession/blob/50a32e7c5b3fdaa1d335771da80d6c919d4ab536/src/providers/opencode/protocol.ts) also projects todo,
subagent, and session relationships, but those projections are not implemented
in the Rust foundation.

## Decision

The [OpenCode adapter](../../../v3/crates/core/src/providers/opencode.rs) finalizes
a protocol bundle from its existing revision-checked event stream and explicit
unknown domain coverage. The shared v2-to-v3 upgrade preserves the same finalized
facts. Observations load no independent source facts, so the bundle cannot mix
event and observation revisions.

Keep parent/fork relationships, tasks, AgentRuns, branches, context, work,
execution, coordination, usage, and ownership explicitly unknown. Existing
Reader fork selection and relations retain their behavior. Capabilities continue
to advertise only partial recorded session events.

## Alternatives considered

Deriving tasks or runs from tool names would introduce unsupported identities.
Adding a synthetic session-header event just to anchor parent/fork relationships
would change the existing event stream for a separate domain. Leaving protocol
documents unavailable would hide the already validated source-event foundation.

## Consequences

OpenCode v1/v2 storage now supports partial v2/v3 protocol documents with the
same canonical session, revision, and ordered events as Runtime Events and
Reader. This is the protocol foundation, not full CORE-09/10 domain parity.

## Verification

- RED: `AGENTSESSION_V3_BIN` selected the frozen previous release under
  `tmp/v3-performance/v3-final-target/release`; running
  `node --test v3/test/opencode-protocol-foundation-http.test.mjs` failed all
  three public tests on the prior 503 protocol-unavailable response.
- `cargo build --manifest-path v3/Cargo.toml -p agentsession-v3` passed.
- GREEN: with `AGENTSESSION_V3_OPENCODE_PRIVATE_MANIFEST` selecting the frozen
  corpus manifest, `node --test --test-concurrency=1
  v3/test/opencode-protocol-foundation-http.test.mjs
  v3/test/opencode-protocol-slice.test.mjs` passed 9/9, no skips. Public tests
  cover both storage generations, fork inherited-row exclusion, unknown domains,
  malformed-source diagnostics, and WAL cursor invalidation.
- The frozen real v2 session exposed 712 events. The new HTTP test compared all
  event IDs and order with read-only SQL rows, checked complete event pagination,
  Reader revision equality, v2/v3 equality, and unchanged database/WAL SHA-256
  hashes. The existing slice test independently checked native rows and tool
  states. Corpus hashes and private paths remain in the ignored manifest.
- `npm run review` passed governance and Viewer TypeScript checks;
  `git diff --check` passed.
- Current live-source and browser checks are not included in this bounded
  backend foundation slice; broader acceptance remains open.
