import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { frozenFourProviderTimelineFacts, verifyFourProviderTimeline } from
  '../../scripts/v3-four-provider-timeline-oracle.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = path.join(repo, 'tmp', 'v3-corpus', 'manifest.private.json');
const packageExecutable = path.join(repo, 'tmp', 'v3-delivery', 'agentsession-v3.0.0-win-x64-4c2b0f20', 'agentsession-v3.exe');
const packageSha256 = '4c2b0f201721ab509798db0d803b9ad4ea1e27abb00e1e0a3bcb41a6c91ff1b1';
const providers = ['opencode', 'claude-code', 'codex', 'pi'];
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const eventKey = event => JSON.stringify([event.provider, event.sessionId, event.messageId, event.segment]);
const requiredCorpus = process.env.AGENTSESSION_V3_REAL_CORPUS_REQUIRED === '1';
const skip = !existsSync(manifestPath) && !requiredCorpus ? 'requires ignored frozen corpus' : false;

function sourceFiles(manifest) {
  return providers.map(provider => provider === 'opencode' ? manifest.database : manifest.files.find(
    row => row.provider === provider && row.role !== 'compact-team-shorter'));
}

function inventory(manifest) {
  return new Map(providers.map(provider => [provider, frozenFourProviderTimelineFacts(manifest, provider)]));
}

function verifyMutations(facts) {
  const good = facts.required.map(({ event, role }) => ({ event, role }));
  assert.equal(verifyFourProviderTimeline(facts, good).ok, true);
  const assistant = good.findIndex(row => row.role === 'assistant');
  assert.ok(assistant >= 0, `${facts.provider} has source assistant evidence`);
  assert.equal(verifyFourProviderTimeline(facts, good.filter((_, index) => index !== assistant)).ok, false,
    `${facts.provider} missing assistant is rejected`);
  if (good.some(row => row.role === 'tool')) {
    const tool = good.findIndex(row => row.role === 'tool');
    assert.equal(verifyFourProviderTimeline(facts, good.filter((_, index) => index !== tool)).ok, false,
      `${facts.provider} missing tool is rejected`);
  }
  const wrongOwner = structuredClone(good);
  wrongOwner[0].event.sessionId = `${facts.sessionId}-wrong`;
  assert.equal(verifyFourProviderTimeline(facts, wrongOwner).ok, false,
    `${facts.provider} wrong owner is rejected`);
}

async function waitForExit(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('MCP child process remained alive after client close');
}

test('frozen source oracle rejects omitted and wrong-owner timeline rows before MCP comparison',
  { skip, timeout: 120_000 }, () => {
    assert.ok(existsSync(manifestPath), 'frozen corpus is required');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const facts of inventory(manifest).values()) {
      assert.equal(facts.coverage.membership, 'exact',
        `${facts.provider} selected default timeline has a complete source-backed inventory`);
      verifyMutations(facts);
    }
  });

test('4c2b0f20 portable stdio MCP complete default timelines agree with four raw sources',
  { skip, timeout: 240_000 }, async t => {
    assert.ok(existsSync(manifestPath), 'frozen corpus is required');
    assert.ok(existsSync(packageExecutable), '4c2b0f20 portable executable is required');
    assert.equal(sha256(packageExecutable), packageSha256, 'test uses the pinned portable executable');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const files = sourceFiles(manifest);
    const beforeHashes = new Map();
    for (const [index, source] of files.entries()) {
      assert.ok(source?.snapshotPath && source.snapshotSha256, 'selected source is recorded');
      const actual = sha256(source.snapshotPath);
      assert.equal(actual, source.snapshotSha256, 'frozen source hash before MCP');
      beforeHashes.set(providers[index], actual);
    }
    const facts = inventory(manifest);
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'agentsession-v3-four-oracle-'));
    const realScratch = await realpath(scratch);
    const realTemp = await realpath(os.tmpdir());
    assert.equal(path.dirname(realScratch).toLowerCase(), realTemp.toLowerCase());
    const state = Object.fromEntries(['meta', 'index', 'cache', 'empty-dsh'].map(name =>
      [name, path.join(realScratch, name)]));
    for (const directory of Object.values(state)) await mkdir(directory);
    let client, transport, childPid;
    t.after(async () => {
      try {
        if (client) await client.close();
        if (childPid) await waitForExit(childPid);
        for (const [index, source] of files.entries()) {
          const after = sha256(source.snapshotPath);
          assert.equal(after, source.snapshotSha256, 'frozen source hash after MCP process exit');
          t.diagnostic(JSON.stringify({ provider: providers[index],
            sourceSha256Before: beforeHashes.get(providers[index]), sourceSha256After: after }));
        }
      } finally {
        const cleanup = await realpath(realScratch);
        assert.equal(path.dirname(cleanup).toLowerCase(), realTemp.toLowerCase());
        await rm(cleanup, { recursive: true, force: true });
      }
    });
    const args = ['mcp'];
    for (const provider of providers) {
      const root = manifest.providerRoots[provider];
      args.push(root.cliFlag, root.path);
    }
    args.push('--dsh-dir', state['empty-dsh'], '--meta-dir', state.meta,
      '--index-dir', state.index, '--cache-dir', state.cache);
    client = new Client({ name: 'agentsession-v3-four-source-oracle', version: '1.0.0' });
    transport = new StdioClientTransport({ command: packageExecutable, args, cwd: repo, stderr: 'pipe' });
    await client.connect(transport);
    childPid = transport.pid;
    assert.ok(childPid, 'native MCP child PID is available for exit verification');

    for (const provider of providers) {
      const source = facts.get(provider);
      const session = { provider, sessionId: source.sessionId };
      const rows = [], cursors = new Set();
      let cursor = null, pages = 0;
      do {
        const response = await client.callTool({ name: 'session_timeline', arguments: {
          session, limit: 50, ...(cursor ? { cursor } : {}),
        } });
        assert.notEqual(response.isError, true, `${provider} timeline page succeeds`);
        const page = response.structuredContent?.result;
        assert.ok(Array.isArray(page?.events), `${provider} has structured timeline rows`);
        assert.ok(page.events.length <= 50, `${provider} page obeys the requested limit`);
        rows.push(...page.events);
        cursor = page.nextCursor;
        pages++;
        if (cursor) {
          assert.equal(cursors.has(cursor), false, `${provider} continuation advances`);
          cursors.add(cursor);
        }
        assert.ok(pages < 500, `${provider} pagination stays bounded`);
      } while (cursor);
      const result = verifyFourProviderTimeline(source, rows);
      assert.equal(result.ok, true, `${provider} source membership, canonical refs, roles and order: ${result.reason ?? ''}`);
      assert.equal(result.matched, source.required.length);
      if (source.coverage.membership === 'exact') assert.equal(result.total, result.matched,
        `${provider} exact source inventory accounts for every default row`);
      const sourceKeys = new Set(source.required.map(item => eventKey(item.event)));
      const unverifiedRowsByRoleSegment = Object.fromEntries(Object.entries(Object.groupBy(
        rows.filter(row => !sourceKeys.has(eventKey(row.event))),
        row => `${row.role}/${row.event.segment}`)).map(([kind, values]) => [kind, values.length]));
      t.diagnostic(JSON.stringify({ provider, matched: result.matched, total: result.total,
        pages, coverage: result.coverage.membership, sourceOrder: result.coverage.sourceOrder,
        unverifiedRowsByRoleSegment }));
    }
  });
