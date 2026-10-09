#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function rootIds(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT id FROM session_v2
      WHERE time_archived IS NULL AND parent_id IS NULL
      ORDER BY time_updated DESC, time_created DESC, id ASC`).all().map(row => row.id);
  } finally { db.close(); }
}

function pageIds(response) {
  if (response?.isError === true || !Array.isArray(response?.structuredContent?.result?.sessions)) throw new Error('Browse page failed');
  return response.structuredContent.result.sessions.map(row => {
    if (row?.session?.provider !== 'opencode' || typeof row.session.sessionId !== 'string') throw new Error('Browse source reference differs');
    return row.session.sessionId;
  });
}

async function main(args) {
  if (args.length !== 3) throw new Error('Expected frozen manifest, private MCP command config and private output');
  const manifest = JSON.parse(await readFile(args[0], 'utf8'));
  const command = JSON.parse(await readFile(args[1], 'utf8'));
  const source = manifest.database;
  if (source?.provider !== 'opencode' || source.snapshotPath !== manifest.providerRoots?.opencode?.path) throw new Error('OpenCode frozen source is invalid');
  const sourceBytes = await readFile(source.snapshotPath);
  if (sha256(sourceBytes) !== source.snapshotSha256) throw new Error('OpenCode frozen source changed before probe');
  const expected = rootIds(source.snapshotPath);
  if (expected.length < 4) throw new Error('Insufficient source roots for cursor probe');
  const client = new Client({ name: 'agentsession-v3-cursor-probe', version: '1.0.0' },
    command.era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  const transport = new StdioClientTransport({ command: command.command, args: command.args,
    cwd: command.cwd, env: { ...process.env, ...command.env }, stderr: 'inherit' });
  let first, second, changed;
  try {
    await client.connect(transport);
    const base = { level: 'sessions', providers: ['opencode'], parent: null, limit: 2 };
    first = await client.callTool({ name: 'session_browse', arguments: base });
    const cursor = first?.structuredContent?.result?.nextCursor;
    if (typeof cursor !== 'string' || !cursor || first.structuredContent.result.truncated !== true) throw new Error('First cursor is invalid');
    second = await client.callTool({ name: 'session_browse', arguments: { ...base, cursor } });
    if (JSON.stringify([...pageIds(first), ...pageIds(second)]) !== JSON.stringify(expected.slice(0, 4))) throw new Error('Ordered source roots differ');
    changed = await client.callTool({ name: 'session_browse', arguments: { ...base, title: 'agentsession-v3-cursor-filter-change', cursor } });
    if (changed?.isError !== true || changed.structuredContent?.result?.sessions) throw new Error('Changed filter accepted an old cursor');
  } finally { await client.close(); }
  if (sha256(await readFile(source.snapshotPath)) !== source.snapshotSha256) throw new Error('OpenCode frozen source changed after probe');
  const summary = { format: 'agentsession-v3-cursor-boundary/v1', passed: true, sourceSha256: source.snapshotSha256,
    sourceRootCount: expected.length, comparedRows: 4, changedFilterRejected: true,
    responseSha256: [first, second, changed].map(response => sha256(JSON.stringify(response))) };
  await writeFile(args[2], `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  console.log('Cursor boundary passed: four ordered source roots; changed filter rejected; source unchanged.');
}

main(process.argv.slice(2)).catch(() => { console.error('Cursor boundary probe failed; inspect private inputs and source'); process.exitCode = 1; });
