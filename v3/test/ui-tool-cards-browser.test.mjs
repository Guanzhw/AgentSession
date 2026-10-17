import { browserPrerequisites } from './browser-prerequisites.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const ui = path.join(repo, 'v3', 'ui');
const { browserBinary, skip } = browserPrerequisites({ ui });

const fixture = `
<script>
  import EventCard from '/src/lib/EventCard.svelte';
  import { language } from '/src/lib/i18n.ts';
  language.set('en');
  window.toolReads = [];
  const recorded = (id, toolName, metadata) => ({ key: id, anchor: id, item: {
    event: { provider: 'codex', sessionId: 'controlled-tools', messageId: id, segment: 'tool' },
    ordinal: 1, owner: null, role: 'tool', timestamp: 1791565200000,
    preview: 'WRAPPER_JS_PREVIEW_SHOULD_STAY_HIDDEN', totalChars: 30,
    toolName, toolMetadata: metadata, presentationPhase: null, processId: null,
    processCount: null, replyMetadata: null, contentRevisions: {},
  } });
  const ordinary = recorded('command', 'exec_command', {
    summary: 'git status --short', directory: '/recorded/workspace', taskName: null,
    model: null, reasoningEffort: null, forkTurns: null, inputState: 'recorded',
  });
  const encrypted = recorded('encrypted', 'spawn_agent', {
    summary: null, directory: null, taskName: 'reviewer', model: 'gpt-6-luna',
    reasoningEffort: 'high', forkTurns: 'none', inputState: 'encrypted',
  });
  let commandInput;
  let commandOutput;
  let encryptedInput;
  const complete = text => ({ text, hasLoaded: true, totalChars: text.length,
    nextOffset: null, done: true, loading: false, error: '' });
  function read(display, field) {
    window.toolReads.push(display.key + ':' + field);
    if (display.key === 'command') {
      if (field === 'toolInput') commandInput = complete('{"cmd":"git status --short"}');
      else commandOutput = complete('exact output\\nM tracked-file');
    } else encryptedInput = complete('{"message":"gAAAAA_exact_encrypted_source"}');
  }
</script>
<main style="max-width: 900px; margin: 60px auto; display: grid; gap: 12px">
  <EventCard display={ordinary} toolInputProgress={commandInput} toolOutputProgress={commandOutput}
    executionLandmarks={[{ phase: 'completed', label: 'Result returned' }]} onReadMore={read} />
  <EventCard display={encrypted} toolInputProgress={encryptedInput} onReadMore={read} />
</main>`;

test('compact tool disclosure uses keyboard, loads exact fields on demand and keeps encrypted input opt-in',
  { skip, timeout: 60_000 }, async t => {
    const { createServer } = createRequire(path.join(ui, 'package.json'))('vite');
    const port = await freeFetchSafePort();
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'agentsession-v3-tool-card-cache-'));
    t.after(() => rm(cacheDir, { recursive: true, force: true }));
    const fixtureId = path.join(ui, 'tool-card-browser-fixture.svelte').replaceAll('\\', '/');
    const server = await createServer({ root: ui, cacheDir, logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true },
      plugins: [{ name: 'controlled-tool-cards',
        resolveId(id) { if (id === '/tool-card-fixture.svelte' || id === '/tool-card-browser-fixture.svelte') return fixtureId; },
        load(id) { if (id === fixtureId) return fixture; },
        configureServer(devServer) {
          devServer.middlewares.use(async (request, response, next) => {
            if (request.url !== '/controlled-tools') return next();
            const html = await devServer.transformIndexHtml('/controlled-tools',
              '<html><body><div id="app"></div><script type="module">' +
              'import { mount } from "svelte"; import Fixture from "/tool-card-fixture.svelte";' +
              'import "/src/styles.css"; mount(Fixture, { target: document.getElementById("app") });' +
              '</script></body></html>');
            response.setHeader('content-type', 'text/html; charset=utf-8');
            response.end(html);
          });
        },
      }] });
    await server.listen();
    t.after(() => server.close());
    const session = `agentsession-v3-tool-cards-${process.pid}-${Date.now()}`;
    const command = (...args) => new Promise((resolve, reject) => {
      const child = spawn(browserBinary, ['--session', session, ...args],
        { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`agent-browser ${args[0]} timed out`)); }, 15_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout)); });
    });
    t.after(async () => { try { await command('close'); } catch { /* Browser already closed. */ } });
    const evaluate = async expression => JSON.parse(await command('eval', expression));
    const waitFor = async expression => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      throw new Error(`Timed out waiting for ${expression}`);
    };
    await command('open', `http://127.0.0.1:${port}/controlled-tools`);
    await waitFor(`document.querySelectorAll('.tool-card').length === 2`);
    const initial = await evaluate(`({ open: [...document.querySelectorAll('.tool-disclosure')].map(element => element.open),
      heights: [...document.querySelectorAll('.tool-card')].map(element => element.getBoundingClientRect().height),
      text: document.querySelector('main').innerText, reads: window.toolReads })`);
    assert.deepEqual(initial.open, [false, false]);
    assert.ok(initial.heights.every(height => height <= 48), 'each closed card occupies one concise row');
    assert.match(initial.text, /exec_command.*git status --short/s);
    assert.match(initial.text, /Returned result/);
    assert.doesNotMatch(initial.text, /Input|Output|WRAPPER_JS|gAAAAA|Model:/);
    assert.deepEqual(initial.reads, []);

    await command('focus', '#command > .tool-disclosure > summary');
    await command('press', 'Enter');
    await waitFor(`document.querySelector('#command .tool-disclosure').open`);
    assert.deepEqual(await evaluate('window.toolReads'), [], 'outer expansion does not fetch payloads');
    await command('click', '#command .tool-field:last-child > summary');
    await waitFor(`document.querySelector('#command .tool-field:last-child .event-body')?.textContent === 'exact output\\nM tracked-file'`);
    assert.deepEqual(await evaluate('window.toolReads'), ['command:toolOutput']);
    await command('click', '#command .tool-field:first-child > summary');
    await waitFor(`document.querySelector('#command .tool-field:first-child .event-body')?.textContent.includes('git status --short')`);
    assert.deepEqual(await evaluate('window.toolReads'), ['command:toolOutput', 'command:toolInput']);

    await command('click', '#encrypted > .tool-disclosure > summary');
    await command('click', '#encrypted .tool-field:first-child > summary');
    assert.match(await command('get', 'text', '#encrypted'), /The task message is encrypted/);
    assert.deepEqual(await evaluate('window.toolReads'), ['command:toolOutput', 'command:toolInput']);
    await command('click', '#encrypted .technical-raw-input > summary');
    await waitFor(`document.querySelector('#encrypted .technical-raw-input .event-body')?.textContent.includes('gAAAAA_exact_encrypted_source')`);
    assert.deepEqual(await evaluate('window.toolReads'), ['command:toolOutput', 'command:toolInput', 'encrypted:toolInput']);
    await command('focus', '#command > .tool-disclosure > summary');
    await command('press', 'Enter');
    await waitFor(`!document.querySelector('#command .tool-disclosure').open`);
    assert.doesNotMatch(await command('get', 'text', '#command > .tool-disclosure > summary'), /exact output|tracked-file/);
  });
