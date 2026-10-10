import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = path.join(repo, 'v3', 'fixtures');
const fixtures = [
  { kind: 'execution', id: '88888888-8888-4888-8888-888888888888', file: path.join(fixtureRoot,
    'codex-execution', 'sessions', '2026', '09', '27', 'rollout-2026-09-27T01-00-00-88888888-8888-4888-8888-888888888888.jsonl') },
  { kind: 'process', id: '99999999-9999-4999-8999-999999999999', file: path.join(fixtureRoot,
    'codex-process', 'sessions', '2026', '09', '27', 'rollout-2026-09-27T03-00-00-99999999-9999-4999-8999-999999999999.jsonl') },
  { kind: 'long', id: '66666666-6666-4666-8666-666666666666', file: path.join(fixtureRoot,
    'codex-execution-reader', 'sessions', '2026', '09', '27', 'rollout-2026-09-27T04-00-00-66666666-6666-4666-8666-666666666666.jsonl') },
];
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3', 'target', 'debug',
  process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const ref = sessionId => ({ provider: 'codex', sessionId });

function agentBrowserBinary() {
  const override = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN;
  if (override && existsSync(override)) return override;
  const binaryName = process.platform === 'win32'
    ? 'agent-browser-win32-x64.exe'
    : `agent-browser-${process.platform}-${process.arch}`;
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(entry, 'node_modules', 'agent-browser', 'bin', binaryName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const agentBrowserExe = agentBrowserBinary();
const skipBrowser = agentBrowserExe ? false
  : 'The existing agent-browser CLI binary is required; this test does not install it or download a browser.';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  return freeFetchSafePort();
}

async function safeRemoveScratch(scratch) {
  const tmpRoot = await realpath(path.join(repo, 'tmp'));
  const resolved = await realpath(scratch);
  assert.equal(path.dirname(resolved), tmpRoot,
    'Scratch cleanup must stay directly under the repository tmp directory');
  assert.match(path.basename(resolved), /^v3-codex-execution-reader-/,
    'Scratch cleanup must target only this test-created corpus');
  await rm(resolved, { recursive: true, force: true });
}

async function isolatedCorpus(t) {
  await mkdir(path.join(repo, 'tmp'), { recursive: true });
  const scratch = await mkdtemp(path.join(repo, 'tmp', 'v3-codex-execution-reader-'));
  const codexDir = path.join(scratch, 'codex');
  const sourceHashes = fixtures.map(({ file }) => sha256(file));
  const sessionDir = path.join(codexDir, 'sessions', '2026', '09', '27');
  await mkdir(sessionDir, { recursive: true });
  const copiedFiles = [];
  for (const { file } of fixtures) {
    const copied = path.join(sessionDir, path.basename(file));
    await copyFile(file, copied);
    copiedFiles.push(copied);
  }
  const copiedHashes = copiedFiles.map(sha256);
  t.after(async () => {
    try {
      assert.deepEqual(fixtures.map(({ file }) => sha256(file)), sourceHashes,
        'The real Web process must leave public fixtures unchanged');
      assert.deepEqual(copiedFiles.map(sha256), copiedHashes,
        'The real Web process must leave its isolated provider-source copies unchanged');
    } finally {
      await safeRemoveScratch(scratch);
    }
  });
  return { scratch, codexDir };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

async function startServer(t, scratch, codexDir) {
  assert.ok(existsSync(binary), `The pinned AgentSession 3.0 binary must exist at ${binary}`);
  for (const name of ['meta', 'index', 'cache', 'claude', 'pi', 'dsh']) {
    await mkdir(path.join(scratch, name));
  }
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port),
    '--codex-dir', codexDir,
    '--opencode-db', path.join(scratch, 'opencode.db'),
    '--claude-dir', path.join(scratch, 'claude'),
    '--pi-dir', path.join(scratch, 'pi'),
    '--dsh-dir', path.join(scratch, 'dsh'),
    '--meta-dir', path.join(scratch, 'meta'),
    '--index-dir', path.join(scratch, 'index'),
    '--cache-dir', path.join(scratch, 'cache')], {
    cwd: repo,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let processOutput = '';
  child.stdout.on('data', chunk => { processOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { processOutput += chunk.toString(); });
  let browserCleanup;
  t.after(async () => {
    try {
      try { await browserCleanup?.(); } finally { await stopProcess(child); }
    } finally {
      assert.ok(child.exitCode !== null || child.signalCode !== null,
        'The isolated Axum process must stop before scratch cleanup');
    }
  });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/api/providers`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch { /* Axum may still be indexing the isolated fixtures. */ }
    await sleep(100);
  }
  assert.ok(ready, `The isolated Axum server did not become ready: ${processOutput}`);
  return {
    origin,
    setBrowserCleanup(cleanup) { browserCleanup = cleanup; },
  };
}

async function getJson(url, message) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, `${message}: ${JSON.stringify(body)}`);
  return body;
}

function startBrowser(harness, url) {
  const session = `agentsession-v3-execution-reader-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(agentBrowserExe, ['--session', session, ...args], {
      cwd: repo,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`agent-browser ${args.join(' ')} timed out after 15 seconds`));
    }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => finish(error));
    child.once('exit', code => {
      if (code !== 0) {
        finish(new Error(`agent-browser ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
        return;
      }
      finish(undefined, stdout.trim());
    });
  });
  harness.setBrowserCleanup(async () => {
    try { await command('close'); } catch { /* Cleanup is best effort after a browser assertion fails. */ }
  });
  return (async () => {
    await command('open');
    await command('eval', `window.location.href = ${JSON.stringify(url)}`);
    return command;
  })();
}

async function waitForBrowser(command, predicate, description, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', `Boolean(${predicate})`);
    if (last.includes('true')) return;
    await sleep(75);
  }
  throw new Error(`Timed out waiting for ${description}. Last browser result: ${last}`);
}

async function openReader(command, origin, sessionId) {
  const href = `/codex/session/${sessionId}`;
  await command('eval', `window.location.href = ${JSON.stringify(`${origin}${href}`)}`);
  await waitForBrowser(command,
    `window.location.pathname === '${href}' && document.querySelector('.reader-heading h1')`,
    `the real Codex Reader ${sessionId}`);
}

async function readerSurface(command) {
  await command('eval', `document.querySelectorAll('.reader-process:not([open])').forEach(details => details.querySelector(':scope > summary')?.click())`);
  return JSON.parse(await command('eval', `(() => {
    const transcript = document.querySelector('[aria-label="Session transcript"]');
    const cards = [...(transcript?.querySelectorAll('article') ?? [])].map(card => ({
      source: card.dataset.segment === 'tool' ? card.dataset.messageId + ' / tool' : null,
      visibleText: card.innerText,
      fullText: card.textContent,
      rowPhase: card.querySelector('.tool-row .tool-execution-phase')?.dataset.phase ?? null,
    }));
    return { pathname: window.location.pathname, transcriptText: transcript?.innerText ?? '', cards };
  })()`));
}

async function apiExecutionFacts(origin, { id, expected }) {
  const prefix = `${origin}/api/v3/reader/codex/${id}`;
  const bootstrap = await getJson(`${prefix}/bootstrap`, `Reader bootstrap ${id}`);
  assert.deepEqual(bootstrap.session.session, ref(id));
  const protocol = await getJson(`${origin}/api/v3/protocol/codex/${id}?version=3`, `Protocol v3 ${id}`);
  assert.equal(protocol.coverage.execution.state, 'observed');
  const events = protocol.events.filter(event => event.execution);
  const facts = events.map(event => [event.sourceOrder.record, event.execution.id, event.execution.kind,
    event.execution.phase, event.execution.handle, event.execution.toolName,
    event.readerEvent?.messageId ?? null, event.readerEvent?.segment ?? null]);
  assert.deepEqual(facts, expected, `${id} API execution facts stay anchored to their source tool events`);
  const readerEvents = new Set(bootstrap.segments.flatMap(segment => segment.items)
    .filter(item => item.role === 'tool').map(item => `${item.event.messageId}/${item.event.segment}`));
  for (const event of events) {
    assert.ok(readerEvents.has(`${event.readerEvent.messageId}/${event.readerEvent.segment}`),
      `${id} exposes the protocol source event ${event.readerEvent.messageId} in Reader`);
  }
  return { bootstrap, protocol };
}

function sourceTool(surface, messageId) {
  return surface.cards.find(card => card.source === `${messageId} / tool`) ?? null;
}

function fixtureToolOutput(fixture, callId) {
  const row = readFileSync(fixture.file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .find(item => /^(?:function_call_output|custom_tool_call_output)$/.test(item.payload?.type) && item.payload.call_id === callId);
  assert.ok(row, `${fixture.id} records output for ${callId}`);
  return row.payload.output;
}

async function openToolOutput(command, messageId, expectedOutput) {
  const result = JSON.parse(await command('eval', `(() => {
    const card = [...document.querySelectorAll('article')].find(candidate =>
      candidate.dataset.segment === 'tool' && candidate.dataset.messageId === ${JSON.stringify(messageId)});
    if (!card) return { found: false };
    card.querySelector('.tool-disclosure').open = true;
    const field = [...card.querySelectorAll('details')].find(detail =>
      detail.querySelector('summary')?.textContent.trim().toLowerCase() === 'output');
    if (!field) return { found: true, field: false };
    field.open = true;
    const body = field.querySelector('.event-body');
    return { found: true, field: true, text: body?.textContent ?? '',
      button: [...field.querySelectorAll('button')].map(button => button.textContent.trim()).find(Boolean) ?? null };
  })()`));
  if (!result.found || !result.field) return result;

  await waitForBrowser(command, `(() => {
    const card = [...document.querySelectorAll('article[data-segment="tool"]')].find(card => card.dataset.messageId === ${JSON.stringify(messageId)});
    const field = [...card.querySelectorAll('.tool-field')].find(detail => detail.querySelector('summary')?.textContent.trim().toLowerCase() === 'output');
    return Boolean(field?.querySelector('.event-body'));
  })()`, `the first loaded output page for ${messageId}`);
  result.text = JSON.parse(await command('eval', `(() => {
    const card = [...document.querySelectorAll('article[data-segment="tool"]')].find(card => card.dataset.messageId === ${JSON.stringify(messageId)});
    return [...card.querySelectorAll('.tool-field')].find(detail => detail.querySelector('summary')?.textContent.trim().toLowerCase() === 'output')?.querySelector('.event-body')?.textContent ?? '';
  })()`));

  for (let page = 0; result.text !== expectedOutput && page < 10; page++) {
    const clicked = await command('eval', `(() => {
      const card = [...document.querySelectorAll('article')].find(candidate =>
        candidate.dataset.segment === 'tool' && candidate.dataset.messageId === ${JSON.stringify(messageId)});
      const field = [...(card?.querySelectorAll('details') ?? [])].find(detail =>
        detail.querySelector('summary')?.textContent.trim().toLowerCase() === 'output');
      const button = [...(field?.querySelectorAll('button') ?? [])].find(candidate => !candidate.disabled);
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked.includes('true')) break;
    await waitForBrowser(command, `(() => {
      const card = [...document.querySelectorAll('article')].find(candidate =>
        candidate.dataset.segment === 'tool' && candidate.dataset.messageId === ${JSON.stringify(messageId)});
      const field = [...(card?.querySelectorAll('details') ?? [])].find(detail =>
        detail.querySelector('summary')?.textContent.trim().toLowerCase() === 'output');
      const body = field?.querySelector('.event-body');
      return body?.textContent.length >= ${Math.min(expectedOutput.length, (page + 1) * 1000)};
    })()`, `tool output page ${page + 1} for ${messageId}`);
    Object.assign(result, JSON.parse(await command('eval', `(() => {
      const card = [...document.querySelectorAll('article')].find(candidate =>
        candidate.dataset.segment === 'tool' && candidate.dataset.messageId === ${JSON.stringify(messageId)});
      const field = [...(card?.querySelectorAll('details') ?? [])].find(detail =>
        detail.querySelector('summary')?.textContent.trim().toLowerCase() === 'output');
      return { text: field?.querySelector('.event-body')?.textContent ?? '',
        button: [...(field?.querySelectorAll('button') ?? [])].map(candidate => candidate.textContent.trim()).find(Boolean) ?? null };
    })()`)));
  }
  return result;
}

test('public Codex execution facts have two visible Reader endpoints and retain complete result evidence',
  { skip: skipBrowser, timeout: 120_000 }, async t => {
    assert.ok(existsSync(binary), `Use the pinned current AgentSession binary at ${binary}`);
    const binaryHash = sha256(binary);
    t.diagnostic(`Pinned AgentSession binary SHA-256: ${binaryHash}`);
    const corpus = await isolatedCorpus(t);
    const harness = await startServer(t, corpus.scratch, corpus.codexDir);

    await apiExecutionFacts(harness.origin, { id: fixtures[0].id, expected: [
      [2, 'outer-1', 'async-tool', 'started', '65', 'exec', 'outer-1', 'tool'],
      [3, 'outer-1', 'async-tool', 'yielded', '65', 'exec', 'outer-1', 'tool'],
      [5, 'outer-1', 'async-tool', 'polled', '65', 'wait', 'wait-1', 'tool'],
      [6, 'outer-1', 'async-tool', 'completed', '65', 'wait', 'wait-1', 'tool'],
    ] });
    await apiExecutionFacts(harness.origin, { id: fixtures[1].id, expected: [
      [1, 'command', 'process', 'started', '97155', 'exec_command', 'command', 'tool'],
      [2, 'command', 'process', 'yielded', '97155', 'exec_command', 'command', 'tool'],
      [3, 'command', 'process', 'polled', '97155', 'write_stdin', 'poll', 'tool'],
      [4, 'command', 'process', 'yielded', '97155', 'write_stdin', 'poll', 'tool'],
      [5, 'command', 'process', 'input', '97155', 'write_stdin', 'input', 'tool'],
      [6, 'command', 'process', 'yielded', '97155', 'write_stdin', 'input', 'tool'],
      [7, 'command', 'process', 'interruption-requested', '97155', 'write_stdin', 'stop', 'tool'],
      [8, 'command', 'process', 'completed', '97155', 'write_stdin', 'stop', 'tool'],
    ] });
    await apiExecutionFacts(harness.origin, { id: fixtures[2].id, expected: [
      [2, 'reader-start', 'async-tool', 'started', '65', 'exec', 'reader-start', 'tool'],
      [3, 'reader-start', 'async-tool', 'yielded', '65', 'exec', 'reader-start', 'tool'],
      [5, 'reader-start', 'async-tool', 'polled', '65', 'wait', 'reader-wait', 'tool'],
      [6, 'reader-start', 'async-tool', 'completed', '65', 'wait', 'reader-wait', 'tool'],
      [8, 'reader-missing', 'async-tool', 'started', '73', 'exec', 'reader-missing', 'tool'],
      [9, 'reader-missing', 'async-tool', 'yielded', '73', 'exec', 'reader-missing', 'tool'],
    ] });

    const failures = [];
    const command = await startBrowser(harness, `${harness.origin}/codex/session/${fixtures[0].id}`);
    await waitForBrowser(command,
      `window.location.pathname === '/codex/session/${fixtures[0].id}' && document.querySelector('.reader-heading h1')`,
      'the outer execution Reader');
    const outer = await readerSurface(command);
    const outerStart = sourceTool(outer, 'outer-1');
    const outerWait = sourceTool(outer, 'wait-1');
    if (!outerStart) failures.push('The source exec tool event is not present in Reader.');
    if (!outerWait) {
      failures.push('The actual wait tool event is absent from Reader.');
    }
    if (outerStart) await openToolOutput(command, 'outer-1', fixtureToolOutput(fixtures[0], 'outer-1'));
    if (outerWait) await openToolOutput(command, 'wait-1', fixtureToolOutput(fixtures[0], 'wait-1'));
    const outerAfterOutput = await readerSurface(command);
    const outerVisible = outerAfterOutput.transcriptText;
    const mainline = outerVisible.indexOf('The outer job is still running. I can continue the main line.');
    const yieldLabel = outerVisible.indexOf('Continued in the background');
    const resultLabel = outerVisible.indexOf('Result returned');
    const yieldedOutput = outerVisible.indexOf('Script running with cell ID 65');
    const returnedOutput = outerVisible.indexOf('Recorded outer result.');
    const finalReply = outerVisible.indexOf('The recorded outer job completed.');
    if (mainline < 0) failures.push('The ordinary assistant message between yield and wait is not visible.');
    if (yieldLabel < 0 || yieldedOutput < 0 || yieldLabel < yieldedOutput ||
      (mainline >= 0 && yieldLabel > mainline)) {
      failures.push('The source exec tool has no visible background-yield landmark before intervening assistant work.');
    }
    if (resultLabel < 0 || returnedOutput < 0 || resultLabel < returnedOutput ||
      (finalReply >= 0 && resultLabel > finalReply)) {
      failures.push('The actual wait endpoint has no visible returned-result landmark after its saved output.');
    }

    const forward = await command('eval', `(() => {
      const source = [...document.querySelectorAll('article')].find(card =>
        card.dataset.segment === 'tool' && card.dataset.messageId === 'outer-1');
      const control = source?.querySelector('[data-execution-counterpart="wait-1"]');
      control?.click();
      return Boolean(control);
    })()`);
    if (!forward.includes('true')) {
      failures.push('The background handoff has no source-linked control to open its recorded return.');
    } else {
      await waitForBrowser(command, `window.location.hash.includes('messageId=wait-1') &&
        Boolean(document.querySelector('[data-execution-counterpart="outer-1"]'))`,
      'the recorded return counterpart');
      const backward = await command('eval', `(() => {
        const returnCard = [...document.querySelectorAll('article')].find(card =>
          card.dataset.segment === 'tool' && card.dataset.messageId === 'wait-1');
        const control = returnCard?.querySelector('[data-execution-counterpart="outer-1"]');
        control?.click();
        return Boolean(control);
      })()`);
      if (!backward.includes('true')) failures.push('The recorded return cannot navigate back to its handoff.');
      else await waitForBrowser(command, `window.location.hash.includes('messageId=outer-1')`,
        'the original background handoff');
    }

    await openReader(command, harness.origin, fixtures[1].id);
    const processInitial = await readerSurface(command);
    const processExpectedOutput = fixtureToolOutput(fixtures[1], 'stop');
    const processLoadedOutput = sourceTool(processInitial, 'stop')
      ? await openToolOutput(command, 'stop', processExpectedOutput)
      : { found: false };
    if (!processLoadedOutput.found || !processLoadedOutput.field || processLoadedOutput.text !== processExpectedOutput) {
      failures.push('The direct process result cannot be read completely from its actual write_stdin endpoint.');
    }
    const process = await readerSurface(command);
    const processStop = sourceTool(process, 'stop');
    if (!processStop || !processStop.fullText.includes('full output')) {
      failures.push('The completed direct process result is not shown at the write_stdin event that recorded it.');
    }
    const processOutput = process.transcriptText.indexOf('full output');
    const processReturn = process.transcriptText.indexOf('Result returned');
    if (processReturn < 0 || processOutput < 0 || processReturn < processOutput) {
      failures.push('The completed direct process endpoint has no visible returned-result landmark after its saved output.');
    }

    await openReader(command, harness.origin, fixtures[2].id);
    const long = await readerSurface(command);
    if (!long.transcriptText.includes('The main conversation kept moving while the job ran.')) {
      failures.push('The long-result Reader omits ordinary assistant work between its source and wait events.');
    }
    const missingTool = sourceTool(long, 'reader-missing');
    const missingVisible = missingTool?.rowPhase === 'unknown' && /unknown outcome/i.test(missingTool.visibleText);
    if (!missingVisible) failures.push('The yielded execution with no return is not explicitly presented as unknown/unreturned.');

    const expectedOutput = fixtureToolOutput(fixtures[2], 'reader-wait');
    const loaded = await openToolOutput(command, 'reader-wait', expectedOutput);
    if (!loaded.found || !loaded.field || loaded.text !== expectedOutput) {
      failures.push(`The actual wait tool output cannot be read completely (${loaded.text?.length ?? 0}/${expectedOutput.length} characters).`);
    }

    assert.equal(sha256(binary), binaryHash, 'The pinned current binary stays unchanged during the red acceptance run');
    assert.deepEqual(failures, [], 'Reader execution presentation acceptance findings');
  });
