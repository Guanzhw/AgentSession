import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const ui = path.join(repo, 'v3/ui');
const require = createRequire(path.join(ui, 'package.json'));
const { createServer } = require('vite');
const binaryName = process.platform === 'win32' ? 'agent-browser-win32-x64.exe' : `agent-browser-${process.platform}-${process.arch}`;
const browser = process.env.AGENTSESSION_V3_AGENT_BROWSER_BIN || (process.env.PATH || '').split(path.delimiter)
  .map(entry => path.join(entry, 'node_modules/agent-browser/bin', binaryName)).find(existsSync);

test('transcript gutter follows collapsed execution and returns to the canonical dispatch', {
  timeout: 60_000, skip: !browser && 'agent-browser native binary is unavailable',
}, async t => {
  const event = (messageId, segment = 'message') => ({ provider: 'codex', sessionId: 'parent', messageId, segment });
  const entries = [
    { type: 'coordination', observation: { kind: 'spawn', state: 'started', correlationId: 'call-1', eventId: 'dispatch', readerEvent: event('dispatch', 'tool'), fromActorPath: '/root', toActorPath: '/root/reviewer', fromSessionRef: null, toSessionRef: null } },
    { type: 'coordination', observation: { kind: 'result', state: 'completed', correlationId: 'call-1', eventId: 'return', readerEvent: event('return'), fromActorPath: '/root/reviewer', toActorPath: '/root', fromSessionRef: null, toSessionRef: null } },
  ];
  const parallelEntries = ['reviewer', 'auditor', 'researcher'].flatMap((name, index) => [
    { type: 'coordination', observation: { kind: 'spawn', state: 'started', correlationId: `parallel-${index}`, eventId: `dispatch-${index}`, readerEvent: event(`dispatch-${index}`, 'tool'), fromActorPath: '/root', toActorPath: `/root/${name}`, fromSessionRef: null, toSessionRef: null } },
    { type: 'coordination', observation: { kind: 'result', state: 'completed', correlationId: `parallel-${index}`, eventId: `return-${index}`, readerEvent: event(`return-${index}`), fromActorPath: `/root/${name}`, toActorPath: '/root', fromSessionRef: null, toSessionRef: null } },
  ]);
  const pendingEntries = [
    ...parallelEntries.filter(entry => entry.observation.kind === 'spawn').slice(0, 2),
    parallelEntries.find(entry => entry.observation.eventId === 'return-0'),
  ];
  const server = await createServer({ root: ui, appType: 'custom', logLevel: 'error',
    server: { host: '127.0.0.1', port: await freeFetchSafePort(), strictPort: true } });
  server.middlewares.use(async (request, response, next) => {
    if (!['/gutter-fixture', '/parallel-fixture', '/pending-fixture'].includes(request.url)) return next();
    const parallel = request.url === '/parallel-fixture';
    const pending = request.url === '/pending-fixture';
    response.setHeader('content-type', 'text/html');
    response.end(await server.transformIndexHtml(request.url, `<!doctype html><html><head><style>
      :root { --muted:#555; --line:#aaa; --paper:#fff; --blue:#369; }
      .transcript {position:relative;padding-left:100px;margin:40px;width:500px}
      article {padding:20px;border:1px solid #ccc;margin:20px 0} summary{padding:10px}
      .inline-child-transcript {padding:20px} #return-card{margin-top:120px}
      </style></head><body><div class="transcript"><div id="overlay"></div>${pending ? `
      <details id="process" open><summary>Pending parallel dispatches</summary>${[0, 1].map(index => `<article style="height:150px" data-message-id="dispatch-${index}" data-segment="tool">Dispatch ${index}</article>`).join('')}</details>` : parallel ? `
      <details id="process"><summary>Parallel dispatches</summary>${[0, 1, 2].map(index => `<article style="height:150px" data-message-id="dispatch-${index}" data-segment="tool">Dispatch ${index}</article>`).join('')}</details>
      ${[0, 1, 2].map(index => `<article data-message-id="return-${index}" data-segment="message">Return ${index}</article>`).join('')}` : `
      <details id="process"><summary>Execution process</summary><article data-message-id="dispatch" data-segment="tool">Recorded dispatch</article></details>
      <div class="inline-child-transcript"><article data-message-id="return" data-segment="message">A child with a reused message ID</article></div>
      <article id="return-card" data-message-id="return" data-segment="message">Returned agent answer</article>`}</div>
      <script type="module">import {mount} from 'svelte';import Gutter from '/src/lib/TranscriptCollaboration.svelte';
      mount(Gutter,{target:document.querySelector('#overlay'),props:{entries:${JSON.stringify(pending ? pendingEntries : parallel ? parallelEntries : entries)},provider:'codex',sessionId:'parent',host:document.querySelector('.transcript'),onNavigate:event=>{window.returnedEvent=event}}});</script></body></html>`));
  });
  await server.listen();
  t.after(() => server.close());
  const url = server.resolvedUrls.local[0] + 'gutter-fixture';
  const session = `transcript-gutter-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', session, ...args], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code ? reject(new Error(stderr || stdout)) : resolve(stdout.trim()));
  });
  t.after(async () => { try { await command('close'); } catch {} });
  await command('open', url);
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await command('eval', "Boolean(document.querySelector('[data-collaboration-connector]'))") === 'true') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const geometry = JSON.parse(await command('eval', `(() => {const root=document.querySelector('.transcript').getBoundingClientRect();
    return {path:document.querySelector('[data-collaboration-connector]').getAttribute('d'),
      summary:document.querySelector('#process>summary').getBoundingClientRect().top-root.top+18,
      returned:document.querySelector('#return-card').getBoundingClientRect().top-root.top+18,
      href:document.querySelector('.return-point').getAttribute('href'),
      label:document.querySelector('.return-point').getAttribute('aria-label')};})()`));
  assert.match(geometry.path, new RegExp(`M 88 ${geometry.summary} `));
  assert.ok(geometry.path.endsWith(` ${geometry.returned} H 88`), 'root return ignores duplicate IDs inside the child transcript');
  assert.match(geometry.href, /messageId=dispatch&segment=tool/);
  assert.match(geometry.label, /\/root\/reviewer/);
  await command('eval', "document.querySelector('.return-point').click()");
  assert.deepEqual(JSON.parse(await command('eval', 'window.returnedEvent')), event('dispatch', 'tool'));
  await command('eval', "document.querySelector('#process').open=true");
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.notEqual(await command('eval', "document.querySelector('[data-collaboration-connector]').getAttribute('d')"), JSON.stringify(geometry.path));
  assert.equal(await command('eval', "document.querySelector('#process').open"), 'true');
  await command('eval', "document.querySelector('#process').append(document.querySelector('#return-card'));document.querySelector('#process').open=false");
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await command('eval', "document.querySelectorAll('[data-collaboration-connector]').length"), '0', 'equal collapsed anchors do not draw a reversed curve');
  assert.equal(await command('eval', "document.querySelectorAll('.collaboration-gutter-point').length"), '1', 'one return-to-dispatch control remains');
  await command('eval', `window.location.href=${JSON.stringify(server.resolvedUrls.local[0] + 'parallel-fixture')}`);
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await command('eval', "document.querySelectorAll('[data-collaboration-connector]').length") === '3') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const readControls = () => command('eval', `(() => {const controls=[...document.querySelectorAll('.collaboration-gutter-point')].filter(item=>item.getClientRects().length);
    const boxes=controls.map(item=>item.getBoundingClientRect()); return {count:controls.length,overlaps:boxes.some((a,i)=>boxes.slice(i+1).some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)),overlay:document.querySelector('.transcript-collaboration').getBoundingClientRect().height,flow:document.querySelector('.transcript').clientHeight};})()`);
  const collapsed = JSON.parse(await readControls());
  assert.equal(collapsed.overlaps, false, 'parallel collapsed dispatches have distinct usable controls');
  assert.equal(collapsed.count, 4, 'one shared dispatch hub and three return controls');
  await command('eval', "document.querySelector('.collaboration-gutter-group > summary').click()");
  const choices = JSON.parse(await command('eval', "[...document.querySelectorAll('.collaboration-gutter-choices a')].map(link=>({label:link.textContent,href:link.getAttribute('href')}))"));
  assert.equal(choices.length, 3);
  for (let index = 0; index < 3; index++) {
    assert.match(choices[index].label, new RegExp(['reviewer', 'auditor', 'researcher'][index]));
    assert.match(choices[index].href, new RegExp(`messageId=return-${index}&segment=message`));
    await command('eval', "document.querySelector('.collaboration-gutter-group').open=true");
    await command('eval', `document.querySelectorAll('.collaboration-gutter-choices a')[${index}].focus()`);
    await command('press', 'Enter');
    assert.deepEqual(JSON.parse(await command('eval', 'window.returnedEvent')), event(`return-${index}`));
    assert.equal(await command('eval', "document.querySelector('.collaboration-gutter-group').open"), 'false', 'selection closes the endpoint menu');
  }
  await command('eval', "document.querySelector('.collaboration-gutter-group').open=false;document.querySelector('#process').open=true");
  await new Promise(resolve => setTimeout(resolve, 250));
  const expanded = JSON.parse(await readControls());
  assert.equal(expanded.count, 6, 'expanded dispatches expose every independent canonical endpoint');
  assert.equal(expanded.overlaps, false);
  assert.ok(expanded.flow > collapsed.flow + 300, 'expanded work contributes normal-flow height');
  await command('eval', "document.querySelector('#process').open=false");
  await new Promise(resolve => setTimeout(resolve, 250));
  const recollapsed = JSON.parse(await readControls());
  assert.equal(recollapsed.flow, collapsed.flow);
  assert.equal(recollapsed.overlay, recollapsed.flow, 'absolute overlay shrinks with normal-flow content after collapse');
  await command('open', server.resolvedUrls.local[0] + 'pending-fixture');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await command('eval', "document.querySelectorAll('[data-collaboration-connector]').length") === '2') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const readPending = () => command('eval', `(() => ({
    paths:[...document.querySelectorAll('[data-collaboration-connector]')].map(item=>({d:item.getAttribute('d'),lane:item.dataset.collaborationLane,color:item.style.stroke,open:item.classList.contains('open-span')})),
    markers:[...document.querySelectorAll('.collaboration-gutter-point')].map(item=>({label:item.getAttribute('aria-label'),href:item.getAttribute('href'),color:item.style.color,icon:item.querySelector('path')?.getAttribute('d')}))
  }))()`);
  const pending = JSON.parse(await readPending());
  assert.deepEqual(pending.paths.map(item => item.lane), ['0', '1'], 'adjacent pending dispatches retain separate lanes');
  assert.ok(pending.paths.every(item => item.open && / V [\d.]+$/.test(item.d)), 'pending lines finish as short continuation stubs, with no invented return endpoint');
  assert.equal(pending.markers.length, 2);
  assert.match(pending.markers[0].label, /reviewer/);
  assert.match(pending.markers[1].label, /auditor/);
  assert.notEqual(pending.markers[0].color, pending.markers[1].color);
  assert.notEqual(pending.markers[0].icon, pending.markers[1].icon);
  assert.match(pending.markers[0].href, /messageId=return-0/);
  assert.equal(pending.markers[1].href, null, 'an unrecorded return cannot navigate to the sibling');
  await command('eval', "document.querySelector('.pending-point').focus()");
  assert.match(await command('eval', "document.activeElement.getAttribute('aria-label')"), /auditor/, 'the pending actor name is keyboard accessible');
  await command('eval', "const returned=document.createElement('article');returned.dataset.messageId='return-0';returned.dataset.segment='message';returned.textContent='Recorded return';document.querySelector('.transcript').append(returned)");
  await new Promise(resolve => setTimeout(resolve, 250));
  const returnedPending = JSON.parse(await readPending());
  assert.equal(returnedPending.paths[0].open, false, 'loading the exact return closes only its own span');
  assert.equal(returnedPending.paths[1].open, true);
  assert.equal(returnedPending.markers[0].color, pending.markers[0].color);
  assert.equal(returnedPending.markers[0].icon, pending.markers[0].icon);
});
