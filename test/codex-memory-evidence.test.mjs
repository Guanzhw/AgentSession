import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readCodexMemoryContent, readCodexMemoryMetadata } from '../dist/src/providers/codex/memory.js';
import { readCodexMemoryEvidence } from '../dist/src/providers/codex/memory-evidence.js';
import { parseCodexMemoryRequest, parseCodexMemorySubmission } from '../dist/src/providers/codex/memory-evidence-parser.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsession-memory-evidence-'));
const generated = 1789621884;
const sourceUpdated = 1789565411;
const summary = '# Synthetic summary\nA saved result with Unicode 中文 and <tags>.\n';
const handlers = 'codex_core::session::handlers';
const requests = 'codex_core::stream_events_utils';
const digest = value => createHash('sha256').update(value).digest('hex');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

function submission(thread = 'generation', turn = 'turn-a', input = '## Memory Writing Agent: Phase 2 (Consolidation)\nSynthetic instructions.') {
  return `session_loop{thread_id=${thread}}: Submission sub=Submission { id: ${JSON.stringify(turn)}, op: TurnInput { request: TurnInputRequest { input: UserInput { content: [Text { text: ${JSON.stringify(input)}, text_elements: [] }], client_id: None } } } }`;
}

function request(content, thread = 'generation', turn = 'turn-a') {
  return `session_loop{thread_id=${thread}}:submission_dispatch{otel.name="submission"}:turn{otel.name="turn" thread.id=${thread} turn.id=${turn} model=synthetic}:session_task.run:handle_output_item_done: ToolCall: exec ${content}\n thread_id=${thread}`;
}

function readRequest(directory, filename = 'sample.md', { thread, turn, cmd } = {}) {
  const args = { cmd: cmd ?? `Get-Content -Raw skills\\sample\\SKILL.md; Get-Content -Raw rollout_summaries\\${filename}; 'separator'; Get-Content -TotalCount 70 MEMORY.md`, workdir: path.join(directory, 'memories'), yield_time_ms: 10000, max_output_tokens: 40000 };
  return request(`const r = await tools.exec_command(${JSON.stringify(args)});\ntext(r.output);\n`, thread, turn);
}

function patchRequest(directory, filename = 'MEMORY.md', { thread, turn, addition = 'Synthetic retained change.' } = {}) {
  const patch = `*** Begin Patch\n*** Update File: ${path.join(directory, 'memories', filename)}\n@@\n+${addition}\n*** End Patch`;
  return request(`const patch = ${JSON.stringify(patch)};\nconst r = await tools.apply_patch(patch);\ntext(typeof r === "string" ? r : JSON.stringify(r));\n`, thread, turn);
}

function sourceFile(directory, filename = 'sample.md', { sessionId = 'source', updated = sourceUpdated, body = summary } = {}) {
  const file = path.join(directory, 'memories', 'rollout_summaries', filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `thread_id: ${sessionId}\nupdated_at: ${new Date(updated * 1000).toISOString()}\nrollout_path: /synthetic/sessions/rollout-2026-09-16-${sessionId}.jsonl\n\n${body}`);
  return file;
}

function fixture(t, { chain = true, logs = true } = {}) {
  const directory = fs.mkdtempSync(path.join(temp, 'fixture-'));
  const memoryPath = path.join(directory, 'memories_1.sqlite');
  const memory = new DatabaseSync(memoryPath);
  memory.exec('CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, source_updated_at INTEGER, generated_at INTEGER, raw_memory TEXT, rollout_summary TEXT)');
  memory.prepare('INSERT INTO stage1_outputs VALUES (?, ?, ?, ?, ?)').run('source', sourceUpdated, generated, 'Synthetic memory', summary);
  t.after(() => memory.close());
  const file = sourceFile(directory);
  const artifact = readCodexMemoryMetadata(directory, 'source').artifacts.find(item => item.kind === 'summary');
  const logPath = path.join(directory, 'logs_2.sqlite');
  let db;
  const add = (id, seconds, body, thread = 'generation', target = requests, nanos = 0) => db.prepare('INSERT INTO logs (id,ts,ts_nanos,target,thread_id,feedback_log_body) VALUES (?,?,?,?,?,?)').run(id, seconds, nanos, target, thread, body);
  if (logs) {
    db = new DatabaseSync(logPath);
    db.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, target TEXT NOT NULL, thread_id TEXT, feedback_log_body TEXT);
      CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
      CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);`);
    t.after(() => db.close());
    if (chain) {
      add(1, generated + 1, submission(), 'generation', handlers);
      add(2, generated + 2, readRequest(directory));
      add(3, generated + 3, patchRequest(directory));
      add(4, generated + 4, patchRequest(directory, 'memory_summary.md'));
      add(5, generated + 5, patchRequest(directory, 'wrong-turn.md', { turn: 'another-turn' }));
      add(6, generated + 6, 'tool call completed turn_id=turn-a tool_name=exec call_id=outer-only execution_started=true', 'generation', 'codex_core::tools::parallel');
    }
  }
  return { directory, memory, memoryPath, db, logPath, file, artifact, add };
}

function page(f, request = {}) { return readCodexMemoryEvidence(f.directory, 'source', f.artifact.id, { mode: 'page', ...request }); }
function source(f, recordId) { return readCodexMemoryEvidence(f.directory, 'source', f.artifact.id, { mode: 'content', recordId }); }
function allPages(f, initial = {}) {
  const pages = [];
  let result = page(f, initial);
  for (let index = 0; index < 100; index++) {
    assert.equal(result.status, 'page');
    pages.push(result);
    if (!result.nextCursor) return pages;
    result = page(f, { cursor: result.nextCursor });
  }
  assert.fail('evidence scan did not finish');
}

test('observed literal log parser records identities and request source without running JavaScript', () => {
  assert.equal(parseCodexMemorySubmission(submission(), 'generation'), 'turn-a');
  assert.equal(parseCodexMemorySubmission(submission(), 'other'), null);
  assert.equal(parseCodexMemorySubmission(submission('generation', 'turn-a', 'A user quoted Memory Writing Agent: Phase 2 (Consolidation).'), 'generation'), null);
  const directory = path.join(temp, 'parser');
  const read = parseCodexMemoryRequest(readRequest(directory), 'generation');
  assert.equal(read.turnId, 'turn-a');
  assert.deepEqual(read.operations.map(item => item.targetPath), ['skills\\sample\\SKILL.md', 'rollout_summaries\\sample.md']);
  const patch = parseCodexMemoryRequest(patchRequest(directory), 'generation');
  assert.equal(patch.operations[0].targetPath, path.join(directory, 'memories', 'MEMORY.md'));
  assert.match(patch.operations[0].content, /tools\.apply_patch/);
  const unsafe = request('const r = await tools.exec_command(makeArgs());\ntext(r.output);');
  assert.equal(parseCodexMemoryRequest(unsafe, 'generation').unsupported, true);
  const interpolated = readRequest(directory, 'sample.md', { cmd: 'Get-Content -Raw "$env:SECRET"; Get-Content -Raw (Get-Path); Get-Content -Raw rollout_summaries\\$(run).md' });
  assert.deepEqual(parseCodexMemoryRequest(interpolated, 'generation').operations, []);
  const injected = request('const r = await tools.exec_command({"cmd":"ignored","workdir":"ignored"});\ntext(r.output);\nthrow new Error("must never execute");');
  assert.deepEqual(parseCodexMemoryRequest(injected, 'generation').operations, []);
});

test('summary advertises on-demand evidence and proves a later turn, preserving producer and provider files', t => {
  const f = fixture(t);
  const before = [f.memoryPath, f.logPath, f.file].map(file => digest(fs.readFileSync(file)));
  const metadata = readCodexMemoryMetadata(f.directory, 'source');
  assert.equal(metadata.artifacts.find(item => item.kind === 'memory').evidenceAccess, undefined);
  assert.equal(f.artifact.evidenceAccess, 'on-demand');
  assert.equal(f.artifact.producerRunId, null);
  const result = page(f);
  assert.equal(result.status, 'page');
  assert.equal(result.coverage.from, generated * 1000);
  assert.equal(result.coverage.to, (generated + 3600) * 1000);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.coverage.issues, []);
  assert.equal(result.activities.length, 1);
  const activity = result.activities[0];
  assert.equal(activity.sessionId, 'generation');
  assert.equal(activity.turnId, 'turn-a');
  assert.equal(activity.historyAvailability, 'unavailable');
  assert.equal(activity.provenance.fidelity, 'recorded');
  assert.equal(activity.binding.provenance.fidelity, 'derived');
  assert.equal(activity.binding.fileHash, digest(fs.readFileSync(f.file)));
  assert.equal(activity.binding.sourceSessionId, 'source');
  assert.equal(activity.binding.sourceUpdatedAt, sourceUpdated * 1000);
  assert.deepEqual(activity.records.map(item => item.kind), ['read-request', 'modification-request', 'modification-request']);
  assert.deepEqual(activity.records.map(item => path.basename(item.targetPath)), ['sample.md', 'MEMORY.md', 'memory_summary.md']);
  assert.doesNotMatch(JSON.stringify(result), /outer-only|execution_started|successful|Synthetic retained change/);
  for (const record of activity.records) {
    const content = source(f, record.id);
    assert.equal(content.status, 'content');
    assert.equal(content.content.length, record.contentLength);
    assert.match(content.content, /tools\.(exec_command|apply_patch)/);
    assert.doesNotMatch(content.content, /Phase 2 \(Consolidation\)/);
  }
  assert.deepEqual([f.memoryPath, f.logPath, f.file].map(file => digest(fs.readFileSync(file))), before);
  assert.equal(readCodexMemoryContent(f.directory, 'source', f.artifact.id).content, summary);
});

test('other summary sources do not create mismatches or join their generation to this artifact', t => {
  const f = fixture(t, { chain: false });
  sourceFile(f.directory, 'other.md', { sessionId: 'other', body: 'A different source.' });
  f.add(1, generated + 1, submission(), 'generation', handlers);
  f.add(2, generated + 2, readRequest(f.directory, 'other.md'));
  f.add(3, generated + 3, patchRequest(f.directory));
  const unrelated = page(f);
  assert.deepEqual(unrelated.activities, []);
  assert.equal(unrelated.coverage.complete, true);
  assert.deepEqual(unrelated.coverage.issues, []);
  sourceFile(f.directory, 'other.md', { updated: sourceUpdated + 1 });
  const mismatch = page(f);
  assert.deepEqual(mismatch.activities, []);
  assert.equal(mismatch.coverage.complete, false);
  assert.ok(mismatch.coverage.issues.includes('summary-file-mismatch'));
});

test('metadata pagination retains unfinished generation scanning and opaque cursor scope', t => {
  const f = fixture(t, { chain: false });
  f.add(1, generated + 1, submission(), 'generation', handlers);
  for (let id = 2; id <= 2100; id++) f.add(id, generated + 2, 'Unrelated retained diagnostic.', 'generation', 'codex_core::session::turn', id);
  f.add(2101, generated + 3, readRequest(f.directory));
  f.add(2102, generated + 4, patchRequest(f.directory));
  const first = page(f);
  assert.equal(first.status, 'page');
  assert.equal(first.coverage.scannedRecords, 2048);
  assert.ok(first.nextCursor);
  assert.ok(first.coverage.issues.includes('metadata-budget'));
  assert.deepEqual(first.activities, []);
  assert.equal(page(f, { cursor: first.nextCursor, from: generated * 1000 + 1 }).status, 'invalid');
  assert.equal(page(f, { cursor: 'not-issued' }).status, 'invalid');
  const retry = page(f, { cursor: first.nextCursor });
  const retryAgain = page(f, { cursor: first.nextCursor });
  assert.deepEqual(retry.activities, retryAgain.activities);
  assert.deepEqual(retry.coverage, retryAgain.coverage);
  const remaining = allPages(f, { cursor: first.nextCursor });
  const records = remaining.flatMap(item => item.activities.flatMap(activity => activity.records));
  assert.deepEqual([...new Set(records.map(item => item.kind))], ['read-request', 'modification-request']);
  assert.equal(remaining.at(-1).coverage.complete, true);
});

test('byte budget continues the same turn and pinned scans exclude appended rows', t => {
  const f = fixture(t, { chain: false });
  f.add(1, generated + 1, submission(), 'generation', handlers);
  for (let id = 2; id <= 14; id++) {
    const content = `const r = await tools.exec_command(${JSON.stringify({ cmd: 'A'.repeat(100_000), workdir: path.join(f.directory, 'memories') })});\ntext(r.output);`;
    f.add(id, generated + 2, request(content), 'generation', requests, id);
  }
  f.add(15, generated + 3, readRequest(f.directory));
  f.add(16, generated + 4, patchRequest(f.directory));
  const first = page(f);
  assert.ok(first.nextCursor);
  assert.ok(first.coverage.issues.includes('byte-budget'));
  assert.ok(first.coverage.readBytes <= 1024 * 1024);
  f.add(17, generated + 5, patchRequest(f.directory, 'new-append.md'));
  f.add(18, generated + 3, patchRequest(f.directory, 'backdated-append.md'), 'generation', requests, 1);
  const remaining = allPages(f, { cursor: first.nextCursor });
  const targets = remaining.flatMap(item => item.activities.flatMap(activity => activity.records.map(record => path.basename(record.targetPath))));
  assert.ok(targets.includes('sample.md'));
  assert.ok(targets.includes('MEMORY.md'));
  assert.equal(targets.includes('new-append.md'), false);
  assert.equal(targets.includes('backdated-append.md'), false);
  assert.equal(remaining.at(-1).revision, first.revision);
  assert.equal(remaining.at(-1).coverage.complete, true);
});

test('binding continuation resumes the next file inside one multi-read request', t => {
  const f = fixture(t, { chain: false });
  f.add(1, generated + 1, submission(), 'generation', handlers);
  const commands = [];
  for (let index = 0; index < 6; index++) {
    sourceFile(f.directory, `other-${index}.md`, { sessionId: `other-${index}`, body: 'x'.repeat(210_000) });
    commands.push(`Get-Content -Raw rollout_summaries\\other-${index}.md`);
  }
  commands.push('Get-Content -Raw rollout_summaries\\sample.md');
  f.add(2, generated + 2, readRequest(f.directory, 'sample.md', { cmd: commands.join('; ') }));
  f.add(3, generated + 3, patchRequest(f.directory));
  const pages = allPages(f);
  assert.ok(pages[0].coverage.issues.includes('byte-budget'));
  assert.ok(pages.length < 5);
  assert.equal(pages.at(-1).coverage.complete, true);
  assert.deepEqual(pages.flatMap(item => item.activities.flatMap(activity => activity.records.map(record => record.kind))), ['read-request', 'modification-request']);
});

test('retention of a submission or matched read is rechecked before a thread continuation', t => {
  for (const deleted of [1, 2]) {
    const f = fixture(t, { chain: false });
    f.add(1, generated + 1, submission(), 'generation', handlers);
    f.add(2, generated + 2, readRequest(f.directory));
    for (let id = 3; id < 2100; id++) f.add(id, generated + 3, 'Other diagnostic.', 'generation', 'codex_core::session::turn', id);
    f.add(2100, generated + 4, patchRequest(f.directory));
    const first = page(f);
    assert.ok(first.nextCursor);
    assert.equal(first.activities[0].records[0].kind, 'read-request');
    f.db.prepare('DELETE FROM logs WHERE id=?').run(deleted);
    assert.equal(page(f, { cursor: first.nextCursor }).status, 'stale');
  }
});

test('oversized records and candidate files are explicitly partial and source boundaries are enforced', t => {
  const f = fixture(t, { chain: false });
  f.add(1, generated + 1, submission('oversized', 'big', '## Memory Writing Agent: Phase 2 (Consolidation)\n' + 'x'.repeat(140_000)), 'oversized', handlers);
  f.add(2, generated + 2, submission(), 'generation', handlers);
  f.add(3, generated + 3, readRequest(f.directory, 'missing.md'));
  const outside = path.join(f.directory, 'outside.md');
  fs.writeFileSync(outside, fs.readFileSync(f.file));
  f.add(4, generated + 4, readRequest(f.directory, '..\\..\\outside.md'));
  sourceFile(f.directory, 'huge.md', { body: summary + 'x'.repeat(270_000) });
  f.add(5, generated + 5, readRequest(f.directory, 'huge.md'));
  const result = page(f);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.nextCursor, null);
  for (const code of ['record-too-large', 'summary-file-missing', 'summary-path-outside-root', 'summary-file-too-large']) assert.ok(result.coverage.issues.includes(code), code);
  assert.deepEqual(result.activities, []);
  assert.ok(result.coverage.readBytes < 140_000);
});

test('record selectors are scoped, body-bound, file-bound and cannot retrieve arbitrary log rows', t => {
  const f = fixture(t);
  const result = page(f);
  const record = result.activities[0].records[1];
  assert.equal(source(f, String(3)).status, 'invalid');
  const other = fixture(t);
  assert.equal(source(other, record.id).status, 'stale');
  f.db.prepare('UPDATE logs SET feedback_log_body=? WHERE id=3').run(patchRequest(f.directory, 'MEMORY.md', { addition: 'A changed request.' }));
  assert.equal(source(f, record.id).status, 'stale');
  const newer = page(f).activities[0].records[1];
  assert.notEqual(newer.id, record.id);
  fs.appendFileSync(f.file, '\nA later current-file edit.');
  assert.equal(source(f, newer.id).status, 'stale');
  const latest = page(f).activities[0].records[0];
  f.db.prepare('DELETE FROM logs WHERE id=1').run();
  assert.equal(source(f, latest.id).status, 'stale');
});

test('an issued record selector after process-local evidence cache loss requests a refresh', async t => {
  const f = fixture(t);
  const record = page(f).activities[0].records[0];
  const freshInstance = await import(`../dist/src/providers/codex/memory-evidence.js?fresh=${Date.now()}`);
  assert.equal(freshInstance.readCodexMemoryEvidence(f.directory, 'source', f.artifact.id, { mode: 'content', recordId: record.id }).status, 'stale');
  assert.equal(freshInstance.readCodexMemoryEvidence(f.directory, 'source', f.artifact.id, { mode: 'content', recordId: 'arbitrary-row-2' }).status, 'invalid');
});

test('unavailable or changed stores and invalid ranges retain explicit result states', t => {
  const missing = fixture(t, { logs: false });
  assert.equal(page(missing).sourceState.code, 'not-found');
  assert.equal(fs.existsSync(missing.logPath), false);
  fs.writeFileSync(missing.logPath, 'not sqlite');
  assert.equal(page(missing).sourceState.code, 'read-failed');
  const f = fixture(t);
  assert.equal(page(f, { from: -1 }).status, 'invalid');
  assert.equal(page(f, { from: 10, to: 9 }).status, 'invalid');
  assert.deepEqual(page(f, { from: 0, to: 1 }).activities, []);
  const raw = readCodexMemoryMetadata(f.directory, 'source').artifacts.find(item => item.kind === 'memory');
  assert.equal(readCodexMemoryEvidence(f.directory, 'source', raw.id, { mode: 'page' }).status, 'not-found');
  f.memory.prepare('UPDATE stage1_outputs SET rollout_summary=?').run('A replacement');
  assert.equal(page(f).status, 'stale');
  const schema = fixture(t);
  schema.db.exec('DROP INDEX idx_logs_ts');
  assert.equal(page(schema).sourceState.code, 'unsupported-schema');
});
