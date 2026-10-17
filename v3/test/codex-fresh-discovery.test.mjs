import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const tmpRoot = path.join(repo, 'tmp');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sessionId = '11111111-1111-4111-8111-111111111111';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('fresh Codex homes discover canonical sessions without a native state database',
  { timeout: 60_000 }, async t => {
    await mkdir(tmpRoot, { recursive: true });
    for (const scenario of [
      { name: 'default home', identity: 'id', source: 'home' },
      { name: 'CODEX_HOME', identity: 'id', source: 'environment' },
      { name: 'legacy session_id header', identity: 'session_id', source: 'home' },
      { name: 'archive-only home', identity: 'id', source: 'home', archived: true },
    ]) {
      await t.test(scenario.name, async t => {
        const work = await mkdtemp(path.join(tmpRoot, 'v3-codex-fresh-'));
        const home = path.join(work, 'home');
        const codex = scenario.source === 'home' ? path.join(home, '.codex') : path.join(work, 'custom-codex');
        const transcripts = path.join(codex, scenario.archived ? 'archived_sessions' : 'sessions/2026/10/12');
        await mkdir(transcripts, { recursive: true });
        const source = path.join(transcripts, 'rollout-fresh.jsonl');
        await writeFile(source, [
          { type: 'session_meta', timestamp: '2026-10-12T00:00:00.000Z',
            payload: { [scenario.identity]: sessionId, cwd: '/fresh-machine', base_instructions: { text: 'Recorded fresh instructions' } } },
          { type: 'event_msg', timestamp: '2026-10-12T00:00:01.000Z',
            payload: { type: 'user_message', message: 'Fresh machine question' } },
          { type: 'response_item', timestamp: '2026-10-12T00:00:02.000Z',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fresh machine answer' }] } },
        ].map(row => JSON.stringify(row)).join('\n') + '\n');
        const originalHash = sha(await readFile(source));
        const env = { ...process.env, HOME: home, USERPROFILE: home,
          APPDATA: path.join(work, 'roaming'), LOCALAPPDATA: path.join(work, 'local'),
          XDG_CONFIG_HOME: path.join(work, 'config'), XDG_DATA_HOME: path.join(work, 'data') };
        for (const key of Object.keys(env)) {
          if (key.startsWith('AGENTSESSION_') || ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'DSH_HOME', 'PORT'].includes(key)) delete env[key];
        }
        if (scenario.source === 'environment') env.CODEX_HOME = codex;
        const port = await freeFetchSafePort();
        const child = spawn(binary, ['serve', '--port', String(port),
          '--meta-dir', path.join(work, 'meta'), '--index-dir', path.join(work, 'index'), '--cache-dir', path.join(work, 'cache')],
        { cwd: work, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-5000); });
        t.after(async () => {
          if (child.exitCode === null && child.signalCode === null) {
            const closed = once(child, 'close'); child.kill(); await closed;
          }
          assert.equal(sha(await readFile(source)), originalHash, 'Provider source remains read-only');
          const relative = path.relative(tmpRoot, path.resolve(work));
          assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
          await rm(work, { recursive: true, force: true });
        });
        const base = `http://127.0.0.1:${port}`;
        for (let attempt = 0; ; attempt++) {
          assert.equal(child.exitCode, null, stderr);
          assert.ok(attempt < 150, `Fresh-machine server readiness: ${stderr}`);
          try { if ((await fetch(base + '/api/providers')).ok) break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const get = async route => {
          const response = await fetch(base + route);
          assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
          return response.json();
        };
        const providers = await get('/api/providers');
        assert.equal(providers.find(row => row.id === 'codex').available, true);
        const list = await get('/api/v3/sessions?provider=codex');
        assert.equal(list.length, 1);
        assert.deepEqual(list[0].session, { provider: 'codex', sessionId });
        assert.equal(list[0].diagnostic, undefined);
        assert.equal(list[0].title, 'Fresh machine question');
        const reader = await get(`/api/v3/reader/codex/${sessionId}/bootstrap`);
        assert.equal(reader.totalItems, 2);
        const protocol = await get(`/api/v3/protocol/codex/${sessionId}?version=3`);
        assert.equal(protocol.validation.ok, true);
        const prompts = await get(`/api/codex/session/${sessionId}/system-prompts`);
        assert.match(JSON.stringify(prompts), /Recorded fresh instructions/);
      });
    }
  });
