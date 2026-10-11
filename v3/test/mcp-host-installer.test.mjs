import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = path.resolve(import.meta.dirname, '../..');
const installer = path.join(repo, 'scripts/v3-install-mcp-host.mjs');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentsession-v3-host-'));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex');
  const xdg = path.join(root, 'xdg');
  mkdirSync(home); mkdirSync(codexHome); mkdirSync(xdg);
  const serverConfig = path.join(root, 'server.json');
  const serverConfigText = `${JSON.stringify({
    codexDir: path.join(root, 'source', 'codex'),
    dbPath: path.join(root, 'source', 'opencode.db'),
    claudeDir: path.join(root, 'source', 'claude'),
    piDir: path.join(root, 'source', 'pi'),
    dshDir: path.join(root, 'source', 'dsh'),
    metaDir: path.join(root, 'state', 'meta'),
    indexDir: path.join(root, 'state', 'index'),
    cacheDir: path.join(root, 'state', 'cache'),
  })}\n`;
  writeFileSync(serverConfig, serverConfigText);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG: path.join(root, 'opencode.json') };
  const install = (target, hostConfig, extra = []) => spawnSync(process.execPath,
    [installer, '--target', target, '--binary', binary, '--host-config', hostConfig,
      '--server-config', serverConfig, ...extra], { encoding: 'utf8', env });
  return { root, home, codexHome, xdg, env, serverConfig, serverConfigText, install };
}

test('installer requires an explicit binary and host config path', () => {
  const { root, env, serverConfigText } = setup();
  const result = spawnSync(process.execPath, [installer, '--target', 'codex'],
    { encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--binary.*--host-config|--host-config.*--binary/);
  assert.equal(readFileSync(path.join(root, 'server.json'), 'utf8'), serverConfigText);
});

test('installer rejects a different executable before writing a host config', () => {
  const { root, env, serverConfigText } = setup();
  const hostConfig = path.join(root, 'config.toml');
  const result = spawnSync(process.execPath,
    [installer, '--target', 'codex', '--binary', process.execPath, '--host-config', hostConfig],
    { encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not report an AgentSession 3.x version/);
  assert.equal(readFileSync(path.join(root, 'server.json'), 'utf8'), serverConfigText);
  assert.equal(existsSync(hostConfig), false);
});

test('installer accepts the prerelease binary version and refuses malformed version output', () => {
  const { root, env, serverConfig } = setup();
  const versions = ['3.0.0', '3.0.0-rc.1', '3.0.0-rc.1+build.7', '3.0.0-rc..1', '3.0.0-', '4.0.0', '3.0.0 extra'];
  for (const [index, version] of versions.entries()) {
    const hostConfig = path.join(root, `version-${index}.toml`);
    // Replace only the executable probe; exercise the real installer/config write boundary.
    const probe = `import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      childProcess.spawnSync = () => ({status: 0, stdout: process.env.TEST_VERSION_OUTPUT});
      syncBuiltinESMExports();
      process.argv = [process.execPath, ...process.argv.slice(1)];
      await import(pathToFileURL(process.argv[1]).href);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, installer,
      '--target', 'codex', '--binary', process.execPath, '--host-config', hostConfig,
      '--server-config', serverConfig], { encoding: 'utf8', env: { ...env, TEST_VERSION_OUTPUT: `agentsession-v3 ${version}\n` } });
    if (index < 3) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(hostConfig), true);
      assert.match(readFileSync(hostConfig, 'utf8'), /\[mcp_servers\.agentsession-v3\]/);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /does not report an AgentSession 3.x version/);
      assert.equal(existsSync(hostConfig), false);
    }
  }
});

test('installer refuses an incomplete explicit server config before writing host settings', () => {
  const { root, serverConfig, install } = setup();
  const hostConfig = path.join(root, 'config.toml');
  for (const content of ['{}\n', JSON.stringify({ codexDir: 'relative-path' }) + '\n']) {
    writeFileSync(serverConfig, content);
    const result = install('codex', hostConfig);
    assert.notEqual(result.status, 0,
      'An explicit config must not silently fall back to personal source or state paths');
    assert.match(result.stderr, /--server-config.*absolute.*path/i);
    assert.equal(existsSync(hostConfig), false);
    assert.equal(readFileSync(serverConfig, 'utf8'), content);
  }
});

test('installer preserves unrelated Codex, Claude and OpenCode entries and is idempotent', () => {
  const { root, install, serverConfig } = setup();
  const codex = path.join(root, 'config.toml');
  const claude = path.join(root, '.claude.json');
  const opencode = path.join(root, 'opencode.json');
  writeFileSync(codex, '[mcp_servers.other]\ncommand = "other"\n\n[features]\nsearch = true\n');
  writeFileSync(claude, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } }));
  writeFileSync(opencode, JSON.stringify({ theme: 'dark', mcp: {
    other: { type: 'local', command: ['other'] },
  } }));

  for (const [target, config] of [['codex', codex], ['claude-code', claude], ['opencode', opencode]]) {
    const first = install(target, config);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /installed/);
    const after = readFileSync(config, 'utf8');
    const second = install(target, config);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already installed/);
    assert.equal(readFileSync(config, 'utf8'), after);
  }
  const codexText = readFileSync(codex, 'utf8');
  assert.match(codexText, /\[mcp_servers\.other\]/);
  assert.match(codexText, /\[features\]\nsearch = true/);
  assert.match(codexText, /\[mcp_servers\.agentsession-v3\]/);
  assert.match(codexText, /args = \[.*"--config".*"mcp".*"--codex-dir"/);
  for (const [filename, field] of [[claude, 'mcpServers'], [opencode, 'mcp']]) {
    const parsed = JSON.parse(readFileSync(filename, 'utf8'));
    assert.equal(parsed.theme, 'dark');
    const servers = field === 'mcp' ? parsed.mcp : parsed.mcpServers;
    assert.equal(servers.other.command === 'other' || servers.other.command[0] === 'other', true);
    const entry = servers['agentsession-v3'];
    const command = field === 'mcp' ? entry.command : [entry.command, ...entry.args];
    if (field === 'mcp') {
      assert.equal(parsed.mcp.servers, undefined);
      assert.equal(entry.type, 'local');
      assert.equal(entry.disabled, undefined);
      assert.equal(entry.enabled, undefined);
    }
    assert.deepEqual(command.slice(0, 4), [binary, '--config', serverConfig, 'mcp']);
    const configured = JSON.parse(readFileSync(serverConfig, 'utf8'));
    for (const [option, key] of [['--codex-dir', 'codexDir'], ['--opencode-db', 'dbPath'],
      ['--claude-dir', 'claudeDir'], ['--pi-dir', 'piDir'], ['--dsh-dir', 'dshDir'],
      ['--meta-dir', 'metaDir'], ['--index-dir', 'indexDir'], ['--cache-dir', 'cacheDir']]) {
      const index = command.indexOf(option);
      assert.ok(index >= 4);
      assert.equal(command[index + 1], configured[key]);
    }
  }
});

test('installer refuses conflicting entries and invalid JSON without replacement', () => {
  const { root, install } = setup();
  const config = path.join(root, '.claude.json');
  const original = '{"mcpServers":{"agentsession-v3":{"command":"custom"}},"theme":"dark"}\n';
  writeFileSync(config, original);
  const refused = install('claude-code', config);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--replace/);
  assert.equal(readFileSync(config, 'utf8'), original);
  const replaced = install('claude-code', config, ['--replace']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).theme, 'dark');

  writeFileSync(config, '{bad json');
  const invalid = install('claude-code', config, ['--replace']);
  assert.notEqual(invalid.status, 0);
  assert.equal(readFileSync(config, 'utf8'), '{bad json');
});

test('OpenCode replacement uses top-level MCP entries and preserves unrelated servers', () => {
  const { root, install } = setup();
  const config = path.join(root, 'opencode.json');
  const original = JSON.stringify({ theme: 'dark', mcp: {
    'agentsession-v3': { type: 'local', command: ['old-binary'], enabled: true },
    other: { type: 'local', command: ['other'] },
  } }) + '\n';
  writeFileSync(config, original);
  const refused = install('opencode', config);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--replace/);
  assert.equal(readFileSync(config, 'utf8'), original);

  const replaced = install('opencode', config, ['--replace']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.match(replaced.stdout, /replaced/);
  const parsed = JSON.parse(readFileSync(config, 'utf8'));
  assert.equal(parsed.theme, 'dark');
  assert.deepEqual(parsed.mcp.other, { type: 'local', command: ['other'] });
  assert.equal(parsed.mcp.servers, undefined);
  assert.deepEqual(parsed.mcp['agentsession-v3'].command.slice(0, 4),
    [binary, '--config', path.join(root, 'server.json'), 'mcp']);
  const idempotent = install('opencode', config);
  assert.equal(idempotent.status, 0, idempotent.stderr);
  assert.match(idempotent.stdout, /already installed/);
});

test('OpenCode preserves a valid server whose name is servers', () => {
  const { root, install } = setup();
  const config = path.join(root, 'opencode.json');
  const namedServer = { type: 'local', command: ['other'] };
  writeFileSync(config, JSON.stringify({ mcp: { servers: namedServer } }) + '\n');

  const result = install('opencode', config);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(readFileSync(config, 'utf8'));
  assert.deepEqual(parsed.mcp.servers, namedServer);
  assert.equal(parsed.mcp['agentsession-v3'].type, 'local');
});

test('OpenCode refuses the previous nested servers layout for manual migration', () => {
  const { root, install } = setup();
  const config = path.join(root, 'opencode.json');
  const original = JSON.stringify({ mcp: { servers: {
    'agentsession-v3': { type: 'local', command: ['old-binary'] },
    other: { type: 'local', command: ['other'] },
  } } }) + '\n';
  writeFileSync(config, original);
  for (const extra of [[], ['--replace']]) {
    const result = install('opencode', config, extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy OpenCode.*manual/i);
    assert.equal(readFileSync(config, 'utf8'), original);
  }
});

test('Codex replacement preserves adjacent nested tables', () => {
  const { root, install } = setup();
  const config = path.join(root, 'config.toml');
  const original = '[mcp_servers.agentsession-v3] # custom\ncommand = "custom"\n'
    + '[mcp_servers.agentsession-v3.env]\nKEEP = "old"\n'
    + '[mcp_servers.other]\ncommand = "other"\n';
  writeFileSync(config, original);
  assert.notEqual(install('codex', config).status, 0);
  assert.equal(readFileSync(config, 'utf8'), original);
  const replaced = install('codex', config, ['--replace']);
  assert.equal(replaced.status, 0, replaced.stderr);
  const current = readFileSync(config, 'utf8');
  assert.equal([...current.matchAll(/\[mcp_servers\.agentsession-v3\]/g)].length, 1);
  assert.doesNotMatch(current, /KEEP =/);
  assert.match(current, /\[mcp_servers\.other\]\ncommand = "other"/);
});

test('Codex ignores a registration-shaped header inside a multiline string when replacing', () => {
  const { root, install } = setup();
  const config = path.join(root, 'config.toml');
  const note = '[notice]\ntext = """\n[mcp_servers.agentsession-v3] # example text\n'
    + 'command = "keep exactly"\n"""\n';
  writeFileSync(config, note);

  const installed = install('codex', config, ['--replace']);
  assert.equal(installed.status, 0, installed.stderr);
  const current = readFileSync(config, 'utf8');
  assert.ok(current.startsWith(note), 'The TOML note remains byte-for-byte intact');
  assert.match(current.slice(note.length), /^\n\[mcp_servers\.agentsession-v3\]\ncommand = /);
});

test('Codex recognizes a quoted table name as an existing registration', () => {
  const { root, install } = setup();
  const config = path.join(root, 'config.toml');
  const original = '[mcp_servers."agentsession-v3"]\ncommand = "custom"\n'
    + '[mcp_servers.other]\ncommand = "other"\n';
  writeFileSync(config, original);
  assert.notEqual(install('codex', config).status, 0);
  assert.equal(readFileSync(config, 'utf8'), original);
  assert.equal(install('codex', config, ['--replace']).status, 0);
  assert.equal([...readFileSync(config, 'utf8').matchAll(/\[mcp_servers\.agentsession-v3\]/g)].length, 1);
});

test('Codex refuses alternate inline and dotted registrations without changing the TOML', () => {
  const { root, install } = setup();
  const config = path.join(root, 'config.toml');
  const originals = [
    '[mcp_servers]\nagentsession-v3 = { command = "custom", args = ["mcp"] }\n',
    '[mcp_servers]\nagentsession-v3.command = "custom"\nagentsession-v3.args = ["mcp"]\n',
    'mcp_servers.agentsession-v3.command = "custom"\nmcp_servers.agentsession-v3.args = ["mcp"]\n',
  ];
  for (const original of originals) {
    writeFileSync(config, original);
    for (const extra of [[], ['--replace']]) {
      const refused = install('codex', config, extra);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /manual host config edit/);
      assert.equal(readFileSync(config, 'utf8'), original);
    }
  }
});

test('installed Codex reads the isolated registration and its stdio command serves the public fixture', async (t) => {
  const { root, codexHome, env, serverConfig, install } = setup();
  const codexProbe = spawnSync(process.platform === 'win32' ? 'codex.exe' : 'codex',
    ['--version'], { encoding: 'utf8', timeout: 5_000, env });
  if (codexProbe.error?.code === 'ENOENT') return t.skip('Codex CLI is not installed');
  assert.equal(codexProbe.status, 0, codexProbe.stderr);

  const fixture = path.join(repo, 'v3/fixtures/codex');
  const empty = name => { const result = path.join(root, name); mkdirSync(result); return result; };
  writeFileSync(serverConfig, JSON.stringify({
    codexDir: fixture,
    dbPath: path.join(empty('opencode'), 'opencode.db'),
    claudeDir: empty('claude'), piDir: empty('pi'), dshDir: empty('dsh'),
    metaDir: empty('meta'), indexDir: empty('index'), cacheDir: empty('cache'),
  }));
  env.AGENTSESSION_CODEX_DIR = empty('ambient-codex');
  const hostConfig = path.join(codexHome, 'config.toml');
  const installed = install('codex', hostConfig);
  assert.equal(installed.status, 0, installed.stderr);
  const listed = spawnSync(process.platform === 'win32' ? 'codex.exe' : 'codex',
    ['mcp', 'list', '--json'], { encoding: 'utf8', timeout: 10_000, env });
  assert.equal(listed.status, 0, listed.stderr);
  const registrations = JSON.parse(listed.stdout);
  const registration = registrations.find(item => item.name === 'agentsession-v3');
  assert.ok(registration, 'Installed Codex CLI sees the isolated MCP entry');
  assert.equal(registration.transport.type, 'stdio');
  assert.equal(registration.transport.command, binary);
  assert.ok(registration.transport.args.includes('--codex-dir'));
  assert.ok(registration.transport.args.includes(fixture));

  const client = new Client({ name: 'agentsession-v3-installed-host-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: registration.transport.command,
    args: registration.transport.args, env, cwd: root, stderr: 'pipe' });
  t.after(async () => client.close());
  await client.connect(transport);
  const event = await client.callTool({ name: 'session_get_event', arguments: {
    event: { provider: 'codex', sessionId: '44444444-4444-4444-8444-444444444444',
      messageId: 'assistant-1', segment: 'message' }, maxChars: 256,
  } });
  assert.notEqual(event.isError, true, event.content?.[0]?.text);
  assert.equal(event.structuredContent.result.content.text,
    'Hello 🙂 from the Rust slice. Continue to the complete ending.');
});
