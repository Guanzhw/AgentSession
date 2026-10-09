import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { dshTimelineSourceFacts, verifyDshTimeline } from '../../scripts/v3-verify-dsh-timeline.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = path.join(repo, 'tmp', 'v3-corpus', 'manifest.private.json');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const providers = ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness'];
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const textHash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const firstRecord = file => {
  const bytes = readFileSync(file);
  const text = file.endsWith('.zstd') ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8');
  return JSON.parse(text.split(/\r?\n/).find(line => line.trim()));
};

function zstdRecords(file) {
  const bytes = readFileSync(file);
  const decoded = [];
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    assert.equal(bytes.readUInt32LE(offset), 0xfd2fb528, 'Zstandard frame magic');
    offset += 4;
    const descriptor = bytes[offset++];
    const singleSegment = Boolean(descriptor & 0x20);
    const checksum = Boolean(descriptor & 0x04);
    const dictionaryBytes = (descriptor & 3) === 3 ? 4 : descriptor & 3;
    const sizeFlag = descriptor >> 6;
    offset += Number(!singleSegment) + dictionaryBytes + (sizeFlag ? 1 << sizeFlag : Number(singleSegment));
    while (true) {
      const header = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
      offset += 3;
      const blockType = (header >> 1) & 3;
      assert.notEqual(blockType, 3, 'Zstandard block type');
      offset += blockType === 1 ? 1 : header >> 3;
      if (header & 1) {
        if (checksum) offset += 4;
        break;
      }
    }
    decoded.push(zstdDecompressSync(bytes.subarray(start, offset)).toString('utf8'));
  }
  return decoded.join('').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
}

function sourceContentOracle(manifest, target) {
  const provider = target.provider;
  if (provider === 'opencode') {
    const db = new DatabaseSync(manifest.database.snapshotPath, { readOnly: true });
    try {
      const row = db.prepare(`SELECT id, data FROM session_message
        WHERE session_id = ? AND type = 'user' ORDER BY seq, id LIMIT 1`).get(target.sessionId);
      assert.ok(row, 'OpenCode v2 source has a readable user row');
      return { messageId: row.id, text: JSON.parse(row.data).text };
    } finally { db.close(); }
  }
  const file = manifest.files.find(row => row.provider === provider && row.role === target.role);
  const records = provider === 'deepseek-harness' ? zstdRecords(file.snapshotPath)
    : readFileSync(file.snapshotPath, 'utf8').split(/\r?\n/)
      .filter(line => line.trim()).map(line => JSON.parse(line));
  if (provider === 'claude-code') {
    const row = records.find(item => item.type === 'user' &&
      typeof item.message?.content === 'string' && item.message.content.length);
    assert.ok(row, 'Claude source has a readable user row');
    return { messageId: row.uuid, text: row.message.content };
  }
  if (provider === 'pi') {
    const row = records.find(item => item.type === 'message' && item.message?.role === 'user' &&
      item.message.content?.some(block => block.type === 'text' && block.text));
    assert.ok(row, 'Pi source has a readable user row');
    return { messageId: row.id, text: row.message.content.filter(block => block.type === 'text')
      .map(block => block.text).join('') };
  }
  if (provider === 'codex') {
    const row = records.find(item => item.type === 'response_item' &&
      item.payload?.type === 'message' && item.payload.role === 'user' &&
      item.payload.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes('user.text') &&
      item.payload.content?.some(block => block.type === 'input_text' && block.text));
    assert.ok(row, 'Codex source has a recorded user text row');
    return { messageId: row.payload.id, text: row.payload.content
      .filter(block => block.type === 'input_text').map(block => block.text).join('') };
  }
  const row = records.find(item => item.type === 'user/message' &&
    item.data?.source?.kind === 'user' && item.data.content?.some(block => block.type === 'text' && block.text));
  assert.ok(row, 'DSH source has a recorded user message');
  return { messageId: row.data.id, text: row.data.content
    .filter(block => block.type === 'text').map(block => block.text).join('') };
}

// These identities come from provider-owned bytes, independently of AgentSession's index or MCP output.
function sourceRef(manifest, target) {
  const provider = target.provider;
  if (provider === 'opencode') {
    const db = new DatabaseSync(manifest.database.snapshotPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT id FROM session_v2 WHERE id = ?').get(target.sessionId);
      assert.ok(row, 'OpenCode session ID must exist in the frozen source database');
      return { provider, sessionId: row.id };
    } finally { db.close(); }
  }
  const file = manifest.files.find(row => row.provider === provider && row.role === target.role);
  assert.ok(file, `frozen ${provider} source is recorded`);
  const record = firstRecord(file.snapshotPath);
  const sessionId = provider === 'claude-code'
    ? record.sessionId
    : provider === 'codex'
      ? record.payload.id
      : record.id;
  assert.ok(sessionId, `${provider} source contains a canonical session ID`);
  return { provider, sessionId };
}

function sourceHasToolEvents(manifest, provider) {
  if (!['claude-code', 'pi'].includes(provider)) return true;
  const file = manifest.files.find(row => row.provider === provider);
  const records = readFileSync(file.snapshotPath, 'utf8').split(/\r?\n/)
    .filter(line => line.trim()).map(line => JSON.parse(line));
  return provider === 'claude-code'
    ? records.some(row => row.type === 'assistant' && row.message?.content?.some(
      block => block.type === 'tool_use'))
    : records.some(row => row.type === 'message' && row.message?.content?.some(
      block => block.type === 'toolCall'));
}

function sourceUserMessageIds(manifest, target) {
  const provider = target.provider;
  if (provider === 'opencode') {
    const db = new DatabaseSync(manifest.database.snapshotPath, { readOnly: true });
    try {
      return db.prepare(`SELECT id, data FROM session_message WHERE session_id = ? AND type = 'user'
        ORDER BY seq, id`).all(target.sessionId)
        .filter(row => JSON.parse(row.data).text?.trim())
        .map(row => row.id);
    } finally { db.close(); }
  }
  const file = manifest.files.find(row => row.provider === provider && row.role === target.role);
  const records = provider === 'deepseek-harness' ? zstdRecords(file.snapshotPath)
    : readFileSync(file.snapshotPath, 'utf8').split(/\r?\n/)
      .filter(line => line.trim()).map(line => JSON.parse(line));
  if (provider === 'claude-code') return records.filter(row => {
    if (row.type !== 'user') return false;
    const content = row.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
    return text.length > 0 && !text.includes('<task-notification>');
  }).map(row => row.uuid);
  if (provider === 'pi') return records.filter(row => row.type === 'message' &&
    row.message?.role === 'user').map(row => row.id);
  if (provider === 'codex') return records.filter(row => row.type === 'response_item' &&
    row.payload?.type === 'message' && row.payload.role === 'user' &&
    row.payload.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes('user.text'))
    .map(row => row.payload.id);
  return records.filter(row => row.type === 'user/message' &&
    row.data?.source?.kind === 'user').map(row => row.data.id);
}

async function awaitProcessClose(closed) {
  let timer;
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('MCP child process did not close')), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, `${name}: ${response.content?.[0]?.text || 'tool error'}`);
  assert.equal(response.structuredContent?.untrustedContent, true, `${name} marks source content untrusted`);
  return response.structuredContent.result;
}

test('frozen five-provider MCP browse to event reading follows source references',
  { timeout: 180_000,
    skip: !existsSync(manifestPath) && process.env.AGENTSESSION_V3_REAL_CORPUS_REQUIRED !== '1'
      ? 'requires the ignored frozen five-provider corpus' : false }, async t => {
    assert.ok(existsSync(manifestPath), 'the ignored frozen corpus manifest is required');
    assert.ok(existsSync(binary), 'the selected 3.0 executable is required');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const sources = [...manifest.files.map(row => [row.snapshotPath, row.snapshotSha256]),
      [manifest.database.snapshotPath, manifest.database.snapshotSha256]];
    for (const [file, expected] of sources) assert.equal(sha256(file), expected, 'frozen source hash');
    const contentOracles = new Map();
    const userInventories = new Map();
    const selected = providers.map(provider => {
      const target = manifest.captureTargets.find(row => row.provider === provider &&
        !['recorded-subagent-descriptor', 'compact-team-shorter'].includes(row.role));
      assert.ok(target, `${provider} has a frozen target`);
      const ref = sourceRef(manifest, target);
      assert.deepEqual(ref, { provider, sessionId: target.sessionId }, 'manifest agrees with raw source');
      // A deliberately corrupted expected ID must be rejected by this independent oracle.
      assert.throws(() => assert.deepEqual({ ...ref, sessionId: `${ref.sessionId}-wrong` }, ref));
      const oracle = sourceContentOracle(manifest, target);
      assert.ok(oracle.messageId && oracle.text, `${provider} has source-owned readable content`);
      contentOracles.set(provider, oracle);
      const userIds = sourceUserMessageIds(manifest, target);
      assert.ok(userIds.length > 0, `${provider} has source-owned user messages`);
      assert.equal(new Set(userIds).size, userIds.length, 'raw user IDs are unique');
      userInventories.set(provider, userIds);
      return ref;
    });
    const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-mcp-five-provider-'));
    let client;
    let childClosed;
    t.after(async () => {
      try {
        if (client) {
          await client.close();
          await awaitProcessClose(childClosed);
        }
        for (const [file, expected] of sources) assert.equal(sha256(file), expected,
          'provider source hash after MCP child process close');
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
    for (const name of ['meta', 'index', 'cache']) await mkdir(path.join(dir, name));
    const args = ['mcp'];
    for (const provider of providers) {
      const root = manifest.providerRoots[provider];
      args.push(root.cliFlag, root.path);
    }
    args.push('--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
      '--cache-dir', path.join(dir, 'cache'));
    client = new Client({ name: 'agentsession-v3-five-provider-workflow', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: binary, args, cwd: repo, stderr: 'pipe' });
    await client.connect(transport);
    childClosed = new Promise(resolve => {
      const prior = transport.onclose;
      transport.onclose = () => { prior?.(); resolve(); };
    });

    const available = await call(client, 'session_browse', { level: 'providers' });
    assert.deepEqual(available.providers.map(row => row.provider).sort(), [...providers].sort());
    assert.ok(available.providers.every(row => row.available), 'all frozen sources are available');

    for (const session of selected) {
      await t.test(session.provider, { timeout: 120_000 }, async () => {
        const browsing = await call(client, 'session_browse', {
          level: 'sessions', providers: [session.provider], limit: 100,
        });
        const browsed = browsing.sessions.find(row => row.session.sessionId === session.sessionId);
        assert.ok(browsed, `${session.provider} source ID is browsable`);
        assert.deepEqual(browsed.session, session);

        const detail = await call(client, 'session_get', { session });
        assert.deepEqual(detail.session, session);
        assert.ok(detail.messageCount > 0);
        assert.deepEqual({ provider: detail.firstMessage.event.provider,
          sessionId: detail.firstMessage.event.sessionId }, session);

        const searchTerm = detail.title?.trim().slice(0, 40);
        if (searchTerm) {
          const found = await call(client, 'session_search', {
            query: searchTerm, providers: [session.provider], fields: ['title'], limit: 100,
          });
          assert.ok(found.matches.some(row => row.session.provider === session.provider &&
            row.session.sessionId === session.sessionId), 'title search returns the source session');
        }

        const first = await call(client, 'session_timeline', { session, limit: 1 });
        assert.equal(first.events.length, 1);
        assert.ok(first.nextCursor, 'the frozen session has a continuation');
        const second = await call(client, 'session_timeline', {
          session, limit: 1, cursor: first.nextCursor,
        });
        assert.equal(second.events.length, 1);
        assert.notDeepEqual(second.events[0].event, first.events[0].event);
        const wrongFilter = await client.callTool({ name: 'session_timeline', arguments: {
          session, limit: 1, cursor: first.nextCursor, roles: ['assistant'],
        } });
        assert.equal(wrongFilter.isError, true, 'continuation binds the original filters');
        for (const page of [first, second]) {
          assert.equal(page.events[0].untrustedContent, true);
          assert.deepEqual({ provider: page.events[0].event.provider,
            sessionId: page.events[0].event.sessionId }, session);
          assert.notEqual(page.events[0].event.segment, 'thinking', 'thinking is excluded by default');
        }
        const timeline = [];
        const cursors = new Set();
        let timelinePages = 0;
        let cursor = null;
        do {
          const page = await call(client, 'session_timeline', {
            session, limit: 200, ...(cursor ? { cursor } : {}),
          });
          assert.ok(page.events.length <= 50, 'timeline page respects the configured cap');
          timeline.push(...page.events);
          timelinePages++;
          cursor = page.nextCursor;
          if (cursor) {
            assert.ok(!cursors.has(cursor), 'timeline cursor advances');
            cursors.add(cursor);
          }
          assert.ok(cursors.size < 500, 'frozen timeline remains within the acceptance bound');
        } while (cursor);
        assert.ok(timeline.length >= 2);
        assert.deepEqual(timeline[0].event, first.events[0].event);
        assert.deepEqual(timeline[1].event, second.events[0].event);
        const eventKeys = timeline.map(row => JSON.stringify(row.event));
        assert.equal(new Set(eventKeys).size, eventKeys.length,
          'canonical event references must not repeat across pages');
        let dshSourceEvidence = '';
        if (session.provider === 'deepseek-harness') {
          const source = manifest.files.find(row => row.provider === session.provider &&
            row.role === 'native-v3-packed-compaction');
          assert.ok(source?.snapshotPath && /^[0-9a-f]{64}$/.test(source.snapshotSha256),
            'the frozen unseeded DSH v3 source is recorded');
          const sourceBytes = readFileSync(source.snapshotPath);
          const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
          assert.equal(sourceHash, source.snapshotSha256, 'the DSH timeline source hash is frozen');
          const facts = dshTimelineSourceFacts(sourceBytes);
          assert.equal(facts.sessionId, session.sessionId, 'raw DSH records own the selected session');
          assert.deepEqual([...new Set(facts.events.map(row => row.role))].sort(),
            ['assistant', 'tool', 'user'], 'the raw source oracle covers user, assistant, and tool events');
          const reconciliation = verifyDshTimeline(facts, timeline);
          const reconciliationDetail = reconciliation.ok ? 'ok' : JSON.stringify(reconciliation);
          assert.equal(reconciliation.ok, true,
            `complete default DSH timeline matches raw source: ${reconciliationDetail}`);
          if (facts.first) assert.deepEqual(timeline[0].event, facts.first,
            'the uniquely earliest source event is the first timeline event');
          if (facts.last) assert.deepEqual(timeline.at(-1).event, facts.last,
            'the uniquely latest source event is the last timeline event');
          dshSourceEvidence = `; ${reconciliation.rows} events reconciled to raw source SHA-256 ${sourceHash}; ` +
            reconciliation.orderCoverage;
        }
        const sourceUsers = userInventories.get(session.provider);
        let previousPosition = -1;
        for (const messageId of sourceUsers) {
          const positions = timeline.flatMap((row, index) => row.role === 'user' &&
            row.event.segment === 'message' && row.event.messageId === messageId ? [index] : []);
          assert.equal(positions.length, 1, 'each source-owned user message appears exactly once');
          assert.ok(positions[0] > previousPosition, 'source-owned user messages preserve order');
          previousPosition = positions[0];
        }
        // Codex also projects legacy event_msg user rows, so response_item user IDs are a subset.
        if (session.provider !== 'codex') {
          assert.equal(timeline.filter(row => row.role === 'user' &&
            row.event.segment === 'message').length, sourceUsers.length,
          'all visible user messages are accounted for by provider source rows');
        }
        if (session.provider === 'pi') {
          const file = manifest.files.find(row => row.provider === 'pi');
          const recordedMessages = readFileSync(file.snapshotPath, 'utf8').split(/\r?\n/)
            .filter(line => line.trim()).map(line => JSON.parse(line))
            .filter(row => row.type === 'message');
          assert.ok(recordedMessages.every(row => row.message?.content?.every(
            block => block.type === 'text')), 'Pi frozen messages contain text blocks only');
          assert.equal(timeline.length, recordedMessages.length,
            'the simple Pi source has one visible event per recorded message');
        }
        const oracle = contentOracles.get(session.provider);
        const sourceEvent = timeline.find(row => row.event.messageId === oracle.messageId &&
          row.event.segment === 'message');
        assert.ok(sourceEvent, `${session.provider} source-owned user event is in the complete timeline`);
        assert.equal(sourceEvent.role, 'user');
        let assembled = '';
        let request = { event: sourceEvent.event, maxChars: 32 };
        let contentPages = 0;
        do {
          const page = await call(client, 'session_get_event', request);
          assert.deepEqual(page.event, sourceEvent.event);
          assert.equal(page.untrustedContent, true);
          assert.equal(page.content.offset, assembled.length, 'content offset follows prior pages');
          assert.equal(page.content.totalChars, oracle.text.length, 'source and MCP lengths agree');
          assembled += page.content.text;
          request = page.continuation;
          assert.ok(++contentPages < 500, 'event content remains within the acceptance bound');
        } while (request);
        assert.equal(textHash(assembled), textHash(oracle.text),
          `${session.provider} complete MCP content matches provider-owned source bytes`);
        t.diagnostic(`${session.provider}: ${timelinePages} timeline pages, ${timeline.length} events, ` +
          `${sourceUsers.length} source user messages, ${contentPages} content pages; source body SHA-256 matched` +
          dshSourceEvidence);
        const event = first.events[0].event;
        const context = await call(client, 'session_get_context', {
          event, before: 0, after: 0,
        });
        assert.deepEqual(context.target, event);
        assert.deepEqual(context.events.map(row => row.event), [event]);
        const full = await call(client, 'session_get_event', { event });
        assert.deepEqual(full.event, event);
        assert.equal(full.untrustedContent, true);
        assert.ok(full.content.text.length > 0, 'the selected event is readable');
        const short = await call(client, 'session_get_event', { event, maxChars: 16 });
        assert.equal(short.content.text, full.content.text.slice(0, short.content.text.length));
        if (short.continuation) {
          const continued = await call(client, 'session_get_event', short.continuation);
          assert.deepEqual(continued.event, event);
          assert.equal(short.content.text + continued.content.text,
            full.content.text.slice(0, short.content.text.length + continued.content.text.length),
            'event continuation preserves source order');
        }

        const toolPage = await call(client, 'session_timeline', {
          session, segments: ['tool'], limit: 1,
        });
        assert.equal(toolPage.events.length, sourceHasToolEvents(manifest, session.provider) ? 1 : 0,
          'tool-event availability follows the recorded source');
        if (toolPage.events.length) {
          const tool = toolPage.events[0];
          const redacted = await call(client, 'session_get_event', { event: tool.event });
          assert.deepEqual(redacted.event, tool.event);
          assert.equal(redacted.toolName, tool.toolName);
          assert.equal(redacted.toolInput, null, 'tool input needs explicit opt-in');
          assert.equal(redacted.toolOutput, null, 'tool output needs explicit opt-in');
          const nearby = await call(client, 'session_get_context', {
            event: tool.event, before: 0, after: 0,
          });
          assert.deepEqual(nearby.events.map(row => row.event), [tool.event]);
          assert.ok(nearby.events[0].preview.length <= 241);
        }
      });
    }
  });
