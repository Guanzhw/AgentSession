import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const browserName = process.platform === 'win32'
  ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browserExe = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN ||
  (process.env.PATH || '').split(path.delimiter)
    .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', browserName))
    .find(existsSync);
const skip = !existsSync(binary) || !browserExe || !existsSync(browserExe)
  ? 'Build the v3 app and install agent-browser for real browser QA.' : false;

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function safePort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = randomInt(20_000, 60_000);
    const server = createServer();
    try {
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      await new Promise(resolve => server.close(resolve));
      return port;
    } catch {
      server.close();
    }
  }
  throw new Error('Could not reserve a local test port');
}

async function browser(t, url) {
  const session = `agentsession-v3-library-source-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browserExe, ['--session', session, ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args[0]} timed out`)); }, 15_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout));
    });
  });
  t.after(async () => { try { await command('close'); } catch { /* Browser already closed. */ } });
  await command('open', url);
  return command;
}

async function waitFor(command, expression) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (JSON.parse(await command('eval', `Boolean(${expression})`)) === true) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

test('Library reports a real unavailable-source diagnostic without stale rows or provider writes',
  { skip, timeout: 60_000 }, async t => {
    const root = await mkdtemp(path.join(repo, 'tmp', 'v3-library-source-browser-'));
    let child;
    t.after(async () => {
      if (child && child.exitCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    });

    const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
      .map(name => [name, path.join(root, name)]));
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
    const fixture = path.join(repo, 'v3', 'fixtures', 'codex', 'sessions', '2026', '09', '26',
      'rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl');
    const source = path.join(dirs.codex, 'sessions', '2026', '09', '26', path.basename(fixture));
    await mkdir(path.dirname(source), { recursive: true });
    await copyFile(fixture, source);
    const secondSource = source.replace(/\.jsonl$/, '_window.jsonl');
    await writeFile(secondSource, readFileSync(fixture, 'utf8') + JSON.stringify({
      type: 'event_msg', timestamp: '2026-09-26T00:01:00.000Z',
      payload: { type: 'user_message', message: 'A second recorded source for this session.' },
    }) + '\n');
    const database = path.join(root, 'opencode.db');
    await writeFile(database, 'not a SQLite database');
    const before = [sha(source), sha(secondSource), sha(database)];

    const port = await safePort();
    child = spawn(binary, ['serve', '--port', String(port), '--codex-dir', dirs.codex,
      '--opencode-db', database, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
      '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta, '--index-dir', dirs.index,
      '--cache-dir', dirs.cache], { cwd: repo, windowsHide: true, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(base + '/api/providers')).ok) { ready = true; break; }
      } catch { /* The isolated local server is starting. */ }
      if (child.exitCode !== null) assert.fail(`server exited with code ${child.exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'isolated Axum server started');

    const [providersResponse, libraryResponse] = await Promise.all([
      fetch(base + '/api/providers'),
      fetch(base + '/api/v3/library/sessions?limit=40'),
    ]);
    assert.equal(providersResponse.status, 200);
    assert.equal(libraryResponse.status, 200);
    const providers = await providersResponse.json();
    const page = await libraryResponse.json();
    const unavailable = providers.find(provider => provider.id === 'opencode');
    assert.equal(unavailable.available, false);
    assert.match(unavailable.storageDiagnostic.note, /SQLite|database|open/i);
    const codex = page.families.find(row => row.session.session.provider === 'codex');
    assert.ok(codex, 'the copied session stays browsable in the initial Library page');
    const sessionId = codex.session.session.sessionId;
    const readerResponse = await fetch(`${base}/api/v3/reader/codex/${sessionId}/bootstrap`);
    assert.equal(readerResponse.status, 503);
    const readerFailure = await readerResponse.json();
    assert.equal(readerFailure.error.code, 'protocol_unavailable');
    assert.match(readerFailure.error.message, /codex_multiple_source_files_unmerged/);

    const command = await browser(t, `${base}/sessions`);
    await waitFor(command, `document.querySelector('.session-table')`);
    await command('fill', 'input[type="search"]', sessionId);
    try {
      await waitFor(command, `document.querySelectorAll('.session-row').length === 1`);
    } catch (error) {
      const state = await command('eval', `({ query: document.querySelector('input[type="search"]')?.value,
        rows: [...document.querySelectorAll('.session-row')].map(row => row.textContent.trim()),
        diagnostics: document.querySelector('.source-diagnostic')?.textContent })`);
      throw new Error(`${error.message}; browser state: ${state}`);
    }
    const project = codex.session.directory;
    if (project) {
      await command('eval', `(() => { const field = document.querySelector('[data-library-project]'); field.value = ${JSON.stringify(project)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await waitFor(command, `document.querySelectorAll('.session-row').length === 1`);
    }
    const { href: departedHref } = JSON.parse(await command('eval', `({
      href: document.querySelector('.session-row').getAttribute('href'),
    })`));
    await command('click', '.session-row');
    await waitFor(command, `document.querySelector('.error-state h1')?.textContent === 'Recorded history unavailable'`);
    const errorState = JSON.parse(await command('eval', `({
      guidance: document.querySelector('.error-state').textContent,
      detailsOpen: document.querySelector('.error-state details').open,
      diagnostic: document.querySelector('.error-state details p').textContent,
    })`));
    assert.equal(errorState.detailsOpen, false, 'source diagnostics start collapsed');
    assert.ok(errorState.diagnostic.includes(readerFailure.error.message));
    assert.ok(!errorState.guidance.includes('Check the local service'));
    await command('click', '.error-state a[href="/sessions"]');
    await waitFor(command, `document.querySelectorAll('.session-row').length === 1`);
    await waitFor(command, `document.activeElement?.getAttribute('href') === ${JSON.stringify(departedHref)}`);
    assert.equal(await command('get', 'value', 'input[type="search"]'), sessionId);
    assert.equal(await command('get', 'value', '[data-library-project]'), project || '');
    await command('eval', `(() => { const select = document.querySelector('[data-library-provider]'); select.value = 'opencode'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(command, `document.querySelector('.library-source-note')?.textContent.includes('OpenCode')`);
    assert.equal(await command('eval', `document.querySelector('.library-source-note').open`), 'false',
      'source issues start folded');
    await command('click', '.library-source-note > summary');
    const diagnostic = await command('get', 'text', '.library-source-note');
    assert.ok(diagnostic.includes(unavailable.storageDiagnostic.note),
      `the selected provider view keeps the detailed source diagnostic: ${JSON.stringify({ diagnostic, storageDiagnostic: unavailable.storageDiagnostic })}`);
    assert.equal(Number(await command('get', 'count', '.session-row')), 0,
      'the failed provider filter clears rows from the previous provider');
    assert.equal(await command('get', 'value', '[data-library-provider]'), 'opencode');
    assert.equal(await command('get', 'value', '[data-library-project]'), project || '');
    assert.equal(await command('get', 'value', 'input[type="search"]'), sessionId);
    assert.deepEqual([sha(source), sha(secondSource), sha(database)], before,
      'provider transcript and malformed database remain byte-identical after browser and API reads');
  });
