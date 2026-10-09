#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { eventSourceExpectation } from './v3-verify-event-continuation.mjs';
import { verifyBodyContinuation } from './v3-source-ledger.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function run(binary, manifestPath, capturePath, era, provider) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const roles = { codex: 'long-team-compaction', 'deepseek-harness': 'native-v3-packed-compaction' };
  const role = roles[provider];
  if (!role) throw new Error('Unsupported frozen continuation provider');
  const frozen = manifest.files.find(item => item.provider === provider && item.role === role);
  if (!frozen) throw new Error('Frozen provider source entry is missing');
  const sourceBytes = await readFile(frozen.snapshotPath);
  if (sha256(sourceBytes) !== frozen.snapshotSha256) throw new Error('Frozen provider source hash differs');
  const capture = JSON.parse(await readFile(capturePath, 'utf8'));
  const sourceCase = capture.output.find(item => item.provider === provider);
  if (!sourceCase?.expected?.line) throw new Error('Provider continuation case is missing');
  const expected = eventSourceExpectation(provider, sourceBytes, sourceCase.expected.line);
  if (!isDeepStrictEqual(expected, sourceCase.expected)) throw new Error('Frozen source expectation differs');

  const state = await mkdtemp(path.join(repo, 'tmp', 'v3-real-continuation-'));
  let client;
  try {
    for (const name of ['meta', 'index', 'cache']) await mkdir(path.join(state, name));
    const args = [
      'mcp', '--codex-dir', manifest.providerRoots.codex.path,
      '--opencode-db', manifest.providerRoots.opencode.path,
      '--claude-dir', manifest.providerRoots['claude-code'].path,
      '--pi-dir', manifest.providerRoots.pi.path,
      '--dsh-dir', manifest.providerRoots['deepseek-harness'].path,
      '--meta-dir', path.join(state, 'meta'),
      '--index-dir', path.join(state, 'index'),
      '--cache-dir', path.join(state, 'cache'),
    ];
    client = new Client({ name: 'agentsession-v3-real-continuation-check', version: '1.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
    await client.connect(new StdioClientTransport({ command: binary, args, cwd: repo, stderr: 'pipe' }));
    let request = { event: expected.event, maxChars: 256 };
    let offset = 0;
    const chunks = [];
    for (let page = 0; page < 100; page += 1) {
      const result = await client.callTool({ name: 'session_get_event', arguments: request });
      if (result.isError || !result.structuredContent?.result) throw new Error('MCP returned an error');
      const body = result.structuredContent.result;
      if (!isDeepStrictEqual(body.event, expected.event) || body.role !== 'assistant') throw new Error('Canonical event owner differs');
      const content = body.content;
      if (content?.offset !== offset || content.totalChars !== expected.fact.codeUnits ||
          typeof content.text !== 'string' || !content.text.length) throw new Error('Page offset or size differs');
      chunks.push(content.text);
      offset += content.text.length;
      if (body.continuation === null) {
        if (content.nextOffset !== null || content.truncated !== false) throw new Error('Final page is incomplete');
        break;
      }
      if (content.nextOffset !== offset || content.truncated !== true ||
          !isDeepStrictEqual(body.continuation.event, expected.event) ||
          body.continuation.offset !== offset) throw new Error('Continuation binding differs');
      request = body.continuation;
      if (page === 99) throw new Error('Continuation exceeded the page bound');
    }
    if (!verifyBodyContinuation(expected.fact, chunks)) throw new Error('Complete body differs from source');
    if (sha256(await readFile(frozen.snapshotPath)) !== frozen.snapshotSha256) throw new Error('Provider source changed');
    return { era, pages: chunks.length, codeUnits: offset, sha256: sha256(chunks.join('')) };
  } finally {
    if (client) await client.close();
    await rm(state, { recursive: true, force: true });
  }
}

const [binary, manifest, capture, requestedProvider = 'codex'] = process.argv.slice(2);
if (!binary || !manifest || !capture) {
  console.error('Usage: node scripts/v3-verify-rust-codex-slice.mjs <binary> <frozen-manifest> <source-continuation-capture> [codex|deepseek-harness]');
  process.exitCode = 2;
} else {
  try {
    const summaries = [];
    for (const era of ['legacy', 'modern']) summaries.push(await run(binary, manifest, capture, era, requestedProvider));
    console.log(JSON.stringify({ passed: true, provider: requestedProvider, summaries }));
  } catch (error) {
    console.error(`3.0 frozen ${requestedProvider} continuation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
