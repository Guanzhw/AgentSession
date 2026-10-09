import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
async function freePort() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    const socket = createServer();
    try {
      await new Promise((resolve, reject) => socket.once('error', reject).listen(port, '127.0.0.1', resolve));
      await new Promise(resolve => socket.close(resolve));
      return port;
    } catch { socket.close(); }
  }
  throw new Error('No free QA port in 20000–59999');
}

test('OpenCode V2 prompt evidence separates recorded system rows from current AGENTS and selected agent sources', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'as-v3-opencode-prompt-'));
  const home = path.join(root, 'home');
  const project = path.join(home, 'project');
  const workspace = path.join(project, 'pkg');
  const global = path.join(root, 'xdg', 'opencode');
  const agentDir = path.join(project, '.opencode', 'agents');
  const outside = path.join(root, 'outside');
  const outsideProject = path.join(outside, 'project');
  const outsideWorkspace = path.join(outsideProject, 'pkg');
  const outsideAgentDir = path.join(outside, '.opencode', 'agents');
  await Promise.all([workspace, global, path.join(global, 'agents'), agentDir, path.join(project, '.git'),
    outsideWorkspace, outsideAgentDir, path.join(outsideProject, '.git')]
    .map(dir => mkdir(dir, { recursive: true })));
  const files = [
    [path.join(global, 'AGENTS.md'), 'GLOBAL_AGENT_GUIDANCE'],
    [path.join(home, 'AGENTS.md'), 'HOME_AGENT_GUIDANCE'],
    [path.join(project, 'AGENTS.md'), 'PROJECT_AGENT_GUIDANCE'],
    [path.join(workspace, 'AGENTS.md'), 'WORKSPACE_AGENT_GUIDANCE'],
    [path.join(outside, 'AGENTS.md'), 'OUTSIDE_PROJECT_AGENT_GUIDANCE'],
    [path.join(outsideProject, 'AGENTS.md'), 'OUTSIDE_PROJECT_ROOT_AGENT_GUIDANCE'],
    [path.join(outsideWorkspace, 'AGENTS.md'), 'OUTSIDE_WORKSPACE_AGENT_GUIDANCE'],
    [path.join(workspace, 'CLAUDE.md'), 'CLAUDE_NOT_A_V2_FALLBACK'],
    [path.join(project, 'EXTRA.md'), 'CONFIG_INSTRUCTIONS_NOT_INJECTED'],
    [path.join(global, 'opencode.jsonc'), '{ // global\n "agents": { "reviewer": { "system": "GLOBAL_REVIEWER_SYSTEM" }, "cleared": { "system": "STALE_GLOBAL_SYSTEM" } }, "token": "SECRET_CONFIG_VALUE" }'],
    [path.join(project, 'opencode.jsonc'), '{ "agents": { "reviewer": { "system": "DIRECT_REVIEWER_SYSTEM" } }, "instructions": ["EXTRA.md"], }'],
    [path.join(project, '.opencode', 'opencode.jsonc'), '{ "agents": { "reviewer": { "system": "PROJECT_DOT_OPENCODE_SYSTEM" }, "cleared": { "system": "" } } }'],
    [path.join(agentDir, 'scribe.md'), '---\ndescription: Writes notes\nmode: primary\n---\nMARKDOWN_AGENT_BODY\n'],
    [path.join(outsideAgentDir, 'outsider.md'), 'ABOVE_PROJECT_MARKDOWN_AGENT'],
    [path.join(global, 'agents', 'outsider.md'), 'GLOBAL_OUTSIDER_MARKDOWN_AGENT'],
  ];
  await Promise.all(files.map(([file, content]) => writeFile(file, content)));
  const dbPath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
    fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
    time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, agent TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT);`);
  const insert = db.prepare('INSERT INTO session_v2 VALUES (?,NULL,NULL,NULL,?,?,?,1,2,NULL,NULL,NULL,NULL,NULL,NULL,?)');
  insert.run('review-session', 'Review', 'review', workspace, 'reviewer');
  insert.run('scribe-session', 'Scribe', 'scribe', workspace, 'scribe');
  insert.run('unknown-session', 'Unknown', 'unknown', workspace, null);
  insert.run('large-session', 'Large', 'large', workspace, 'reviewer');
  insert.run('cleared-session', 'Cleared', 'cleared', workspace, 'cleared');
  insert.run('outside-session', 'Outside', 'outside', outsideWorkspace, 'outsider');
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run('recorded-system', 'review-session', 'system', 1, 1234, 1234,
    JSON.stringify({ text: 'RECORDED_SYSTEM_FROM_SESSION' }));
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run('unrelated-malformed', 'review-session', 'assistant', 2, 1235, 1235,
    '{not-json');
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run('large-system', 'large-session', 'system', 1, 1234, 1234,
    JSON.stringify({ text: 'X'.repeat(1_048_577) }));
  db.close();
  const before = new Map([dbPath, ...files.map(([file]) => file)].map(file => [file, sha(file)]));
  const state = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache'].map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(state).map(dir => mkdir(dir)));
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--opencode-db', dbPath,
    '--codex-dir', state.codex, '--claude-dir', state.claude, '--pi-dir', state.pi,
    '--dsh-dir', state.dsh, '--meta-dir', state.meta, '--index-dir', state.index, '--cache-dir', state.cache],
  { cwd: repo, windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(root, 'xdg') }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'close');
    for (const [file, digest] of before) assert.equal(sha(file), digest, `${file} changed`);
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/providers')).ok) break; } catch { /* startup */ }
    if (i === 99) assert.fail(stderr);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const get = async id => {
    const response = await fetch(`${base}/api/opencode/session/${id}/system-prompts`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const review = await get('review-session');
  assert.equal(review.selectedAgent, 'reviewer');
  assert.equal(review.hiddenPromptStored, true);
  const items = review.sections.flatMap(section => section.items);
  assert.ok(items.some(item => item.content === 'RECORDED_SYSTEM_FROM_SESSION' && item.provenance === 'recorded' && item.sourcePath === dbPath));
  for (const value of ['GLOBAL_AGENT_GUIDANCE', 'HOME_AGENT_GUIDANCE', 'PROJECT_AGENT_GUIDANCE', 'WORKSPACE_AGENT_GUIDANCE'])
    assert.ok(items.some(item => item.content === value && item.provenance === 'current-local'));
  assert.ok(items.some(item => item.content === 'HOME_AGENT_GUIDANCE' &&
    item.sourcePath === path.join(home, 'AGENTS.md')));
  assert.ok(items.some(item => item.content === 'PROJECT_DOT_OPENCODE_SYSTEM' && item.provenance === 'current-local' &&
    item.sourcePath === path.join(project, '.opencode', 'opencode.jsonc')));
  assert.ok(!items.some(item => ['GLOBAL_REVIEWER_SYSTEM', 'DIRECT_REVIEWER_SYSTEM'].includes(item.content)));
  assert.ok(!JSON.stringify(review).includes('CLAUDE_NOT_A_V2_FALLBACK'));
  assert.ok(!JSON.stringify(review).includes('CONFIG_INSTRUCTIONS_NOT_INJECTED'));
  assert.ok(!JSON.stringify(review).includes('SECRET_CONFIG_VALUE'));
  assert.ok(review.diagnostics.some(item => item.code === 'opencode_instructions_not_injected'));
  const scribe = await get('scribe-session');
  assert.equal(scribe.selectedAgent, 'scribe');
  assert.ok(scribe.sections.flatMap(section => section.items).some(item =>
    item.content === 'MARKDOWN_AGENT_BODY' && item.sourcePath === path.join(agentDir, 'scribe.md')));
  assert.equal(scribe.hiddenPromptStored, false);
  const unknown = await get('unknown-session');
  assert.equal(unknown.selectedAgent, null);
  assert.ok(unknown.diagnostics.some(item => item.code === 'opencode_selected_agent_unrecorded'));
  assert.ok(unknown.diagnostics.some(item => item.code === 'opencode_instructions_not_injected'));
  assert.ok(!unknown.sections.flatMap(section => section.items).some(item => item.kind === 'agent-prompt'));
  const large = await get('large-session');
  assert.equal(large.hiddenPromptStored, false);
  assert.ok(large.diagnostics.some(item => item.code === 'opencode_system_text_too_large'));
  assert.ok(!JSON.stringify(large).includes('X'.repeat(100)));
  const cleared = await get('cleared-session');
  assert.ok(!JSON.stringify(cleared).includes('STALE_GLOBAL_SYSTEM'));
  assert.ok(cleared.diagnostics.some(item => item.code === 'opencode_agent_prompt_unavailable'));

  const outsidePrompt = await get('outside-session');
  const outsideItems = outsidePrompt.sections.flatMap(section => section.items);
  for (const value of ['OUTSIDE_PROJECT_ROOT_AGENT_GUIDANCE', 'OUTSIDE_WORKSPACE_AGENT_GUIDANCE'])
    assert.ok(outsideItems.some(item => item.content === value && item.provenance === 'current-local'));
  assert.ok(!JSON.stringify(outsidePrompt).includes('OUTSIDE_PROJECT_AGENT_GUIDANCE'));
  assert.ok(outsideItems.some(item => item.content === 'GLOBAL_OUTSIDER_MARKDOWN_AGENT' &&
    item.sourcePath === path.join(global, 'agents', 'outsider.md')));
  assert.ok(!JSON.stringify(outsidePrompt).includes('ABOVE_PROJECT_MARKDOWN_AGENT'));
});

test('OpenCode V2 schema without optional session agent column remains explicit', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'as-v3-opencode-prompt-old-schema-'));
  const dbPath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT,
    fork_boundary TEXT, title TEXT, slug TEXT, directory TEXT, time_created INTEGER,
    time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO session_v2 VALUES ('old',NULL,NULL,NULL,'Old','old',NULL,1,2,NULL,NULL,NULL,NULL,NULL,NULL);`);
  db.close();
  const digest = sha(dbPath);
  const dirs = Object.fromEntries(['codex', 'claude', 'pi', 'dsh', 'meta', 'index', 'cache', 'xdg']
    .map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const port = await freePort();
  const child = spawn(binary, ['serve', '--port', String(port), '--opencode-db', dbPath,
    '--codex-dir', dirs.codex, '--claude-dir', dirs.claude, '--pi-dir', dirs.pi,
    '--dsh-dir', dirs.dsh, '--meta-dir', dirs.meta, '--index-dir', dirs.index, '--cache-dir', dirs.cache],
  { cwd: repo, windowsHide: true, env: { ...process.env, XDG_CONFIG_HOME: dirs.xdg }, stdio: 'ignore' });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'close');
    assert.equal(sha(dbPath), digest);
    await rm(root, { recursive: true, force: true });
  });
  let response;
  for (let i = 0; i < 100; i++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/opencode/session/old/system-prompts`);
      if (response.ok) break;
    } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(response?.status, 200);
  const body = await response.json();
  assert.equal(body.selectedAgent, null);
  assert.ok(body.diagnostics.some(item => item.code === 'opencode_agent_column_unavailable'));
  assert.ok(body.diagnostics.some(item => item.code === 'opencode_selected_agent_unrecorded'));
});
