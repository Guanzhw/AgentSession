import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { browserPrerequisites } from './browser-prerequisites.mjs';

const { browserBinary, skip } = browserPrerequisites();
assert.equal(skip, false, 'Browser smoke requires the installed native CLI and Chrome.');
const session = `agentsession-browser-smoke-${process.pid}-${Date.now()}`;
const launchArgs = '--disable-features=BackForwardCache,--enable-automation';
const env = { ...process.env, AGENT_BROWSER_ARGS: launchArgs };
const command = (...args) => new Promise((resolve, reject) => {
  const child = spawn(browserBinary, ['--session', session, ...args], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve(stdout.trim())
    : reject(new Error(`agent-browser ${args[0]} failed (${code}): ${stderr || stdout}`)));
});
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<title>AgentSession browser smoke</title><p>Browser launch verified</p>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}/browser-smoke`;
  // Exercise the custom Chromium flag used by the navigation regression suites.
  await command('open', url, '--args', launchArgs);
  assert.equal(await command('get', 'url'), url);
  assert.equal(await command('get', 'title'), 'AgentSession browser smoke');
  const cdp = new WebSocket(await command('get', 'cdp-url'));
  try {
    const signal = AbortSignal.timeout(30_000);
    await once(cdp, 'open', { signal });
    const message = once(cdp, 'message', { signal });
    cdp.send(JSON.stringify({ id: 1, method: 'Browser.getBrowserCommandLine' }));
    const response = JSON.parse((await message)[0].data);
    assert.ifError(response.error);
    assert.ok(response.result.arguments.some(argument =>
      argument.startsWith('--disable-features=') && argument.split('=')[1].split(',').includes('BackForwardCache')),
    'The launched Chrome disables BackForwardCache for the fresh-mount check.');
  } finally { cdp.close(); }
  console.log(`Browser launch verified: ${process.env.AGENT_BROWSER_EXECUTABLE_PATH}`);
} finally {
  try { await command('close'); } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
