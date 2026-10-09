import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

async function freePort() {
  return freeFetchSafePort();
}

async function serve(t, command, args, env) {
  const port = await freePort();
  const child = spawn(command, [...args, '--port', String(port)], {
    cwd: repo, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2_000))]);
    }
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(origin + '/api/providers', { signal: AbortSignal.timeout(500) });
      if (response.ok) return response.json();
    } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Provider service did not start: ${stderr}`);
}

test('HTTP-01 provider descriptors expose the five-provider native contract',
  { timeout: 60_000 }, async t => {
    const scratch = path.join(repo, 'tmp');
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(path.join(scratch, 'v3-provider-descriptor-http01-'));
    const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta-v3',
      'index-v3', 'cache-v3'].map(name => [name, path.join(root, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
    // A Codex root without its sessions directory is unavailable.
    const dbPath = path.join(root, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
      fork_boundary TEXT, title TEXT, directory TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);`);
    db.close();
    const sourceArgs = ['--opencode-db', dbPath, '--codex-dir', dirs.codex,
      '--claude-dir', dirs.claude, '--pi-dir', dirs.pi, '--dsh-dir', dirs.dsh];
    const v3 = await serve(t, binary, ['serve', ...sourceArgs, '--meta-dir', dirs['meta-v3'],
      '--index-dir', dirs['index-v3'], '--cache-dir', dirs['cache-v3']], process.env);
    t.after(() => rm(root, { recursive: true, force: true }));
    const expectedIds = ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness'];
    assert.deepEqual(v3.map(row => row.id), expectedIds);
    const current = Object.fromEntries(v3.map(row => [row.id, row]));
    const expectedNames = ['OpenCode', 'Claude Code', 'Codex CLI', 'Pi', 'DeepSeek Harness'];
    const domains = ['sessionEvents', 'sessionRelationships', 'tasks', 'agentRuns',
      'contextArtifacts', 'branches'].sort();
    for (const id of expectedIds) {
      assert.equal(current[id].name, expectedNames[expectedIds.indexOf(id)], `${id} name`);
      assert.match(current[id].icon, /^<svg\b.*<path\b.*<\/svg>$/, `${id} icon SVG`);
      assert.equal(current[id].manageable, true, `${id} management`);
      assert.deepEqual(Object.keys(current[id].protocolCapabilities).sort(),
        domains, `${id} protocol domains`);
      for (const [domain, descriptor] of Object.entries(current[id].protocolCapabilities)) {
        assert.match(descriptor.support, /^(full|partial|none)$/, `${id}.${domain} support`);
        assert.match(descriptor.provenance, /^(recorded|derived|mixed|unknown)$/,
          `${id}.${domain} provenance`);
        if (descriptor.support !== 'none') {
          assert.equal(typeof descriptor.details, 'string', `${id}.${domain} source detail`);
          assert.ok(descriptor.details.length > 0);
        }
      }
    }
    assert.equal(current.opencode.available, true);
    assert.equal(current.pi.available, false);
    assert.equal(current.codex.available, false,
      'a Codex root without sessions is unavailable');
    assert.deepEqual(Object.keys(current.opencode.storageDiagnostic).sort(),
      ['note', 'path', 'schema']);
    assert.equal(current.opencode.storageDiagnostic.schema, 'v2');
    assert.equal(current.opencode.storageDiagnostic.path, dbPath);
    assert.match(current.opencode.storageDiagnostic.note, /ordered messages.*task tool dispatch/i);
    assert.equal(current.pi.storageDiagnostic, null);
    assert.equal(current.opencode.protocolCapabilities.tasks.support, 'partial',
      'the OpenCode v2 source adapter exposes recorded task dispatch');
  });
