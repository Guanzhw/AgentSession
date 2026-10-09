import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const publicSource = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
  'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
const event = { provider: 'codex', sessionId: '44444444-4444-4444-8444-444444444444',
  messageId: 'assistant-1', segment: 'message' };
const secondEvent = { ...event, sessionId: '55555555-5555-4555-8555-555555555555' };
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

for (const era of ['legacy', 'modern']) {
  test(`session_search preserves JSON escaped UTF-16 surrogate and NUL queries over ${era} stdio`,
    { timeout: 20_000 }, async t => {
      const dir = mkdtempSync(path.join(repo, 'tmp', 'v3-delivery', 'mcp03-json-boundary-'));
      const codex = path.join(dir, 'codex');
      const copied = path.join(codex, 'sessions', '2026', '09', '26', path.basename(publicSource));
      const second = path.join(path.dirname(copied),
        `rollout-2026-09-26T00-00-00-${secondEvent.sessionId}.jsonl`);
      mkdirSync(path.dirname(copied), { recursive: true });
      for (const name of ['claude', 'pi', 'dsh', 'meta', 'index', 'cache']) {
        mkdirSync(path.join(dir, name));
      }
      const sourceHash = hash(publicSource);
      const rows = readFileSync(publicSource, 'utf8').trimEnd().split('\n').map(JSON.parse);
      rows.find(row => row.payload?.id === 'assistant-1').payload.content[0].text =
        'prefix\u0000needle after NUL; emoji 🙂ab; sigma 🙂 ΟΣ; literal \uE000';
      writeFileSync(copied, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
      const sibling = structuredClone(rows);
      sibling[0].payload.id = secondEvent.sessionId;
      sibling.find(row => row.type === 'token_usage_record').payload.session_id = secondEvent.sessionId;
      sibling.find(row => row.type === 'token_usage_record').payload.thread_id = secondEvent.sessionId;
      sibling.find(row => row.payload?.id === 'assistant-1').payload.content[0].text =
        'prefix\u0000needle after NUL; emoji 🙂ab; sigma 🙂 ΟΣ';
      writeFileSync(second, `${sibling.map(row => JSON.stringify(row)).join('\n')}\n`);
      const copiedHash = hash(copied);
      const secondHash = hash(second);
      t.after(() => {
        try {
          assert.equal(hash(publicSource), sourceHash, 'public source stays read-only');
          assert.equal(hash(copied), copiedHash, 'copied source stays read-only');
          assert.equal(hash(second), secondHash, 'second copied source stays read-only');
        } finally {
          const relative = path.relative(path.resolve(repo, 'tmp', 'v3-delivery'), path.resolve(dir));
          assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
            'cleanup target stays within repository tmp/v3-delivery');
          rmSync(dir, { recursive: true, force: true });
        }
      });
      const client = new Client({ name: 'mcp03-json-boundary', version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
      await client.connect(new StdioClientTransport({ command: binary, cwd: repo, stderr: 'pipe',
        args: ['mcp', '--codex-dir', codex, '--opencode-db', path.join(dir, 'missing-opencode.db'),
          '--claude-dir', path.join(dir, 'claude'), '--pi-dir', path.join(dir, 'pi'),
          '--dsh-dir', path.join(dir, 'dsh'), '--meta-dir', path.join(dir, 'meta'),
          '--index-dir', path.join(dir, 'index'), '--cache-dir', path.join(dir, 'cache')],
      }), { signal: AbortSignal.timeout(5_000) });
      t.after(async () => client.close());

      const observed = {};
      for (const [label, query] of [
        ['emoji', '🙂'], ['high surrogate', '\uD83D'], ['low surrogate', '\uDE42'],
        ['contextual sigma', '\uD83D ΟΣ'],
        ['after NUL', 'needle'], ['embedded NUL', 'prefix\u0000needle'],
        ['literal PUA', '\uE000'],
      ]) {
        try {
          const response = await client.callTool({ name: 'session_search', arguments: {
            query, providers: ['codex'], fields: ['assistant'],
          } }, { signal: AbortSignal.timeout(2_500) });
          observed[label] = response.structuredContent?.result?.matches?.map(hit => hit.event)
            ?? { isError: response.isError, content: response.content };
        } catch (error) {
          observed[label] = String(error);
        }
      }
      for (const label of ['emoji', 'after NUL', 'embedded NUL',
        'high surrogate', 'low surrogate', 'contextual sigma']) {
        assert.deepEqual(observed[label], [event, secondEvent],
          `${label}: ${JSON.stringify(observed)}`);
      }
      assert.deepEqual(observed['literal PUA'], [event], 'literal PUA remains distinct');
      const search = (query, cursor) => client.callTool({ name: 'session_search', arguments: {
        query, providers: ['codex'], fields: ['assistant'], limit: 1,
        ...(cursor ? { cursor } : {}),
      } }, { signal: AbortSignal.timeout(2_500) });
      const first = await search('\uD83D');
      assert.deepEqual(first.structuredContent.result.matches.map(hit => hit.event), [event]);
      assert.ok(first.structuredContent.result.nextCursor);
      const cursor = first.structuredContent.result.nextCursor;
      const next = await search('\uD83D', cursor);
      assert.deepEqual(next.structuredContent.result.matches.map(hit => hit.event), [secondEvent]);
      assert.equal(next.structuredContent.result.nextCursor, null);
      const wrongQuery = await search('\uDE42', cursor);
      assert.equal(wrongQuery.isError, true, 'cursor binds to the exact UTF-16 query');
      const forged = await client.callTool({ name: 'session_search', arguments: {
        query: 'needle', providers: ['codex'], fields: ['assistant'],
        __agentsessionUtf16Units: [0xd83d],
      } }, { signal: AbortSignal.timeout(2_500) });
      assert.equal(forged.isError, true, 'client supplied unit sidecars are invalid arguments');
      for (const query of ['needle', '\uD83D']) {
        await assert.rejects(client.callTool({ name: 'session_search', arguments: {
          query, providers: ['codex'], fields: ['assistant'],
          __agentsessionUtf16Boundary: 1,
        } }, { signal: AbortSignal.timeout(2_500) }),
        /Invalid UTF-16 request string/, 'client supplied boundary markers are rejected');
      }
      await assert.rejects(client.callTool({ name: 'session_get', arguments: {
        session: { provider: 'codex', sessionId: '\uD83D' },
      } }, { signal: AbortSignal.timeout(2_500) }),
      /Invalid UTF-16 request string/, 'non-search lone surrogate receives an explicit error');
      const healthy = await search('needle');
      assert.deepEqual(healthy.structuredContent.result.matches.map(hit => hit.event), [event]);
    });
}
