---
status: implemented
date: 2026-09-29
decision: Remap release build paths and reject portable binaries that embed the current builder home or checkout path.
---

# Portable release build paths

## Context

The first Windows and Linux release candidates embedded absolute paths from
the Rust toolchain and Cargo registry. The binary ran, but those local paths
are unnecessary in a portable artifact. Rust's release build supports source
path remapping. The packager already validates binary version and bundle
contents before publishing a local archive.

## Decision

Build Windows and Linux release executables with `--remap-path-prefix` for
the builder's home, and for the checkout where applicable. Before creating an
output directory, the portable packager scans the executable's UTF-8 text for
the current home and checkout paths in native and slash-normalized forms.
Windows comparison is case-insensitive. If either path is present, packaging
fails with an explicit error. This is an artifact-local check; it does not
claim to detect every private string a program might embed.

## Alternatives considered

Keeping absolute compiler paths would leave local build-machine information
in distributed executables. Stripping symbols alone did not remove observed
Rust source paths. A generic secret scanner would have a different contract
and cannot replace the exact path check at this packaging boundary.

## Consequences

Local release builds must set the documented remapping flags. The Windows
and Linux x64 artifacts were rebuilt without the observed paths; the earlier
unremapped builds remain in ignored evidence directories. The packaging
content and executable behavior are unchanged by the later UTF-8 checker
correction, as verified by byte-identical regenerated bundle files.

## Verification

The [standalone release test](../../../v3/test/standalone-release.test.mjs)
appends the current and a Chinese home path to version-correct executables,
then verifies that packaging rejects both before creating output. The
Chinese case failed when the checker decoded bytes as Latin-1 and passed
after the UTF-8 fix. The extracted Windows executable passed the full 398
test Node suite, and the updated packager regenerated eight files with the
same hashes as the existing ZIP. The Linux build and guard record (`../../../tmp/v3-delivery/linux-x64-mcp06-fix-20260929/FINAL.md`, local evidence)
documents the same remapping and Unicode guard check on the final ELF.
