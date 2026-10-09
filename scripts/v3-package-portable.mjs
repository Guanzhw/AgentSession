import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nativeTargets } from '../v3/npm/native/targets.mjs';
import { assertNativeArtifact } from './v3-native-artifact.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(scriptPath), '..');
const fixtureRoot = path.join(repo, 'v3', 'fixtures', 'codex');
const publicFixtureRelative = 'sessions/2026/09/26/rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl';
const publicFixturePath = path.join(fixtureRoot, ...publicFixtureRelative.split('/'));
const licenseFile = path.join(repo, 'LICENSE');
const hostInstaller = path.join(repo, 'scripts', 'v3-install-mcp-host.mjs');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const execFileAsync = promisify(execFile);

function assertNoLocalBuildPaths(binary) {
  const contents = binary.toString('utf8');
  const comparable = process.platform === 'win32' ? contents.toLowerCase() : contents;
  for (const prefix of [os.homedir(), repo]) {
    const forms = [prefix, prefix.replaceAll('\\', '/'), prefix.replaceAll('/', '\\')];
    if (forms.some(form => comparable.includes(process.platform === 'win32' ? form.toLowerCase() : form))) {
      throw new Error('Release executable contains an absolute local build path; rebuild with Rust path remapping before packaging');
    }
  }
}

function usage() {
  return 'Usage: node scripts/v3-package-portable.mjs --release-bin <existing-release-executable> --output-dir <new-directory>';
}

function parseArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!['--release-bin', '--output-dir'].includes(option) || !value || value.startsWith('--')) {
      throw new Error(usage());
    }
    if (options.has(option)) throw new Error(`Repeated option: ${option}`);
    options.set(option, value);
  }
  const releaseBin = options.get('--release-bin');
  const outputDir = options.get('--output-dir');
  if (!releaseBin || !outputDir) throw new Error(usage());
  return { releaseBin: path.resolve(releaseBin), outputDir: path.resolve(outputDir) };
}

function isWithinOrEqual(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

async function listRegularFiles(root, prefix = '') {
  const files = [];
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const source = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Portable package source contains a symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await listRegularFiles(source, relative));
    else if (entry.isFile()) files.push({ source, relative });
    else throw new Error(`Portable package source contains a non-file entry: ${relative}`);
  }
  return files;
}

function powershellSetup(executable) {
  return String.raw`$Root = (Get-Location).Path
$State = Join-Path $Root 'state'
@('meta', 'index', 'cache', 'claude', 'pi', 'dsh', 'opencode') | ForEach-Object {
  New-Item -ItemType Directory -Force -Path (Join-Path $State $_) | Out-Null
}
$Config = Join-Path $State 'config.json'
if (-not (Test-Path $Config)) { [System.IO.File]::WriteAllText($Config, '{}') }
$ProviderArgs = @(
  '--codex-dir', (Join-Path $Root 'fixtures\codex'),
  '--opencode-db', (Join-Path $State 'opencode\opencode.db'),
  '--claude-dir', (Join-Path $State 'claude'),
  '--pi-dir', (Join-Path $State 'pi'),
  '--dsh-dir', (Join-Path $State 'dsh'),
  '--meta-dir', (Join-Path $State 'meta'),
  '--index-dir', (Join-Path $State 'index'),
  '--cache-dir', (Join-Path $State 'cache')
)
$Exe = Join-Path $Root '${executable}'`;
}

function bashSetup(executable) {
  return String.raw`set -eu
root="$(pwd)"
state="$root/state"
mkdir -p "$state"/{meta,index,cache,claude,pi,dsh,opencode}
config="$state/config.json"
[ -f "$config" ] || printf '{}' > "$config"
common=(--codex-dir "$root/fixtures/codex" --opencode-db "$state/opencode/opencode.db"
  --claude-dir "$state/claude" --pi-dir "$state/pi" --dsh-dir "$state/dsh"
  --meta-dir "$state/meta" --index-dir "$state/index" --cache-dir "$state/cache")
exe="$root/${executable}"`;
}

function readmeFor(executable) {
  const windows = process.platform === 'win32';
  const shell = windows ? 'powershell' : 'bash';
  const setup = windows ? powershellSetup(executable) : bashSetup(executable);
  const webCommand = windows
    ? '& $Exe --config $Config serve --port 3457 @ProviderArgs'
    : '"$exe" --config "$config" serve --port 3457 "${common[@]}"';
  const mcpCommand = windows
    ? '& $Exe --config $Config mcp @ProviderArgs'
    : '"$exe" --config "$config" mcp "${common[@]}"';
  return [
    '# AgentSession 3.0 portable bundle',
    '',
    'Copy or unpack this entire directory wherever you want to run it. It works offline and needs no Node.js, Cargo, or npm.',
    'The included public Codex sample is under `fixtures/codex`. Configuration and derived state stay under `state/` when you use these commands.',
    '`manifest.json` records each payload file size and SHA-256. `SHA256SUMS` covers those files and the manifest.',
    'After starting the server, open the Library at `http://127.0.0.1:3457/sessions`; press Ctrl+C to stop it.',
    '',
    'Open a terminal in this directory and start the Web Reader:',
    '',
    `\`\`\`${shell}`,
    setup,
    '',
    '# Start the Web Reader at http://127.0.0.1:3457. Press Ctrl+C to stop it.',
    webCommand,
    `\`\`\``,
    '',
    'For MCP, run this independent block in a fresh shell. In a host configuration, use the absolute executable path and the same absolute config/source/state arguments:',
    '',
    `\`\`\`${shell}`,
    setup,
    '',
    mcpCommand,
    `\`\`\``,
    '',
    'The MCP host stops its process when disconnected. The Reader sample is the included synthetic session with ID `44444444-4444-4444-8444-444444444444`.',
    '',
    'Before registering a host, replace the demo `state/config.json` (`{}`) with a JSON object containing absolute `codexDir`, `dbPath`, `claudeDir`, `piDir`, `dshDir`, `metaDir`, `indexDir`, and `cacheDir` paths. The Web/MCP demo flags above are process arguments; a host does not inherit them. The installer refuses an incomplete `--server-config`, so it cannot silently read personal default roots instead of this portable sample.',
    'To register the native MCP in Codex, Claude Code, or OpenCode, run the included `install-mcp-host.mjs` once with Node.js. Supply `--target`, the absolute `--binary` path, the explicit `--host-config` file, and the populated `--server-config` for source/state settings. For example: `node install-mcp-host.mjs --target codex --binary <absolute-binary-path> --host-config <absolute-codex-config.toml> --server-config <absolute-server-config.json>`. The installer pins all eight source/state paths in the registered command so ambient provider variables cannot override them. Re-register with `--replace` after changing a registered path. It keeps other host entries. OpenCode 2.0.16 reads named servers directly under `mcp`, such as `mcp.agentsession-v3`; an older experimental `mcp.servers` wrapper must be manually corrected before installing. Node.js is only needed for this configuration step; the registered host runs the native binary directly.',
    '',
  ].join('\n');
}

async function packageFiles(root) {
  const files = await listRegularFiles(root);
  const manifestFiles = [];
  for (const file of files) {
    const bytes = await readFile(file.source);
    manifestFiles.push({
      path: file.relative,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  return manifestFiles.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function versionFromCargoManifest(body) {
  let inWorkspacePackage = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      if (inWorkspacePackage) break;
      inWorkspacePackage = line.trim() === '[workspace.package]';
      continue;
    }
    if (!inWorkspacePackage) continue;
    const version = line.match(/^\s*version\s*=\s*"([^"]+)"\s*$/)?.[1];
    if (version) return version;
  }
  throw new Error('Could not read [workspace.package].version from v3/Cargo.toml');
}

async function ensureNewOutput(outputDir) {
  try {
    await lstat(outputDir);
    throw new Error(`Output path already exists: ${outputDir}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function removeStagingDirectory(stageDir, parentDir) {
  try {
    const physicalStage = await realpath(stageDir);
    const stageParent = path.dirname(physicalStage);
    const sameParent = process.platform === 'win32'
      ? stageParent.toLowerCase() === parentDir.toLowerCase()
      : stageParent === parentDir;
    if (!sameParent) {
      throw new Error(`Refusing to remove staging path outside its parent: ${physicalStage}`);
    }
    await rm(physicalStage, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function main() {
  const { releaseBin, outputDir } = parseArgs(process.argv.slice(2));
  const releaseStat = await lstat(releaseBin);
  if (!releaseStat.isFile() || releaseStat.isSymbolicLink()) {
    throw new Error(`Release executable must be a regular file: ${releaseBin}`);
  }
  const target = `${process.platform}-${process.arch}`;
  const descriptor = nativeTargets[target];
  if (!descriptor) throw new Error(`Unsupported portable native target: ${target}`);
  const executable = descriptor.executable;
  if (path.basename(releaseBin).toLowerCase() !== executable.toLowerCase()) {
    throw new Error(`Expected the existing ${executable} release executable: ${releaseBin}`);
  }
  const releaseBytes = await readFile(releaseBin);
  assertNativeArtifact(releaseBytes, target);
  const cargoManifest = await readFile(path.join(repo, 'v3', 'Cargo.toml'), 'utf8');
  const version = versionFromCargoManifest(cargoManifest);
  const { stdout: reportedVersion } = await execFileAsync(releaseBin, ['--version'], {
    timeout: 5_000, maxBuffer: 1_000, windowsHide: true,
  });
  if (reportedVersion.trim() !== `agentsession-v3 ${version}`) {
    throw new Error(`Release executable version does not match v3/Cargo.toml: ${reportedVersion.trim()}`);
  }
  assertNoLocalBuildPaths(releaseBytes);
  const fixtureStat = await lstat(publicFixturePath);
  if (!fixtureStat.isFile() || fixtureStat.isSymbolicLink()) {
    throw new Error(`Public Codex fixture is not a regular file: ${publicFixturePath}`);
  }
  const licenseStat = await lstat(licenseFile);
  if (!licenseStat.isFile() || licenseStat.isSymbolicLink()) throw new Error(`Missing project license: ${licenseFile}`);

  await mkdir(path.dirname(outputDir), { recursive: true });
  const parentDir = await realpath(path.dirname(outputDir));
  const finalDir = path.join(parentDir, path.basename(outputDir));
  await ensureNewOutput(finalDir);
  const finalExecutable = path.join(finalDir, executable);
  const sameExecutablePath = process.platform === 'win32'
    ? path.resolve(finalExecutable).toLowerCase() === path.resolve(releaseBin).toLowerCase()
    : path.resolve(finalExecutable) === path.resolve(releaseBin);
  if (sameExecutablePath) {
    throw new Error('Package output must not overwrite the release executable');
  }
  if (isWithinOrEqual(fixtureRoot, finalDir) || isWithinOrEqual(finalDir, fixtureRoot)) {
    throw new Error('Package output must not overlap the public Codex fixture source');
  }

  const stageDir = await mkdtemp(path.join(parentDir, `.${path.basename(finalDir)}.stage-`));
  try {
    await copyFile(releaseBin, path.join(stageDir, executable));
    await copyFile(licenseFile, path.join(stageDir, 'LICENSE'));
    await copyFile(hostInstaller, path.join(stageDir, 'install-mcp-host.mjs'));
    const packagedFixture = path.join(stageDir, 'fixtures', 'codex',
      ...publicFixtureRelative.split('/'));
    await mkdir(path.dirname(packagedFixture), { recursive: true });
    await copyFile(publicFixturePath, packagedFixture);
    await writeFile(path.join(stageDir, 'README.md'), readmeFor(executable), 'utf8');

    const files = await packageFiles(stageDir);
    const manifest = {
      schemaVersion: 1,
      product: 'AgentSession',
      version,
      platform: target,
      executable,
      fixture: {
        provider: 'codex',
        sessionId: '44444444-4444-4444-8444-444444444444',
        path: `fixtures/codex/${publicFixtureRelative}`,
      },
      files,
    };
    const manifestPath = path.join(stageDir, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const sumFiles = [...files.map(file => ({ path: file.path, sha256: file.sha256 })),
      { path: 'manifest.json', sha256: sha256(await readFile(manifestPath)) }]
      .sort((left, right) => left.path.localeCompare(right.path, 'en'));
    await writeFile(path.join(stageDir, 'SHA256SUMS'),
      `${sumFiles.map(file => `${file.sha256}  ${file.path}`).join('\n')}\n`, 'utf8');
    await rename(stageDir, finalDir);
    process.stdout.write(`${finalDir}\n`);
  } catch (error) {
    await removeStagingDirectory(stageDir, parentDir);
    throw error;
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n${usage()}\n`);
  process.exitCode = 1;
});
