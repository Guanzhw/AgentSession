import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const SNAPSHOT_FORMAT = 'agentsession-v3-snapshot/v1';
const PROVIDERS = ['opencode', 'claude-code', 'codex', 'pi', 'deepseek-harness'];
const TARGETS = [
  ['opencode', 'long'],
  ['claude-code', 'available-live'],
  ['pi', 'available-live'],
  ['codex', 'long-team-compaction'],
  ['codex', 'compact-team-shorter'],
  ['deepseek-harness', 'native-v3-packed-compaction'],
  ['deepseek-harness', 'recorded-subagent-descriptor'],
].map(([provider, role]) => ({ provider, role, label: `${provider}/${role}` }));

const PROTOCOL_TARGETS = [
  { provider: 'pi', role: 'available-live', compactionFact: 'compactionRecords' },
  { provider: 'codex', role: 'long-team-compaction', compactionFact: 'compactedRecords' },
  { provider: 'deepseek-harness', role: 'native-v3-packed-compaction', compactionFact: 'compactionStartRecords' },
];

const DETAIL_CASES = TARGETS.map(({ provider, role }) => `http.detail.${provider}.${role}`);
const READER_PROTOCOL_CASES = PROTOCOL_TARGETS.flatMap(({ provider }) => [
  `http.reader.${provider}`,
  `http.protocol.${provider}`,
]);
const MCP_CASES = [
  'mcp.tools',
  'mcp.providers',
  ...TARGETS.map(({ provider, role }) => `mcp.get.${provider}.${role}`),
  'mcp.timeline.codex',
  'mcp.timeline.deepseek-harness',
];

const PAGINATION_CASES = [
  { id: 'mcp.browse.opencode.all-roots', provider: 'opencode', rowsKey: 'sessions', pages: 4, rows: 78 },
  { id: 'mcp.timeline.all.codex', provider: 'codex', rowsKey: 'events', pages: 26, rows: 1260 },
  { id: 'mcp.timeline.all.deepseek-harness', provider: 'deepseek-harness', rowsKey: 'events', pages: 20, rows: 1000 },
];

class SafeError extends Error {}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

function targetKey(provider, role) {
  return `${provider}\u0000${role}`;
}

function expectedCaseIds() {
  return {
    http: ['http.providers', ...DETAIL_CASES],
    readerProtocol: READER_PROTOCOL_CASES,
    mcp: MCP_CASES,
    pagination: PAGINATION_CASES.map(({ id }) => id),
  };
}

function validateManifest(manifest) {
  if (!isObject(manifest) || !Array.isArray(manifest.captureTargets) || !isObject(manifest.providerRoots)) {
    throw new SafeError('manifest structure is invalid');
  }

  const rootKeys = Object.keys(manifest.providerRoots);
  if (rootKeys.length !== PROVIDERS.length || PROVIDERS.some((provider) =>
    !Object.hasOwn(manifest.providerRoots, provider) || !isObject(manifest.providerRoots[provider]) ||
    typeof manifest.providerRoots[provider].cliFlag !== 'string' || !manifest.providerRoots[provider].cliFlag ||
    typeof manifest.providerRoots[provider].path !== 'string' || !manifest.providerRoots[provider].path)) {
    throw new SafeError('manifest provider roots are invalid');
  }

  if (manifest.captureTargets.length !== TARGETS.length) {
    throw new SafeError('manifest target count is invalid');
  }

  const expected = new Set(TARGETS.map(({ provider, role }) => targetKey(provider, role)));
  const byKey = new Map();
  for (const target of manifest.captureTargets) {
    if (!isObject(target) || typeof target.provider !== 'string' || typeof target.role !== 'string' ||
        typeof target.sessionId !== 'string' || target.sessionId.length === 0 || !isObject(target.knownFacts)) {
      throw new SafeError('manifest target structure is invalid');
    }
    const key = targetKey(target.provider, target.role);
    if (!expected.has(key) || byKey.has(key)) throw new SafeError('manifest target labels are invalid');
    for (const count of Object.values(target.knownFacts)) {
      if (!Number.isSafeInteger(count) || count < 0) throw new SafeError('manifest fact counts are invalid');
    }
    byKey.set(key, { ...target, label: `${target.provider}/${target.role}` });
  }
  if (byKey.size !== expected.size) throw new SafeError('manifest targets are incomplete');
  return byKey;
}

function indexSnapshot(snapshot, label, requiredIds, issues) {
  if (!isObject(snapshot) || Object.keys(snapshot).length !== 2 || !Object.hasOwn(snapshot, 'format') ||
      !Object.hasOwn(snapshot, 'cases') || snapshot.format !== SNAPSHOT_FORMAT || !Array.isArray(snapshot.cases)) {
    throw new SafeError(`${label} snapshot structure is invalid`);
  }

  const required = new Set(requiredIds);
  const byId = new Map();
  for (const item of snapshot.cases) {
    if (!isObject(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'id') ||
        !Object.hasOwn(item, 'result') || typeof item.id !== 'string' || item.id.length === 0) {
      throw new SafeError(`${label} snapshot case structure is invalid`);
    }
    if (byId.has(item.id)) throw new SafeError(`${label} snapshot has duplicate case ${fingerprint(item.id)}`);
    byId.set(item.id, item.result);
  }

  for (const id of requiredIds) {
    if (!byId.has(id)) issues.add(id, 'case missing');
  }
  for (const id of byId.keys()) {
    if (!required.has(id)) issues.add(`extra ${label} case ${fingerprint(id)}`, 'case is outside the frozen capture set');
  }
  return byId;
}

function createIssues() {
  const items = [];
  let count = 0;
  return {
    add(label, reason) {
      count += 1;
      if (items.length < 24) items.push({ label, reason });
    },
    get count() { return count; },
    get items() { return items; },
  };
}

function validMcpResponse(response) {
  if (!isObject(response)) return false;
  // MCP omits isError on success in the captured SDK response; explicit true is a failure.
  return !Object.hasOwn(response, 'isError') || response.isError === false;
}

function checkProviderList(rows, idField, label, issues) {
  if (!Array.isArray(rows)) {
    issues.add(label, 'provider list missing');
    return;
  }
  if (rows.length !== PROVIDERS.length) issues.add(label, 'provider count differs');
  const seen = new Set();
  for (const row of rows) {
    if (!isObject(row)) {
      issues.add(label, 'provider entry invalid');
      continue;
    }
    const provider = row[idField];
    if (typeof provider !== 'string' || !PROVIDERS.includes(provider)) {
      issues.add(label, 'provider set differs');
      continue;
    }
    if (seen.has(provider)) issues.add(`${label} ${provider}`, 'provider is duplicated');
    seen.add(provider);
    if (row.available !== true) issues.add(`${label} ${provider}`, 'provider is unavailable');
  }
  if (seen.size !== PROVIDERS.length || PROVIDERS.some((provider) => !seen.has(provider))) {
    issues.add(label, 'provider set differs');
  }
}

function checkHttpDetail(result, target, issues) {
  const label = `HTTP detail ${target.label}`;
  if (!isObject(result) || result.status !== 200) issues.add(label, 'status is not 200');
  const session = result?.body?.session;
  if (session?.provider !== target.provider || session?.id !== target.sessionId) {
    issues.add(label, 'canonical identity differs from manifest');
  }
}

function checkMcpSuccess(result, label, issues) {
  if (!isObject(result) || !validMcpResponse(result.response)) issues.add(label, 'MCP response is an error or malformed');
}

function checkMcpGet(result, target, issues) {
  const label = `MCP get ${target.label}`;
  checkMcpSuccess(result, label, issues);
  const session = result?.response?.structuredContent?.result?.session;
  if (session?.provider !== target.provider || session?.sessionId !== target.sessionId) {
    issues.add(label, 'canonical identity differs from manifest');
  }
}

function checkReader(result, target, issues) {
  const label = `HTTP reader ${target.label}`;
  if (!isObject(result) || result.status !== 200) issues.add(label, 'status is not 200');
  const body = result?.body;
  if (body?.ok !== true || body.provider !== target.provider || body.sessionId !== target.sessionId) {
    issues.add(label, 'canonical identity or reader status differs from manifest');
  }
}

function checkProtocol(result, target, sourceCompactionCount, issues) {
  const label = `HTTP protocol ${target.label}`;
  if (!isObject(result) || result.status !== 200) issues.add(label, 'status is not 200');
  const body = result?.body;
  const protocol = body?.protocol;
  const ref = protocol?.session?.ref;
  if (body?.validation?.ok !== true || protocol?.validation?.ok !== true) {
    issues.add(label, 'protocol validation is not ok');
  }
  if (body?.sessionId !== target.sessionId || protocol?.sessionId !== target.sessionId ||
      ref?.provider !== target.provider || ref?.sessionId !== target.sessionId) {
    issues.add(label, 'canonical identity differs from manifest');
  }
  if (!Array.isArray(protocol?.events)) {
    issues.add(label, 'protocol events are missing');
    return;
  }
  let eventIdentityErrors = 0;
  for (const event of protocol.events) {
    if (!isObject(event) || event.sessionId !== target.sessionId) eventIdentityErrors += 1;
  }
  if (eventIdentityErrors > 0) issues.add(label, 'event identity differs from manifest');

  const recordedCompactions = protocol.events.filter((event) => isObject(event) &&
    event.kind === 'context.compaction' && event.category === 'context' &&
    event.provenance?.fidelity === 'recorded');
  if (recordedCompactions.length !== sourceCompactionCount) {
    issues.add(label, 'recorded context.compaction count differs from source manifest');
  }
}

function checkTimeline(result, provider, target, issues) {
  const label = `MCP timeline ${provider}`;
  checkMcpSuccess(result, label, issues);
  const events = result?.response?.structuredContent?.result?.events;
  if (!Array.isArray(events)) {
    issues.add(label, 'events are missing');
    return;
  }
  for (const event of events) {
    const ref = event?.event;
    if (ref?.provider !== provider || ref?.sessionId !== target.sessionId ||
        typeof ref?.messageId !== 'string' || !ref.messageId || typeof ref?.segment !== 'string' || !ref.segment) {
      issues.add(label, 'canonical event identity is invalid');
      return;
    }
  }
}

function checkPagination(snapshot, targetsByKey, opencodeRootIds, codexSourcePositions, issues) {
  if (!snapshot) return null;
  const cases = indexSnapshot(snapshot, 'MCP pagination', PAGINATION_CASES.map(({ id }) => id), issues);
  const totals = { pages: 0, rows: 0 };

  for (const expected of PAGINATION_CASES) {
    const label = `MCP pagination ${expected.provider}`;
    const result = cases.get(expected.id);
    if (!isObject(result) || result.kind !== 'mcp-paginate' || !Array.isArray(result.pages)) {
      issues.add(label, 'pagination pages are missing');
      continue;
    }
    if (result.pages.length !== expected.pages) issues.add(label, 'page count differs from frozen capture');
    totals.pages += result.pages.length;
    const references = new Set();
    const cursors = new Set();
    let rowCount = 0;
    let previousCodexSourcePosition = -1;
    const expectedSessionId = expected.rowsKey === 'events'
      ? targetsByKey.get(targetKey(expected.provider,
        expected.provider === 'codex' ? 'long-team-compaction' : 'native-v3-packed-compaction')).sessionId
      : null;

    for (let pageIndex = 0; pageIndex < result.pages.length; pageIndex += 1) {
      const response = result.pages[pageIndex];
      if (!validMcpResponse(response)) issues.add(label, 'page response is an MCP error');
      const page = response?.structuredContent?.result;
      if (!isObject(page)) {
        issues.add(label, 'page result is malformed');
        continue;
      }
      const nextCursor = page.nextCursor;
      // The frozen capture stores responses, while the capture runner owns cursor forwarding.
      if (!(nextCursor === null || (typeof nextCursor === 'string' && nextCursor.length > 0)) ||
          typeof page.truncated !== 'boolean' || page.truncated !== (nextCursor !== null)) {
        issues.add(label, 'cursor and truncated state disagree');
      }
      if (pageIndex < result.pages.length - 1 && nextCursor === null) {
        issues.add(label, 'pagination ended before the final page');
      }
      if (pageIndex === result.pages.length - 1 && nextCursor !== null) {
        issues.add(label, 'final page retains a cursor');
      }
      if (typeof nextCursor === 'string') {
        if (cursors.has(nextCursor)) issues.add(label, 'pagination cursor repeats');
        cursors.add(nextCursor);
      }

      const rows = page[expected.rowsKey];
      if (!Array.isArray(rows)) {
        issues.add(label, 'page rows are missing');
        continue;
      }
      rowCount += rows.length;
      for (const row of rows) {
        const ref = expected.rowsKey === 'sessions' ? row?.session : row?.event;
        const validSession = ref?.provider === expected.provider && typeof ref?.sessionId === 'string' &&
          ref.sessionId.length > 0 && (expectedSessionId === null || ref.sessionId === expectedSessionId);
        const validEvent = expected.rowsKey !== 'events' ||
          (typeof ref?.messageId === 'string' && ref.messageId.length > 0 && typeof ref?.segment === 'string' && ref.segment.length > 0);
        if (!validSession || !validEvent) {
          issues.add(label, 'canonical source reference is invalid');
          continue;
        }
        if (expected.provider === 'codex') {
          const position = codexSourcePositions?.get(ref.messageId);
          if (!Number.isSafeInteger(position) || position <= previousCodexSourcePosition) {
            issues.add(label, 'event reference is missing from or out of order in source JSONL');
          } else {
            previousCodexSourcePosition = position;
          }
        }
        const reference = expected.rowsKey === 'sessions'
          ? JSON.stringify([ref.provider, ref.sessionId])
          : JSON.stringify([ref.provider, ref.sessionId, ref.messageId, ref.segment]);
        if (references.has(reference)) issues.add(label, 'canonical source reference repeats');
        references.add(reference);
      }
    }
    totals.rows += rowCount;
    if (rowCount !== expected.rows) issues.add(label, 'row count differs from frozen capture');
    if (expected.rowsKey === 'sessions') {
      const actualIds = result.pages.flatMap((response) =>
        Array.isArray(response?.structuredContent?.result?.sessions)
          ? response.structuredContent.result.sessions.map((row) => row?.session?.sessionId)
          : []);
      if (!Array.isArray(opencodeRootIds) || actualIds.length !== opencodeRootIds.length ||
          actualIds.some((id, index) => id !== opencodeRootIds[index])) {
        issues.add(label, 'ordered canonical refs differ from source SQLite');
      }
    }
  }
  return totals;
}

export function verifySourceFacts({ manifest, httpDetails, readerProtocol, mcp, mcpPagination = null, opencodeRootIds = null, codexSourcePositions = null }) {
  const issues = createIssues();
  const targetsByKey = validateManifest(manifest);
  const expected = expectedCaseIds();
  const http = indexSnapshot(httpDetails, 'HTTP details', expected.http, issues);
  const reader = indexSnapshot(readerProtocol, 'Reader/protocol', expected.readerProtocol, issues);
  const mcpCases = indexSnapshot(mcp, 'MCP', expected.mcp, issues);
  const targetFor = (provider, role) => targetsByKey.get(targetKey(provider, role));

  checkProviderList(http.get('http.providers')?.body, 'id', 'HTTP providers', issues);
  for (const targetSpec of TARGETS) {
    const target = targetFor(targetSpec.provider, targetSpec.role);
    checkHttpDetail(http.get(`http.detail.${target.provider}.${target.role}`), target, issues);
    checkMcpGet(mcpCases.get(`mcp.get.${target.provider}.${target.role}`), target, issues);
  }
  checkProviderList(
    mcpCases.get('mcp.providers')?.response?.structuredContent?.result?.providers,
    'provider',
    'MCP providers',
    issues,
  );
  checkMcpSuccess(mcpCases.get('mcp.tools'), 'MCP tools', issues);
  checkMcpSuccess(mcpCases.get('mcp.providers'), 'MCP providers', issues);

  for (const protocolTarget of PROTOCOL_TARGETS) {
    const target = targetFor(protocolTarget.provider, protocolTarget.role);
    checkReader(reader.get(`http.reader.${target.provider}`), target, issues);
    const knownCompactions = target.knownFacts[protocolTarget.compactionFact];
    checkProtocol(reader.get(`http.protocol.${target.provider}`), target,
      Number.isSafeInteger(knownCompactions) ? knownCompactions : 0, issues);
  }

  checkTimeline(mcpCases.get('mcp.timeline.codex'), 'codex',
    targetFor('codex', 'long-team-compaction'), issues);
  checkTimeline(mcpCases.get('mcp.timeline.deepseek-harness'), 'deepseek-harness',
    targetFor('deepseek-harness', 'native-v3-packed-compaction'), issues);

  const pagination = checkPagination(mcpPagination, targetsByKey, opencodeRootIds, codexSourcePositions, issues);
  return {
    passed: issues.count === 0,
    issueCount: issues.count,
    issues: issues.items,
    counts: {
      targets: TARGETS.length,
      httpDetails: DETAIL_CASES.length,
      readerCases: PROTOCOL_TARGETS.length,
      protocolCases: PROTOCOL_TARGETS.length,
      mcpGets: TARGETS.length,
      mcpCases: MCP_CASES.length,
      paginationPages: pagination?.pages ?? 0,
      paginationRows: pagination?.rows ?? 0,
    },
  };
}

function readOpenCodeRootIds(manifest) {
  const dbPath = manifest?.providerRoots?.opencode?.path;
  if (typeof dbPath !== 'string' || !dbPath) throw new SafeError('OpenCode source path is unavailable');
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db.prepare(`SELECT id FROM session_v2
      WHERE time_archived IS NULL AND parent_id IS NULL
      ORDER BY time_updated DESC, time_created DESC, id ASC`).all().map((row) => row.id);
  } catch {
    throw new SafeError('OpenCode source roots cannot be read');
  } finally {
    db?.close();
  }
}

async function readCodexSourcePositions(manifest) {
  const sourcePath = manifest?.files?.find((file) =>
    file?.provider === 'codex' && file?.role === 'long-team-compaction')?.snapshotPath;
  if (typeof sourcePath !== 'string' || !sourcePath) throw new SafeError('Codex source path is unavailable');
  let text;
  try {
    text = await readFile(sourcePath, 'utf8');
  } catch {
    throw new SafeError('Codex source cannot be read');
  }
  const positions = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload;
    if (!isObject(payload)) continue;
    for (const key of ['id', 'message_id', 'call_id']) {
      if (typeof payload[key] === 'string' && !positions.has(payload[key])) positions.set(payload[key], index);
    }
  }
  return positions;
}

function parseArguments(args) {
  const values = new Map();
  const known = new Set(['--manifest', '--http-details', '--reader-protocol', '--mcp', '--mcp-pagination']);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!known.has(flag)) throw new SafeError('unknown command-line option');
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new SafeError(`${flag} requires a path`);
    if (values.has(flag)) throw new SafeError(`${flag} may be specified once`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of ['--manifest', '--http-details', '--reader-protocol', '--mcp']) {
    if (!values.has(flag)) throw new SafeError(`missing required option ${flag}`);
  }
  return values;
}

async function readDocument(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch {
    throw new SafeError(`${label} input cannot be read`);
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), hash: digest(bytes) };
  } catch {
    throw new SafeError(`${label} input is invalid JSON`);
  }
}

function printReport(result, hashes) {
  if (result.passed) {
    const pagination = hashes.pagination
      ? `; pagination pages=${result.counts.paginationPages} rows=${result.counts.paginationRows}`
      : '';
    process.stdout.write(
      `PASS source-facts targets=${result.counts.targets} HTTP details=${result.counts.httpDetails} providers=5 ` +
      `Reader=${result.counts.readerCases} protocols=${result.counts.protocolCases} ` +
      `MCP gets=${result.counts.mcpGets} providers=5 cases=${result.counts.mcpCases}${pagination}; ` +
      `sha256 manifest=${hashes.manifest} http=${hashes.http} reader-protocol=${hashes.reader} mcp=${hashes.mcp}` +
      (hashes.pagination ? ` pagination=${hashes.pagination}` : '') + '\n',
    );
    return;
  }
  process.stdout.write(`FAIL source-facts checks=${result.issueCount}\n`);
  for (const { label, reason } of result.issues) process.stdout.write(`- ${label}: ${reason}\n`);
  if (result.issueCount > result.issues.length) {
    process.stdout.write(`- additional failures=${result.issueCount - result.issues.length}\n`);
  }
}

async function main(args) {
  try {
    const options = parseArguments(args);
    const labels = [
      ['--manifest', 'manifest'],
      ['--http-details', 'http'],
      ['--reader-protocol', 'reader'],
      ['--mcp', 'mcp'],
      ['--mcp-pagination', 'pagination'],
    ];
    const loaded = await Promise.all(labels.map(async ([flag, label]) =>
      options.has(flag) ? [label, await readDocument(options.get(flag), label)] : [label, null]));
    const input = Object.fromEntries(loaded);
    const result = verifySourceFacts({
      manifest: input.manifest.value,
      httpDetails: input.http.value,
      readerProtocol: input.reader.value,
      mcp: input.mcp.value,
      mcpPagination: input.pagination?.value ?? null,
      opencodeRootIds: input.pagination ? readOpenCodeRootIds(input.manifest.value) : null,
      codexSourcePositions: input.pagination ? await readCodexSourcePositions(input.manifest.value) : null,
    });
    printReport(result, {
      manifest: input.manifest.hash,
      http: input.http.hash,
      reader: input.reader.hash,
      mcp: input.mcp.hash,
      pagination: input.pagination?.hash ?? null,
    });
    return result.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`ERROR source-facts ${error instanceof SafeError ? error.message : 'verification failed'}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
