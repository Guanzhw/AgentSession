import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { browserPrerequisites } from './browser-prerequisites.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const ui = path.join(repo, 'v3/ui');
const require = createRequire(path.join(ui, 'package.json'));
const { browserBinary: browser, skip } = browserPrerequisites({ ui });

test('Reader execution failures show bounded reasons, recorded IDs and unknown codes in both languages', {
  timeout: 60_000, skip,
}, async t => {
  const { createServer } = require('vite');
  const session = { provider: 'deepseek-harness', sessionId: 'invalid-protocol-fixture' };
  const bootstrap = {
    session: { session, title: 'Readable conversation', directory: null, createdAt: null,
      updatedAt: null, messageCount: 0, tokenCount: null, parent: null },
    revision: 'fixture-revision', totalItems: 0,
    segments: [{ id: 'segment-0', pageId: 'page-0', startOrdinal: 0, items: [], ownerContext: null,
      previousCursor: null, nextCursor: null }],
    toc: { entries: [], previousCursor: null, nextCursor: null },
  };
  const server = await createServer({ root: ui, appType: 'custom', logLevel: 'error',
    server: { host: '127.0.0.1', port: await freeFetchSafePort(), strictPort: true, hmr: false } });
  server.middlewares.use(async (request, response, next) => {
    if (request.url !== '/reader-diagnostic-fixture') return next();
    response.setHeader('content-type', 'text/html');
    response.end(await server.transformIndexHtml(request.url, `<!doctype html><html><body><div id="app"></div>
      <script type="module">
      import {mount} from 'svelte'; import Reader from '/src/lib/ReaderPage.svelte';
      import {language} from '/src/lib/i18n.ts';
      language.set('en'); window.setFixtureLanguage = value => language.set(value);
      window.fixtureExecutionRequests = 0;
      window.fetch = async url => {
        if (String(url).includes('/executions?')) {
          window.fixtureExecutionRequests++;
          return new Response(JSON.stringify({error:{code:'protocol_invalid',message:'protocol evidence is invalid',
            diagnostics:[{code:'duplicate_event_id',event_id:'event-fixture-1'},
              {code:'malformed_source_record',event_id:'event:codex:3'},
              {code:'future_provider_diagnostic',event_id:null}],diagnosticsTruncated:true,
            rawPayload:'RAW_PROVIDER_PAYLOAD_MUST_STAY_HIDDEN'}}), {status:422});
        }
        return new Response(JSON.stringify(String(url).includes('/resume/')
          ? {available:false,allowTerminalLaunch:false,diagnostic:null,command:null} : null),{status:200});
      };
      mount(Reader,{target:document.querySelector('#app'),props:{provider:${JSON.stringify(session.provider)},
        sessionId:${JSON.stringify(session.sessionId)},bootstrap:${JSON.stringify(bootstrap)},
        onBack:()=>{},onOpen:()=>{},onDeleted:()=>{},onRenamed:()=>{}}});
      </script></body></html>`));
  });
  await server.listen();
  t.after(() => server.close());
  const browserSession = `reader-diagnostics-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(browser, ['--session', browserSession, ...args], {
      cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code ? reject(new Error(stderr || stdout)) : resolve(stdout.trim()));
  });
  t.after(async () => { try { await command('close'); } catch {} });
  await command('open', server.resolvedUrls.local[0] + 'reader-diagnostic-fixture');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await command('eval', "Boolean(document.querySelector('.reader-execution-details'))") === 'true') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await command('eval', "document.querySelector('.reader-session-details').open"), 'false');
  await command('eval', "document.querySelector('.reader-session-details>summary').click();document.querySelector('.reader-execution-details>summary').click()");
  const visibleText = () => command('eval', "document.querySelector('.reader-execution-details').innerText");
  const english = await visibleText();
  assert.match(english, /Recorded event IDs are duplicated\./);
  assert.match(english, /A recorded source entry could not be parsed\./);
  assert.match(english, /duplicate_event_id/);
  assert.match(english, /event-fixture-1/);
  assert.match(english, /future_provider_diagnostic/);
  assert.match(english, /Additional diagnostic codes are omitted\./);
  assert.doesNotMatch(await command('eval', 'document.body.innerText'), /RAW_PROVIDER_PAYLOAD_MUST_STAY_HIDDEN/);
  await command('eval', "window.setFixtureLanguage('zh')");
  const chinese = await visibleText();
  assert.match(chinese, /协议证据无效。/);
  assert.match(chinese, /已记录的事件 ID 重复。/);
  assert.match(chinese, /一条已记录的来源条目无法解析。/);
  assert.match(chinese, /future_provider_diagnostic/);
  assert.match(chinese, /其他诊断代码已省略。/);
  await command('eval', "document.querySelector('.reader-execution-details button').click()");
  assert.equal(await command('eval', 'window.fixtureExecutionRequests'), '2');
  await command('eval', "document.querySelector('.reader-execution-details').open=true");
  assert.match(await visibleText(), /已记录的事件 ID 重复。/);
});
