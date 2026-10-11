---
status: implemented
date: 2026-10-11
decision: Read recorded DSH generation-four sources in the owning adapter
---

# DSH generation-four source support

## Context

Two real DSH generation-four source copies were absent from the native Library;
Reader and Protocol returned `session_not_found`. The installed producer codec
accepted all 11,579 physical event records. The latest-generation discovery
contract therefore needed an owning-provider extension.

## Decision

The DSH adapter selects `session.v4.jsonl` and its Zstd form ahead of earlier
generations, with a distinct v4 revision namespace. It reads the producer's
first-class tool messages and flat content, validates tool identity, and retains
recorded catalog v1/unknown-mode child references. Existing generation 0–3
revision namespaces and behavior remain intact.

The producer can emit catalog v1 from a discovered child header when no launch
descriptor is available. Those rows project as `catalog` / `recorded` with
their canonical references, rather than `spawn` / `started`. This preserves
related-session access without inventing a handoff or Reader launch placement.
The v4 revision namespace changes with this projection correction; v4 catalog
version zero retains its existing launch interpretation.

Producer-owned message source kinds remain recorded context rather than human
requests. Developer and pruning events retain their Protocol context records;
they do not create unsupported Reader messages or inferred lifecycle facts.
Content-only surface replacement preserves the original readable tool body.

The producer permits unknown generation-four events carrying `ignorable: true`.
Those records retain their source order and Protocol provenance without a
Reader projection. Unknown required events still fail explicitly. Independent
review reproduced a producer-accepted record returning HTTP 500 before this
boundary correction; the existing generation-three contract is unchanged.

The format evidence is the installed `@deepseek-ai/dsh-session-format-v3-to-v4`
0.1.7-rc.2 codec, `lib/index.js` SHA-256
`382a3f28b95e0b9504969ac6f407f909aef0ba4699c3175d36c0ef91b31cfde2`.
Its message/source validation, tool-message validation and catalog conversion
own the field rules. The package metadata has no `gitHead`; this evidence does
not establish the producer version that originally wrote each real capture.

## Alternatives considered

Keeping generation four unavailable fails the observed real sources. Editing
or converting provider-owned files would violate their read-only boundary.
Shared-core or browser branches for DSH would put decoding outside its owner.

## Consequences

Generation-four records become available through the same core Reader,
Protocol and MCP consumers. Existing full-frame decoding is retained, so this
change alone establishes no bounded-decompression or performance claim.
Latest-producer pairing and missing rare real-source cases remain separate
stable-release requirements.

## Verification

The baseline native binary `1073a656…` reproduces both missing sessions.
The owning repair's `464bd525…` binary passes 25 DSH Rust tests (three explicit
ignores), 29 native DSH tests (two private-source skips), and the final public
v4 Web/MCP test. The public fixture checks raw event retention, canonical tool
content, source-generation precedence and complete mailbox-body pagination.
The real complete-source oracle and final integrated regression results belong
to the [stable task ledger](../../../docs/specs/stable-readiness-2026-10/tasks.md);
their completion must be recorded there from actual results.
