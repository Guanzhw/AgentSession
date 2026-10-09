import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../scripts/v3-compare-snapshots.mjs', import.meta.url));
const PUBLIC_POLICY = fileURLToPath(new URL('../docs/design/agentsession-v3-volatile-policy.json', import.meta.url));
const UPDATED_BEFORE = '/response/structuredContent/result/snapshotUpdatedBefore';
const DURATION = '/response/structuredContent/result/diagnostics/0/durationMs';

const fingerprint = (value) => `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
const keyPath = (...keys) => '$.result' + keys.map((key) => `[key-${fingerprint(key)}]`).join('');

async function runComparator(expected, actual, policy) {
  const directory = await mkdtemp(join(tmpdir(), 'agentsession-v3-snapshot-'));
  try {
    const expectedPath = join(directory, 'expected.json');
    const actualPath = join(directory, 'actual.json');
    const reportPath = join(directory, 'report.txt');
    const policyPath = join(directory, 'policy.json');
    await Promise.all([
      writeFile(expectedPath, JSON.stringify(expected), 'utf8'),
      writeFile(actualPath, JSON.stringify(actual), 'utf8'),
      ...(policy && typeof policy !== 'string' ? [writeFile(policyPath, JSON.stringify(policy), 'utf8')] : []),
    ]);
    const processResult = spawnSync(process.execPath, [
      SCRIPT,
      '--expected', expectedPath,
      '--actual', actualPath,
      '--output', reportPath,
      ...(policy ? ['--volatile-policy', typeof policy === 'string' ? policy : policyPath] : []),
    ], { encoding: 'utf8' });
    return {
      ...processResult,
      report: await readFile(reportPath, 'utf8'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function snapshot(cases) {
  return { format: 'agentsession-v3-snapshot/v1', cases };
}

function policy(id, ignore = [UPDATED_BEFORE, DURATION]) {
  return { format: 'agentsession-v3-volatile-policy/v1', cases: [{ id, ignore }] };
}

function searchResult(snapshotUpdatedBefore, durationMs, extra = {}) {
  return {
    response: {
      structuredContent: {
        result: {
          snapshotUpdatedBefore,
          diagnostics: [{ durationMs }],
          cursor: 'stable-cursor',
          ...extra,
        },
      },
    },
  };
}

test('matches object values when only key order differs', async () => {
  const expected = snapshot([{ id: 'read-event', result: { response: { body: 'unchanged', status: 200 }, request: { cursor: 'c1' } } }]);
  const actual = snapshot([{ id: 'read-event', result: { request: { cursor: 'c1' }, response: { status: 200, body: 'unchanged' } } }]);
  const result = await runComparator(expected, actual);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Snapshots match (1 cases).\n');
  assert.equal(result.report, result.stdout);
});

test('reports private result changes by case, path, reason, and digest', async () => {
  const expected = snapshot([{
    id: 'mcp-event',
    result: {
      cursor: 'CURSOR_EXPECTED_PRIVATE',
      availability: { state: 'available' },
      messages: [{ role: 'assistant', content: 'BODY_EXPECTED_PRIVATE' }],
      sequence: ['first', 'second'],
    },
  }]);
  const actual = snapshot([{
    id: 'mcp-event',
    result: {
      cursor: 'CURSOR_ACTUAL_PRIVATE',
      availability: { state: 'unavailable' },
      messages: [{ role: 'user', content: 'BODY_ACTUAL_PRIVATE' }],
      sequence: ['second', 'first'],
    },
  }]);
  const result = await runComparator(expected, actual);

  assert.equal(result.status, 1);
  for (const path of [
    keyPath('availability', 'state'),
    keyPath('cursor'),
    `${keyPath('messages')}[0][key-${fingerprint('content')}]`,
    `${keyPath('messages')}[0][key-${fingerprint('role')}]`,
    `${keyPath('sequence')}[0]`,
    `${keyPath('sequence')}[1]`,
  ]) {
    assert.ok(result.stdout.includes(path), `report should include ${path}`);
  }
  assert.match(result.stdout, /sha256:[0-9a-f]{12}/);
  assert.doesNotMatch(result.stdout, /CURSOR_EXPECTED_PRIVATE|CURSOR_ACTUAL_PRIVATE|BODY_EXPECTED_PRIVATE|BODY_ACTUAL_PRIVATE/);
  assert.equal(result.report, result.stdout);

  const repeated = await runComparator(expected, actual);
  assert.equal(repeated.stdout, result.stdout);
});

test('distinguishes missing properties from null values', async () => {
  const expected = snapshot([{ id: 'missing-null', result: { cursor: null } }]);
  const actual = snapshot([{ id: 'missing-null', result: {} }]);
  const result = await runComparator(expected, actual);

  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes(`case ${fingerprint('missing-null')} ${keyPath('cursor')}: property missing from actual (expected null sha256:`));
});

test('reports missing and extra case IDs', async () => {
  const expected = snapshot([
    { id: 'shared', result: { ok: true } },
    { id: 'missing-case', result: {} },
  ]);
  const actual = snapshot([
    { id: 'shared', result: { ok: true } },
    { id: 'extra-case', result: {} },
  ]);
  const result = await runComparator(expected, actual);

  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes(`case ${fingerprint('missing-case')} path $.cases: missing from actual`));
  assert.ok(result.stdout.includes(`case ${fingerprint('extra-case')} path $.cases: extra in actual`));
});

test('treats case array order as significant', async () => {
  const expected = snapshot([
    { id: 'first', result: 1 },
    { id: 'second', result: 2 },
  ]);
  const actual = snapshot([
    { id: 'second', result: 2 },
    { id: 'first', result: 1 },
  ]);
  const result = await runComparator(expected, actual);

  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes(`case ${fingerprint('first')} path $.cases[0].id: order differs`));
  assert.ok(result.stdout.includes(`case ${fingerprint('second')} path $.cases[1].id: order differs`));
});

test('rejects duplicate case IDs and invalid format', async () => {
  const duplicate = snapshot([
    { id: 'same', result: {} },
    { id: 'same', result: {} },
  ]);
  const duplicateResult = await runComparator(duplicate, snapshot([]));
  assert.equal(duplicateResult.status, 2);
  assert.ok(duplicateResult.stderr.includes(`expected snapshot has duplicate case id ${fingerprint('same')}`));

  const invalidResult = await runComparator({ format: 'wrong', cases: [] }, snapshot([]));
  assert.equal(invalidResult.status, 2);
  assert.match(invalidResult.stderr, /expected snapshot format must be agentsession-v3-snapshot\/v1/);

  const missingResult = await runComparator(snapshot([{ id: 'missing-result' }]), snapshot([]));
  assert.equal(missingResult.status, 2);
  assert.match(missingResult.stderr, /expected snapshot case at index 0 must contain only id and result/);
});

test('never prints private dynamic object keys or case IDs', async () => {
  const privateKey = 'PRIVATE_SYNTHETIC_FILENAME';
  const privateId = 'PRIVATE_SYNTHETIC_CASE_ID';
  const expected = snapshot([{ id: privateId, result: { toolInput: { [privateKey]: 'before' } } }]);
  const actual = snapshot([{ id: privateId, result: { toolInput: { [privateKey]: 'after' } } }]);
  const result = await runComparator(expected, actual);

  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes(fingerprint(privateKey)));
  assert.ok(result.stdout.includes(fingerprint(privateId)));
  assert.doesNotMatch(result.stdout, /PRIVATE_SYNTHETIC/);
  assert.doesNotMatch(result.report, /PRIVATE_SYNTHETIC/);
});

test('public policy ignores only the two reviewed search fields and counts changed values', async () => {
  const id = 'mcp.search.codex.user-assistant';
  const expected = snapshot([{ id, result: searchResult(100, 4) }]);
  const actual = snapshot([{ id, result: searchResult(101, 5) }]);

  const strict = await runComparator(expected, actual);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /Snapshots differ \(2 differences\):/);

  const allowed = await runComparator(expected, actual, PUBLIC_POLICY);
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, 'Snapshots match (1 cases; 2 ignored differences).\n');
  assert.equal(allowed.report, allowed.stdout);

  const same = await runComparator(expected, expected, PUBLIC_POLICY);
  assert.equal(same.status, 0);
  assert.equal(same.stdout, 'Snapshots match (1 cases; 0 ignored differences).\n');
});

test('policy preserves cursor, body, identity, and case order differences', async () => {
  const id = 'mcp.search.codex.user-assistant';
  const expected = snapshot([
    { id, result: searchResult(100, 4, { body: 'PRIVATE_BODY_BEFORE', identity: 'PRIVATE_ID_BEFORE' }) },
    { id: 'other', result: { ok: true } },
  ]);
  const actual = snapshot([
    { id: 'other', result: { ok: true } },
    { id, result: searchResult(101, 5, { body: 'PRIVATE_BODY_AFTER', identity: 'PRIVATE_ID_AFTER', cursor: 'PRIVATE_CURSOR_AFTER' }) },
  ]);
  const result = await runComparator(expected, actual, PUBLIC_POLICY);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /2 ignored differences/);
  for (const path of [keyPath('response', 'structuredContent', 'result', 'body'),
    keyPath('response', 'structuredContent', 'result', 'identity'),
    keyPath('response', 'structuredContent', 'result', 'cursor')]) {
    assert.ok(result.stdout.includes(path));
  }
  assert.match(result.stdout, /order differs/);
  assert.doesNotMatch(result.stdout, /PRIVATE_/);
});

test('policy rejects absent paths and changed types instead of hiding them', async () => {
  const id = 'search';
  const expected = snapshot([{ id, result: searchResult(100, 4) }]);
  const missing = snapshot([{ id, result: searchResult(101, 5, { diagnostics: [] }) }]);
  const missingResult = await runComparator(expected, missing, policy(id));
  assert.equal(missingResult.status, 2);
  assert.match(missingResult.stderr, /must exist on both sides/);
  assert.doesNotMatch(missingResult.stderr, /search|durationMs/);

  const changedType = snapshot([{ id, result: searchResult('101', 5) }]);
  const typeResult = await runComparator(expected, changedType, policy(id));
  assert.equal(typeResult.status, 2);
  assert.match(typeResult.stderr, /same primitive type/);

  const objectResult = await runComparator(
    snapshot([{ id, result: searchResult({ value: 1 }, 4) }]),
    snapshot([{ id, result: searchResult({ value: 2 }, 5) }]),
    policy(id),
  );
  assert.equal(objectResult.status, 2);
  assert.match(objectResult.stderr, /same primitive type/);
});

test('policy schema rejects wildcard, protected fields, duplicates, and unknown cases', async () => {
  const id = 'PRIVATE_CASE_ID';
  const expected = snapshot([{ id, result: searchResult(100, 4) }]);
  const actual = snapshot([{ id, result: searchResult(101, 5) }]);
  for (const pointer of ['/response/structuredContent/result/*', '/response/structuredContent/result/cursor', '/response/structuredContent/result/body', '/response/structuredContent/result']) {
    const result = await runComparator(expected, actual, policy(id, [pointer]));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unsupported pointer/);
    assert.doesNotMatch(result.stderr, /PRIVATE_CASE_ID|cursor|body/);
  }
  const duplicate = await runComparator(expected, actual, policy(id, [UPDATED_BEFORE, UPDATED_BEFORE]));
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /duplicate pointer/);

  const unknown = await runComparator(expected, actual, policy('PRIVATE_UNKNOWN_CASE', [UPDATED_BEFORE]));
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /must exist in both snapshots/);
  assert.doesNotMatch(unknown.stderr, /PRIVATE_UNKNOWN_CASE/);

  const malformed = await runComparator(expected, actual, { format: 'wrong', cases: [] });
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /volatile policy must contain format/);
});
