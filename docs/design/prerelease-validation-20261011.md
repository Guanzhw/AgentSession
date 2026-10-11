# AgentSession 3.0 prerelease validation

This prerelease compares product changes with the last public release,
[v1.10.1](https://github.com/Guanzhw/AgentSession/releases/tag/v1.10.1).
Its [release notes](../releases/3.0.0-rc.4.md) describe the upgrade and supported
scope. Publication uses npm `next` and a GitHub prerelease.

## Current source and platform evidence

Published `v3.0.0-rc.4` resolves to commit
`d74d5088388118d8df7dd622a7ef17f4be0c73ed`. Read-only GitHub CLI checks on
2026-10-11 confirm `completed` / `success` for the exact-commit
[publication run 38132614812](https://github.com/Guanzhw/AgentSession/actions/runs/38132614812),
[Quality 38132610988](https://github.com/Guanzhw/AgentSession/actions/runs/38132610988)
and [native validation 38132610982](https://github.com/Guanzhw/AgentSession/actions/runs/38132610982).
Every response reports that complete source SHA.

The tagged publication matrix actually builds and packs on Windows x64, Linux
x64, Linux arm64 and macOS arm64. All four jobs pass packaged HTTP, stdio MCP,
installer and npm checks. The release job passes combined-tarball offline
installation and launch, npm publication with `next` and provenance, and GitHub
prerelease publication. These close the rc.4 CI packaging/installation subresult;
private source shapes, full desktop user flows, preferences and shared-process
resource acceptance retain the [remaining gates](agentsession-v3-delivery-plan.md#稳定版剩余门槛).

The [follow-through work](../specs/prerelease-followthrough-2026-10/requirements.md)
is **Unreleased**. Its npm routing, upgrade guidance and private-source test
reporting changes do not alter rc.4's published artifacts or historical results.
The commands used to refresh the baseline are `gh run view 38132614812`,
`gh run view 38132610988` and `gh run view 38132610982`, with JSON status,
conclusion and head SHA; both matrix runs also include job outcomes.

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

RC.2's [tagged run](https://github.com/Guanzhw/AgentSession/actions/runs/38131025041)
passes the complete Linux x64/arm64 and macOS arm64 jobs. Windows passes the
temporary-root repair and old-configuration checks but reveals a new test-only
archive-path error: Git Bash GNU tar interprets an absolute drive-letter archive
path as a remote host. The archive assertion now uses the exact basename under
its stage working directory, matching the production packer's existing pattern.
The parallel main-branch run also records one old-config HTTP timeout; the tagged
Windows run passes that unchanged check. Neither run publishes public packages.
RC.3 retains both failed candidate tags and repeats the complete release gates.
The exact tarball assertion passes with Windows native tar and Git GNU tar;
the complete packaging file passes all five checks on WSL/Linux. Its local
release build/review pass, and 24 targeted old-config, MCP, installer and package
checks pass with one Linux-only archive check skipped on Windows. The binary
reports `3.0.0-rc.3`, SHA-256
`1456b6619c5f19f557dababde7d393de69a3cd8cb8ef8e7a8486ea4ff06b698b`.
Rust runtime and Svelte source files are unchanged across the candidate repairs;
earlier real-data/browser evidence retains that source scope. Publication still
requires the exact RC.3 tag's four-host build and installed-package checks.

RC.3's [publication run](https://github.com/Guanzhw/AgentSession/actions/runs/38132079173)
is cancelled before registry publication after a real npm CLI reproduction
reveals a first-publish check issue. With a next-only package and no latest tag,
`npm view <name> dist-tags.next` returns empty because npm selects latest first;
`npm view <name>@<exact-version> dist-tags.next` returns the recorded next tag.
Post-publication tag checks now select the exact immutable version and preserve
the existing latest channel. RC.4 repeats the complete publication gates with
this corrected publisher and retains all earlier unpublished tags.

RC.4's remapped release build and standard pre-push review pass. Its binary
reports `3.0.0-rc.4`, SHA-256
`4ee6e642531e8b71f1c503f47f7710d7ef5a9686f1c3243542ebed45a7af3a33`.
The focused publisher, installed-package contract and actual native MCP output
checks pass: nine passed, one Linux aggregation-only check skipped on Windows.
Both protocol eras initialize the exact candidate and read all seven tools.
The new next-only publication regression records a failure before the fix and
passes afterward; a disposable loopback registry independently reproduces the
bare versus exact-version lookup with the actual npm CLI. Independent review
finds no issue in the final publisher/version delta. The subsequent exact-tag
four-host and publication execution succeeded in run 38132614812, as recorded
above; this local pre-publication artifact retains its own hash and scope.

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
