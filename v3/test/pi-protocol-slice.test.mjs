import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixtures = [
  ['pi-v3-current.jsonl', '019f8a00-0000-7000-8000-000000000001', 'asst0001'],
  ['pi-current.jsonl', '019f7b00-0000-7000-8000-000000000001', 'oldasst1'],
];
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const refKey = ref => `${ref.provider}\0${ref.sessionId}\0${ref.messageId}\0${ref.segment}`;

async function freePort() {
  return freeFetchSafePort();
}

test('Pi native protocol keeps every physical source row across HTTP pages',
  { timeout: 60_000 }, async t => {
    assert.ok(existsSync(binary), `Build the v3 binary at ${binary}`);
    const dir = await mkdtemp(path.join(repo, 'tmp', 'v3-pi-protocol-'));
    t.after(async () => { await rm(dir, { recursive: true, force: true }); });
    const pi = path.join(dir, 'pi');
    const sessions = path.join(pi, 'sessions', 'project');
    await mkdir(sessions, { recursive: true });
    const sources = [];
    for (const [fixture, id, abandoned] of fixtures) {
      const source = path.join(sessions, `${id}.jsonl`);
      await copyFile(path.join(repo, 'test', 'fixtures', fixture), source);
      sources.push({ source, id, abandoned });
    }
    const frozen = path.join(repo, 'tmp', 'v3-corpus', 'pi', 'sessions',
      '--D--WorkSpace-OpenSession--',
      '2026-07-19T13-31-30-839Z_019f7a93-2297-76db-827d-ee366e46482e.jsonl');
    if (existsSync(frozen)) {
      assert.equal(sha256(frozen),
        'c6db5c9c105be0961721fef7f0f8f1b5d2458933bc48fc13302fd768e0c42c29');
      const source = path.join(sessions, path.basename(frozen));
      await copyFile(frozen, source);
      sources.push({ source, id: '019f7a93-2297-76db-827d-ee366e46482e' });
    }
    const before = sources.map(({ source }) => sha256(source));
    const port = await freePort();
    const args = ['serve', '--port', String(port), '--pi-dir', pi,
      '--codex-dir', path.join(dir, 'codex'), '--claude-dir', path.join(dir, 'claude'),
      '--dsh-dir', path.join(dir, 'dsh'), '--opencode-db', path.join(dir, 'opencode.db'),
      '--meta-dir', path.join(dir, 'meta'), '--index-dir', path.join(dir, 'index'),
      '--cache-dir', path.join(dir, 'cache')];
    const child = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
    t.after(async () => {
      child.kill();
      if (child.exitCode === null) await once(child, 'close');
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error('Pi protocol server exited during startup');
      try {
        const response = await fetch(`${base}/api/providers`);
        if (response.ok) { ready = true; break; }
      } catch { /* Startup in progress. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Pi protocol server became ready');

    for (const { source, id, abandoned } of sources) {
      const expected = readFileSync(source, 'utf8').split('\n')
        .map((line, index) => [line.trim(), index]).filter(([line]) => line)
        .map(([line, index]) => ({ record: JSON.parse(line), index }));
      const readerResponse = await fetch(`${base}/api/v3/reader/pi/${id}/bootstrap`);
      assert.equal(readerResponse.status, 200);
      const reader = await readerResponse.json();
      const readerSegments = [...reader.segments];
      let segmentCursor = readerSegments.at(-1)?.nextCursor;
      while (segmentCursor) {
        const page = await fetch(`${base}/api/v3/reader/pi/${id}/segments?` +
          new URLSearchParams({ cursor: segmentCursor }));
        assert.equal(page.status, 200);
        const next = await page.json();
        readerSegments.push(...next.segments);
        segmentCursor = next.segments.at(-1)?.nextCursor;
      }
      const references = new Set(readerSegments.flatMap(segment => segment.items)
        .map(item => refKey(item.event)));
      const seen = [];
      let cursor;
      do {
        const url = new URL(`/api/v3/runtime/pi/${id}/events`, base);
        url.searchParams.set('limit', '2');
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await fetch(url);
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.equal(page.coverage, 'partial');
        assert.equal(page.revision, reader.revision);
        for (const event of page.events) {
          assert.equal(event.sequence, seen.length + 1);
          assert.ok(event.sourceOrder.ordinal >= 0);
          assert.equal(event.provenance.fidelity, 'recorded');
          if (event.readerEvent) assert.ok(references.has(refKey(event.readerEvent)),
            `${id}: ${event.provenance.sourceId} => ${JSON.stringify(event.readerEvent)}`);
          seen.push(event);
        }
        cursor = page.nextCursor;
      } while (cursor);
      const rows = seen.filter(event => event.sourceOrder.ordinal === 0);
      assert.deepEqual(rows.map(event => event.sourceOrder.record),
        expected.map(row => row.index));
      assert.deepEqual(rows.map(event => event.provenance.sourceId),
        expected.map(row => row.record.id ?? null));
      assert.deepEqual(rows.map(event => event.provenance.sourceType),
        expected.map(row => `pi.${row.record.type}`));
      const blocks = expected.flatMap(({ record, index }) =>
        record.type === 'message' && record.message.role === 'assistant' &&
        Array.isArray(record.message.content) ? record.message.content.map((block, ordinal) =>
          ({ block, index, ordinal: ordinal + 1, id: record.id })) : []);
      const projected = seen.filter(event => event.sourceOrder.ordinal > 0);
      assert.deepEqual(projected.map(event => [event.sourceOrder.record,
        event.sourceOrder.ordinal, event.provenance.sourceType, event.provenance.sourceId]),
        blocks.map(({ block, index, ordinal, id }) =>
          [index, ordinal, `pi.message.content.${block.type}`, id]));
      for (const event of projected.filter(event => event.kind === 'tool.call')) {
        const block = blocks.find(row => row.index === event.sourceOrder.record &&
          row.ordinal === event.sourceOrder.ordinal);
        if (event.readerEvent) assert.equal(event.readerEvent.messageId, block.block.id);
      }
      if (abandoned) assert.ok(projected.filter(event => event.provenance.sourceId === abandoned)
        .every(event => event.readerEvent === null));
      if (abandoned) assert.equal(seen.find(event => event.provenance.sourceId === abandoned)
        ?.readerEvent, null);
      assert.ok(!JSON.stringify(seen).includes('Earlier Pi'));
    }
    const broken = path.join(sessions, 'bad.jsonl');
    await writeFile(broken, '{"type":"session","id":"bad"}\n{"id":"bad-row"}\n');
    const invalid = await fetch(`${base}/api/v3/runtime/pi/bad/events`);
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, 'protocol_invalid');
    await writeFile(broken, JSON.stringify({ type: 'session', id: 'bad' }) + '\n' +
      JSON.stringify({ type: 'message', id: 'a', message: { role: 'assistant',
        content: [{ type: 'toolCall', name: 'read', arguments: { secret: 'SECRET_BAD' } }] } }) + '\n');
    const badBlock = await fetch(`${base}/api/v3/runtime/pi/bad/events`);
    assert.equal(badBlock.status, 422);
    const diagnostic = await badBlock.text();
    assert.match(diagnostic, /protocol_invalid/);
    assert.equal(diagnostic.includes('SECRET_BAD'), false);
    assert.deepEqual(sources.map(({ source }) => sha256(source)), before);
  });
