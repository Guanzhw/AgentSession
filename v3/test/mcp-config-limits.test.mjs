import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const dsh = path.join(repo, 'v3', 'fixtures', 'deepseek-harness');
const ids = ['dsh-v3-s2-root', 'dsh-v3-s2-alpha', 'dsh-v3-s2-beta'];
const sources = ids.map(id => path.join(dsh, 'sessions', 's2-synthetic', id,
  'session.v3.jsonl.zstd'));
const sourceHashes = sources.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
const session = { provider: 'deepseek-harness', sessionId: ids[0] };
const event = { ...session, messageId: 'root-continues', segment: 'message' };

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-mcp-config-'));
  t.after(async () => {
    try {
      assert.deepEqual(sources.map(file => createHash('sha256').update(readFileSync(file)).digest('hex')),
        sourceHashes, 'provider source bytes remain unchanged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  for (const name of ['codex', 'claude', 'pi', 'meta', 'index', 'cache']) {
    await mkdir(path.join(dir, name));
  }
  const config = path.join(dir, 'config.json');
  const paths = {
    codexDir: path.join(dir, 'codex'), dbPath: path.join(dir, 'opencode.db'),
    claudeDir: path.join(dir, 'claude'), piDir: path.join(dir, 'pi'), dshDir: dsh,
    metaDir: path.join(dir, 'meta'), indexDir: path.join(dir, 'index'),
    cacheDir: path.join(dir, 'cache'),
  };
  return { dir, config, paths };
}

async function connect(t, config, era) {
  const client = new Client({ name: 'agentsession-v3-mcp-config-test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(new StdioClientTransport({ command: binary,
    args: ['mcp', '--config', config], cwd: repo, stderr: 'pipe' }));
  t.after(async () => client.close());
  return client;
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

function result(response) {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  assert.equal(response.structuredContent.untrustedContent, true);
  return response.structuredContent.result;
}

for (const era of ['legacy', 'modern']) {
  test(`selected mcp limits bound four tools over ${era} native stdio`,
    { timeout: 30_000 }, async t => {
      const { config, paths } = await setup(t);
      await writeFile(config, JSON.stringify({ ...paths, mcp: {
        searchLimit: 1, timelineLimit: 2, eventMaxChars: 8, contextWindow: 1,
        unusedLegacyOption: 'retained by existing configuration',
      } }));
      const client = await connect(t, config, era);

      const search = { query: 'synthetic', providers: ['deepseek-harness'], fields: ['title'] };
      assert.equal(result(await call(client, 'session_search', search)).matches.length, 1);
      assert.equal(result(await call(client, 'session_search', { ...search, limit: 3 })).matches.length,
        1, 'configured search maximum caps an explicit request');
      assert.equal(result(await call(client, 'session_search', { ...search, limit: 101 })).matches.length,
        1, 'valid requests above the absolute search bound still cap');

      assert.equal(result(await call(client, 'session_timeline', { session })).events.length, 2);
      assert.equal(result(await call(client, 'session_timeline', { session, limit: 5 })).events.length,
        2, 'configured timeline maximum caps an explicit request');
      assert.equal(result(await call(client, 'session_timeline', { session, limit: 201 })).events.length,
        2, 'valid requests above the absolute timeline bound still cap');

      const detail = result(await call(client, 'session_get_event', { event }));
      assert.equal(detail.content.text.length, 8);
      assert.equal(detail.content.truncated, true);
      assert.equal(result(await call(client, 'session_get_event', { event, maxChars: 20 }))
        .content.text.length, 8, 'configured event maximum caps an explicit request');
      assert.equal(result(await call(client, 'session_get_event', { event, maxChars: 20_001 }))
        .content.text.length, 8, 'valid requests above the absolute event bound still cap');

      const neighbors = result(await call(client, 'session_get_context', { event }));
      assert.deepEqual(neighbors.events.map(row => row.event.messageId),
        ['root-dispatch', 'root-continues', 'root-check']);
      assert.deepEqual(result(await call(client, 'session_get_context', {
        event, before: 2, after: 2,
      })).events.map(row => row.event.messageId),
      ['root-dispatch', 'root-continues', 'root-check'],
      'configured context window caps each explicit side');
      assert.deepEqual(result(await call(client, 'session_get_context', {
        event, before: 21, after: 21,
      })).events.map(row => row.event.messageId),
      ['root-dispatch', 'root-continues', 'root-check'],
      'valid requests above the absolute context bound still cap');

      const browse = { level: 'sessions', providers: ['deepseek-harness'] };
      assert.equal(result(await call(client, 'session_browse', browse)).sessions.length, 1,
        'browse shares the configured default search page size');
      assert.equal(result(await call(client, 'session_browse', { ...browse, limit: 3 }))
        .sessions.length, 3, 'explicit browse size is not capped by searchLimit');
      assert.equal(result(await call(client, 'session_browse', { ...browse, limit: 101 }))
        .sessions.length, 3, 'browse caps a valid request at its separate hard maximum');
    });
}

test('selected mcp settings reject noninteger, zero and out-of-range values before stdio starts',
  { timeout: 30_000 }, async t => {
    const { dir, config, paths } = await setup(t);
    for (const [mcp, field] of [
      [{ searchLimit: 1.5 }, 'searchLimit'],
      [{ searchLimit: 0 }, 'searchLimit'],
      [{ searchLimit: 101 }, 'searchLimit'],
      [{ timelineLimit: '2' }, 'timelineLimit'],
      [{ timelineLimit: 201 }, 'timelineLimit'],
      [{ eventMaxChars: 20_001 }, 'eventMaxChars'],
      [{ contextWindow: -1 }, 'contextWindow'],
      [{ contextWindow: 21 }, 'contextWindow'],
      [[], 'mcp'],
    ]) {
      await writeFile(config, JSON.stringify({ ...paths, mcp }));
      const run = spawnSync(binary, ['mcp', '--config', config], {
        cwd: dir, encoding: 'utf8', timeout: 5_000, windowsHide: true,
      });
      assert.notEqual(run.status, 0, JSON.stringify(mcp));
      assert.match(run.stderr, new RegExp(field), JSON.stringify(mcp));
      assert.equal(run.stdout, '', 'invalid startup config must not write protocol stdout');
    }
  });
