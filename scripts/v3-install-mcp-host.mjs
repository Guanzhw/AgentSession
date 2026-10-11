import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const name = 'agentsession-v3';
const targets = ['codex', 'claude-code', 'opencode'];

function usage() {
  return 'Usage: node v3-install-mcp-host.mjs --target <codex|claude-code|opencode> --binary <native-executable> --host-config <host-config-file> [--server-config <agentsession-v3-config.json>] [--replace]';
}

function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return null;
  const values = new Map();
  let replace = false;
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i];
    if (option === '--replace') {
      if (replace) throw new Error('Repeated option: --replace');
      replace = true;
      continue;
    }
    if (!['--target', '--binary', '--host-config', '--server-config'].includes(option)) {
      throw new Error(`${usage()}\nUnknown option: ${option}`);
    }
    const value = args[++i];
    if (!value || value.startsWith('--') || values.has(option)) throw new Error(usage());
    values.set(option, value);
  }
  const target = values.get('--target');
  const binary = values.get('--binary');
  const hostConfig = values.get('--host-config');
  if (!target || !binary || !hostConfig) throw new Error(usage());
  if (!targets.includes(target)) throw new Error(`Unsupported target: ${target}. Choose ${targets.join(', ')}.`);
  return {
    target,
    binary: path.resolve(binary),
    hostConfig: path.resolve(hostConfig),
    serverConfig: values.has('--server-config') ? path.resolve(values.get('--server-config')) : undefined,
    replace,
  };
}

function requireRegularFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${label} must be an existing file: ${file}`);
}

function readJsonObject(file, label) {
  if (!existsSync(file)) return {};
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`${label} is not valid JSON: ${file}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object: ${file}`);
  }
  return parsed;
}

function requireIsolatedServerConfig(file) {
  const config = readJsonObject(file, 'AgentSession 3.0 server config');
  for (const key of ['codexDir', 'dbPath', 'claudeDir', 'piDir', 'dshDir',
    'metaDir', 'indexDir', 'cacheDir']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) {
      throw new Error(`--server-config must specify an absolute ${key} path: ${file}`);
    }
  }
  return config;
}

function sourceArgs(config) {
  return [
    '--codex-dir', config.codexDir,
    '--opencode-db', config.dbPath,
    '--claude-dir', config.claudeDir,
    '--pi-dir', config.piDir,
    '--dsh-dir', config.dshDir,
    '--meta-dir', config.metaDir,
    '--index-dir', config.indexDir,
    '--cache-dir', config.cacheDir,
  ];
}

function save(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try { renameSync(temporary, file); }
  catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

function* tomlCodeLines(source) {
  let multiline = null;
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf('\n', offset);
    const end = newline < 0 ? source.length : newline + 1;
    const raw = source.slice(offset, end);
    const line = raw.replace(/\r?\n$/, '');
    if (!multiline) yield { index: offset, line, raw };
    for (let index = 0; index < line.length;) {
      if (multiline) {
        let end = line.indexOf(multiline, index);
        while (end >= 0 && multiline === '"""') {
          let slashes = 0;
          for (let cursor = end - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) slashes += 1;
          if (slashes % 2 === 0) break;
          end = line.indexOf(multiline, end + multiline.length);
        }
        if (end < 0) break;
        index = end + multiline.length;
        multiline = null;
        continue;
      }
      if (line[index] === '#') break;
      const delimiter = line.slice(index, index + 3);
      if (delimiter === '"""' || delimiter === "'''") {
        multiline = delimiter;
        index += 3;
        continue;
      }
      if (line[index] === '"') {
        index += 1;
        while (index < line.length && line[index] !== '"') {
          index += line[index] === '\\' ? 2 : 1;
        }
      } else if (line[index] === "'") {
        index += 1;
        while (index < line.length && line[index] !== "'") index += 1;
      }
      index += 1;
    }
    offset = end;
  }
}

function hasTomlKeyAssignment(source, expression) {
  for (const { line } of tomlCodeLines(source)) {
    if (expression.test(line)) return true;
  }
  return false;
}

function tomlTableHeaders(source) {
  const headerPattern = /^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:#.*)?$/;
  return [...tomlCodeLines(source)].flatMap(({ index, line, raw }) => {
    const match = headerPattern.exec(line);
    return match ? [{ index, raw, name: match[1] }] : [];
  });
}

function codexTable(source) {
  const lines = tomlTableHeaders(source);
  const header = `mcp_servers.${name}`;
  const tableNames = [header, `mcp_servers."${name}"`, `mcp_servers.'${name}'`];
  const parentTables = new Set(['mcp_servers', '"mcp_servers"', "'mcp_servers'"]);
  const key = `(?:${name}|"${name}"|'${name}')`;
  const alternateKey = new RegExp(`^[ \\t]*${key}[ \\t]*(?:\\.|=)`);
  const rootDottedKey = new RegExp(`^[ \\t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \\t]*\\.[ \\t]*${key}[ \\t]*(?:\\.|=)`);
  const firstTable = lines[0]?.index ?? source.length;
  if (hasTomlKeyAssignment(source.slice(0, firstTable), rootDottedKey)) {
    throw new Error(`Existing ${name} dotted Codex key needs a manual host config edit.`);
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (!parentTables.has(lines[index].name.trim())) continue;
    const nextHeader = lines[index + 1]?.index ?? source.length;
    const section = source.slice(lines[index].index + lines[index].raw.length, nextHeader);
    if (hasTomlKeyAssignment(section, alternateKey)) {
      throw new Error(`Existing ${name} inline or dotted Codex key needs a manual host config edit.`);
    }
  }
  const matching = lines.filter(match => tableNames.includes(match.name.trim()));
  if (matching.length > 1) throw new Error(`Duplicate [${header}] tables; edit the host config manually.`);
  if (!matching.length && lines.some(match => tableNames.some(table =>
    match.name.trim().startsWith(`${table}.`)))) {
    throw new Error(`Existing nested [${header}] table needs a manual host config edit.`);
  }
  if (!matching.length) return null;
  const start = matching[0].index;
  const next = lines.find(match => match.index > start
    && !tableNames.includes(match.name.trim())
    && !tableNames.some(table => match.name.trim().startsWith(`${table}.`)));
  return { start, end: next?.index ?? source.length };
}

function codexSection(binary, args) {
  return `[mcp_servers.${name}]\ncommand = ${JSON.stringify(binary)}\nargs = [${args.map(JSON.stringify).join(', ')}]\n`;
}

function installCodex(options, args) {
  const source = existsSync(options.hostConfig) ? readFileSync(options.hostConfig, 'utf8') : '';
  const table = codexTable(source);
  const section = codexSection(options.binary, args);
  if (table) {
    if (source.slice(table.start, table.end).trim() === section.trim()) return 'already installed';
    if (!options.replace) throw new Error(`${name} already exists in ${options.hostConfig}; use --replace to overwrite it.`);
  }
  const next = table
    ? source.slice(0, table.start) + section + source.slice(table.end)
    : source.trimEnd() + (source.trimEnd() ? '\n\n' : '') + section;
  save(options.hostConfig, next);
  return table ? 'replaced' : 'installed';
}

function installJson(options, args) {
  const config = readJsonObject(options.hostConfig, 'Host config');
  const claude = options.target === 'claude-code';
  const property = claude ? 'mcpServers' : 'mcp';
  if (config[property] !== undefined && (!config[property] || typeof config[property] !== 'object'
    || Array.isArray(config[property]))) {
    throw new Error(property + ' must be a JSON object in ' + options.hostConfig);
  }
  const servers = claude ? config.mcpServers ?? {} : config.mcp ?? {};
  const legacyServers = servers.servers;
  if (!claude && legacyServers && typeof legacyServers === 'object' && !Array.isArray(legacyServers)
    && !Object.hasOwn(legacyServers, 'type')) {
    throw new Error('Existing legacy OpenCode mcp.servers config needs a manual host config edit: '
      + options.hostConfig);
  }
  const entry = claude
    ? { command: options.binary, args }
    : { type: 'local', command: [options.binary, ...args] };
  const current = servers[name];
  if (current !== undefined) {
    if (isDeepStrictEqual(current, entry)) return 'already installed';
    if (!options.replace) {
      throw new Error(name + ' already exists in ' + options.hostConfig + '; use --replace to overwrite it.');
    }
  }
  servers[name] = entry;
  if (claude) config.mcpServers = servers;
  else config.mcp = servers;
  save(options.hostConfig, JSON.stringify(config, null, 2) + '\n');
  return current === undefined ? 'installed' : 'replaced';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) { console.log(usage()); return; }
  requireRegularFile(options.binary, 'Native AgentSession 3.0 binary');
  const version = spawnSync(options.binary, ['--version'], { encoding: 'utf8', timeout: 5_000,
    windowsHide: true });
  if (version.error || version.status !== 0
    || !/^agentsession-v3 3\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\s*$/.test(version.stdout)) {
    throw new Error(`Binary does not report an AgentSession 3.x version: ${options.binary}`);
  }
  let config;
  if (options.serverConfig) {
    requireRegularFile(options.serverConfig, 'AgentSession 3.0 server config');
    config = requireIsolatedServerConfig(options.serverConfig);
  }
  const args = [...(options.serverConfig ? ['--config', options.serverConfig] : []), 'mcp',
    ...(config ? sourceArgs(config) : [])];
  const status = options.target === 'codex' ? installCodex(options, args) : installJson(options, args);
  console.log(`${name}: ${status} in ${options.target} host config ${options.hostConfig}`);
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
