import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const activeId = '44444444-4444-4444-8444-444444444444';
const healthyId = '55555555-5555-4555-8555-555555555555';
const row = (type, payload) => JSON.stringify({
  timestamp: '2026-10-16T12:00:00.000Z', type, payload,
}) + '\n';
const header = id => row('session_meta', { id, cwd: '/synthetic/live-catalog' });
const user = message => row('event_msg', { type: 'user_message', message });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const recorded of [false, true]) {
  test(`Codex ${recorded ? 'recorded-rollout-selected' : 'single-source'} catalog remains usable during legal appends`,
    { timeout: 60_000 }, async t => {
      await mkdir(path.join(repo, 'tmp'), { recursive: true });
      const dir = await temporaryDirectory(t, path.join(repo, 'tmp/codex-live-catalog-'));
      const codex = path.join(dir, 'codex');
      const sessions = path.join(codex, 'sessions');
      await mkdir(sessions, { recursive: true });
      const active = path.join(sessions, 'active.jsonl');
      const seed = row('event_msg', { type: 'agent_message', message: 'seed '.repeat(400) });
      await writeFile(active, header(activeId) + user('Live catalog initial request') + seed.repeat(4096));
      await writeFile(path.join(sessions, 'healthy.jsonl'), header(healthyId) + user('Healthy stable request'));
      if (recorded) {
        await writeFile(path.join(sessions, 'unselected.jsonl'), header(activeId) + user('Unselected fragment'));
        const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
        try {
          db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
          db.prepare('INSERT INTO threads VALUES (?, ?)').run(activeId, active);
        } finally {
          db.close();
        }
        await writeFile(path.join(codex, 'session_index.jsonl'), JSON.stringify({
          id: activeId, thread_name: 'Recorded native title', updated_at: '2026-10-16T12:00:00Z',
        }) + '\n');
      }
      const port = await freeFetchSafePort();
      const base = `http://127.0.0.1:${port}`;
      let child;
      let stderr = '';
      const args = ['serve', '--port', String(port), '--codex-dir', codex,
        '--opencode-db', path.join(dir, 'missing.db'), '--claude-dir', path.join(dir, 'claude'),
        '--pi-dir', path.join(dir, 'pi'), '--dsh-dir', path.join(dir, 'dsh'),
        '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
        '--cache-dir', path.join(dir, 'cache'), '--disable-terminal-launch'];
      async function stop() {
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close');
          child.kill();
          await Promise.race([closed, sleep(3000)]);
          assert.ok(child.exitCode !== null || child.signalCode !== null, 'task server exited');
        }
      }
      onCleanup(t, stop);
      async function start() {
        child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-10_000); });
        for (let attempt = 0; attempt < 100; attempt++) {
          if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
          try {
            const response = await fetch(`${base}/api/providers`);
            if (response.ok) {
              const providers = await response.json();
              assert.equal(providers.find(provider => provider.id === 'codex').available, true);
              return;
            }
          } catch (error) {
            if (attempt === 99) throw error;
          }
          await sleep(50);
        }
        throw new Error(`server did not become ready: ${stderr}`);
      }
      async function get(endpoint) {
        const response = await fetch(base + endpoint);
        const body = await response.text();
        assert.equal(response.status, 200, `${endpoint}: ${body}; stderr=${stderr}`);
        return JSON.parse(body);
      }
      async function list() {
        const body = await get('/api/codex/sessions');
        assert.deepEqual(new Set(body.sessions.map(session => session.id)), new Set([activeId, healthyId]));
        return body;
      }
      await start();
      let appends = 0;
      const writer = setInterval(() => {
        appendFileSync(active, row('event_msg', {
          type: 'agent_message', message: `Legal append ${++appends}: ` + 'running '.repeat(200),
        }));
      }, 5);
      onCleanup(t, () => clearInterval(writer));
      await sleep(20);
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = appends;
        const body = await list();
        assert.ok(appends > before, 'writer appended while the catalog request was executing');
        if (recorded) assert.equal(body.sessions.find(session => session.id === activeId).title, 'Recorded native title');
      }
      clearInterval(writer);
      appendFileSync(active, user('livecatalogfinalsentinel'));
      await list();
      const final = await get('/api/v3/search?provider=codex&fields=user&q=livecatalogfinalsentinel');
      assert.equal(final.matches.length, 1);
      assert.equal(final.matches[0].session.sessionId, activeId);
      const target = final.matches[0].target;
      const reader = `/api/v3/reader/codex/${activeId}`;
      const bootstrap = await get(`${reader}/bootstrap`);
      const content = await get(`${reader}/content?${new URLSearchParams({
        messageId: target.event.messageId, segment: target.event.segment, field: 'body',
        offset: String(target.offset), maxChars: '1000', revision: bootstrap.revision,
        contentRevision: target.contentRevision,
      })}`);
      assert.equal(content.text, 'livecatalogfinalsentinel');
      await stop();
      appendFileSync(active, user('livecatalogrestartsentinel'));
      await start();
      await list();
      const restarted = await get('/api/v3/search?provider=codex&fields=user&q=livecatalogrestartsentinel');
      assert.equal(restarted.matches.length, 1);
      assert.equal(restarted.matches[0].session.sessionId, activeId);
    });
}
