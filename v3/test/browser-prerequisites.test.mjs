import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { browserPrerequisites } from './browser-prerequisites.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentsession-browser-prerequisites-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, process.platform === 'win32' ? 'browser.exe' : 'browser');
  writeFileSync(binary, 'test executable');
  chmodSync(binary, 0o755);
  const ui = path.join(root, 'ui');
  for (const dependency of ['vite', 'svelte']) mkdirSync(path.join(ui, 'node_modules', dependency), { recursive: true });
  return { root, binary, ui, env: { PATH: '', AGENTSESSION_V3_AGENT_BROWSER_BIN: binary } };
}

test('available browser prerequisites return an absolute executable and no skip', t => {
  const { binary, ui, env } = fixture(t);
  assert.deepEqual(browserPrerequisites({ ui, env }), { browserBinary: binary, skip: false });
});

test('local missing dependencies skip and required browser mode fails explicitly', t => {
  const { root, binary, ui, env } = fixture(t);
  const missingBrowser = { ...env, AGENTSESSION_V3_AGENT_BROWSER_BIN: path.join(root, 'absent') };
  assert.match(browserPrerequisites({ ui, env: missingBrowser }).skip, /agent-browser/);
  assert.throws(() => browserPrerequisites({ ui, env: { ...missingBrowser, AGENTSESSION_V3_REQUIRE_BROWSER: '1' } }), /AGENTSESSION_V3_REQUIRE_BROWSER=1.*agent-browser/);
  rmSync(path.join(ui, 'node_modules', 'svelte'), { recursive: true });
  assert.match(browserPrerequisites({ ui, env }).skip, /v3\/ui/);
  assert.throws(() => browserPrerequisites({ ui, env: { ...env, AGENTSESSION_V3_REQUIRE_BROWSER: '1' } }), /AGENTSESSION_V3_REQUIRE_BROWSER=1.*v3\/ui/);
  assert.deepEqual(browserPrerequisites({ env }), { browserBinary: binary, skip: false }, 'packaged Axum tests do not depend on Vite');
});

test('a non-executable native browser cannot satisfy required mode', { skip: process.platform === 'win32' }, t => {
  const { binary, env } = fixture(t);
  chmodSync(binary, 0o644);
  assert.throws(() => browserPrerequisites({ env: { ...env, AGENTSESSION_V3_REQUIRE_BROWSER: '1' } }), /agent-browser/);
});

test('an explicitly selected Chrome executable must be available', t => {
  const { root, env } = fixture(t);
  const selected = { ...env, AGENT_BROWSER_EXECUTABLE_PATH: path.join(root, 'missing-chrome'),
    AGENTSESSION_V3_REQUIRE_BROWSER: '1' };
  assert.throws(() => browserPrerequisites({ env: selected }), /AGENTSESSION_V3_REQUIRE_BROWSER=1.*Chrome/);
});

test('a non-executable selected Chrome cannot satisfy required mode', { skip: process.platform === 'win32' }, t => {
  const { root, env } = fixture(t);
  const chrome = path.join(root, 'chrome');
  writeFileSync(chrome, 'not executable');
  chmodSync(chrome, 0o644);
  assert.throws(() => browserPrerequisites({ env: { ...env, AGENT_BROWSER_EXECUTABLE_PATH: chrome,
    AGENTSESSION_V3_REQUIRE_BROWSER: '1' } }), /Chrome/);
});

test('all six public browser suites enforce required mode before registering skipped tests', () => {
  for (const suite of ['ui-tool-cards-browser', 'ui-regressions', 'ui-collaboration-timeline-browser',
    'ui-transcript-collaboration-browser', 'ui-codex-collab', 'dsh-ui-integration']) {
    const result = spawnSync(process.execPath, [`v3/test/${suite}.test.mjs`], {
      cwd: repo, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PATH: '', AGENTSESSION_V3_REQUIRE_BROWSER: '1',
        AGENTSESSION_V3_AGENT_BROWSER_BIN: path.join(repo, 'tmp', 'missing-agent-browser') },
    });
    assert.notEqual(result.status, 0, `${suite} must fail when its required browser is missing`);
    assert.match(result.stdout + result.stderr, /AGENTSESSION_V3_REQUIRE_BROWSER=1.*agent-browser/, suite);
  }
});
