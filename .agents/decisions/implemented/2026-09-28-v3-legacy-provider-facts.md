---
status: implemented
date: 2026-09-28
decision: Keep legacy provider/list facts source-backed in 3.0 while describing genuinely new 3.0 projections truthfully.
---

# Provider facts in the 3.0 legacy HTTP surface

## Context

The fixed 2.0 `/api/providers` includes five SVG icons, provider-owned storage
diagnostics, and per-domain capability descriptions. The first 3.0 projection
replaced icons with IDs, flattened diagnostics, and omitted capability details.
Its scoped list also returned an empty success response for an unavailable
provider. OpenCode's recorded file-change counts were lost from the legacy
list. Controlled 2.0/3.0 HTTP tests demonstrated each difference.

## Decision

The existing provider and scoped-list routes retain their documented response
shapes. Icons and capability domains have explicit descriptors. Provider-owned
OpenCode schema detection supplies a structured `{schema,path,note}` diagnostic;
the Library and Svelte UI render its readable note. A known unavailable
provider's scoped list returns the fixed 2.0 `503` error shape with its
configured data path. Codex availability requires a `sessions` directory.

OpenCode reads recorded file-change counts at its adapter boundary and carries
them in normalized `SessionSummary` through the derived catalog to lists.
Unknown stays null and recorded zero stays zero. The 2.0 global index returned
zero for all three fields even when the provider database recorded other
values; 3.0 exposes the recorded values in global as well as provider lists.
Capability support and diagnostic wording describe what 3.0 actually projects
rather than copying obsolete 2.0 claims. DSH probes the six conventional
SQLite filenames for the signature only, preserving the structured 2.0
unsupported-schema diagnostic and availability while reading sessions from
JSONL only.

## Alternatives considered

Copying the 2.0 provider response literally would make the capabilities claim
features that the 3.0 Reader and MCP do not implement. Keeping the first 3.0
projection would discard recorded provider facts and turn an unavailable
configured source into an apparently empty successful list.

## Consequences

The persisted summary schema advances to version 2 so unchanged indexed
sources recapture the new OpenCode fields once. The separate [JSON-only list
decision](2026-09-28-v3-json-only-list-responses.md) removes the 2.0 HTML
fragments from the 3.0 list routes.

## Verification

`v3/test/provider-descriptor-http01.test.mjs`,
`v3/test/legacy-provider-unavailable-http01.test.mjs`, and
`v3/test/opencode-recorded-counts-http01.test.mjs` each use isolated fixed-2.0
and 3.0 servers; their relevant assertions went RED before the fixes and now
pass. The OpenCode oracle checks recorded 3/12/4, recorded zero, and unknown
counts, a fresh 3.0 process, and unchanged source SQLite bytes. The Rust
workspace passes 145 core and 2 app tests with 13 ignored private tests.
`v3/test/dsh-provider-status-http01.test.mjs` compares empty, SQLite-only,
invalid-marker, and JSONL-plus-SQLite roots against fixed 2.0; the two gaps
went RED before the adapter edit, all cases are GREEN, and source hashes stayed
unchanged.
The full exact-package Node/browser suite remains a later delivery gate.
