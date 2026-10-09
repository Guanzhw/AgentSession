import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const fixture = path.join(repo, 'v3', 'fixtures', 'codex-inherited', 'sessions', '2026', '09', '27',
  'rollout-public-child.jsonl');
const childId = 'codex-inherited-public-child';
const parentId = 'codex-inherited-absent-parent';

function agentBrowserBinary() {
  const override = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN;
  if (override && existsSync(override)) return override;
  const name = process.platform === 'win32'
    ? 'agent-browser-win32-x64.exe'
    : 'agent-browser-' + process.platform + '-' + process.arch;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'node_modules', 'agent-browser', 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const browser = agentBrowserBinary();
const skipReason = !existsSync(binary)
  ? 'Build the v3 debug binary before the real inherited-context Reader test.'
  : !browser
    ? 'The agent-browser CLI is required; the test does not install it or download a browser.'
    : false;

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function freePort() {
  return freeFetchSafePort();
}

async function startAxum(t) {
  const fixtureDigest = await digest(fixture);
  const temp = await mkdtemp(path.join(repo, 'tmp', 'v3-inherited-context-ui-real-'));
  const roots = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache']
    .map(name => [name, path.join(temp, name)]));
  await Promise.all(Object.values(roots).map(directory => mkdir(directory)));
  const sessionDir = path.join(roots.codex, 'sessions', '2026', '09', '27');
  await mkdir(sessionDir, { recursive: true });
  const childSource = path.join(sessionDir, path.basename(fixture));
  await copyFile(fixture, childSource);
  assert.equal(await digest(childSource), fixtureDigest, 'the isolated child begins as a byte-identical fixture copy');

  const resolvedTemp = path.resolve(temp);
  const resolvedTmp = path.resolve(repo, 'tmp');
  assert.equal(path.dirname(resolvedTemp), resolvedTmp, 'the test cleanup target stays under repository tmp');
  assert.ok(path.basename(resolvedTemp).startsWith('v3-inherited-context-ui-real-'));
  t.after(async () => {
    await rm(resolvedTemp, { recursive: true, force: true });
    assert.equal(await digest(fixture), fixtureDigest, 'the checked-in public fixture remains unchanged');
  });

  const port = await freePort();
  const args = ['serve', '--port', String(port), '--codex-dir', roots.codex,
    '--opencode-db', path.join(temp, 'missing-opencode.db'), '--claude-dir', roots.claude,
    '--pi-dir', roots.pi, '--dsh-dir', roots.dsh, '--meta-dir', roots.meta,
    '--index-dir', roots.index, '--cache-dir', roots.cache];
  const process = spawn(binary, args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  process.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      const closed = new Promise(resolve => process.once('close', resolve));
      process.kill();
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  });

  const base = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (process.exitCode !== null) throw new Error('The pinned Axum Reader exited before readiness: ' + stderr);
    try {
      if ((await fetch(base + '/api/providers', { signal: AbortSignal.timeout(500) })).ok) {
        return { base, childSource, fixtureDigest };
      }
    } catch { /* Axum is starting and indexing the isolated fixture copy. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The pinned Axum Reader did not become ready: ' + stderr);
}

async function startBrowser(t, url) {
  const session = 'agentsession-v3-inherited-real-' + process.pid + '-' + Date.now();
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', session, ...args], {
      cwd: repo, windowsHide: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('agent-browser ' + args.join(' ') + ' timed out'));
    }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error('agent-browser ' + args.join(' ') + ' failed (' + code + '): ' + (stderr || stdout)));
      else resolve(stdout.trim());
    });
  });
  t.after(async () => { try { await command('close'); } catch { /* Browser may already be closed. */ } });
  await command('open');
  await command('eval', 'window.location.href = ' + JSON.stringify(url));
  return { command };
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForBrowser(command, predicate, description) {
  const deadline = Date.now() + 15_000;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', 'Boolean(' + predicate + ')');
    if (last.includes('true')) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + description + '. Last browser result: ' + last);
}

function inheritedUrl(base, query = {}) {
  const url = new URL('/api/v3/reader/codex/' + childId + '/inherited-context', base);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

test('public Codex inherited context renders and continues in the embedded Axum Reader', {
  skip: skipReason || false,
  timeout: 120_000,
}, async t => {
  const executableDigest = await digest(binary);
  const harness = await startAxum(t);
  const bootstrapResponse = await fetch(harness.base + '/api/v3/reader/codex/' + childId + '/bootstrap');
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.totalItems, 2, 'The child owns only its two message events');
  assert.equal(bootstrap.toc.entries.length, 2, 'The owned outline contains only those two events');
  assert.doesNotMatch(JSON.stringify(bootstrap), /Inherited developer context|Inherited reasoning/,
    'Inherited records stay outside the owned Reader bootstrap');

  const firstListResponse = await fetch(inheritedUrl(harness.base, { limit: 40 }));
  assert.equal(firstListResponse.status, 200);
  const firstList = await firstListResponse.json();
  const secondListResponse = await fetch(inheritedUrl(harness.base,
    { limit: 40, cursor: firstList.nextCursor }));
  assert.equal(secondListResponse.status, 200);
  const secondList = await secondListResponse.json();
  const allRows = [...firstList.items, ...secondList.items];
  const duplicateRows = allRows.filter(item => item.messageId === 'shared-body');
  assert.equal(duplicateRows.length, 2, 'The inherited source repeats shared-body twice');
  const secondDuplicate = duplicateRows[1];
  const toolRow = allRows.find(item => item.messageId === 'tool-call-inherited');
  const expectedToolOutput = 'Inherited tool output ' + 'o'.repeat(3_500);
  assert.ok(toolRow, 'The inherited source includes a tool call with recorded output');
  assert.equal(toolRow.totalChars, expectedToolOutput.length,
    'The list length for the tool row reflects its output field');
  const longRow = allRows.find(item => item.messageId === 'dev-44');
  assert.ok(longRow, 'The public inherited list includes the 13,063-character row');
  assert.equal(longRow.totalChars, 13_063);
  assert.equal(firstList.items.length, 40);
  assert.equal(secondList.items.length, 11);
  assert.equal(secondList.nextCursor, null);

  const { command } = await startBrowser(t, harness.base + '/codex/session/' + childId);
  await waitForBrowser(command,
    "document.querySelector('#reader-title')?.textContent.trim().length > 0",
    'the embedded Codex child Reader');
  assert.equal(await command('eval', "document.querySelector('.inherited-context-details').open"), 'false',
    'The embedded inherited section starts collapsed');
  assert.equal(Number(await command('get', 'count', '.reader-outline nav a')), 2,
    'The real child outline stays at its two owned events');

  await command('click', '.inherited-context-details > summary');
  await waitForBrowser(command,
    "document.querySelectorAll('.inherited-context-item').length === 40",
    'the first embedded inherited page');
  assert.equal(await command('eval', "document.querySelector('.inherited-context-details').open"), 'true',
    'Loading real inherited records preserves the user-opened disclosure');
  assert.equal(Number(await command('get', 'count', '.reader-outline nav a')), 2);
  assert.match(await command('get', 'text', '.inherited-context-source'), new RegExp(parentId),
    'The UI names the recorded parent source');

  const duplicateSelector = '.inherited-context-item[data-ordinal=\"' + secondDuplicate.ordinal + '\"]';
  await command('eval', `document.documentElement.style.scrollBehavior = 'auto'; document.querySelector(${JSON.stringify(duplicateSelector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await command('click', duplicateSelector + ' > .inherited-context-record > summary');
  await waitForBrowser(command,
    'document.querySelector(' + JSON.stringify(duplicateSelector + ' .inherited-context-body') +
      ')?.textContent === ' + JSON.stringify('Inherited developer context 1'),
    'the second shared-body inherited record selected by ordinal');
  assert.equal(JSON.parse(await command('eval', 'document.querySelector(' + JSON.stringify(duplicateSelector) +
    ')?.getAttribute(\"data-message-id\")')), 'shared-body');
  assert.equal(await command('eval', 'document.querySelectorAll(' +
    JSON.stringify(duplicateSelector + ' a[href*=\"#event\"]') + ').length'), '0',
    'The inherited record does not become an owned event link');

  const toolSelector = '.inherited-context-item[data-ordinal="' + toolRow.ordinal + '"]';
  await command('click', toolSelector + ' > .inherited-context-record > summary');
  const outputField = toolSelector + ' .inherited-context-field:nth-child(2)';
  await command('click', outputField + ' > summary');
  const outputButton = outputField + ' button.read-more';
  assert.equal(Number(await command('get', 'count', outputButton)), 1,
    'A tool with a long recorded output exposes its continuation control');
  let toolOffset = 0;
  for (let page = 0; page < 3; page++) {
    const disabled = await command('eval',
      'document.querySelector(' + JSON.stringify(outputButton) + ')?.disabled');
    if (disabled.includes('true')) break;
    await command('click', outputButton);
    toolOffset = Math.min(toolOffset + 2048, expectedToolOutput.length);
    await waitForBrowser(command,
      'Number(document.querySelector(' + JSON.stringify(outputField + ' .content-progress') +
        ')?.textContent.trim().split("/")[0]) === ' + toolOffset,
      'inherited tool output continuation at offset ' + toolOffset);
  }
  assert.equal(toolOffset, expectedToolOutput.length,
    'The Reader requested all bounded chunks of inherited tool output');
  assert.equal(await command('eval',
    'document.querySelector(' + JSON.stringify(outputField + ' pre') +
      ')?.textContent === ' + JSON.stringify(expectedToolOutput)),
  'true', 'The rendered inherited tool output is complete and exact');

  await command('click', '.inherited-context-next');
  await waitForBrowser(command,
    "document.querySelectorAll('.inherited-context-item').length === 51",
    'the final 11 inherited records');
  assert.match(await command('get', 'text', '.inherited-context-count'), /51 of 51/);

  const longSelector = '.inherited-context-item[data-ordinal=\"' + longRow.ordinal + '\"]';
  await command('click', longSelector + ' > .inherited-context-record > summary');
  const bodySelector = JSON.stringify(longSelector + ' .inherited-context-body');
  const progressSelector = JSON.stringify(longSelector + ' .content-progress');
  let offset = 0;
  for (let page = 0; page < 8; page++) {
    const disabled = await command('eval',
      'document.querySelector(' + JSON.stringify(longSelector + ' button.read-more') + ')?.disabled');
    if (disabled.includes('true')) break;
    await command('click', longSelector + ' button.read-more');
    offset = Math.min(offset + 2048, longRow.totalChars);
    await waitForBrowser(command,
      'Number(document.querySelector(' + progressSelector + ')?.textContent.trim().split(\"/\")[0]) === ' + offset,
      'inherited field continuation at offset ' + offset);
  }
  assert.equal(offset, 13_063, 'The UI requested each bounded page through the final character');
  assert.equal(await command('eval',
    'document.querySelector(' + bodySelector + ')?.textContent.length === 13063 && ' +
    'document.querySelector(' + bodySelector + ')?.textContent.endsWith(\"END_OF_PUBLIC_INHERITED_CONTEXT\")'),
  'true', 'The rendered inherited field reaches its exact final marker and length');
  assert.equal(await command('eval',
    'document.querySelectorAll(\".inherited-context-item[id^=event-], .reader-outline nav a\").length === 2'),
  'true', 'The inherited records did not add owned anchors or outline entries');

  assert.equal(await digest(harness.childSource), harness.fixtureDigest,
    'The isolated provider source copy stayed byte-for-byte unchanged');
  assert.equal(await digest(fixture), harness.fixtureDigest,
    'The checked-in public provider fixture stayed byte-for-byte unchanged');
  assert.equal(await digest(binary), executableDigest, 'The pinned build input remained stable during the browser run');
});
