import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { decodeSourceBytes } from './v3-source-ledger.mjs';

function textPresent(blocks) {
  return Array.isArray(blocks) && blocks.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim());
}

// Partial oracle for the frozen unseeded v3 append-origin case. Membership and
// timestamps come directly from source records. Equal-time tie order is not
// inferred from the Viewer's message construction order.
export function dshTimelineSourceFacts(bytes) {
  const records = decodeSourceBytes(bytes).records;
  const header = records[0]?.value;
  if (header?.type !== 'session' || header.version !== 3 || header.isSeeded !== false) throw new Error('Requires unseeded DSH v3 source');
  const events = new Map();
  const calls = new Map();
  const results = new Map();
  const rememberCall = (id, timestamp, line) => {
    if (typeof id !== 'string' || !id || !Number.isFinite(timestamp)) throw new Error('Recorded tool call identity or time missing');
    if (!calls.has(id)) calls.set(id, { timestamp, line });
  };
  const add = (id, segment, role, timestamp, line) => {
    if (typeof id !== 'string' || !id || !Number.isFinite(timestamp)) throw new Error('Recorded identity or time missing');
    const key = JSON.stringify([id, segment]);
    if (events.has(key)) throw new Error('Source event identity is ambiguous');
    events.set(key, { event: { provider: 'deepseek-harness', sessionId: header.id, messageId: id, segment }, role, timestamp, line });
  };
  for (const { value: r, line } of records.slice(1)) {
    const d = r.data;
    if (r.type === 'user/message' && r.surfaceOp === 'append' && d.source?.kind === 'user' && textPresent(d.content)) add(d.id, 'message', 'user', r.time, line);
    if (r.type === 'assistant/message' && r.surfaceOp === 'append') {
      if (textPresent(d.message?.content)) add(d.message.id, 'message', 'assistant', r.time, line);
      for (const block of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (block.type === 'tool-call') rememberCall(block.id, r.time, line);
      }
    }
    if (r.type === 'tool/call') rememberCall(d.callId, r.time, line);
    if (r.type === 'tool/result' && r.surfaceOp === 'append') {
      const blocks = d.message?.content?.filter(block => block.type === 'tool-result');
      if (!blocks?.length) throw new Error('Exact tool result linkage missing');
      for (const block of blocks) {
        if (!block.toolCallId || results.has(block.toolCallId)) throw new Error('Source tool settlement is ambiguous');
        results.set(block.toolCallId, { time: r.time, line });
      }
    }
  }
  if (calls.size !== results.size || [...results.keys()].some(id => !calls.has(id))) throw new Error('Tool call/result membership differs');
  for (const id of results.keys()) {
    const call = calls.get(id);
    add(id, 'tool', 'tool', call.timestamp, call.line);
  }
  const orderedByTime = [...events.values()].sort((a, b) => a.timestamp - b.timestamp);
  const first = orderedByTime.filter(row => row.timestamp === orderedByTime[0]?.timestamp);
  const last = orderedByTime.filter(row => row.timestamp === orderedByTime.at(-1)?.timestamp);
  return { sessionId: header.id, events: [...events.values()],
    first: first.length === 1 ? first[0].event : null, last: last.length === 1 ? last[0].event : null,
    orderCoverage: 'strict timestamp order; equal-timestamp tie order is not asserted' };
}

export function verifyDshTimeline(facts, rows) {
  if (rows.length !== facts.events.length) return { ok: false, reason: 'source-backed total differs' };
  const refKey = ref => JSON.stringify([ref?.provider, ref?.sessionId, ref?.messageId, ref?.segment]);
  const expected = new Map(facts.events.map(row => [refKey(row.event), row]));
  const seen = new Set();
  let previous = -Infinity;
  for (const [timelineIndex, row] of rows.entries()) {
    const key = refKey(row.event);
    const source = expected.get(key);
    if (!source || seen.has(key)) return { ok: false, reason: 'owner, membership or uniqueness differs' };
    if (row.timestamp !== source.timestamp) return { ok: false, reason: 'source timestamp differs',
      timelineIndex, event: source.event, sourceLine: source.line,
      expectedTimestamp: source.timestamp, actualTimestamp: row.timestamp };
    if (row.role !== source.role) return { ok: false, reason: 'source role differs',
      timelineIndex, event: source.event, sourceLine: source.line,
      expectedRole: source.role, actualRole: row.role };
    if (row.timestamp < previous) return { ok: false, reason: 'timestamp order differs' };
    seen.add(key); previous = row.timestamp;
  }
  return { ok: true, rows: rows.length, exactFirst: facts.first !== null, exactLast: facts.last !== null, orderCoverage: facts.orderCoverage };
}

async function main(args) {
  if (args.length !== 2) throw new Error('Expected frozen manifest and private pagination capture');
  const manifest = JSON.parse(await readFile(args[0], 'utf8'));
  const source = manifest.files?.find(item => item.provider === 'deepseek-harness' && item.role === 'native-v3-packed-compaction');
  if (!source?.snapshotPath || !/^[0-9a-f]{64}$/.test(source.snapshotSha256)) throw new Error('Frozen DSH source is missing');
  const bytes = await readFile(source.snapshotPath);
  if (createHash('sha256').update(bytes).digest('hex') !== source.snapshotSha256) throw new Error('Frozen DSH source differs');
  const captureBytes = await readFile(args[1]);
  const capture = JSON.parse(captureBytes);
  const item = capture.cases?.find(entry => entry.id === 'mcp.timeline.all.deepseek-harness');
  if (!Array.isArray(item?.result?.pages)) throw new Error('Frozen DSH timeline pages are missing');
  const rows = item.result.pages.flatMap(page => {
    if (page?.isError === true || !Array.isArray(page?.structuredContent?.result?.events)) throw new Error('Frozen DSH timeline page is invalid');
    return page.structuredContent.result.events;
  });
  const facts = dshTimelineSourceFacts(bytes);
  const result = verifyDshTimeline(facts, rows);
  if (!result.ok) throw new Error(result.reason);
  console.log(JSON.stringify({ passed: true, captureSha256: createHash('sha256').update(captureBytes).digest('hex'),
    pages: item.result.pages.length, rows: result.rows, exactFirst: result.exactFirst, exactLast: result.exactLast,
    orderCoverage: result.orderCoverage }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Frozen DSH timeline verification failed'); process.exitCode = 1; });
}
