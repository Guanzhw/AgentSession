---
status: implemented
date: 2026-10-01
decision: Add an unpublished four-platform native validation workflow for the Rust candidate
---

# Native validation workflow

## Context

The existing quality, binary-release, and publishing workflows consume the
2.0 Node workspaces. Their platform matrix does not build or test the 3.0 Rust
candidate. Local Windows x64 and WSL Linux x64 runs cannot establish Linux
ARM64 or macOS ARM64 execution.

## Decision

The [native validation workflow](../../../.github/workflows/v3-native.yml)
builds the locked Svelte UI, tests the Rust workspace, builds the native
executable with build-path remapping, creates a portable bundle, and runs the
public serial Node suite against that exact bundled executable. It selects
Windows x64, Linux x64, Linux ARM64, and macOS ARM64 native runners. Rust
1.95.0 matches the observed working local toolchain; Node 26.5.0 matches the
repository's existing newest CI lane.

The workflow runs for relevant pull requests or explicit manual dispatch and
uploads validation bundles. It has read-only repository permission and no
release, registry publication, or tag consumer. Each job verifies its actual
OS/architecture, prepares and packs its own verified host payload, and enables
the fresh offline npm install test against that same portable bundle. The
uploaded artifact contains the portable files, three npm tarballs, and their
payload provenance.

## Alternatives considered

Reusing the 2.0 matrix would validate the wrong executable. Cross-compiling
locally would establish compilation without native execution. A release/tag
trigger would mix the requested unpublished candidate with publication.

## Consequences

The source now has a consumer for four-platform native validation. A successful
remote run and its checksummed artifacts are still required evidence. Private
corpus, desktop browser, and installed-host cases retain their explicit test
gates; a public CI run does not close those acceptance rows. Existing repository
governance remains in the independent root quality workflow.

## Verification

The main agent inspected all three existing workflows and the portable packager.
The [official runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
confirms the selected platform labels, including ARM64 `ubuntu-24.04-arm`
and `macos-15`. Local YAML parsing and all 24 per-platform Bash step syntax
checks passed. Executing the workflow's exact Node environment-emission command
on Windows produced three distinct lines with absolute selected executable
and config paths; the validation report is retained under ignored
`tmp/v3-delivery/v3-ci-local-validation/`. These checks execute neither a
remote runner nor the workflow's builds.

Local locked UI production build, Rust tests (173 core and 6 app passed,
14 ignored), and remapped Windows release build passed. The workflow file has
not been uploaded, dispatched, or executed on remote runners. DEL-04 remains
open pending native ARM64/macOS execution, CI results, and the other installation
checks. The MCP host-installer test now accepts the same selected executable
environment variable as the other native tests, rather than forcing a debug
binary during package verification.

The four-target npm resolver and artifact boundary checks were independently
reviewed against the actual package inputs. Windows source/stage/pack checks
passed 7/7; Linux passed 6 with one Windows-only skip. Fresh and retained offline
npm candidates each passed Viewer and seven-tool native MCP installation on
both x64 hosts. Those focused wrapper runs used the preserved 91f2d58a/d86ae0e9
payloads; they do not establish the later 4267345b runtime or ARM64 execution.
The current 4267345b Windows portable executable passed all 448 public serial
Node tests: 416 passed, zero failed, and 32 conditional skips. The workflow now
enables its host-specific npm acceptance, which was conditional in that local
full-suite invocation. These local results remain distinct from a remote CI run.
