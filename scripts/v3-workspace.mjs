import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { constants, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const binary = path.join(repo, 'v3', 'target', 'release',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: repo, env, stdio: 'inherit', windowsHide: true });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const status = signal ? 128 + (constants.signals[signal] ?? 1) : code ?? 1;
    if (status !== 0) {
      process.exitCode = status;
      return false;
    }
    return true;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

async function build() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this command through npm run build, start, dev, or test.');
  if (!await run(process.execPath, [npmCli, '--prefix', 'v3/ui', 'run', 'build'])) return false;
  const flags = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f')
    ?? process.env.RUSTFLAGS?.split(/\s+/).filter(Boolean) ?? [];
  flags.push(`--remap-path-prefix=${path.resolve(repo)}=/agentsession-src`,
    `--remap-path-prefix=${homedir()}=/build-user`);
  return run('cargo', ['build', '--manifest-path', 'v3/Cargo.toml', '--release', '--locked',
    '--bin', 'agentsession-v3'], { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') });
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!['build', 'start', 'dev', 'test'].includes(mode)) throw new Error(`Unknown workspace command: ${mode}`);
  if ((mode === 'build' || mode === 'test') && args.length) throw new Error(`${mode} takes no arguments.`);
  if (!await build()) return;
  if (mode === 'start' || mode === 'dev') {
    await run(binary, ['serve', ...(mode === 'dev' ? ['--open'] : []), ...args]);
  } else if (mode === 'test') {
    if (!await run('cargo', ['test', '--manifest-path', 'v3/Cargo.toml', '--workspace', '--locked'])) return;
    const tests = [];
    for (const directory of ['test', 'v3/test']) {
      tests.push(...(await readdir(path.join(repo, directory)))
        .filter(name => name.endsWith('.test.mjs')).sort().map(name => `${directory}/${name}`));
    }
    await run(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
      ...process.env, AGENTSESSION_V3_BIN: binary, AGENTSESSION_V3_BINARY: binary,
      AGENTSESSION_V3_RELEASE_BIN: binary,
    });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
