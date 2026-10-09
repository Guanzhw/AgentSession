---
status: implemented
date: 2026-09-26
decision: Use a Rust-owned core with Axum, rusqlite, native rmcp stdio, and a static Svelte frontend for the independently runnable AgentSession 3.0 candidate; keep product and platform acceptance explicit.
---

# Rust-first AgentSession architecture

## Context

The user requested a reviewable from-scratch architecture after comparing Rust
and TypeScript. Functional behavior and reading experience must remain
equivalent; visual design may change. The current five-provider/search work is
merged but not published. The user has since authorized a separately runnable
AgentSession 3.0 implementation and direct comparison with 2.0. Publication,
replacement of the user's running service, and provider-data mutation remain
outside that authorization.

The existing search study shows effective indexed queries but remaining
startup/RSS concerns. The Rust parser probe measures only source parsing and
envelope hashing, not end-to-end product parity or performance. See the
[architecture proposal](../../../docs/design/agentsession-rust-first-architecture.md)
and its linked baseline evidence.

## Decision

Use one Rust core shared directly by Axum Web routes and native rmcp stdio
tools, with rusqlite/SQLite persistent incremental read models and a static
Svelte frontend. Web and MCP run as independent processes, each calling the
same Rust core library in process. Preserve canonical identity, source ownership, protocol v2/v3,
the six existing MCP tools, complete Reader behavior, Viewer metadata, and read-only
provider storage. Support exactly Claude Code, Codex CLI, OpenCode, DeepSeek
Harness, and Pi; retired providers remain retired without deleting their data.

Share a derived namespace, refresh lock, and revision only between equivalent
normalized source configurations. Its fingerprint includes effective provider
roots/DB paths and provider settings that change derived facts, not language,
theme, or port. Different source scopes remain isolated even with one metadata
path; cursors bind the source scope. Public canonical references and Viewer
metadata keys remain provider plus session ID. Physical partitions versus
separate sidecars are left to the storage implementation.

The chosen boundaries are implemented in the independent 3.0 candidate.
[`v3/AGENTS.md`](../../../v3/AGENTS.md) owns its build and validation rules;
the [2026-10-09 consolidation decision](2026-10-09-sole-v3-workspace.md)
supersedes the parallel-workspace arrangement with sole 3.0 ownership.
Implementation status records this technical choice. Product acceptance remains governed by
the [acceptance contract](../../../docs/design/agentsession-v3-acceptance-contract.md)
and does not authorize publication or replacement of the user's service.

## Alternatives considered

- TypeScript core with SvelteKit SSR: strong existing-code reuse and one
  language; retain as the optimized comparison and migration baseline.
- Rust core with a long-lived TS MCP bridge: use only for a demonstrated rmcp
  interoperability gap, with an explicit exit condition.
- Narrow Rust parser worker: a valid fallback if full-core adoption does not
  pass correctness, resource, and distribution gates.
- A shared daemon or microservices: no present consumer requires this
  operational layer; independent Web/MCP processes with equivalent source
  configurations can share derived storage.

## Consequences

Provider semantics move to one Rust owner, while browser interaction stays in
Svelte/TypeScript. Generated contracts and behavioral parity checks address the
language boundary. Static bootstrap replaces the proposed Node SSR path and
must pass real reading/first-content acceptance. Persistent projections,
bounded work, and cross-process consistency are required regardless of language.

Migration preserves provider records, existing Viewer metadata, and old derived
indexes. Historical formats of the five active providers remain evidence-led;
no new OpenClaw/Hermes compatibility is introduced. No schedule or financial
estimate is part of the decision.

## Verification

Current candidate evidence is indexed in the
delivery report (`../../../tmp/v3-delivery/FINAL-CANDIDATE-20261001.md`, local evidence)
and [delivery plan](../../../docs/design/agentsession-v3-delivery-plan.md).
Windows exact83 and Linux exact70 use the same 70 production inputs, with
shared Rust core, Axum routes, native rmcp stdio and embedded Svelte assets.
The actual five-provider Web/MCP chains, metadata-preserving migration,
scope/cursor regression checks, complete Node/Rust results and installed npm
artifacts are linked there with their exact binaries and conditional skips.
The matched Reader experiment records slower first paragraph paint and fewer
transferred bytes; architecture adoption does not imply universal speedup.

Current native search targets and shared failure ledger (`../../../tmp/v3-performance/final-native-83edfddc-20261001/REPORT.md`, local evidence)
verify five rounds of complete source-backed search results and both absolute
search/restart targets. The final Reader entry counts and full selected-root
traversal close DEL-02. A formal concurrent browse continuation failed in
round4; two bounded diagnostics passed, but the original cause remains
unknown. MCP-02 and DEL-03 remain failed acceptance rows. Default Viewer DB
hash changes retain their separate STATE-01 preservation finding.

Remaining latest/rare source shapes, ARM64/macOS and external CI are explicit
source/environment gaps. Final paired performance remains DEL-01 unknown;
these acceptance statuses are independent of this implemented ownership
decision. Run `npm run review` and `git diff --check` for the final
handoff and record their actual outcomes in the delivery report.
