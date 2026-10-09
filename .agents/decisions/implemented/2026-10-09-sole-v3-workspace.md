---
status: implemented
date: 2026-10-09
decision: Consolidate the main workspace on the latest Rust/Svelte AgentSession 3.0 implementation and remove the TypeScript 2.0 runtime and its default startup, test, and package paths.
---

# Sole AgentSession 3.0 workspace

## Context

The user explicitly requested that the latest 3.0 implementation be moved into
the main workspace, that 2.0 be completely removed from the current runtime,
and that normal startup use 3.0. This supersedes the parallel-workspace choice
in the [Rust-first architecture record](2026-09-26-rust-first-architecture.md).
The source worktree and main checkout share baseline Git revision
`50a32e7c5b3fdaa1d335771da80d6c919d4ab536`. Existing main-workspace edits were
preserved under ignored `tmp/v3-consolidation-20261009/main-before/` before
integration.

## Decision

Keep Rust core, Axum Web, native rmcp stdio MCP, and Svelte as the sole
implementation. Root install has no prepare hook; UI dependencies are installed
explicitly. Root build produces the UI and locked Rust release; root start
builds and serves that native runtime, forwarding options. Default loopback
port remains the native runtime's 3457.

Remove the TypeScript runtime, workspaces, compiled artifacts, runtime-specific
tests and scripts, and active side-by-side/2.0 rollback harnesses. Keep native
Protocol schemas 2 and 3, observed provider format generations, explicit HTTP
migration diagnostics, and Viewer metadata-copy import; their version numbers
describe supported facts and migration boundaries rather than a second runtime.

Retain historical decisions, source evidence, fixtures and reports with their
original dates and limitations. Pin links to removed baseline source to Git
revision 50a32e7. The previous implementation is recoverable from Git history;
it is not installed or built by current workspace commands.

## Alternatives considered

- Keep both implementations as the default development surface: conflicts with
  the user's explicit sole-runtime request and duplicates provider ownership.
- Delete historical evidence and provider state along with source: would lose
  provenance and user data without helping runtime consolidation.
- Publish native npm packages during consolidation: publication is a separate
  action and is not required for the requested workspace startup.

## Consequences

Provider-owned sources and existing user metadata remain untouched. Task-owned
validation uses isolated derived state and identified ports/processes. Existing
listeners require ownership checks before restart. Root instructions and CI
now describe native Rust/UI ownership and retained integration checks.

This changes the workspace default and delivery path. Open acceptance failures,
source gaps, resource measurements, human usability, ARM64/macOS and external CI
gates retain their recorded status in the
[acceptance contract](../../../docs/design/agentsession-v3-acceptance-contract.md).
It does not claim a published 3.0 release or universal performance gains.

## Verification

The ignored integration ledger (`../../../tmp/v3-consolidation-20261009/integration.json`, local evidence)
records byte/hash verification for 505 imported source and documentation files.
The removal inventory is preserved in
`deleted-files.json` (`../../../tmp/v3-consolidation-20261009/deleted-files.json`, local evidence).
Independent review verified the main Rust/UI production inputs against the
source worktree. Historical linked evidence was copied with hash verification
into the same ignored relative paths.

Documentation/governance verification in the consolidated main workspace:
`node scripts/verify-governance.mjs` passed;
`node --test test/governance.test.mjs` passed 6/6 with no skipped tests;
`git -c core.safecrlf=false diff --check` passed. These cover current Markdown
targets, decision lifecycle, native protocol ownership probes, and the actual
root/CI gate definitions.

Current-workspace `npm run build` and `npm run review` passed. The final
`npm test` passed 204 core Rust tests, 5 native app tests and 692 Node/browser
tests with zero failures. Fourteen Rust tests and 46 Node tests remain explicit
private-corpus, platform or opt-in acceptance skips. Test repairs removed four
remaining old CLI consumers and aligned browser checks with the current folded
outline, progressive content and inline collaboration. A real inherited-context
disclosure reset found by those checks was fixed and covered by both real and
simulated browser pagination checks.

Plain root `npm start` rebuilt and launched
`v3/target/release/agentsession-v3.exe serve` on `127.0.0.1:3457`.
The running binary SHA-256 is
`89161ce31d34c9bae10e4ea8eae146e352c43701b30e5eaf04eff4eaae853879`.
Real provider discovery, settings, Library and canonical Codex Reader APIs
returned HTTP 200. A quiet real-data statistics request read all five providers,
with 30 daily rows and 12 model rows. Its incomplete usage remains explicit:
126 requests have unknown totals and two ambiguous Codex sessions are excluded.
During active log appends the consistent-report guard rejects a changed source;
this was also observed in the browser and is not treated as complete usage.

Native stdio MCP from the final tested production inputs exposed all seven
tools, browsed three real Codex rows and read the canonical research-workflow
session. The checked transcript SHA-256 stayed unchanged. The live in-app
browser rendered that real conversation and the statistics charts. Both main
and the previous source worktree now have no `bin`, `src`, `packages` or root
`dist` directories. Their current Rust/UI sources, root tooling and guidance
were synchronized; source evidence and uncommitted work remain preserved.
Independent source review found no remaining 2.0 runtime dependency.

Current logs and scope details are summarized in the ignored
verification report (`../../../tmp/v3-consolidation-20261009/RESULTS.md`, local evidence).
These are local consolidation checks; private acceptance and external release
gates retain their separate status.
