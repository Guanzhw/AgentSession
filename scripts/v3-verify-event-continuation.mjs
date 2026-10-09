import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { decodeSourceBytes, sourceLedger, verifyBodyContinuation } from './v3-source-ledger.mjs';

export function eventSourceExpectation(provider, bytes, line) {
  const { records } = decodeSourceBytes(bytes);
  const record = records.find(record => record.line === line)?.value;
  const header = records[0]?.value;
  let content, messageId, sessionId, prefix, textType;
  if (provider === 'codex') {
    if (header?.type !== 'session_meta' || record?.type !== 'response_item' || record.payload?.type !== 'message' || record.payload.role !== 'assistant') throw new Error('Source is not a recorded assistant message');
    sessionId = header.payload.id;
    messageId = record.payload.id;
    content = record.payload.content;
    prefix = '/payload/content';
    textType = 'output_text';
  } else if (provider === 'deepseek-harness') {
    if (header?.type !== 'session' || header.version !== 3 || record?.type !== 'assistant/message' || record.surfaceOp !== 'append' || record.data?.message?.role !== 'assistant') throw new Error('Source is not an appended v3 assistant message');
    sessionId = header.id;
    messageId = record.data.message.id;
    content = record.data.message.content;
    prefix = '/data/message/content';
    textType = 'text';
  } else throw new Error('Unsupported source provider');
  if (typeof sessionId !== 'string' || !sessionId || typeof messageId !== 'string' || !messageId) throw new Error('Recorded identity is missing');
  const texts = Array.isArray(content) ? content.map((block, index) => ({ block, index })).filter(({ block }) => block.type === textType) : [];
  if (texts.length !== 1 || typeof texts[0].block.text !== 'string' || !texts[0].block.text.length) throw new Error('No exact single-string body mapping');
  const ledger = sourceLedger(provider, bytes);
  const source = ledger.records.find(record => record.line === line);
  const path = `${prefix}/${texts[0].index}/text`;
  const fact = source.body.find(fact => fact.path === path);
  if (!fact) throw new Error('Source body locator missing');
  return { sourceSha256: ledger.sourceSha256, line, recordSha256: source.sha256, path, fact,
    event: { provider, sessionId, messageId, segment: 'message' }, role: 'assistant' };
}

export function verifyEventContinuation(expected, pages, locator) {
  const fail = reason => ({ ok: false, reason });
  if (!isDeepStrictEqual(locator, { sourceSha256: expected.sourceSha256, line: expected.line, path: expected.path, recordSha256: expected.recordSha256 })) return fail('source locator differs');
  if (!Array.isArray(pages) || !pages.length) return fail('continuation pages missing');
  let offset = 0;
  const chunks = [];
  for (const [index, { request, result }] of pages.entries()) {
    if (!isDeepStrictEqual(request?.event, expected.event) || !isDeepStrictEqual(result?.event, expected.event) || result.role !== expected.role) return fail('event owner or reference differs');
    if ((request.offset ?? 0) !== offset || result.content?.offset !== offset) return fail('continuation order differs');
    const content = result.content;
    if (typeof content.text !== 'string' || !content.text.length || content.totalChars !== expected.fact.codeUnits) return fail('body shape or total length differs');
    chunks.push(content.text);
    offset += content.text.length;
    const final = index === pages.length - 1;
    if (final) {
      if (content.nextOffset !== null || content.truncated !== false || result.continuation !== null) return fail('final continuation is incomplete');
    } else {
      if (content.nextOffset !== offset || content.truncated !== true || !isDeepStrictEqual(result.continuation, pages[index + 1].request)) return fail('continuation link differs');
    }
  }
  if (!verifyBodyContinuation(expected.fact, chunks)) return fail('ordered body digest differs');
  return { ok: true, pages: pages.length, codeUnits: offset, sha256: createHash('sha256').update(chunks.join('')).digest('hex') };
}

export function verifyCaptureAgainstSourceBytes(capture, sourceBytesByProvider) {
  if (!Array.isArray(capture?.output) || !capture.output.length) throw new Error('Continuation capture is missing');
  const seen = new Set();
  const summary = [];
  for (const item of capture.output) {
    const provider = item?.provider;
    if (seen.has(provider) || !sourceBytesByProvider.has(provider)) throw new Error('Continuation provider is invalid');
    seen.add(provider);
    const expected = eventSourceExpectation(provider, sourceBytesByProvider.get(provider), item.expected?.line);
    if (!isDeepStrictEqual(item.expected, expected)) throw new Error('Captured expectation differs from raw source');
    const result = verifyEventContinuation(expected, item.pages, item.locator);
    if (!result.ok) throw new Error(`Continuation verification failed: ${result.reason}`);
    summary.push({ provider, pages: result.pages, codeUnits: result.codeUnits, sha256: result.sha256 });
  }
  return summary;
}

async function main(args) {
  if (args.length !== 2) throw new Error('Expected frozen manifest and private capture paths');
  const manifest = JSON.parse(await readFile(args[0], 'utf8'));
  const captureBytes = await readFile(args[1]);
  const capture = JSON.parse(captureBytes);
  const roles = new Map([['codex', 'long-team-compaction'], ['deepseek-harness', 'native-v3-packed-compaction']]);
  const sources = new Map();
  for (const [provider, role] of roles) {
    const file = manifest.files?.find(item => item.provider === provider && item.role === role);
    if (!file?.snapshotPath || !/^[0-9a-f]{64}$/.test(file.snapshotSha256)) throw new Error('Frozen source entry is missing');
    const bytes = await readFile(file.snapshotPath);
    if (createHash('sha256').update(bytes).digest('hex') !== file.snapshotSha256) throw new Error('Frozen source hash differs');
    sources.set(provider, bytes);
  }
  const summary = verifyCaptureAgainstSourceBytes(capture, sources);
  if (summary.length !== roles.size || summary.some(item => !roles.has(item.provider))) throw new Error('Frozen continuation coverage is incomplete');
  console.log(JSON.stringify({ passed: true, captureSha256: createHash('sha256').update(captureBytes).digest('hex'), summary }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Frozen continuation verification failed'); process.exitCode = 1; });
}
