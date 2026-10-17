import { browserPrerequisites } from './browser-prerequisites.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const ui = path.join(repo, 'v3/ui');
const require = createRequire(path.join(ui, 'package.json'));
const { browserBinary: browser, skip } = browserPrerequisites({ ui });

test('collaboration overview updates when canonical Reader items arrive after recorded relations', {
  timeout: 60_000, skip,
}, async t => {
  const { createServer } = require('vite');
  const event = { provider: 'codex', sessionId: 'canonical-parent', messageId: 'reused-answer', segment: 'message' };
  const rootPreview = 'The canonical parent return identified the missing ownership constraint.';
  const childPreview = 'This is a different child conversation with the same message ID.';
  const entries = [{ type: 'coordination', observation: {
    kind: 'result', state: 'completed', correlationId: 'recorded-call', eventId: 'recorded-return',
    readerEvent: event, fromActorPath: '/root/reviewer', toActorPath: '/root',
    fromSessionRef: null, toSessionRef: { provider: event.provider, sessionId: event.sessionId },
    provenance: { fidelity: 'recorded', sourceType: 'fixture', sourceId: 'result' },
  } }];
  const spawnObservation = (id, fromActorPath, toActorPath) => ({ type: 'coordination', observation: {
    kind: 'spawn', state: 'requested', correlationId: id, eventId: id + '-dispatch',
    fromSessionRef: null, toSessionRef: null, fromActorPath, toActorPath,
    launchRequest: { model: 'requested-model', reasoningEffort: 'max', forkTurns: 'none' },
    provenance: { fidelity: 'recorded', sourceType: 'fixture', sourceId: id },
  } });
  entries.unshift(spawnObservation('recorded-call', '/root', '/root/reviewer'));
  entries.push(spawnObservation('writer-call', '/root', '/root/writer'));
  entries.push(spawnObservation('nested-call', '/root/reviewer', '/root/reviewer/checker'));
  const item = {
    event, ordinal: 0, owner: null, role: 'agent', timestamp: null,
    preview: rootPreview, totalChars: rootPreview.length, toolName: null,
    presentationPhase: null, processId: null, processCount: null, replyMetadata: null, contentRevisions: {},
  };
  const childItem = { ...item, event: { ...event, sessionId: 'different-child' },
    preview: childPreview, totalChars: childPreview.length };
  const work = await mkdtemp(path.join(repo, 'tmp', 'timeline-reactivity-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const fixturePath = path.join(work, 'TimelineFixture.svelte');
  await writeFile(fixturePath, `<script>
    import Timeline from ${JSON.stringify(path.join(ui, 'src/lib/CollaborationTimeline.svelte').replaceAll('\\', '/'))};
    import ${JSON.stringify(path.join(ui, 'src/styles.css').replaceAll('\\', '/'))};
    const entries=${JSON.stringify(entries)};
    const rootItem=${JSON.stringify(item)};
    const childItem=${JSON.stringify(childItem)};
    let items=[];
    </script>
    <button class="fixture-load-root" onclick={()=>items=[rootItem]}>Load parent Reader items</button>
    <button class="fixture-load-child" onclick={()=>items=[childItem]}>Replace with child Reader items</button>
    <div style="width:460px;margin:24px"><Timeline {entries} {items} session={rootItem.event} complete /></div>`);
  const server = await createServer({ root: ui, appType: 'custom', logLevel: 'error',
    server: { host: '127.0.0.1', port: await freeFetchSafePort(), strictPort: true, fs: { allow: [repo] } } });
  server.middlewares.use(async (request, response, next) => {
    if (request.url !== '/timeline-reactivity') return next();
    response.setHeader('content-type', 'text/html');
    response.end(await server.transformIndexHtml(request.url, `<!doctype html><html><body>
      <div id="fixture"></div><script type="module">import {mount} from 'svelte';
      import Fixture from ${JSON.stringify('/@fs/' + fixturePath.replaceAll('\\', '/'))};
      mount(Fixture,{target:document.querySelector('#fixture')});</script></body></html>`));
  });
  await server.listen();
  t.after(() => server.close());
  const session = `timeline-reactivity-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', session, ...args], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('agent-browser command timed out')); }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code ? reject(new Error(stderr || stdout)) : resolve(stdout.trim()); });
  });
  t.after(async () => { try { await command('close'); } catch {} });
  await command('open', server.resolvedUrls.local[0] + 'timeline-reactivity');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await command('eval', "Boolean(document.querySelector('.collaboration-child-node'))") === 'true') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await command('eval', "document.querySelectorAll('.collaboration-return').length"), '0', 'graph starts without task or result prose');
  assert.equal(await command('eval', "document.querySelectorAll('.collaboration-parent').length"), '2', 'nested delegation keeps its own recorded sender branch');
  assert.equal(await command('eval', "document.querySelectorAll('.collaboration-child-node').length"), '3');
  assert.equal(await command('eval', "document.querySelector('.collaboration-timeline').scrollWidth <= document.querySelector('.collaboration-timeline').clientWidth"), 'true', 'graph fits a desktop side panel');
  await command('click', '.collaboration-child-node');
  assert.equal(await command('eval', "document.querySelectorAll('.collaboration-return p').length"), '0', 'recorded result arrives before its Reader preview');
  assert.equal(await command('eval', "document.querySelector('.collaboration-source-details').open"), 'false', 'technical details start closed');
  const returnHref = JSON.parse(await command('eval', "document.querySelector('.collaboration-return a').getAttribute('href')"));
  assert.match(returnHref, /\/codex\/session\/canonical-parent#event\?messageId=reused-answer&segment=message/);
  await command('click', '.fixture-load-root');
  assert.equal(JSON.parse(await command('eval', "document.querySelector('.collaboration-return p')?.textContent")), rootPreview,
    'late items update the existing overview without changing relation records');
  await command('click', '.fixture-load-child');
  assert.equal(await command('eval', "document.querySelectorAll('.collaboration-return p').length"), '0',
    'the same message ID in another canonical session cannot replace the parent preview');
  assert.equal(await command('eval', `document.querySelector('.collaboration-timeline').textContent.includes(${JSON.stringify(childPreview)})`), 'false');
  await command('click', '.fixture-load-root');
  assert.equal(JSON.parse(await command('eval', "document.querySelector('.collaboration-return p')?.textContent")), rootPreview, 'parent preview returns after another item update');
  assert.equal(await command('eval', "document.querySelector('.collaboration-source-details').open"), 'false', 'content updates retain collapsed technical details');
  await command('click', '.collaboration-source-details summary');
  assert.equal(await command('eval', "document.querySelector('.collaboration-source-details').textContent.includes('requested-model')"), 'true', 'recorded requested configuration stays available through disclosure');
  await command('click', '.collaboration-source-details summary');
  await command('click', '[data-collaboration-handoff="writer-call"] .collaboration-child-node');
  assert.equal(await command('eval', "document.querySelectorAll('.collaboration-selected-details').length"), '1', 'only the selected agent details expand');
  assert.equal(await command('eval', "document.querySelector('[data-collaboration-handoff=\"recorded-call\"] .collaboration-child-node').getAttribute('aria-expanded')"), '"false"');
});
