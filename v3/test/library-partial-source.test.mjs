import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function safePort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = randomInt(20000, 60000);
    const server = createServer();
    try {
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      await new Promise(resolve => server.close(resolve));
      return port;
    } catch {
      server.close();
    }
  }
  throw new Error('Could not reserve a local test port');
}

test('global Library keeps a healthy family and diagnoses one malformed provider',
  { timeout: 30_000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'as-v3-library-partial-'));
    let child;
    t.after(async () => {
      if (child && child.exitCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    });
    const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
      .map(name => [name, path.join(root, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
    const source = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
      'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
    const copy = path.join(dirs.codex, 'sessions', '2026', '09', '26', path.basename(source));
    await mkdir(path.dirname(copy), { recursive: true });
    await copyFile(source, copy);
    const badDb = path.join(root, 'opencode.db');
    await writeFile(badDb, 'not a SQLite database');
    const before = [sha(copy), sha(badDb)];
    const port = await safePort();
    child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', dirs.codex,
      '--opencode-db', badDb, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
      '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta, '--index-dir', dirs.index,
      '--cache-dir', dirs.cache], { cwd: repo, windowsHide: true, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base + '/api/providers')).ok) break; } catch { /* Starting. */ }
      if (attempt === 99) assert.fail('server did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const response = await fetch(base + '/api/v3/library/sessions?limit=20');
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.ok(page.families.some(row => row.session.session.provider === 'codex'));
    assert.ok(page.sourceDiagnostics.some(row => row.provider === 'opencode'));
    assert.equal((await fetch(base + '/api/v3/library/sessions?provider=opencode')).status, 503);
    assert.deepEqual([sha(copy), sha(badDb)], before);
  });
