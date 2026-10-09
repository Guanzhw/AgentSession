#!/usr/bin/env node
// Independent partial source oracle. No production parser, search implementation,
// index, or captured result participates in deriving the expected facts.
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { decodeSourceBytes } from './v3-source-ledger.mjs';
import { deriveOpenCodeToolMatches } from './v3-tool-name-opencode-oracle.mjs';
import { deriveSmallProviderToolNameHits } from './v3-tool-name-small-oracle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const termsOf = query => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
const hit = (text, terms) => typeof text === 'string' && terms.every(term => text.toLowerCase().includes(term));
const textBlocks = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text').map(block => block.text || '').join('');
const stamp = value => typeof value === 'number' ? value : Date.parse(value) || 0;
const flatTitle = text => String(text).replace(/\s+/g, ' ').trim().slice(0, 120);
const inside = (base, target) => { const relative = path.relative(base, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };

export async function scanJsonl(file, visit, maxLineBytes = 32 * 1024 * 1024) {
  const sha = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', line = 0, bytes = 0, records = 0;
  function consume(raw) {
    line++;
    if (!raw.trim()) return;
    if (Buffer.byteLength(raw) > maxLineBytes) throw new Error('SourceLineLimit');
    const row = JSON.parse(raw);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('InvalidSourceRecord');
    visit(row, line); records++;
  }
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    sha.update(chunk); bytes += chunk.length; pending += decoder.decode(chunk, { stream: true });
    let start = 0, end;
    while ((end = pending.indexOf('\n', start)) >= 0) { consume(pending.slice(start, end)); start = end + 1; }
    pending = pending.slice(start);
    if (Buffer.byteLength(pending) > maxLineBytes) throw new Error('SourceLineLimit');
  }
  pending += decoder.decode();
  if (pending) consume(pending);
  return { bytes, records, sha256: sha.digest('hex') };
}

function codexText(payload) {
  const content = payload?.content ?? payload?.message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(item => item?.content || [item])
    .filter(item => ['text', 'input_text', 'output_text', 'summary_text'].includes(item?.type))
    .map(item => item.text || '').join('');
}

// This is a SUPERSET, not an owned-message projection. Removing inherited or
// duplicate records cannot turn a proved absence into a hit. Include both raw
// and synthesized task text, plus joined response blocks (including cross-block
// terms). A positive observation is deliberately inconclusive.
export function codexBodySuperset(record) {
  const p = record.payload;
  if (!p) return [];
  if (record.type === 'event_msg' && ['user_message', 'agent_message'].includes(p.type)) return [String(p.message || '')];
  if (record.type !== 'response_item') return [];
  if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) return [codexText(p)];
  if (p.type === 'agent_message') {
    const text = codexText(p).replace(/\s+/g, ' ').trim();
    const task = text.match(/(?:^|\s)Task name:\s*([^\s]+)/i)?.[1];
    return [text, `${task ? `Subagent task: ${task}` : 'Subagent task'}\n\nThe task body is encrypted in the Codex transcript and cannot be recovered locally.`];
  }
  return [];
}

// Keep only search-relevant evidence while streaming. Tool arguments/results
// never affect body membership, but calls and reasoning consume fallback IDs.
function searchRecord(row, line, spawnCalls) {
  const p = row.payload || {}, kind = row.type === 'response_item' ? p.type : `${row.type}/${p.type || ''}`;
  if (['function_call', 'custom_tool_call'].includes(kind) && p.name === 'spawn_agent'
    && p.namespace === 'collaboration' && typeof p.call_id === 'string') spawnCalls.add(p.call_id);
  if (['function_call_output', 'custom_tool_call_output'].includes(kind) && !spawnCalls.has(p.call_id)) return null;
  if (!['message', 'agent_message', 'reasoning', 'function_call', 'custom_tool_call',
    'function_call_output', 'custom_tool_call_output',
    'event_msg/user_message', 'event_msg/agent_message', 'event_msg/agent_reasoning'].includes(kind)) return null;
  return { kind, line, timestamp: stamp(row.timestamp), id: p.id, callId: p.call_id, role: p.role,
    tagged: p.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes('user.text') || false,
    text: kind === 'reasoning' ? codexText({ content: p.summary || p.content || [] })
      : kind === 'event_msg/agent_reasoning' ? String(p.text || '')
      : kind.startsWith('event_msg/') ? String(p.message || '') : codexText(p),
    name: p.name, namespace: p.namespace,
    arguments: p.name === 'spawn_agent' && p.namespace === 'collaboration' ? p.arguments : undefined,
    author: p.author, recipient: p.recipient,
    output: ['function_call_output', 'custom_tool_call_output'].includes(kind) ? p.output : undefined,
    encrypted: Array.isArray(p.content) && p.content.some(item => item?.type === 'encrypted_content'
      || Array.isArray(item?.content) && item.content.some(child => child?.type === 'encrypted_content')) };
}

const taskEnvelope = row => row.kind === 'agent_message' && /^Message Type:\s*NEW_TASK\b/i.test(flatWhitespace(row.text));
const flatWhitespace = text => text.replace(/\s+/g, ' ').trim();
const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };
const finalAnswerBody = (text, author) => {
  const lines = text.split('\n');
  const body = lines.slice(4).join('\n');
  return lines.length >= 5 && lines[0].replace(/\r$/, '') === 'Message Type: FINAL_ANSWER'
    && lines[1].replace(/\r$/, '').startsWith('Task name: ') && lines[1].replace(/\r$/, '').length > 11
    && lines[2].replace(/\r$/, '') === `Sender: ${author}`
    && lines[3].replace(/\r$/, '') === 'Payload:' && body ? body : null;
};
const firstSearchDocument = (documents, query) => documents.find(d =>
  query.fields.includes(d.role === 'tool' ? 'toolName' : d.role === 'agent' ? 'assistant' : d.role)
  && d.text && hit(d.text, termsOf(query.query)));

// A separately implemented finite source interpreter. Unsupported ownership is
// explicit and query-independent; candidate rows cannot enlarge its coverage.
export function deriveCodexDocuments(rows, header, headerTime, copiedParentHeader = true) {
  const parent = header.parent_thread_id || header.forked_from_id || header.source?.subagent?.thread_spawn?.parent_thread_id;
  const boundary = rows.findIndex(taskEnvelope);
  // The frozen v2 body-prefix contract requires an immediately copied parent
  // header. Without it, parent token replay can affect usage but not messages.
  if (parent && boundary < 0 && copiedParentHeader) return { complete: false, reason: 'parent-prefix-without-task-envelope', documents: [] };
  const owned = parent && boundary >= 0 ? rows.slice(boundary) : rows;
  const tagged = new Set(owned.filter(r => r.kind === 'message' && r.role === 'user' && r.tagged && r.text).map(r => flatWhitespace(r.text)));
  const documents = [], taskKeys = new Set(), spawnCalls = new Map(), acknowledged = new Map();
  let next = 0, previous = null, group = 0;
  const emit = (r, role, text, prefix, explicit, source, thinking = '', evidence = null) => {
    const entry = { id: explicit || `${prefix}-${next++}`, role, text, source, thinking, group, line: r.line, evidence };
    documents.push(entry); previous = entry;
  };
  for (const r of owned) {
    if ((header.parent_thread_id || header.forked_from_id) && headerTime && r.timestamp && r.timestamp < headerTime) continue;
    if (r.kind === 'event_msg/user_message' && !tagged.has(flatWhitespace(r.text))) {
      group++; emit(r, 'user', r.text, 'msg', null, 'legacy-user');
    } else if (r.kind === 'message' && r.role === 'user' && r.tagged && r.text) {
      let text = r.text;
      const envelope = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
      if (envelope) {
        let answers; try { answers = JSON.parse(envelope[1]); } catch {}
        if (Array.isArray(answers) && answers.length && answers.every(a => a && typeof a.questionItemId === 'string' && typeof a.question === 'string' && typeof a.answer === 'string')) {
          text = answers.flatMap(a => [a.question, a.answer]).join('\n\n');
        }
      }
      group++; emit(r, 'user', text, 'msg', r.id, 'tagged-user');
    } else if (taskEnvelope(r)) {
      const flat = flatWhitespace(r.text), name = flat.match(/(?:^|\s)Task name:\s*([^\s]+)/i)?.[1];
      const text = r.encrypted ? `${name ? `Subagent task: ${name}` : 'Subagent task'}\n\nThe task body is encrypted in the Codex transcript and cannot be recovered locally.` : flat;
      const key = `${name || ''}\0${text}`;
      group++;
      if (!taskKeys.has(key)) { taskKeys.add(key); emit(r, 'user', text, 'subagent-task', r.id, 'task'); }
    } else if (r.kind === 'agent_message') {
      const actor = r.author, recipient = r.recipient;
      const recipientMatches = header.agent_path ? recipient === header.agent_path
        : typeof actor === 'string' && actor.slice(0, actor.lastIndexOf('/')) === recipient;
      const body = typeof actor === 'string' && typeof recipient === 'string' && actor !== recipient
        && recipientMatches && acknowledged.has(actor) ? finalAnswerBody(r.text, actor) : null;
      if (body) {
        const ack = acknowledged.get(actor);
        emit(r, 'agent', body, 'agent-result', r.id, 'agent', '', {
          author: actor, recipient, spawnCallId: ack.callId, spawnLine: ack.spawnLine,
          spawnTaskName: ack.spawnTaskName, acknowledgementLine: ack.line,
          answerTaskName: r.text.split('\n')[1].replace(/\r$/, '').slice('Task name: '.length),
          answerLine: r.line, answerBodySha256: digest(body)
        });
      }
    } else if (r.kind === 'event_msg/agent_message' || r.kind === 'message' && r.role === 'assistant') {
      if (!r.text || previous?.source === 'legacy-assistant' && previous.text === r.text) continue;
      const legacy = r.kind === 'event_msg/agent_message';
      emit(r, 'assistant', r.text, legacy ? 'agent-message' : 'msg', legacy ? null : r.id, legacy ? 'legacy-assistant' : 'assistant');
    } else if (['reasoning', 'event_msg/agent_reasoning'].includes(r.kind) && r.text) {
      const legacy = r.kind === 'event_msg/agent_reasoning';
      const progressive = previous?.role === 'assistant' && (legacy ? previous.source === 'legacy-reasoning'
        : !previous.text && previous.group === group && previous.thinking)
        && (r.text.startsWith(previous.thinking) || previous.thinking.startsWith(r.text));
      if (progressive) { if (r.text.length > previous.thinking.length) previous.thinking = r.text; }
      else emit(r, 'assistant', '', legacy ? 'agent-reasoning' : 'reasoning', legacy ? null : r.id, legacy ? 'legacy-reasoning' : 'reasoning', r.text);
    } else if (['function_call', 'custom_tool_call'].includes(r.kind)) {
      if (r.name === 'spawn_agent' && r.namespace === 'collaboration' && typeof r.callId === 'string') {
        const args = typeof r.arguments === 'string' ? parseJson(r.arguments) : null;
        spawnCalls.set(r.callId, { line: r.line, taskName: typeof args?.task_name === 'string' ? args.task_name : null });
      }
      emit(r, 'tool', String(r.name || 'unknown').trim() || 'tool', 'tool', r.callId, 'tool');
    } else if (['function_call_output', 'custom_tool_call_output'].includes(r.kind) && spawnCalls.has(r.callId)) {
      const output = typeof r.output === 'string' ? parseJson(r.output) : null;
      const actor = typeof output?.task_name === 'string' ? output.task_name.trim() : '';
      if (actor.startsWith('/') && actor !== '/') {
        const spawn = spawnCalls.get(r.callId);
        acknowledged.set(actor, { callId: r.callId, spawnLine: spawn.line, spawnTaskName: spawn.taskName, line: r.line });
      }
    }
  }
  return { complete: true, documents };
}

// Frozen service excerpt contract: exact phrase, 40 UTF-16 units before and
// 80 after. Separated multi-term window allocation remains an explicit gap.
export function deriveExactSnippet(text, query) {
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - 40), end = Math.min(text.length, at + query.length + 80);
  const excerpt = `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  return excerpt.length <= 160 ? excerpt : null;
}

// The source oracle derives bounded context from the selected source document.
// Distant AND terms retain separate windows, so a hit cannot disappear from
// the excerpt simply because another term occurs much earlier in the text.
export function deriveSourceSnippet(text, query) {
  if (!text) return '';
  if (!query) return text.slice(0, 160);
  const exact = deriveExactSnippet(text, query);
  const terms = [...new Set(termsOf(query))];
  if (exact !== null && terms.length <= 1) return exact;
  const lower = text.toLocaleLowerCase();
  const phraseAt = lower.indexOf(query.toLocaleLowerCase());
  if (terms.length > 1) {
    if (exact !== null) return exact;
    const positions = terms.map(term => lower.indexOf(term, Math.max(0, phraseAt)));
    if (positions.every(at => at >= 0)) {
      const merge = input => {
        const sorted = input.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
        const merged = [];
        for (const [start, end] of sorted) {
          const last = merged.at(-1);
          if (last && start <= last[1]) last[1] = Math.max(last[1], end);
          else merged.push([start, end]);
        }
        return merged;
      };
      const spans = merge(positions.map((at, i) => [at, at + terms[i].length]));
      const first = spans[0][0], last = spans.at(-1)[1];
      const available = 160 - Number(first > 0) - Number(last < text.length);
      if (last - first <= available) {
        const budget = available - (last - first);
        let before = Math.min(first, 40, Math.floor(budget / 3));
        let after = Math.min(text.length - last, 80, budget - before);
        let remaining = budget - before - after;
        const moreBefore = Math.min(first - before, remaining);
        before += moreBefore; remaining -= moreBefore;
        after += Math.min(text.length - last - after, remaining);
        const start = first - before, end = last + after;
        return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
      }
      const render = ranges => `${ranges[0][0] ? '…' : ''}${ranges.map(([start, end]) => text.slice(start, end)).join('…')}${ranges.at(-1)[1] < text.length ? '…' : ''}`;
      for (let radius = 20; radius >= 0; radius--) {
        const windows = merge(spans.map(([start, end]) => [Math.max(0, start - radius), Math.min(text.length, end + radius)]));
        const excerpt = render(windows);
        if (excerpt.length <= 160) return excerpt;
      }
      let remaining = 159, excerpt = '';
      for (const [start, end] of spans) {
        const separator = excerpt || start > 0 ? '…' : '';
        if (separator.length > remaining) break;
        excerpt += separator; remaining -= separator.length;
        const visible = Math.min(end - start, remaining);
        excerpt += text.slice(start, start + visible); remaining -= visible;
        if (visible < end - start || remaining === 0) break;
      }
      return `${excerpt}…`;
    }
  }
  const first = terms[0] || query.toLocaleLowerCase();
  const at = phraseAt >= 0 ? phraseAt : lower.indexOf(first);
  if (at < 0) return text.slice(0, 160);
  const start = Math.max(0, at - 40);
  const length = phraseAt >= 0 ? query.length : first.length;
  const end = Math.min(text.length, at + length + 80);
  const prefix = start ? '…' : '', suffix = end < text.length ? '…' : '';
  const excerpt = `${prefix}${text.slice(start, end)}${suffix}`;
  return excerpt.length <= 160 ? excerpt : `${prefix}${text.slice(start, start + 160 - prefix.length - 1)}…`;
}

export function deriveDocumentMatches(metadata, documents, queries) {
  return Object.fromEntries(queries.map(q => {
    const first = firstSearchDocument(documents, q);
    if (!first) return [q.label, null];
    const session = { provider: 'codex', sessionId: metadata.sessionId }, tool = first.role === 'tool';
    return [q.label, { session, event: { ...session, messageId: first.id, segment: tool ? 'tool' : 'message' },
      matchField: tool ? 'toolName' : 'message', matchRole: first.role, snippet: deriveSourceSnippet(first.text, q.query),
      title: metadata.title?.trim() ? metadata.title : metadata.sessionId, directory: metadata.directory, updatedAt: metadata.updatedAt, untrustedContent: true }];
  }));
}

export async function scanCodexFile(file, queries) {
  let header, headerTime = 0, title = null, updatedAt = 0, nextAfterHeader;
  const searchRows = [], spawnCalls = new Set();
  const rawHits = Object.fromEntries(queries.map(q => [q.label, 0]));
  const compiled = queries.map(q => ({ ...q, terms: termsOf(q.query) }));
  const source = await scanJsonl(file, (row, line) => {
    updatedAt = Math.max(updatedAt, stamp(row.timestamp));
    if (header && nextAfterHeader === undefined) nextAfterHeader = row.type === 'session_meta' ? [row.payload?.id, row.payload?.session_id] : [];
    if (row.type === 'session_meta' && !header) { header = row.payload; headerTime = stamp(row.timestamp); }
    const search = searchRecord(row, line, spawnCalls); if (search) searchRows.push(search);
    if (!title && row.type === 'event_msg' && row.payload?.type === 'user_message' && row.payload.message) title = flatTitle(row.payload.message);
    if (!title && row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user'
      && row.payload.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes('user.text')) {
      const text = codexText(row.payload); if (text) title = flatTitle(text);
    }
    const texts = codexBodySuperset(row);
    for (const q of compiled) if (texts.some(text => hit(text, q.terms))) rawHits[q.label]++;
  });
  if (!header || !(header.id || header.session_id)) throw new Error('MissingCanonicalCodexHeader');
  const spawn = header.source?.subagent?.thread_spawn || {};
  const sessionId = header.id || header.session_id;
  const parent = header.parent_thread_id || header.forked_from_id || spawn.parent_thread_id
    || (header.thread_source === 'subagent' && header.session_id !== sessionId ? header.session_id : null);
  if (parent) title = header.agent_path || spawn.agent_path || header.agent_nickname || spawn.agent_nickname || title;
  const metadata = { provider: 'codex', sessionId, title, directory: header.cwd || header.workdir || null, updatedAt };
  const bodyParent = header.parent_thread_id || header.forked_from_id || spawn.parent_thread_id;
  const copiedParentHeader = Boolean(bodyParent && nextAfterHeader?.includes(bodyParent));
  const projection = deriveCodexDocuments(searchRows, header, headerTime, copiedParentHeader);
  return { metadata, source, rawHits, projection: { complete: projection.complete, reason: projection.reason,
    matches: projection.complete ? deriveDocumentMatches(metadata, projection.documents, queries) : {},
    agentEvidence: projection.complete ? Object.fromEntries(queries.map(query => {
      const first = firstSearchDocument(projection.documents, query);
      return [query.label, first?.role === 'agent' ? {
        ...first.evidence, messageId: first.id, firstMatchingDocumentOrdinal: projection.documents.indexOf(first)
      } : null];
    })) : {} } };
}

function filesAt(directory, discoveryOrder = false) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('LinkedSource');
  if (statSync(directory).isFile()) return [directory];
  const entries = readdirSync(directory, { withFileTypes: true });
  if (!discoveryOrder) entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return entries.flatMap(entry => filesAt(path.join(directory, entry.name), discoveryOrder));
}

// The frozen v2 workload resolves canonical collisions by the last file in
// native recursive discovery order (Map replacement), not by timestamp or
// filename suffix. Preserve that order explicitly. A source header establishes
// identity; it does not establish which segment is a complete conversation.
// Retain the first-sorted-path alternative that exposed the v3 discrepancy,
// without treating either production implementation's output as the oracle.
export function selectCodexMetadata(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const id = candidate.metadata.sessionId;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(candidate);
  }
  const metadata = [], duplicateMetadata = [];
  for (const [sessionId, entries] of groups) {
    const selected = entries.at(-1);
    metadata.push(selected.metadata);
    if (entries.length < 2) continue;
    const identical = entries.every(entry => isDeepStrictEqual(entry.metadata, selected.metadata));
    const firstSorted = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)[0];
    duplicateMetadata.push({ provider: 'codex', sessionId, identical,
      resolution: 'frozen-v2-last-discovered', selectedPath: selected.path,
      firstSortedPath: firstSorted.path, differsFromFirstSorted: selected.path !== firstSorted.path,
      candidates: entries.map(({ path, metadata, source }) => ({ path, metadata, source })) });
  }
  return { metadata, duplicateMetadata };
}

function sourceStats(providerRoots) {
  return Object.fromEntries(Object.entries(providerRoots).map(([provider, item]) => {
    const base = provider === 'codex' ? path.join(item.path, 'sessions') : item.path;
    const statHash = createHash('sha256'), contentHash = provider === 'codex' ? null : createHash('sha256');
    let totalBytes = 0, fileCount = 0;
    let files = filesAt(base);
    if (statSync(base).isFile()) files = [base, `${base}-wal`, `${base}-shm`].filter(existsSync);
    else if (provider === 'codex') files = files.filter(file => /\.jsonl(?:\.zst)?$/i.test(file));
    for (const file of files) {
      const s = statSync(file), relative = statSync(base).isFile() ? path.basename(file) : path.relative(base, file).replaceAll('\\', '/');
      statHash.update(JSON.stringify([relative, s.size, s.mtimeMs]));
      if (contentHash) contentHash.update(relative).update('\0').update(digest(readFileSync(file))).update('\0');
      totalBytes += s.size; fileCount++;
    }
    return [provider, { fileCount, totalBytes, statManifestSha256: statHash.digest('hex'), ...(contentHash ? { contentManifestSha256: contentHash.digest('hex') } : {}) }];
  }));
}

async function smallMetadata(provider, file) {
  const records = [];
  await scanJsonl(file, row => records.push(row));
  if (provider === 'claude-code') {
    const side = records.find(r => r.isSidechain);
    const custom = records.findLast(r => ['custom-title', 'custom_title'].includes(r.type) && r.customTitle);
    const summary = records.findLast(r => r.type === 'summary' && r.summary);
    const user = records.find(r => r.type === 'user' && !textBlocks(r.message?.content ?? r.content).trim().startsWith('<task-notification>'));
    let directory = null;
    for (const r of records) if (r.cwd && (r.type === 'system' || !directory)) directory = r.cwd;
    return { provider, sessionId: side?.agentId || path.basename(file, '.jsonl').replace(/^agent-/, ''),
      title: side?.agentId || (custom ? String(custom.customTitle).slice(0, 160) : summary ? String(summary.summary).slice(0, 160)
        : textBlocks(user?.message?.content ?? user?.content).trim().slice(0, 120) || null), directory,
      updatedAt: Math.max(0, ...records.map(r => stamp(r.timestamp))) };
  }
  const header = records.find(r => r.type === 'session');
  if (!header?.id) throw new Error('MissingPiHeader');
  const entries = records.filter(r => r.type !== 'session' && typeof r.id === 'string');
  let active = entries;
  if (Number(header.version || 1) >= 2 && entries.every(r => 'parentId' in r)) {
    const byId = new Map(entries.map(r => [r.id, r])); const seen = new Set(); active = [];
    for (let r = entries.at(-1); r; r = r.parentId === null ? undefined : byId.get(r.parentId)) {
      if (seen.has(r.id)) throw new Error('PiBranchCycle'); seen.add(r.id); active.unshift(r);
    }
  }
  const first = active.find(r => r.type === 'message' && r.message?.role === 'user' && textBlocks(r.message.content).trim());
  return { provider, sessionId: header.id, title: records.findLast(r => r.type === 'session_info')?.name?.trim() || (first ? flatTitle(textBlocks(first.message.content)) : null),
    directory: header.cwd || null, updatedAt: Math.max(0, ...records.map(r => stamp(r.message?.timestamp) || stamp(r.timestamp))) };
}

function dshMetadata(file) {
  const rows = decodeSourceBytes(readFileSync(file)).records.map(r => r.value), header = rows[0];
  if (header?.type !== 'session' || !header.id) throw new Error('MissingDshHeader');
  const seeded = header.version >= 2 || typeof header.isSeeded === 'boolean';
  const cutoff = seeded ? (header.isSeeded ? rows.findLast(r => r.type === 'session/end-seed' && r.data?.inherited === true)?.seq || 0 : 0) : header.seedLength || 0;
  const owned = rows.slice(1).filter(r => (r.seq ?? r.seq0 ?? 0) >= cutoff);
  const title = owned.findLast(r => r.type === 'session/title')?.data?.title?.trim()
    || owned.findLast(r => r.type === 'subagent/descriptor')?.data?.label?.trim();
  // Do not silently approximate the provider's fallback visible-user selection.
  if (!title) throw new Error('DshFallbackTitleUnsupported');
  const times = owned.map(r => r.time ?? (r.time0 + (r.data?.dt || []).reduce((a, b) => a + b, 0)));
  return { generation: header.version, metadata: { provider: 'deepseek-harness', sessionId: header.id, title, directory: header.cwd || null,
    updatedAt: Math.max(header.createdAt || 0, ...times.filter(Number.isFinite)) } };
}

export function deriveMetadataMatches(metadata, query, updatedBefore) {
  const terms = termsOf(query.query);
  const matches = [];
  for (const row of metadata) {
    if (!query.providers.includes(row.provider) || row.updatedAt > updatedBefore) continue;
    const field = ['title', 'directory'].find(field => query.fields.includes(field) && hit(row[field], terms));
    if (!field) continue;
    matches.push({ session: { provider: row.provider, sessionId: row.sessionId }, event: null, matchField: field, matchRole: null,
      snippet: row[field].length > 240 ? `${row[field].slice(0, 240)}…` : row[field],
      title: row.title?.trim() || row.sessionId, directory: row.directory,
      updatedAt: row.updatedAt, untrustedContent: true });
  }
  const rank = { title: 0, directory: 1 };
  return matches.sort((a, b) => rank[a.matchField] - rank[b.matchField] || b.updatedAt - a.updatedAt
    || a.session.provider.localeCompare(b.session.provider) || a.session.sessionId.localeCompare(b.session.sessionId));
}

export function compareMetadata(expected, actual) {
  const withoutSnippet = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'snippet'));
  const orderedFieldsPassed = isDeepStrictEqual(expected.map(withoutSnippet), actual.map(withoutSnippet));
  const shortSnippetCount = expected.filter(row => row.snippet !== null).length;
  const shortSnippetsPassed = orderedFieldsPassed && expected.every((row, i) => row.snippet === null || row.snippet === actual[i].snippet);
  return { passed: orderedFieldsPassed && shortSnippetsPassed && shortSnippetCount === expected.length,
    orderedFieldsPassed, shortSnippetsPassed, expectedCount: expected.length, actualCount: actual.length,
    verifiedSnippetCount: shortSnippetsPassed ? shortSnippetCount : 0, remainingLongSnippetCount: expected.length - shortSnippetCount };
}

export function acceptedSearchGolden(report) {
  if (report.verification?.status !== 'source-verified' || report.queries?.length !== 9
    || report.queries.some(query => query.status !== 'source-verified'
      || !Number.isInteger(query.count) || query.count < 0
      || !/^[0-9a-f]{64}$/.test(query.orderedSemanticSha256 || '')
      || !/^[0-9a-f]{64}$/.test(query.firstPageSemanticSha256 || ''))) {
    throw new Error('SourceVerificationIncomplete');
  }
  const persistedReport = JSON.parse(JSON.stringify(report));
  return { format: 'agentsession-v3-search-golden/v1',
    verification: { status: 'source-verified', sourceReportSha256: digest(canonical(persistedReport)) },
    providerStats: persistedReport.providerStats,
    queries: persistedReport.queries.map(({ label, querySha256, count, orderedSemanticSha256, firstPageSemanticSha256 }) =>
      ({ label, querySha256, count, orderedSemanticSha256, firstPageSemanticSha256 })) };
}

export function compareDocumentProjection(sources, query, updatedBefore, actual) {
  const covered = sources.filter(s => s.projection.complete && s.metadata.updatedAt <= updatedBefore);
  const unresolvedIds = new Set(sources.filter(s => !s.projection.complete && s.metadata.updatedAt <= updatedBefore).map(s => s.metadata.sessionId));
  const expected = covered.map(s => s.projection.matches[query.label]).filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.session.sessionId.localeCompare(b.session.sessionId));
  // Exclude only explicitly unresolved source IDs. Invented IDs or results
  // beyond the timestamp cutoff must remain visible as unexpected membership.
  const codexOnly = query.providers.every(p => p === 'codex');
  const observed = actual.filter(r => r.session.provider === 'codex' ? !unresolvedIds.has(r.session.sessionId) : codexOnly);
  const comparison = compareMetadata(expected, observed);
  const byId = new Map(observed.map(r => [r.session.sessionId, r]));
  const expectedIds = new Set(expected.map(r => r.session.sessionId));
  const mismatches = expected.flatMap(row => {
    const candidate = byId.get(row.session.sessionId);
    const fields = Object.keys(row).filter(key => !(key === 'snippet' && row.snippet === null) && !isDeepStrictEqual(row[key], candidate?.[key]));
    return fields.length ? [{ sessionId: row.session.sessionId, fields, expected: row, actual: candidate || null }] : [];
  });
  for (const row of observed) if (!expectedIds.has(row.session.sessionId)) mismatches.push({ sessionId: row.session.sessionId, fields: ['unexpected-membership'], actual: row });
  const unresolved = sources.filter(s => !s.projection.complete && s.metadata.updatedAt <= updatedBefore)
    .map(s => ({ sessionId: s.metadata.sessionId, path: s.path, reason: s.projection.reason }));
  const remainingProviders = query.providers.filter(p => p !== 'codex');
  return { ...comparison, passed: comparison.passed && !unresolved.length && !remainingProviders.length,
    coveredSessions: covered.length, unresolvedSessions: unresolved.length, remainingProviders,
    mismatchedSessions: mismatches.length, expected, unresolved, mismatches };
}

export async function verifySources(manifest, progress = () => {}) {
  const metadata = [], codexSources = [], codexCandidates = [], rawHits = {};
  const queries = manifest.queries.filter(q => q.providers.includes('codex') && q.fields.every(f => ['user', 'assistant', 'toolName'].includes(f)));
  for (const file of filesAt(path.join(manifest.providerRoots.codex.path, 'sessions'), true)) {
    if (!file.endsWith('.jsonl')) throw new Error('UnsupportedCodexSourceExtension');
    const facts = await scanCodexFile(file, queries);
    codexCandidates.push({ path: file, metadata: facts.metadata, source: facts.source, projection: facts.projection });
    codexSources.push({ path: file, ...facts.source });
    for (const [label, count] of Object.entries(facts.rawHits)) rawHits[label] = (rawHits[label] || 0) + count;
    if (codexSources.length % 100 === 0) progress({ provider: 'codex', filesScanned: codexSources.length });
  }
  const codexSelection = selectCodexMetadata(codexCandidates);
  metadata.push(...codexSelection.metadata);
  for (const provider of ['claude-code', 'pi']) for (const file of filesAt(manifest.providerRoots[provider].path)) {
    if (!file.endsWith('.jsonl')) throw new Error('UnsupportedSmallSourceExtension');
    metadata.push(await smallMetadata(provider, file));
  }
  const dsh = new Map();
  for (const file of filesAt(manifest.providerRoots['deepseek-harness'].path)) {
    const entry = dshMetadata(file), old = dsh.get(entry.metadata.sessionId);
    if (old?.generation === entry.generation) throw new Error('AmbiguousDshGeneration');
    if (!old || entry.generation > old.generation) dsh.set(entry.metadata.sessionId, entry);
  }
  metadata.push(...[...dsh.values()].map(r => r.metadata));
  // The frozen 2.0 interface reads OpenCode's historical session table. A v2
  // table may coexist; selecting it would silently change the frozen workload.
  const db = new DatabaseSync(manifest.providerRoots.opencode.path, { readOnly: true });
  try {
    for (const row of db.prepare('SELECT id, title, slug, directory, time_updated FROM session WHERE time_archived IS NULL').iterate()) {
      metadata.push({ provider: 'opencode', sessionId: row.id, title: row.title || row.slug || null, directory: row.directory || null, updatedAt: Number(row.time_updated) || 0 });
    }
  } finally { db.close(); }
  const unique = new Map(), duplicateMetadata = [...codexSelection.duplicateMetadata];
  for (const row of metadata) {
    const key = `${row.provider}/${row.sessionId}`, previous = unique.get(key);
    if (previous) duplicateMetadata.push({ provider: row.provider, sessionId: row.sessionId, identical: isDeepStrictEqual(previous, row) });
    else unique.set(key, row);
  }
  const selected = new Map(codexCandidates.map(s => [s.metadata.sessionId, s]));
  const codexAgentHits = [...selected.values()].flatMap(source => source.metadata.updatedAt <= manifest.updatedBeforeUnixMs
    ? queries.flatMap(query => {
      const evidence = source.projection.agentEvidence[query.label];
      return evidence ? [{ label: query.label, querySha256: query.querySha256,
        sessionId: source.metadata.sessionId, sourcePath: source.path, sourceSha256: source.source.sha256,
        ...evidence }] : [];
    }) : []);
  const toolQuery = manifest.queries.find(q => q.fields.length === 1 && q.fields[0] === 'toolName');
  const toolSources = toolQuery ? {
    opencode: deriveOpenCodeToolMatches(manifest.providerRoots.opencode.path, toolQuery.query, manifest.updatedBeforeUnixMs),
    small: deriveSmallProviderToolNameHits(manifest.providerRoots, toolQuery.query, manifest.updatedBeforeUnixMs)
  } : null;
  return { metadata: [...unique.values()], codexSources, rawHits, duplicateMetadata,
    codexProjections: [...selected.values()], codexAgentHits, toolSources };
}

async function main(args) {
  if (args.length !== 3) throw new Error('Expected manifest, candidate record, and fresh ignored output directory');
  const [manifestFile, candidateFile, outputInput] = args;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.format !== 'agentsession-v3-performance-input/v1' || manifest.queries.length !== 9) throw new Error('InvalidFrozenManifest');
  for (const q of manifest.queries) if (!termsOf(q.query).length || digest(q.query) !== q.querySha256) throw new Error('QueryIdentityChanged');
  const tmp = realpathSync(path.join(root, 'tmp')), output = path.resolve(outputInput);
  if (!inside(tmp, output) || existsSync(output)) throw new Error('OutputMustBeFreshPrivateDirectory');
  for (const item of Object.values(manifest.providerRoots)) {
    if (!inside(tmp, realpathSync(item.path))) throw new Error('SourceMustBeFrozenCheckoutCopy');
    if (inside(path.resolve(item.path), output)) throw new Error('OutputInsideSource');
  }
  let current = tmp;
  for (const part of path.relative(tmp, output).split(path.sep)) { current = path.join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('LinkedOutput'); }
  execFileSync('git', ['-C', root, 'check-ignore', '--quiet', '--no-index', '--', output]);
  mkdirSync(output, { recursive: true });
  const started = performance.now();
  const attemptFile = path.join(output, 'attempt.public.json');
  const attempt = { status: 'running', startedAtUtc: new Date().toISOString() };
  writeFileSync(attemptFile, JSON.stringify(attempt, null, 2) + '\n');
  try {
  const before = sourceStats(manifest.providerRoots);
  if (!isDeepStrictEqual(before.codex, manifest.codexStat)) throw new Error('FrozenCodexSignatureChanged');
  const facts = await verifySources(manifest, data => {
    appendFileSync(path.join(output, 'progress.public.jsonl'), JSON.stringify(data) + '\n');
    console.log(JSON.stringify(data));
  });
  const after = sourceStats(manifest.providerRoots);
  if (!isDeepStrictEqual(before, after)) throw new Error('SourcesChangedDuringVerification');
  // Read candidate only AFTER independent derivation has finished.
  const candidate = JSON.parse(readFileSync(candidateFile, 'utf8'));
  const queries = manifest.queries.map(q => {
    const observed = candidate.queries.find(row => row.label === q.label);
    if (!observed?.complete || observed.querySha256 !== q.querySha256 || !Array.isArray(observed.matches)) throw new Error('IncompleteCandidateQuery');
    if (Object.hasOwn(facts.rawHits, q.label)) {
      if (q.fields.length === 1 && q.fields[0] === 'toolName') {
        const codex = compareDocumentProjection(facts.codexProjections, { ...q, providers: ['codex'] },
          manifest.updatedBeforeUnixMs, observed.matches.filter(row => row.session.provider === 'codex'));
        const expected = [...codex.expected, ...facts.toolSources.opencode, ...facts.toolSources.small.hits]
          .sort((a, b) => b.updatedAt - a.updatedAt
            || `${a.session.provider}\0${a.session.sessionId}`.localeCompare(`${b.session.provider}\0${b.session.sessionId}`));
        const comparison = compareMetadata(expected, observed.matches);
        const passed = codex.passed && comparison.passed;
        return { label: q.label, querySha256: q.querySha256,
          status: passed ? 'source-verified' : 'source-mismatch',
          method: 'independent-five-provider-owned-tool-name', ...comparison,
          codexUnresolvedSessions: codex.unresolvedSessions,
          providers: q.providers.map(provider => ({ provider,
            ...compareMetadata(expected.filter(row => row.session.provider === provider),
              observed.matches.filter(row => row.session.provider === provider)) })),
          ...(passed ? { count: expected.length, orderedSemanticSha256: digest(canonical(expected)),
            firstPageSemanticSha256: digest(canonical(expected.slice(0, q.limit))) } : {}),
          expected, sourceEvidence: facts.toolSources.small,
          remaining: passed ? [] : ['Candidate differs from independently derived tool source rows.'] };
      }
      const absenceProved = q.fields.every(f => ['user', 'assistant'].includes(f)) && facts.rawHits[q.label] === 0;
      const passed = absenceProved && isDeepStrictEqual(observed.matches, []);
      if (!absenceProved) {
        const comparison = compareDocumentProjection(facts.codexProjections, q, manifest.updatedBeforeUnixMs, observed.matches);
        return { label: q.label, querySha256: q.querySha256,
          status: comparison.passed ? 'source-verified' : comparison.orderedFieldsPassed && comparison.shortSnippetsPassed ? 'partial-source-verified' : 'source-mismatch',
          method: 'independent-codex-owned-first-document', ...comparison,
          ...(comparison.passed ? { count: comparison.expected.length, orderedSemanticSha256: digest(canonical(comparison.expected)),
            firstPageSemanticSha256: digest(canonical(comparison.expected.slice(0, q.limit))) } : {}),
          remaining: [
            ...(comparison.unresolvedSessions ? ['Copied-parent header requires independent parent-prefix comparison.'] : []),
            ...(comparison.remainingLongSnippetCount ? ['Separated multi-term excerpt window allocation remains unverified.'] : []),
            ...(comparison.remainingProviders.length ? ['Tool-name projection for the listed remaining providers remains unverified.'] : []),
            ...(!comparison.orderedFieldsPassed || !comparison.shortSnippetsPassed ? ['Candidate mismatches are retained in the private report.'] : [])
          ] };
      }
      return { label: q.label, querySha256: q.querySha256, status: passed ? 'source-verified' : 'unverified',
        method: 'exhaustive-codex-body-superset-absence', sourceMatchingRecords: facts.rawHits[q.label],
        ...(passed ? { count: 0, orderedSemanticSha256: digest('[]'), firstPageSemanticSha256: digest('[]') } : {}),
        remaining: passed ? [] : ['Owned-message selection, canonical event IDs, first hit, ordered fields, and long snippets require independent derivation.'] };
    }
    if (q.fields.every(f => ['title', 'directory'].includes(f))) {
      const expected = deriveMetadataMatches(facts.metadata, q, manifest.updatedBeforeUnixMs);
      const comparison = compareMetadata(expected, observed.matches);
      comparison.conflictingCanonicalSources = facts.duplicateMetadata.filter(r => !r.identical && !r.resolution).length;
      comparison.adjudicatedCanonicalSources = facts.duplicateMetadata.filter(r => !r.identical && r.resolution).length;
      if (comparison.conflictingCanonicalSources) comparison.passed = comparison.orderedFieldsPassed = false;
      return { label: q.label, querySha256: q.querySha256, status: comparison.passed ? 'source-verified' : 'partial-source-verified',
        method: 'direct-provider-metadata', ...comparison,
        ...(comparison.passed ? { count: expected.length, orderedSemanticSha256: digest(canonical(expected)),
          firstPageSemanticSha256: digest(canonical(expected.slice(0, q.limit))) } : {}),
        providers: q.providers.map(provider => {
          const result = compareMetadata(expected.filter(r => r.session.provider === provider), observed.matches.filter(r => r.session.provider === provider));
          const conflicts = facts.duplicateMetadata.filter(r => r.provider === provider && !r.identical && !r.resolution).length;
          if (conflicts) result.passed = result.orderedFieldsPassed = false;
          return { provider, ...result, conflictingCanonicalSources: conflicts };
        }),
        expected, remaining: comparison.passed ? [] : ['Long metadata excerpt window semantics and any reported field differences remain unverified.'] };
    }
    return { label: q.label, querySha256: q.querySha256, status: 'unverified', remaining: ['Tool normalization, first-hit selection and exact event references have not been independently derived.'] };
  });
  const sourceVerified = queries.every(query => query.status === 'source-verified'
    && Number.isInteger(query.count) && typeof query.orderedSemanticSha256 === 'string'
    && typeof query.firstPageSemanticSha256 === 'string');
  const report = { format: 'agentsession-v3-search-source-verification/v1',
    verification: { status: sourceVerified ? 'source-verified' : 'partial-source-verified' },
    searchSpeedupEligible: false, providerStats: before, codexSources: facts.codexSources,
    codexAgentHits: facts.codexAgentHits, duplicateMetadata: facts.duplicateMetadata, queries };
  writeFileSync(path.join(output, 'source-verification.private.json'), JSON.stringify(report, null, 2) + '\n');
  if (sourceVerified) writeFileSync(path.join(output, 'search-golden.private.json'),
    JSON.stringify(acceptedSearchGolden(report), null, 2) + '\n');
  const summary = { format: report.format, searchSpeedupEligible: false, codexFiles: facts.codexSources.length,
    codexBytes: facts.codexSources.reduce((sum, r) => sum + r.bytes, 0), unchanged: true,
    sourceContentManifestSha256: digest(canonical(facts.codexSources.map(({ path: file, ...r }) => ({ path: path.relative(manifest.providerRoots.codex.path, file), ...r })))),
    codexAgentHitCounts: Object.fromEntries(manifest.queries.map(q =>
      [q.label, facts.codexAgentHits.filter(hit => hit.label === q.label).length])),
    queries: queries.map(({ expected, unresolved, mismatches, sourceEvidence, querySha256, ...q }) => q) };
  writeFileSync(path.join(output, 'summary.public.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(attemptFile, JSON.stringify({ ...attempt, status: 'completed', elapsedMs: performance.now() - started,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, preparationOnly: true }, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  } catch (error) {
    writeFileSync(attemptFile, JSON.stringify({ ...attempt, status: 'failed', elapsedMs: performance.now() - started,
      failureKind: /^[A-Za-z]+$/.test(error.message) ? error.message : error.name, preparationOnly: true }, null, 2) + '\n');
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`Source verification failed: ${/^[A-Za-z]+$/.test(error.message) ? error.message : error.name}`); process.exitCode = 1; });
}
