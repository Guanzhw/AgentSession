---
status: proposed
date: 2026-09-26
decision: Propose a Rust-owned AgentSession core with Axum, rusqlite, native rmcp stdio, and a static Svelte frontend, preserving the five-provider product and reading contracts through staged parity and live acceptance.
---

# Rust-first AgentSession architecture

## Context

The user requested a reviewable from-scratch architecture after comparing Rust
and TypeScript. Functional behavior and reading experience must remain
equivalent; visual design may change. The current five-provider/search work is
merged but not published. This proposal does not authorize implementation,
service replacement, or publication.

The existing search study shows effective indexed queries but remaining
startup/RSS concerns. The Rust parser probe measures only source parsing and
envelope hashing, not end-to-end product parity or performance. See the
[architecture proposal](../../../docs/design/agentsession-rust-first-architecture.md)
and its linked baseline evidence.

## Decision

Propose one Rust core shared directly by Axum Web routes and native rmcp stdio
tools, with rusqlite/SQLite persistent incremental read models and a static
Svelte frontend. Web and MCP run as independent processes, each calling the
same Rust core library in process. Preserve canonical identity, source ownership, protocol v2/v3,
all six MCP tools, complete Reader behavior, Viewer metadata, and read-only
provider storage. Support exactly Claude Code, Codex CLI, OpenCode, DeepSeek
Harness, and Pi; retired providers remain retired without deleting their data.

Share a derived namespace, refresh lock, and revision only between equivalent
normalized source configurations. Its fingerprint includes effective provider
roots/DB paths and provider settings that change derived facts, not language,
theme, or port. Different source scopes remain isolated even with one metadata
path; cursors bind the source scope. Public canonical references and Viewer
metadata keys remain provider plus session ID. Physical partitions versus
separate sidecars are left to the storage implementation.

Keep this record proposed until staged implementation and acceptance settle
the choice. Current repository implementation constraints remain in force;
adoption requires synchronizing those constraints rather than silently
overriding them.

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

This change is documentation only. Review the proposal against current README,
MCP contract, provider scope, Reader P1–P14, and recorded experiments; run
`npm run check:governance` and `git diff --check` before handoff. The implementation
gates include five-provider normalized/protocol parity, both MCP lifecycle
clients over real stdio, browser reading/navigation, concurrent index refresh,
two configurations sharing a metadata path but using different roots with both
overlapping IDs and unique sessions (no cross-scope reads, deletions, or cursor
reuse), metadata-preserving migration, platform-installed artifacts, and matched
end-to-end performance. These are required future checks, not claimed results.
