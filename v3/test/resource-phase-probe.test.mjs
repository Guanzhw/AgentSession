import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_RESOURCE_PROBE_BIN;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = output => output.split('\n').filter(line => line.startsWith('{'))
  .map(line => JSON.parse(line)).filter(row => row.kind?.endsWith('_probe'));
const exits = (output, kind) => events(output).filter(row => row.kind === kind && row.stage === 'exit');
const sum = (rows, name) => rows.reduce((total, row) => total + (row.counts[name] || 0), 0);

test('resource probe observes cold, warm, Web force, failure and disabled paths with pure MCP stdout',
  { timeout: 60_000, skip: !binary && 'requires separately built search-phase-probe binary' }, async t => {
    const root = await temporaryDirectory(t, path.join(os.tmpdir(), 'agentsession-resource-probe-'));
    for (const name of ['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache'])
      await mkdir(path.join(root, name));
    await cp(path.join(repo, 'v3/fixtures/codex'), path.join(root, 'codex'), { recursive: true });
    const args = ['--codex-dir', path.join(root, 'codex'), '--opencode-db', path.join(root, 'missing.db'),
      '--claude-dir', path.join(root, 'claude'), '--pi-dir', path.join(root, 'pi'), '--dsh-dir', path.join(root, 'dsh'),
      '--meta-dir', path.join(root, 'meta'), '--index-dir', path.join(root, 'index'), '--cache-dir', path.join(root, 'cache')];
    function launch(mode, enabled, extra = []) {
      const process = spawn(binary, [mode, ...extra, ...args], { cwd: repo, windowsHide: true,
        env: { ...globalThis.process.env, AGENTSESSION_V3_SEARCH_PHASE_PROBE: enabled ? '1' : '0' },
        stdio: ['pipe', 'pipe', 'pipe'] });
      onCleanup(t, async () => {
        if (process.exitCode === null && process.signalCode === null) {
          const closed = once(process, 'close'); process.kill(); await closed;
        }
      });
      let stderr = '', stdout = '', buffer = '', next = 1;
      const pending = new Map();
      process.on('close', code => {
        for (const call of pending.values()) call.reject(new Error(`MCP exited ${code}: ${stderr}`));
        pending.clear();
      });
      process.stderr.on('data', chunk => { stderr += chunk; });
      process.stdout.on('data', chunk => {
        stdout += chunk; buffer += chunk;
        while (buffer.includes('\n')) {
          const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          if (mode === 'mcp') {
            const row = JSON.parse(line);
            assert.equal(row.jsonrpc, '2.0', 'stdout contains protocol only');
            if (row.id !== undefined) { pending.get(row.id)?.resolve(row); pending.delete(row.id); }
          }
        }
      });
      return { process, stderr: () => stderr, stdout: () => stdout,
        request: async (method, params) => {
          const id = next++;
          const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
          process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
          const result = await reply; await sleep(30); return result;
        },
        close: async () => { if (process.exitCode === null && process.signalCode === null) { const closed = once(process, 'close'); process.kill(); await closed; } },
      };
    }
    async function connect(enabled) {
      const mcp = launch('mcp', enabled);
      const initialized = await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'resource-probe-test', version: '1' } });
      assert.ok(initialized.result);
      mcp.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return mcp;
    }
    const search = mcp => mcp.request('tools/call', { name: 'session_search',
      arguments: { query: 'Hello', providers: ['codex'], fields: ['assistant'], limit: 100 } });
    const mcp = await connect(true);
    const first = await search(mcp);
    assert.notEqual(first.result?.isError, true);
    const cold = mcp.stderr();
    const publication = exits(cold, 'index_publication_probe');
    assert.ok(publication.length > 0, 'feature-enabled publication diagnostics must exist');
    assert.equal(sum(publication, 'capture_attempts'), 1);
    assert.equal(sum(publication, 'capture_successes'), 1);
    assert.equal(sum(publication, 'changed_sessions'), 1);
    assert.equal(sum(publication, 'commits'), 1);
    assert.equal(sum(exits(cold, 'search_document_build_probe'), 'build_attempts'), 1);
    assert.equal(sum(exits(cold, 'search_document_build_probe'), 'build_successes'), 1);
    assert.equal(exits(cold, 'codex_positioned_reader_probe').length, 1);
    const second = await search(mcp);
    assert.deepEqual(second.result.structuredContent.result.matches, first.result.structuredContent.result.matches);
    const warm = mcp.stderr().slice(cold.length);
    assert.equal(sum(exits(warm, 'index_publication_probe'), 'capture_attempts'), 0);
    assert.equal(exits(warm, 'codex_positioned_reader_probe').length, 0);
    assert.equal(exits(warm, 'search_document_build_probe').length, 0);
    await mcp.close();

    const port = await freeFetchSafePort(), web = launch('serve', true, ['--port', String(port)]);
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = (await fetch(origin + '/api/providers')).ok; } catch { /* startup */ }
      if (!ready) await sleep(50);
    }
    assert.ok(ready, web.stderr());
    const force = await fetch(origin + '/api/reindex', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(force.status, 200, await force.text());
    await web.close();
    const forced = exits(web.stderr(), 'index_publication_probe').filter(row => row.provider === 'codex');
    assert.equal(forced.length, 1);
    assert.equal(sum(forced, 'force'), 1);
    assert.equal(sum(forced, 'commits'), 1);
    assert.equal(sum(forced, 'capture_attempts'), 0, 'exact revision reuse does not parse unchanged source');
    assert.ok(forced[0].lock_wait_ms >= 0);
    assert.equal(forced[0].completed, true);

    const disabled = await connect(false);
    assert.deepEqual((await search(disabled)).result.structuredContent.result.matches, first.result.structuredContent.result.matches);
    await disabled.close();
    assert.deepEqual(events(disabled.stderr()), [], 'environment-disabled feature build emits no probe');

    const indexFiles = (await readdir(path.join(root, 'index'))).filter(name => name.endsWith('.sqlite'));
    assert.equal(indexFiles.length, 1);
    await writeFile(path.join(root, 'index', indexFiles[0]), 'invalid sqlite fixture');
    const failed = await connect(true);
    assert.notEqual((await search(failed)).result.structuredContent.result.diagnostics[0].status, 'ok');
    await failed.close();
    assert.equal(exits(failed.stderr(), 'index_publication_probe')[0].completed, false);

    for (const output of [mcp.stderr(), web.stderr(), failed.stderr()]) {
      const rows = events(output).filter(row => row.stage);
      for (const exit of rows.filter(row => row.stage === 'exit')) {
        assert.equal(rows.filter(row => row.stage === 'entry' && row.pid === exit.pid && row.invocation === exit.invocation).length, 1);
        assert.ok(Number.isInteger(exit.pid) && exit.pid > 0);
      }
      assert.ok(!output.includes('44444444-4444-4444-8444-444444444444'));
      assert.ok(!output.includes('Hello 🙂 from the Rust slice.'));
    }
  });
