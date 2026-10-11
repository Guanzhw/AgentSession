# AgentSession 3.0 npm packages

By default, these private package templates stage a local npm install candidate. The
Viewer and stdio MCP entrypoints share one native package, which contains the
explicitly supplied native binaries. The supported target pairs are Windows x64
(`win32-x64`), Linux x64 (`linux-x64`), Linux arm64 (`linux-arm64`) and macOS arm64
(`darwin-arm64`). These are the workspace's native package templates.

From the repository root, select actual extracted portable bundle directories,
then prepare a fresh directory under ignored `tmp/`. Supply at least one explicit
bundle. A native CI job can supply only its host bundle; a combined candidate
can supply all four. No absent platform payload is synthesized or reused:

```powershell
$WindowsBundle = 'D:\path\to\selected\windows-bundle'
$LinuxBundle = 'D:\path\to\selected\linux-bundle'
node scripts/v3-prepare-npm-candidate.mjs `
  --output-dir tmp/v3-npm-candidate `
  --windows-bundle $WindowsBundle `
  --linux-bundle $LinuxBundle
```

Additional bundle options are `--linux-arm64-bundle <dir>` and
`--macos-arm64-bundle <dir>`. Supply them only when those real native bundles
exist. The source mapping itself does not establish an installed or validated
ARM64/macOS candidate.

Each selected bundle must contain `manifest.json` and `SHA256SUMS`. Preparation
checks every listed payload, verifies executable format and architecture (PE
x64, ELF x64/arm64, or native thin Mach-O arm64), and records each supplied portable manifest and executable
hash in `native/provenance.json`. Pass `--source-ledger <file>` to record an
additional source-ledger hash when one exists; this does not claim the current
source tree matches those binaries. Preparation narrows all three staged npm
manifests' OS/CPU fields to the supplied payloads. npm expresses OS and CPU as
separate axes; the resolver enforces the four exact pairs and explicitly rejects
other combinations. A supported pair whose payload is absent fails with a
missing-binary diagnostic.

Pack from Linux (including arm64 or WSL ext4) or macOS. The packer copies the prepared package sources to
its POSIX temp directory, sets each supplied Unix executable bit, verifies the tar archive
mode, and writes all three tarballs into the prepared directory:

```bash
node scripts/v3-pack-npm-candidate.mjs --stage-dir tmp/v3-npm-candidate
```

On this Windows workspace, invoke the same script through WSL Ubuntu:

```powershell
$RepoWin = (Get-Location).Path.Replace('\', '/')
$RepoLinux = (wsl.exe -d Ubuntu -- wslpath -u $RepoWin).Trim()
wsl.exe -d Ubuntu -- node "$RepoLinux/scripts/v3-pack-npm-candidate.mjs" `
  --stage-dir "$RepoLinux/tmp/v3-npm-candidate"
```

Windows-only candidates can pack directly on Windows. A candidate containing
Unix payloads must use Linux/WSL ext4 or macOS to preserve executable modes;
packing it on Windows is rejected. The original
portable bundles and binaries are never rewritten.

Install the three tarballs together into a **new isolated prefix** using
`npm install --offline --ignore-scripts --no-audit --no-fund --prefix <prefix>
<native.tgz> <viewer.tgz> <mcp.tgz>`. Preserve existing installations by selecting a separate prefix.
Run `agentsession --config <isolated-config.json> --port <port>` for Web and
`agentsession-mcp --config <isolated-config.json>` for stdio MCP. The config must
name all five provider source paths and three 3.0 derived-state paths. The
installed commands need Node and the packaged binary; they do not invoke npm,
Cargo, or the network at runtime. Both entrypoints pass their remaining
arguments to the native executable and retain its stdio and exit status.

Run the opt-in isolated pack/install/Web/MCP test with
`AGENTSESSION_V3_NPM_CANDIDATE=1 node --test v3/test/npm-candidate-install.test.mjs`
(PowerShell: `$env:AGENTSESSION_V3_NPM_CANDIDATE='1'` first). It uses only the
included public Codex fixture and explicit empty roots for the other providers.
For a single native CI job, set `AGENTSESSION_V3_NPM_HOST_BUNDLE` to its actual
portable directory. When the test prepares a combined candidate, set
`AGENTSESSION_V3_NPM_WINDOWS_BUNDLE` and `AGENTSESSION_V3_NPM_LINUX_BUNDLE` to
the selected extracted portable directories. Optional additional inputs are
`AGENTSESSION_V3_NPM_LINUX_ARM64_BUNDLE` and
`AGENTSESSION_V3_NPM_MACOS_ARM64_BUNDLE`; set
`AGENTSESSION_V3_NPM_SOURCE_LEDGER` only when that evidence file exists. Set
`AGENTSESSION_V3_NPM_TARBALL_DIR` to a prepared directory to retest its retained
tarballs exactly without preparing or packing them again.
Every installed platform requires its real selected payload and a native host
execution. ARM64/macOS runtime, installation and CI outcomes remain unverified
until those artifacts and executions exist; no publication is performed here.

## Public prerelease

[The prerelease workflow](../../.github/workflows/v3-prerelease.yml) resolves one
existing version tag to a commit, validates all four actual native hosts, and
checks out that same commit throughout the run. It stages all three packages
for public publication only after every matrix job succeeds. Workflow dispatch
with `publish: false` performs the complete validation and uploads publication
assets. A prerelease tag push, or dispatch with `publish: true`, publishes the
validated artifacts using the existing `NPM_TOKEN` secret and GitHub OIDC
provenance. Every npm publication explicitly uses `next`; existing `latest`
values are checked before and after publication.

Public staging uses the current template version, requires a 3.x prerelease,
all four bundles, and each bundle's `release-source.json` sidecar matching the
frozen version, platform, and source commit:

```bash
node scripts/v3-prepare-npm-candidate.mjs --public \
  --source-commit "$RELEASE_COMMIT" --output-dir tmp/npm-prerelease \
  --windows-bundle tmp/portable/win32-x64 \
  --linux-bundle tmp/portable/linux-x64 \
  --linux-arm64-bundle tmp/portable/linux-arm64 \
  --macos-arm64-bundle tmp/portable/darwin-arm64
node scripts/v3-pack-npm-candidate.mjs --stage-dir tmp/npm-prerelease
```

Only staged public manifests receive `private: false`, repository metadata,
and `publishConfig` with public access, `next`, and provenance. Wrappers pin the
exact native prerelease version. The packer validates staged identities,
dependency pins, native payloads, provenance, and Unix executable archive modes.
The Ubuntu publication job installs and launches the exact combined tarballs
offline before publishing native, Viewer, then MCP.

Public portable archives use GNU tar and `gzip -n` with the resolved commit's
timestamp and normalized archive owners. The GitHub prerelease includes the
four portable archives, three npm tarballs, aggregate npm provenance, and
global `SHA256SUMS`; it is explicitly marked prerelease and `latest: false`.
Publication retries compare existing npm integrity and GitHub asset bytes,
then continue with missing packages/assets. A different immutable artifact
fails explicitly. Re-run failed jobs to reuse the validated host inputs.
