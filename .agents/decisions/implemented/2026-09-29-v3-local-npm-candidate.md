---
status: implemented
date: 2026-09-29
decision: Stage an unpublishable local 3.0 npm candidate with one shared manifest-verified native payload and separate Viewer and MCP launchers.
---

# Local 3.0 npm install candidate

## Context

The first local candidate used Windows x64 `2dd3c8ab` and Linux x64 `40ed8519`
portable bundles. Later builds can change without changing the npm package
layout, so candidate preparation must select current bundle paths explicitly.
The install test exercises the installed `agentsession` and `agentsession-mcp`
commands without rebuilding Rust, changing 2.0 packages, or reading personal
provider sources.

## Decision

`scripts/v3-prepare-npm-candidate.mjs` requires explicit Windows and Linux
portable bundle paths, verifies each manifest and listed payload against
`SHA256SUMS`, then records the selected manifest and executable hashes. An
optional source-ledger path records its hash when available. It stages three
`private: true` npm packages under a fresh output directory: one shared native
payload with both x64 executables, and thin Viewer and MCP command packages
depending on that payload. The commands use Node only to spawn the selected
executable with inherited stdio and forwarded arguments, signals, and exit
status. Unsupported platforms fail explicitly. All packages are packed on
Linux ext4 by `scripts/v3-pack-npm-candidate.mjs`, then installed together from
local tarballs with `--offline` into a new prefix. The packer normalizes file
modes and checks the Linux ELF archive entry. The existing 2.0 `packages/` tree
remains unchanged.

The package provenance identifies the selected portable artifacts; it does not
claim that the current source tree matches those binary inputs. A later release
must rebuild and validate every supported platform.

## Alternatives considered

Embedding the same native executable in both command packages would double the
installed payload. Platform-specific optional dependencies would reduce the
per-host download, but they would require more tarballs and more resolution
paths for this offline local candidate. A single shared package keeps the two
installed commands on one verified binary per platform.

## Consequences

The shared package installs both x64 binaries, so each supported host stores
the other platform's binary too. Installing from local tarballs requires all
three packages in the same isolated npm install. macOS and ARM64 fail at
launch with an explicit unsupported-platform error until their native binaries
are built and validated. The 2.0 package manifests and runtime stay untouched.

## Verification

`v3/test/npm-candidate-install.test.mjs` prepares, packs, and installs the three
packages in an isolated directory with a separate working directory. It checks
the installed binary hashes, both commands, unsupported-platform diagnostics,
embedded Web assets and Reader content, and native stdio MCP content. Its Web
and MCP processes use the public Codex fixture, explicit empty roots for four
other providers, and isolated metadata/index/cache paths. It verifies the
fixture hash after execution. A Windows-packed native tarball first failed on
WSL with `EACCES` because its Linux ELF entry was `0644`; that tarball and the
failure log are preserved in `tmp/v3-npm-windows-pack-red/`. With ext4 packing,
the exact retained tarballs passed 1/1 installed Web/MCP tests on Windows and
1/1 on WSL Linux. The Linux archive and installed ELF were both executable;
the Web port and MCP process exited after the test. Exact hashes, commands,
and limits are recorded in ignored
`tmp/v3-npm-candidate-2dd3c8ab-40ed8519-ext4-normalized/EVIDENCE.md`.

The earlier Windows `63023dee` ZIP and matching Linux candidate archive were
staged locally without publishing. Its Windows Viewer/MCP install smoke passed,
but the MCP initialize response reported `name: "rmcp"` and version `3.4.1`;
this historical run is not final release evidence. The Linux package was not
installed in that run. Its redacted record remains at
`tmp/v3-delivery/npm-smoke-63023dee/smoke-run.public.json`.

The corrected candidate uses Windows ZIP
`b5278f3f75e9d474e10b544ab5e44408c1a7aa723fd629ec3422cdb80c16d16c` with
executable `5edacbcf8fc85528e413e85b25333b19cf7a286eebd1a8def1a544bbb5080329`,
and Linux archive
`a3d83a9a8147d32422c052684fd82f077532ae2adab26d30b9ab9d06466020c3` with ELF
`7d7a2a8a576c8be62ef793fd2e8cc8fc0ce997ae25fbd0bd7e671d46fee9d9cd`. The
three retained npm tarballs have SHA-256 `7e3e006279317be9b12b37ef4154eb435485cb0a75eed82c64a2758da7730bbe`
(native), `a745c65b1fb312a4b758b7cfdddd7fd702813d48b1b6482bc031e711712946fd`
(Viewer), and `7cedb7977ec495996a0eadfd229c123cebb9c1ef5df3ae7c68d3e7908dd03b4f`
(MCP). Those exact tarballs passed 1/1 offline installed Viewer/MCP tests on
Windows and WSL Linux, using a prefix and launch working directory with spaces.
Both installed MCP handshakes reported `AgentSession-MCP` version `3.0.0`,
listed seven tools, and completed a read-only `session_get_event` call. Viewer
assets and Reader content passed; both installed processes exited and the Viewer
port closed. The public fixture SHA-256 remained
`17e3638a76197a60969f83849707bda886377c6d69cd8f5a78a6620f44f7dc12`. The
redacted evidence and per-platform logs are in
`tmp/v3-delivery/npm-smoke-5edacbcf/npm-candidate-smoke.public.json` and the
adjacent Windows/Linux test logs. This is local candidate verification only; it
does not claim that the current source tree produced those binaries.

The local candidate covers Windows x64 and Linux x64. macOS and ARM64 have no
native payload yet and remain open in DEL-04.
