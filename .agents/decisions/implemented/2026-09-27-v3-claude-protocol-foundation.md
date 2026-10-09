---
status: implemented
date: 2026-09-27
decision: Claude exposes validated same-byte partial protocol documents
---

## Context

The Rust Claude adapter already exposes source-ordered events, but document and
Work routes were unavailable. Events without a native uuid/id use derived
provenance, while capability declarations previously claimed recorded only.
The 2.0 adapter additionally correlates task notifications and sidechain files;
those structured projections are not yet ported to the Rust protocol model.

## Decision

The [Claude adapter](../../../v3/crates/core/src/providers/claude_code.rs) loads
one byte snapshot for Reader anchors, revision and protocol events. Its existing
source revision salt and event vocabulary remain unchanged. The provider
finalizes a partial v2 bundle and the shared upgrade preserves those facts in
v3. Session event capability is partial/mixed, matching the existing provenance.

Relationships, tasks, runs, context, branches, work, execution, coordination
and ownership are explicitly unknown. Usage was unported in this foundation
slice; the later [Claude request-usage decision](2026-09-27-v3-claude-request-usage.md)
records its current projection. Sidechain parent IDs, task notifications and
compaction records remain anchored raw events. This slice does not manufacture
structured observations from the Reader projection.

## Alternatives considered

Porting the 2.0 multi-file Task/AgentRun correlation would require a separate
source/revision contract. Keeping documents unavailable would hide the existing
event foundation. Independent Reader/event reads would allow revision mixing;
the provider instead parses a single captured byte buffer.

## Consequences

Claude documents validate and Work returns an empty partial page with explicit
unknown domain coverage. This is foundation coverage, not full 2.0 structured
domain parity. Existing Reader sidechain and MCP behavior remain intact.

## Verification

- Six new [HTTP tests](../../../v3/test/claude-protocol-foundation-http.test.mjs)
  failed against the frozen prior release: five 503-versus-200 document failures
  and one malformed-record 503-versus-422 failure.
- `cargo build --manifest-path v3/Cargo.toml -p agentsession-v3 --locked --offline`
  passed; `cargo test --manifest-path v3/Cargo.toml -p agentsession-core
  providers::claude_code --locked --offline` passed 5/5.
- Serial foundation, Claude Reader/MCP and protocol-events HTTP test files passed
  13 tests. One older manifest-gated private test was explicitly skipped; the
  new independent frozen-source test ran successfully.
- Public current/legacy/v259 sources preserve row order, source IDs/provenance,
  complete event pagination and Reader/v2/v3 revision equality. Isolated copies
  test sidechain/task boundaries and invalid-record diagnostics.
- Frozen real Claude data retained 26 rows/events and SHA-256
  `ee5e4cca0777b45ef7e97306139ad53022233a95e364ca314734890d14190734`.
  Original and isolated-copy hashes are checked after HTTP access. This checks
  one frozen transcript, not a complete cross-file sidechain corpus.
- The review skill's governance/typecheck and whitespace checks passed.
  Browser validation remains part of the coordinator's shared Runtime checks.
- Claude request usage was implemented in the later
  [request-usage decision](2026-09-27-v3-claude-request-usage.md), using the
  same captured transcript bytes as the event stream.
