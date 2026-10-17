import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(repo, 'test', 'fixtures', 'cleanup-faults');

// This sandbox deliberately does not use the helper under test. Inspect each
// child's fixtures before finally removing this task-owned outer directory.
function inSandbox(run) {
  const parent = path.join(repo, 'tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'fixture-cleanup-regression-'));
  const temporary = path.join(root, 'temporary');
  mkdirSync(temporary);
  const trace = path.join(root, 'trace.jsonl');
  try {
    return run({ temporary, trace });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runChild(sandbox, file, pattern, fault = '') {
  const env = { ...process.env, NODE_OPTIONS: '', TEMP: sandbox.temporary,
    TMP: sandbox.temporary, TMPDIR: sandbox.temporary,
    CLEANUP_TRACE: sandbox.trace, CLEANUP_FAULT: fault,
    // The injected failures happen before either executable can launch.
    AGENTSESSION_V3_BIN: process.execPath, AGENTSESSION_V3_AGENT_BROWSER_BIN: process.execPath };
  // Start a separate runner instead of inheriting the parent's worker marker.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(path.join(fixtures, 'inject.mjs')).href,
    '--test', '--test-reporter=tap', '--test-reporter-destination=stdout',
    `--test-reporter=${pathToFileURL(path.join(fixtures, 'errors-reporter.mjs')).href}`,
    '--test-reporter-destination=stderr', '--test-concurrency=1',
    '--test-name-pattern', pattern, path.join(repo, file),
  ], {
    cwd: repo, encoding: 'utf8', timeout: 45_000, windowsHide: true,
    env,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  const events = existsSync(sandbox.trace)
    ? readFileSync(sandbox.trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { ...result, output: result.stdout + result.stderr, events };
}

function assertReleased(sandbox, result, prefix) {
  const directories = result.events.filter(event => event.event === 'directory'
    && path.basename(event.directory).startsWith(prefix));
  assert.ok(directories.length > 0, 'The actual test must create its fixture');
  for (const { directory } of directories) assert.equal(existsSync(directory), false, directory);
  assert.deepEqual(readdirSync(sandbox.temporary), [], 'Child fixtures remain before outer cleanup');
}

test('real host installer test releases its OS fixtures on two successive successful runs', () => {
  for (let attempt = 0; attempt < 2; attempt++) inSandbox(sandbox => {
    const result = runChild(sandbox, 'v3/test/mcp-host-installer.test.mjs',
      '^installer requires an explicit binary and host config path$');
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /# pass 1\b/);
    assertReleased(sandbox, result, 'agentsession-v3-host-');
  });
});

for (const scenario of [
  { name: 'settings config write', file: 'v3/test/settings-slice.test.mjs',
    pattern: '^abandoned temporary sibling', fault: 'settings-write',
    marker: /INJECTED_CONFIG_WRITE_FAILURE/, prefix: 'agentsession-v3-settings-boundary-' },
  { name: 'SQL setup', file: 'test/v3-tool-name-opencode-oracle.test.mjs',
    pattern: '^OpenCode tool oracle', fault: 'sql-setup',
    marker: /INJECTED_SQL_SETUP_FAILURE/, prefix: 'tool-oracle-', database: true },
  { name: 'metadata assertion', file: 'test/v3-metadata-seeds.test.mjs',
    pattern: '^metadata seeds preserve', fault: 'metadata-assertion',
    marker: /INJECTED_METADATA_ASSERTION_FAILURE/, prefix: 'v3-meta-seed-', database: true },
]) test(`actual ${scenario.name} failure keeps its original diagnostic and releases its fixture`, () => {
  inSandbox(sandbox => {
    const result = runChild(sandbox, scenario.file, scenario.pattern, scenario.fault);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, scenario.marker);
    assert.doesNotMatch(result.output, /EBUSY|EPERM|Fixture cleanup failed/);
    const injected = result.events.findIndex(event => event.event === 'injected');
    assert.ok(injected >= 0, 'The intended boundary failure must run');
    if (scenario.database) assert.ok(result.events.slice(injected + 1)
      .some(event => event.event === 'database-closed'), 'SQLite must close after the injected failure');
    assertReleased(sandbox, result, scenario.prefix);
  });
});

for (const [fault, marker] of [
  ['vite-build', /INJECTED_VITE_BUILD_FAILURE/],
  ['http-create', /INJECTED_HTTP_CREATE_FAILURE/],
]) test(`actual UI harness releases its build directory after ${fault} failure`, {
  skip: !existsSync(path.join(repo, 'v3/ui/node_modules/vite')) && 'Install the locked v3 UI dependencies.',
}, () => {
  inSandbox(sandbox => {
    const result = runChild(sandbox, 'v3/test/ui-theme.test.mjs', '^theme preference', fault);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, marker);
    assert.ok(result.events.some(event => event.event === 'injected'));
    assertReleased(sandbox, result, 'agentsession-v3-theme-ui-');
  });
});

test('cleanup drains real pending HTTP work before closing SQLite and deleting its directory', () => {
  inSandbox(sandbox => {
    const result = runChild(sandbox, 'test/fixtures/cleanup-faults/resources.mjs', '^pending HTTP work');
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.events.filter(event => ['http-drained', 'sqlite-closed', 'directory-removed']
      .includes(event.event)).map(event => event.event), ['http-drained', 'sqlite-closed', 'directory-removed']);
    assertReleased(sandbox, result, 'cleanup-http-sqlite-');
  });
});

test('cleanup failures propagate together while subsequent resource cleanup still runs', () => {
  inSandbox(sandbox => {
    const result = runChild(sandbox, 'test/fixtures/cleanup-faults/resources.mjs', '^a failed cleanup');
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /AggregateError/);
    assert.match(result.output, /Fixture cleanup failed/);
    assert.match(result.output, /INJECTED_FIRST_CLEANUP_FAILURE/);
    assert.match(result.output, /INJECTED_SECOND_CLEANUP_FAILURE/);
    assert.ok(result.events.some(event => event.event === 'sqlite-closed'));
    assertReleased(sandbox, result, 'cleanup-failed-hooks-');
  });
});
