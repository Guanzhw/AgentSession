---
status: implemented
date: 2026-10-11
decision: Publish AgentSession 3 prereleases from one frozen commit and four verified native payloads using npm next and GitHub prerelease.
---

# Native prerelease publication

## Context

The native runtime replaces the v1.10.1 TypeScript packages. Existing native
CI validates per-host private install candidates. Public prerelease publication
needs one combined package containing four actual target binaries, exact
version/dependency pins, source identity, and retained executable modes.

## Decision

Use [v3-prerelease.yml](../../../.github/workflows/v3-prerelease.yml) to resolve
one tag commit before the build matrix. Each actual host validates its portable
and npm artifacts and records that frozen commit in a release source sidecar.
Ubuntu combines verified bundles with `--public`, packs and launches the exact
combined tarballs, then publishes native, Viewer, and MCP with `next`, public
access, and npm provenance. The v1.10.1 workflow's `NPM_TOKEN` and GitHub OIDC
authentication pattern is retained. Recheck the remote tag at publication.

Keep templates private for existing local/host CI consumers. Public staging
requires a 3.x prerelease, all four target payloads, full commit identity, and
matching sidecars; the packer pins staged identities and payload hashes.
Record the source and bundle hashes in npm provenance. Canonical public
portable archives use GNU tar's fixed timestamp/owners and `gzip -n`.

GitHub assets include the four complete portable archives, three npm tarballs,
provenance, and global checksums. Publish with `--prerelease --latest=false`.
Partial reruns verify existing immutable npm integrity and GitHub asset bytes
before skipping them, then publish only missing items. Never clobber published
artifacts. Workflow dispatch can validate without publication.

## Alternatives considered

Publishing host-only npm packages would leave absent targets in the public
package. Packaging Unix payloads on Windows would lose executable modes.
Independently resolving a mutable tag in each job could combine different
source revisions. Noncanonical host archives would change bytes on a fresh
run because of filesystem timestamps. Tokenless trusted publishing was not
selected because only the established token/provenance flow was evidenced.

## Consequences

The npm `latest` channel stays on the stable release, and explicit prerelease
consumers use `next`. The public release depends on all four native CI hosts.
Re-run failed jobs to retain the exact validated inputs; differing rebuilt
payloads remain an explicit immutable-artifact failure. Publication status is
reported separately from implementation and validation of this plumbing.

## Verification

- `node --test v3/test/npm-prerelease-packaging.test.mjs v3/test/npm-native-targets.test.mjs`: 9 passed, 3 explicit host/tool skips on Windows.
- `node --test --test-name-pattern='installer accepts the prerelease' v3/test/mcp-host-installer.test.mjs`: regression recorded RED, then GREEN; accepts RC/build metadata and refuses malformed output before host writes.
- `wsl.exe -d Ubuntu -- node --test --test-name-pattern='Linux release archives' /mnt/d/WorkSpace/OpenSession/v3/test/npm-prerelease-packaging.test.mjs`: 1 passed; changing filesystem timestamps preserves identical archive bytes and executable mode; existing output is preserved.
- `node --test test/prerelease-publish.test.mjs`: 2 passed; mocked npm registry boundary proves partial-publication recovery, exact integrity enforcement, and literal next/provenance arguments without network or credentials.
- Local checks validate plumbing and fixture contracts. Full native matrix, combined installed artifacts, npm provenance, and live GitHub/npm publication require the authorized workflow's actual run.
