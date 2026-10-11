# AgentSession 3.0 prerelease validation

This prerelease compares product changes with the last public release,
[v1.10.1](https://github.com/Guanzhw/AgentSession/releases/tag/v1.10.1).
Its [release notes](../releases/3.0.0-rc.2.md) describe the upgrade and supported
scope. Publication uses npm `next` and a GitHub prerelease.

## Current source and platform evidence

Before the release-version changes, source commit
`d5653accf34b25160d0a14cc002e04f9fdff20e2` passes
[Quality](https://github.com/Guanzhw/AgentSession/actions/runs/38128436257) and
[native validation](https://github.com/Guanzhw/AgentSession/actions/runs/38128436303).
The native matrix executes on Windows x64, Linux x64/arm64 and macOS arm64,
including packaged HTTP/MCP and standalone checks. These are current platform
execution results; dated source-format and resource acceptance gaps retain their
original scope.

The prerelease workflow repeats the affected source, packaging and installed
checks at the exact release tag before publication. Its four native payloads
share one resolved source commit; aggregate npm packages retain platform hashes
and source identity. The complete payloads are combined on Linux and installed
offline before publishing. Published archive/tarball checksums are independent
of the local Windows build hash below.

The `v3.0.0-rc.1` publication run
[38130369177](https://github.com/Guanzhw/AgentSession/actions/runs/38130369177)
stopped before public publication: root preservation-helper tests passed aliased
OS temporary paths to a boundary that requires physical paths. Windows short
names and macOS `/var` aliases triggered five assertions on each host. Test-created
temporary roots are now canonicalized once; the actual untrusted-path boundary
retains its strict link checks. The unpublished tag remains immutable. The next
candidate is `3.0.0-rc.2`, with the same runtime source and a full repeat of the
tagged four-host publication gates.

The RC.2 local UI/release build, review and Rust tests pass (244 passed,
16 explicitly ignored). Its remapped Windows binary reports `3.0.0-rc.2` and
has SHA-256 `5849ebfbb70c58890594e81f1b05b29bde6b062414446027e3c3ae57638cb482`.
The full root-helper collection passes with 234 passed, two explicit existing
skips and no failures. The affected preservation file passes all 24 checks on
Windows and WSL/Linux. Using a genuine Windows 8.3 temporary alias reproduces
five failures before the fixture fix and none after it; real junction redirects
remain rejected. Actual macOS execution is a tagged publication gate.

Targeted RC.2 MCP output, host installer, native target, packaging and mocked
publication checks pass. An initial harness run supplied slash-form Windows
binary paths to tests expecting native paths; rerunning with `Resolve-Path`
corrects those assertions. One Windows staging-directory rename returned
`EPERM`; the unchanged packaging file passes on isolated recheck. The final
four-host run repeats these package checks before publishing.

## Windows real-data release check

The standard remapped local `3.0.0-rc.1` binary has SHA-256
`8e60149dd2dc264373a51bcb4fd2701db28364ba4af0a8028d19360cb4d3a345`.
The UI build and Rust tests pass: 244 passed, 16 explicitly ignored, no failures.

Read-only checks use the existing frozen 917,848,369-byte real Codex parent,
task-owned recorded authority and alternate source, plus isolated copied Viewer
metadata. Original provider data is never sent to a mutation path.

- The real legacy `session_meta` table exactly matches the fresh-install schema
  at public tag `v1.10.1`, `src/meta.ts` blob
  `50b060a7489cb9eea7106ff025b3e439ee9ff9d6`.
- Import preserves the complete database schema and all table logical digests,
  including 1,670 historical `session_index` rows and statistics tables.
  The original database and input copy hashes remain unchanged.
- An isolated existing scope retains its raw metadata hash and all logical
  contents through Web/MCP reads, a new-process restart and refused repeat
  import. Task-owned OpenClaw/Hermes metadata sentinels remain present.
- Seven HTTP reads validate selected settings/source identity and a Reader
  bootstrap containing 29,305 items. The existing port 3457 service stays intact.
- Actual SDK stdio initialization finds seven tools. Browse/search resolve the
  canonical parent; two 37-UTF-16-unit event pages match recorded assistant
  text, content revision and continuation. All stdout lines are JSON-RPC and
  the process exits. Source and authority hashes remain unchanged.
- The three migration integration tests pass, including committed WAL row
  preservation, source-scope isolation and no overwrite.
- On Node.js 22.15.0, a portable Windows candidate is packed and installed
  offline. Its actual Viewer and stdio MCP launch checks pass; both protocol-era
  output-contract checks pass. The Node runtime archive is checked against its
  official SHA-256 before use. Release tooling itself uses Node.js 26.5.0 in CI.
- Packaging contracts validate matching four-target source sidecars and hashes;
  the installer RC regression passes after rejecting the old numeric-only
  version matcher. A Linux/WSL check confirms deterministic archive bytes and
  executable modes. Mocked registry tests prove immutable-version mismatch
  rejection and partial-publication continuation to the `next` channel.
- The complete sequential Node test collection finishes with 767 tests:
  720 passed, 47 explicitly skipped and none failed. This includes actual
  desktop browser navigation, Reader disclosure, packaged installation and
  native Web/MCP checks. The two newly added mocked publication tests also pass
  in a separate run. Source/host opt-in skips remain outside this evidence.

Private evidence is outside Git under
`D:/CodexArtifacts/OpenSession/20261011-release-validation`: `README.md`,
`meta-web-rc.json`, `v1.10.1-legacy-schema.json`, `meta-migration-rc.log` and
`mcp-smoke-trial-xjjOI3.json`. These contain machine-specific paths and real
source details; the published record retains commands, outcome and scope.

## Scope retained

This check establishes Windows metadata-copy compatibility with the tagged
schema, read-only retrieval and restart behavior for the selected frozen source.
It does not attribute the writer of historical default-state failures or assert
coverage of every latest/rare provider format. Configuration and runtime-derived
indexes require explicit 3.0 setup. Remaining source, product and resource gates
stay open for the stable release.

Performance claims remain bounded by the
[incremental indexing report](performance-incremental-20261011.md): cold catalog
construction improves consistently; append gains vary and Reader still reparses
the source. They are not an end-to-end comparison with public v1.10.1.
