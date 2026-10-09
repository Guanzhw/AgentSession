// Source-only oracle for the frozen Claude, Pi, and DSH tool-name workload.
// The Zstd decoder reads raw frames; no provider parser or search index is used.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { decodeSourceBytes } from './v3-source-ledger.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (name, query) => typeof name === 'string' && query.trim().toLowerCase().split(/\s+/).every(term => name.toLowerCase().includes(term));

function filesAt(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? filesAt(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

function readSource(provider, file) {
  const bytes = readFileSync(file);
  const records = provider === 'deepseek-harness'
    ? decodeSourceBytes(bytes).records.map(record => record.value)
    : bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  return { path: file, bytes: bytes.length, sha256: hash(bytes), recordCount: records.length, records };
}

// Include every source shape that can produce a normalized Claude tool message:
// assistant calls, standalone calls and results, embedded results, and task notifications.
export function claudeToolNames(records) {
  const names = [];
  for (const row of records) {
    if (row.type === 'tool_use') names.push(row.tool_name || row.name || 'unknown');
    if (row.type === 'tool_result') names.push(row.tool_name || 'tool_result');
    const blocks = Array.isArray(row.message?.content ?? row.content) ? row.message?.content ?? row.content : [];
    if (row.type === 'assistant') for (const block of blocks) if (block?.type === 'tool_use') names.push(block.name || 'unknown');
    if (row.type === 'user') {
      for (const block of blocks) if (block?.type === 'tool_result') names.push(block.tool_name || 'tool_result');
      const text = typeof row.message?.content === 'string' ? row.message.content : blocks
        .filter(block => block?.type === 'text').map(block => block.text || '').join('');
      if (text.trim().startsWith('<task-notification>')) names.push('task_notification');
    }
  }
  return names;
}

function activePiRows(records) {
  const header = records.find(row => row.type === 'session');
  if (!header?.id) throw new Error('MissingPiHeader');
  const entries = records.filter(row => row.type !== 'session' && typeof row.id === 'string');
  if (Number(header.version || 1) < 2 || entries.some(row => !('parentId' in row))) return entries;
  const byId = new Map(entries.map(row => [row.id, row])), seen = new Set(), active = [];
  for (let row = entries.at(-1); row; row = row.parentId === null ? undefined : byId.get(row.parentId)) {
    if (seen.has(row.id)) throw new Error('PiBranchCycle');
    seen.add(row.id); active.unshift(row);
  }
  return active;
}

export function piToolNames(records) {
  const names = [];
  for (const row of activePiRows(records)) {
    if (row.type !== 'message') continue;
    const message = row.message || {};
    if (message.role === 'assistant') for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'toolCall') names.push(String(block.name || 'tool'));
    }
    if (message.role === 'toolResult') names.push(String(message.toolName || 'tool'));
    if (message.role === 'bashExecution') names.push('bash');
  }
  return names;
}

function dshOwned(records) {
  const header = records[0];
  if (header?.type !== 'session' || !header.id) throw new Error('MissingDshHeader');
  const seeded = header.version >= 2 || typeof header.isSeeded === 'boolean';
  const cutoff = seeded ? (header.isSeeded
    ? records.findLast(row => row.type === 'session/end-seed' && row.data?.inherited === true)?.seq || 0 : 0)
    : header.seedLength || 0;
  return { header, rows: records.slice(1).filter(row => (row.seq ?? row.seq0 ?? 0) >= cutoff) };
}

export function dshToolHit(records, query = 'read', updatedBefore = Infinity) {
  const { header, rows } = dshOwned(records);
  const title = rows.findLast(row => row.type === 'session/title')?.data?.title?.trim()
    || rows.findLast(row => row.type === 'subagent/descriptor')?.data?.label?.trim();
  const updatedAt = Math.max(header.createdAt || 0, ...rows.map(row => row.time
    ?? (row.time0 + (row.data?.dt || []).reduce((sum, delta) => sum + delta, 0))).filter(Number.isFinite));
  const observations = [];
  // The durable assistant message introduces the visible call. A following
  // tool/call record repeats it and may supply a name for call-only records.
  const calls = new Map();
  for (const row of rows) {
    if (row.type === 'assistant/message' && row.surfaceOp !== 'replace') {
      const content = Array.isArray(row.data?.message?.content) ? row.data.message.content : [];
      for (const [index, block] of content.entries()) if (block?.type === 'tool-call' && typeof block.id === 'string') {
        const name = String(block.name || 'tool');
        if (!calls.has(block.id)) calls.set(block.id, { id: block.id, name, seq: row.seq, contentIndex: index });
        observations.push({ id: block.id, name, seq: row.seq, origin: 'assistant/message' });
      }
    }
    if (row.type === 'tool/call') {
      const id = typeof row.data?.callId === 'string' ? row.data.callId : '';
      const name = typeof row.data?.name === 'string' ? row.data.name : 'tool';
      if (calls.has(id)) {
        const call = calls.get(id);
        if (name && name !== 'tool') call.name = name;
      } else calls.set(id, { id: id || `tool-call:${row.seq}`, name, seq: row.seq });
      observations.push({ id, name, seq: row.seq, origin: 'tool/call' });
    }
  }
  const first = [...calls.values()].find(call => matches(call.name, query));
  const metadata = { provider: 'deepseek-harness', sessionId: header.id, title, directory: header.cwd || null, updatedAt };
  const hit = first && updatedAt <= updatedBefore ? {
    session: { provider: metadata.provider, sessionId: metadata.sessionId },
    event: { provider: metadata.provider, sessionId: metadata.sessionId, messageId: first.id, segment: 'tool' },
    matchField: 'toolName', matchRole: 'tool', snippet: first.name,
    title: title || header.id, directory: metadata.directory, updatedAt, untrustedContent: true
  } : null;
  return { metadata, hit, first, observations };
}

export function deriveSmallProviderToolNameHits(providerRoots, query = 'read', updatedBefore = Infinity) {
  const sources = [], evidence = [], hits = [], dsh = new Map();
  for (const provider of ['claude-code', 'pi', 'deepseek-harness']) {
    for (const file of filesAt(providerRoots[provider].path)) {
      const source = readSource(provider, file);
      sources.push({ provider, path: file, bytes: source.bytes, sha256: source.sha256, recordCount: source.recordCount });
      if (provider === 'claude-code' || provider === 'pi') {
        const names = provider === 'claude-code' ? claudeToolNames(source.records) : piToolNames(source.records);
        const matching = names.filter(name => matches(name, query));
        // This frozen oracle's Claude/Pi corpus is an absence proof. A new
        // positive source requires a first-hit projection, not a silent skip.
        if (matching.length) throw new Error(`Positive${provider}ToolProjectionUnsupported`);
        evidence.push({ provider, path: file, toolNames: names, matchingCount: 0 });
      } else {
        const result = dshToolHit(source.records, query, updatedBefore);
        const previous = dsh.get(result.metadata.sessionId);
        if (previous?.generation === source.records[0].version) throw new Error('AmbiguousDshGeneration');
        if (!previous || source.records[0].version > previous.generation) dsh.set(result.metadata.sessionId,
          { ...result, generation: source.records[0].version, path: file });
      }
    }
  }
  for (const selected of dsh.values()) {
    if (selected.hit) hits.push(selected.hit);
    evidence.push({ provider: 'deepseek-harness', path: selected.path, selectedGeneration: selected.generation,
      sessionId: selected.metadata.sessionId, firstMatch: selected.first,
      matchingCallCount: selected.observations.filter(row => matches(row.name, query)).length });
  }
  hits.sort((a, b) => b.updatedAt - a.updatedAt || a.session.provider.localeCompare(b.session.provider)
    || a.session.sessionId.localeCompare(b.session.sessionId));
  return { hits, sources, evidence };
}
