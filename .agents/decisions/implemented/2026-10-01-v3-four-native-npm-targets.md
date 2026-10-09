---
status: implemented
date: 2026-10-01
decision: Resolve and stage only explicitly supplied native payloads for the four required hosts
---

# Four native npm targets

## Context

The native validation matrix requires Windows x64, Linux x64, Linux ARM64 and
macOS ARM64. The original candidate resolver and staging scripts accepted only
the two x64 payloads and required both bundles, so the ARM64 jobs had no usable
package consumer and a host-only build could not be installed independently.

## Decision

[The native target map](../../../v3/npm/native/targets.mjs) owns the four exact
OS/architecture pairs. The resolver rejects unsupported pairs and reports a
missing supported payload explicitly. The
[candidate preparer](../../../scripts/v3-prepare-npm-candidate.mjs) accepts any
explicit nonempty subset of real portable bundles, verifies manifest hashes
and PE/ELF/Mach-O architecture at the supplied-artifact boundary, and includes
only those payloads and their provenance. Package OS/CPU metadata follows the
supplied subset; it does not declare absent artifacts as installed.

[Packing](../../../scripts/v3-pack-npm-candidate.mjs) preserves Unix executable
mode on a POSIX host. A Windows-only stage can pack directly on Windows. Each
[native validation job](../../../.github/workflows/v3-native.yml) consumes its
own host bundle for offline Viewer/MCP installation and saves unpublished npm
tarballs alongside the portable artifact.

## Alternatives considered

Keeping the two-target resolver would leave the required ARM64 matrix without
an installer. Requiring all four artifacts for every local pack would prevent
host-only verification. Header fixtures establish parser behavior and cannot
substitute for native execution or shipping payloads.

## Consequences

One host can verify a complete installed candidate without pretending that
other payloads exist. A combined candidate contains exactly its supplied
platforms and requires a POSIX packaging surface when it includes Unix files.
Each ARM64 platform still needs a native build and installed runtime evidence.

## Verification

Independent Windows source/stage/pack checks passed 7/7. Linux passed six with
one Windows-only skip. Fresh host-only and retained dual-target npm tarballs
each passed actual offline install, Viewer HTTP/static retrieval and seven-tool
stdio MCP on both x64 hosts. Original packages, source roots and protected
services remained preserved. The exact wrapper evidence used Windows91 and
Linuxd86 payloads; its report and hashes are retained under ignored
`tmp/v3-delivery/npm-four-targets-20261001/`.

Linux ARM64 and macOS ARM64 native builds, installed runtime checks and remote
CI execution remain required. Valid header recognition is explicitly limited
to in-memory parser fixtures; absent ARM64 payloads fail staging. No package
has been published.
