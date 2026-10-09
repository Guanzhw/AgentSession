// Independent, source-only assertions for default MCP timeline rows. The
// oracle deliberately emits identities and roles, never provider body text.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const present = value => typeof value === 'string' && value.trim().length > 0;
const blocks = value => Array.isArray(value) ? value : [];
const textBlocks = value => blocks(value).some(block => block?.type === 'text' && present(block.text));
const sourceText = value => typeof value === 'string' ? value : blocks(value)
  .filter(block => block?.type === 'text').map(block => block.text ?? '').join('');
const key = event => JSON.stringify([event?.provider, event?.sessionId, event?.messageId, event?.segment]);

function collector(provider, sessionId) {
  const required = [], seen = new Set(), unknown = [];
  return {
    add(messageId, segment, role, order) {
      if (!present(messageId)) { unknown.push('missing recorded event id'); return; }
      const event = { provider, sessionId, messageId, segment };
      if (seen.has(key(event))) throw new Error('Raw source has ambiguous event identity');
      seen.add(key(event));
      required.push({ event, role, order });
    },
    unknown(reason) { if (!unknown.includes(reason)) unknown.push(reason); },
    done(sourceSha256) {
      required.sort((a, b) => a.order - b.order);
      return { provider, sessionId, sourceSha256, required, coverage: {
        membership: unknown.length ? 'partial' : 'exact',
        sourceOrder: 'strict among required events', unknown,
      } };
    },
  };
}

export function openCodeV2TimelineFacts(dbPath, sessionId) {
  const bytes = readFileSync(dbPath), db = new DatabaseSync(dbPath, { readOnly: true });
  const facts = collector('opencode', sessionId);
  try {
    const session = db.prepare('SELECT id FROM session_v2 WHERE id = ?').get(sessionId);
    if (!session) throw new Error('Frozen OpenCode session is absent');
    const rows = db.prepare('SELECT id, type, seq, data FROM session_message WHERE session_id = ? ORDER BY seq, id').all(sessionId);
    if (rows.some((row, index) => index && row.seq === rows[index - 1].seq))
      throw new Error('OpenCode source seq tie leaves row order ambiguous');
    rows.forEach((row, position) => {
      const data = JSON.parse(row.data);
      const base = position * 100000;
      if (row.type === 'user') {
        if (present(data.text)) facts.add(row.id, 'message', 'user', base);
      } else if (row.type === 'assistant') {
        if (!Array.isArray(data.content)) { facts.unknown('assistant without content array'); return; }
        data.content.forEach((part, index) => {
          if (part?.type === 'text') {
            if (present(part.text)) facts.add(`${row.id}:content:${index}`, 'message', 'assistant', base + index + 1);
          } else if (part?.type === 'tool') {
            if (present(part.name)) facts.add(`${row.id}:content:${index}`, 'tool', 'tool', base + index + 1);
            else facts.unknown('tool without a recorded name');
          } else if (part?.type !== 'reasoning') facts.unknown('unmapped assistant content');
        });
      } else if (row.type === 'system') {
        if (present(data.text)) facts.add(row.id, 'message', 'system', base);
      } else facts.unknown('non-conversation source row');
    });
    return facts.done(hash(bytes));
  } finally { db.close(); }
}

export function jsonlTimelineFacts(provider, bytes, sessionId) {
  if (!['claude-code', 'codex', 'pi'].includes(provider)) throw new Error('Unsupported oracle provider');
  const records = bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(JSON.parse);
  const facts = collector(provider, sessionId);
  if (provider === 'claude-code') {
    if (!records.some(row => row.sessionId === sessionId)) throw new Error('Claude session identity differs');
    records.forEach((row, line) => {
      const content = row.message?.content ?? row.content;
      if (row.type === 'user') {
        const hasText = present(content) || textBlocks(content);
        const notification = sourceText(content).trim().startsWith('<task-notification>');
        if (notification) facts.unknown('task notification mapping');
        else if (hasText) facts.add(row.uuid, 'message', 'user', line * 1000);
        for (const [index, block] of blocks(content).entries()) if (block?.type === 'tool_result') {
          const id = present(block.tool_use_id) ? `tool-result:${block.tool_use_id}` : `${row.uuid}:tool-result-${index}`;
          facts.add(id, 'tool', 'tool', line * 1000 + index + 1);
        }
      } else if (row.type === 'assistant') {
        if (present(content)) facts.add(row.uuid, 'message', 'assistant', line * 1000);
        for (const [index, block] of blocks(content).entries()) {
          if (block?.type === 'text' && present(block.text)) facts.add(
            blocks(content).length === 1 ? row.uuid : `${row.uuid}:${index}`, 'message', 'assistant', line * 1000 + index + 1);
          if (block?.type === 'tool_use') facts.add(block.id ?? `${row.uuid}:tool-${index}`, 'tool', 'tool', line * 1000 + index + 1);
        }
      } else if (row.type === 'tool_use' || row.type === 'tool_result') {
        facts.add(row.uuid, 'tool', 'tool', line * 1000);
      } else if (row.type === 'system' && row.subtype === 'compact_boundary') facts.unknown('compact boundary');
    });
    // Task notifications are tool events; their XML interpretation is outside
    // this small source oracle and must be named as uncovered when present.
  } else if (provider === 'pi') {
    const header = records.find(row => row.type === 'session');
    if (header?.id !== sessionId) throw new Error('Pi session identity differs');
    const entries = records.filter(row => row.type !== 'session' && present(row.id));
    let active = entries;
    if (Number(header.version || 1) >= 2 && entries.every(row => 'parentId' in row)) {
      const byId = new Map(entries.map(row => [row.id, row])), visited = new Set();
      active = [];
      for (let row = entries.at(-1); row; row = row.parentId === null ? undefined : byId.get(row.parentId)) {
        if (visited.has(row.id)) throw new Error('Pi source branch cycle');
        visited.add(row.id); active.unshift(row);
      }
    }
    const activeIds = new Set(active.map(row => row.id));
    records.forEach((row, line) => {
      if (!activeIds.has(row.id)) return;
      if (row.type === 'compaction' || row.type === 'branch_summary') {
        if (present(row.summary)) facts.add(row.id, 'message', 'system', line * 1000);
        return;
      }
      if (row.type === 'custom_message') {
        if (row.display === true && present(sourceText(row.content)))
          facts.add(row.id, 'message', 'system', line * 1000);
        return;
      }
      if (row.type !== 'message') return;
      const message = row.message ?? {};
      if (message.role === 'user') facts.add(row.id, 'message', 'user', line * 1000);
      else if (message.role === 'assistant') {
        if (textBlocks(message.content)) facts.add(row.id, 'message', 'assistant', line * 1000);
        for (const [index, block] of blocks(message.content).entries()) if (block?.type === 'toolCall')
          facts.add(block.id, 'tool', 'tool', line * 1000 + index + 1);
      } else if (message.role === 'toolResult' || message.role === 'bashExecution') facts.unknown('standalone Pi tool result');
      else facts.unknown('unmapped Pi message role');
    });
  } else {
    const header = records.find(row => row.type === 'session_meta');
    if (header?.payload?.id !== sessionId) throw new Error('Codex session identity differs');
    const actorPath = header.payload.agent_path;
    const spawnCalls = new Set(), acknowledged = new Set();
    records.forEach((row, line) => {
      const p = row.payload ?? {};
      if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type) &&
          p.name === 'spawn_agent' && p.namespace === 'collaboration' && present(p.call_id))
        spawnCalls.add(p.call_id);
      if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p.type) &&
          spawnCalls.has(p.call_id)) {
        try {
          const actor = JSON.parse(p.output).task_name;
          if (present(actor) && actor.startsWith('/') && actor !== '/') acknowledged.add(actor);
        } catch { /* No actor is acknowledged by an unreadable tool result. */ }
      }
      if (row.type === 'response_item' && p.type === 'message') {
        if (p.role === 'user' && p.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes('user.text') &&
          blocks(p.content).some(block => present(block.text))) facts.add(p.id, 'message', 'user', line);
        else if (p.role === 'assistant' && blocks(p.content).some(block => present(block.text)))
          facts.add(p.id, 'message', 'assistant', line);
      } else if (row.type === 'response_item' && p.type === 'agent_message') {
        const lines = blocks(p.content).map(block => block.text ?? '').join('').split(/\r?\n/);
        if (lines[0] === 'Message Type: FINAL_ANSWER') {
          const separator = typeof p.author === 'string' ? p.author.lastIndexOf('/') : -1;
          const parent = separator > 0 ? p.author.slice(0, separator) : null;
          if (present(p.id) && present(p.author) && p.author !== p.recipient &&
              p.recipient === (present(actorPath) ? actorPath : parent) && acknowledged.has(p.author) &&
              lines[1]?.startsWith('Task name: ') && lines[1].length > 'Task name: '.length &&
              lines[2] === `Sender: ${p.author}` && lines[3] === 'Payload:' && lines.slice(4).join('\n').length > 0)
            facts.add(p.id, 'message', 'agent', line);
          else facts.unknown('unbound final answer');
        }
      } else if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type))
        facts.add(p.call_id, 'tool', 'tool', line);
      else if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(p.type))
        facts.unknown('legacy event_msg deduplication');
    });
  }
  return facts.done(hash(bytes));
}

export function frozenFourProviderTimelineFacts(manifest, provider) {
  if (provider === 'opencode') {
    const source = manifest.database;
    const bytes = readFileSync(source.snapshotPath);
    if (hash(bytes) !== source.snapshotSha256) throw new Error('Frozen OpenCode source hash differs');
    const target = manifest.captureTargets.find(row => row.provider === provider);
    return openCodeV2TimelineFacts(source.snapshotPath, target.sessionId);
  }
  const target = manifest.captureTargets.find(row => row.provider === provider && row.role !== 'compact-team-shorter');
  const source = manifest.files.find(row => row.provider === provider && row.role === target?.role);
  if (!source || !target) throw new Error('Frozen source target missing');
  const bytes = readFileSync(source.snapshotPath);
  if (hash(bytes) !== source.snapshotSha256) throw new Error('Frozen source hash differs');
  return jsonlTimelineFacts(provider, bytes, target.sessionId);
}

export function verifyFourProviderTimeline(facts, rows) {
  const required = new Map(facts.required.map(row => [key(row.event), row]));
  const seen = new Set();
  let previous = -1, matched = 0;
  for (const row of rows) {
    const id = key(row.event);
    if (seen.has(id)) return { ok: false, reason: 'duplicate event reference' };
    seen.add(id);
    if (row.event?.provider !== facts.provider || row.event?.sessionId !== facts.sessionId)
      return { ok: false, reason: 'wrong event owner' };
    const source = required.get(id);
    if (!source) {
      if (facts.coverage.membership === 'exact') return { ok: false, reason: 'event absent from source inventory' };
      continue;
    }
    if (row.role !== source.role) return { ok: false, reason: 'source role differs' };
    if (source.order < previous) return { ok: false, reason: 'source order reversed' };
    previous = source.order;
    matched++;
  }
  if (matched !== required.size) return { ok: false, reason: 'source event missing' };
  return { ok: true, matched, total: rows.length, coverage: facts.coverage };
}
