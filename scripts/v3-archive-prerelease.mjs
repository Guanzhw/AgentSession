import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const [input, output, timestamp] = process.argv.slice(2);
if (process.argv.length !== 5 || !/^\d+$/.test(timestamp ?? '')) {
  throw new Error('Usage: node scripts/v3-archive-prerelease.mjs <portable-dir> <new.tar.gz> <commit-unix-seconds>; requires GNU tar and gzip');
}
const destination = path.resolve(output);
const tar = spawn('tar', ['--sort=name', `--mtime=@${timestamp}`, '--owner=0', '--group=0', '--numeric-owner',
  '-C', path.resolve(input), '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
const gzip = spawn('gzip', ['-n'], { stdio: ['pipe', 'pipe', 'inherit'] });
const closed = (child, label) => new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`)));
});
const tarClosed = closed(tar, 'GNU tar');
const gzipClosed = closed(gzip, 'gzip');
const stream = createWriteStream(destination, { flags: 'wx' });
let created = false;
stream.once('open', () => { created = true; });
try {
  await Promise.all([pipeline(tar.stdout, gzip.stdin), pipeline(gzip.stdout, stream), tarClosed, gzipClosed]);
} catch (error) {
  tar.kill(); gzip.kill();
  await Promise.allSettled([tarClosed, gzipClosed]);
  if (created) await unlink(destination);
  throw error;
}
