import { browserPrerequisites } from './browser-prerequisites.mjs';
import { onCleanup, temporaryDirectory } from '../../test/helpers/fixture-cleanup.mjs';
import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.join(repo, 'v3', 'ui');
const sessionA = 's2-ui-session-a';
const sessionB = 's2-ui-session-b';
const dshProvider = 'deepseek-harness';
const dshIds = { root: 'dsh-v3-s2-root', alpha: 'dsh-v3-s2-alpha', beta: 'dsh-v3-s2-beta' };
const orphanDsh = dshSummary('dsh-v3-s2-orphan', 'DSH child with missing parent', 'dsh-v3-s2-missing-parent');
const toolInput = `{"command":"${'i'.repeat(1450)}","tail":"input-end"}`;
const toolOutput = `{"result":"${'o'.repeat(1460)}","tail":"output-end"}`;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const { browserBinary: agentBrowserExe, skip: skipReason } = browserPrerequisites({ ui: uiDir });

async function freePort() {
  return freeFetchSafePort();
}

function summary(id, title) {
  return {
    session: { provider: 'codex', sessionId: id },
    title,
    directory: null,
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_000_000,
    messageCount: 1,
    tokenCount: null,
    parent: null,
  };
}

function dshSessionRef(sessionId) {
  return { provider: dshProvider, sessionId };
}

function dshSummary(id, title, parentId = null) {
  return {
    session: dshSessionRef(id),
    title,
    directory: '/synthetic/dsh-s2',
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_000_000,
    messageCount: 2,
    tokenCount: null,
    parent: parentId ? dshSessionRef(parentId) : null,
  };
}

const dshRows = [
  dshSummary(dshIds.root, 'DSH S2 root'),
  dshSummary(dshIds.alpha, 'DSH S2 alpha child', dshIds.root),
  dshSummary(dshIds.beta, 'DSH S2 beta child', dshIds.root),
];

const opencodeRoot = 'opencode-root';
const opencodeRows = [
  { ...summary(opencodeRoot, 'OpenCode project root'),
    session: { provider: 'opencode', sessionId: opencodeRoot } },
  ...Array.from({ length: 73 }, (_, index) => ({
    ...summary(`opencode-child-${String(index + 1).padStart(3, '0')}`,
      `OpenCode child ${String(index + 1).padStart(3, '0')}${index === 72 ? ' project root' : ''}`),
    session: { provider: 'opencode', sessionId: `opencode-child-${String(index + 1).padStart(3, '0')}` },
    parent: { provider: 'opencode', sessionId: opencodeRoot },
  })),
];

const statsReport = {
  provider: 'codex', scope: 'active_source_sessions', revision: 'stats-revision-1',
  coverage: 'partial', usageCoverage: 'partial',
  modelRanking: [
    { model: 'model-one', recordedRequestCount: 1, knownTokenCount: 47, unknownTokenRequestCount: 0 },
    { model: null, recordedRequestCount: 1, knownTokenCount: 0, unknownTokenRequestCount: 1 },
  ],
  availableDirectories: ['/project/a', '/project/b'], availableModels: [{ model: 'model-one' }, { model: 'model-two' }],
  availableProjects: ['project-a', 'project-b'],
  overview: { totalSessions: 2, totalMessages: 3, totalTokens: null,
    recordedRequestCount: 2, knownTokenCount: 47, unknownTokenRequestCount: 1,
    unresolvedUsageObservationCount: 0, untimedRequestCount: 0 },
  sessions: [
    { session: { provider: 'codex', sessionId: sessionA }, createdAt: null, updatedAt: null,
      messageCount: 1, tokenCount: null, recordedRequestCount: 2, knownTokenCount: 47,
      unknownTokenRequestCount: 1, unresolvedUsageObservationCount: 0 },
  ],
  dailyUsage: [
    { day: '2026-09-19', recordedRequestCount: 1, knownTokenCount: 47,
      unknownTokenRequestCount: 0, unresolvedUsageObservationCount: 0,
      inputTokens: 30, outputTokens: 17,
      reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      sessions: [{ session: { provider: 'codex', sessionId: sessionA },
        recordedRequestCount: 1, knownTokenCount: 47, unknownTokenRequestCount: 0,
        unresolvedUsageObservationCount: 0 }],
      totalTokens: 47 },
    { day: '2026-09-20', recordedRequestCount: 1, knownTokenCount: 0,
      unknownTokenRequestCount: 1, unresolvedUsageObservationCount: 0,
      inputTokens: null, outputTokens: null,
      reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      sessions: [{ session: { provider: 'codex', sessionId: sessionB },
        recordedRequestCount: 1, knownTokenCount: 0, unknownTokenRequestCount: 1,
        unresolvedUsageObservationCount: 0 }],
      totalTokens: null },
  ],
  usageRange: { fromDay: '2026-09-01', toDay: '2026-09-30' },
};

function dshBootstrap(id) {
  const isRoot = id === dshIds.root;
  const title = [...dshRows, orphanDsh].find(row => row.session.sessionId === id)?.title || 'Unknown DSH session';
  const items = (isRoot
    ? [['root-user', 'user', 'The parent delegates source-backed work.'], ['root-final', 'assistant', 'Both synthetic reports are recorded.']]
    : [[id === dshIds.alpha ? 'alpha-user' : 'beta-user', 'user', 'Inspect the assigned source.'],
      [id === dshIds.alpha ? 'alpha-answer' : 'beta-answer', 'assistant', 'The child result is recorded.']])
    .map(([messageId, role, preview], ordinal) => ({
      event: { provider: dshProvider, sessionId: id, messageId, segment: 'message' },
      ordinal,
      owner: null,
      role,
      timestamp: null,
      preview,
      totalChars: 0,
      toolName: null,
      ownerMessageId: null,
      replyMetadata: null,
    }));
  if (isRoot) items.splice(1, 0, {
    event: { provider: dshProvider, sessionId: id, messageId: 'root-final', segment: 'thinking' },
    ordinal: 1,
    owner: { provider: dshProvider, sessionId: id, messageId: 'root-final', segment: 'message' },
    role: 'assistant',
    timestamp: null,
    preview: 'Recorded private reasoning for the final assistant response.',
    totalChars: 0,
    toolName: null,
    ownerMessageId: 'root-final',
    replyMetadata: null,
  });
  items.forEach((item, ordinal) => { item.ordinal = ordinal; });
  return {
    session: dshSummary(id, title, isRoot ? null : dshIds.root),
    revision: `revision-${id}`,
    totalItems: items.length,
    segments: [{
      id: 'segment-0',
      pageId: `page-${id}-0`,
      startOrdinal: 0,
      items,
      ownerContext: null,
      previousCursor: null,
      nextCursor: null,
    }],
    toc: {
      entries: items.map(item => ({ event: item.event, ordinal: item.ordinal, owner: null, label: item.preview })),
      previousCursor: null,
      nextCursor: null,
    },
    relations: isRoot
      ? { taskCount: 4, observationCount: 12, firstCursor: 'dsh-relations-root-0' }
      : { taskCount: 0, observationCount: 0, firstCursor: null },
  };
}

const dshRelationEntries = [
  { type: 'task', task: { id: 'team:alpha', kind: 'team-task', status: 'completed', owner: dshIds.alpha,
    provenance: { fidelity: 'recorded', sourceType: 'dsh.session-event:team/task', sourceId: '20' } } },
  { type: 'task', task: { id: 'team:beta', kind: 'team-task', status: 'completed', owner: dshIds.beta,
    provenance: { fidelity: 'recorded', sourceType: 'dsh.session-event:team/task', sourceId: '18' } } },
  { type: 'task', task: { id: 'workflow:parallel-inspection:1', kind: 'workflow', status: 'completed', owner: dshIds.alpha,
    provenance: { fidelity: 'recorded', sourceType: 'dsh.session-event:tool-workflow/agent-start', sourceId: '9' } } },
  { type: 'task', task: { id: 'workflow:parallel-inspection:2', kind: 'workflow', status: 'completed', owner: dshIds.beta,
    provenance: { fidelity: 'recorded', sourceType: 'dsh.session-event:tool-workflow/agent-start', sourceId: '12' } } },
  ...[
    ['message', 'requested', 'mail-alpha-initial', 8, dshIds.root, dshIds.alpha, 'team/message/queued'],
    ['spawn', 'started', 'parallel-inspection:1', 10, dshIds.root, dshIds.alpha, 'tool-workflow/agent-start'],
    ['message', 'requested', 'mail-beta-initial', 11, dshIds.root, dshIds.beta, 'team/message/queued'],
    ['spawn', 'started', 'parallel-inspection:2', 13, dshIds.root, dshIds.beta, 'tool-workflow/agent-start'],
    ['message', 'requested', 'mail-alpha-followup', 15, dshIds.root, dshIds.alpha, 'team/message/queued'],
    ['mailbox-delivery', 'delivered', 'mail-alpha-followup', 16, dshIds.root, dshIds.alpha, 'team/message/delivered'],
    ['spawn', 'completed', 'parallel-inspection:2', 17, dshIds.root, dshIds.beta, 'tool-workflow/agent-end'],
    ['spawn', 'completed', 'parallel-inspection:1', 19, dshIds.root, dshIds.alpha, 'tool-workflow/agent-end'],
    ['message', 'requested', 'mail-alpha-return', 21, dshIds.alpha, dshIds.root, 'team/message/queued'],
    ['mailbox-delivery', 'delivered', 'mail-alpha-return', 22, dshIds.alpha, dshIds.root, 'team/message/delivered'],
    ['message', 'requested', 'mail-beta-return', 23, dshIds.beta, dshIds.root, 'team/message/queued'],
    ['mailbox-delivery', 'delivered', 'mail-beta-return', 24, dshIds.beta, dshIds.root, 'team/message/delivered'],
  ].map(([kind, state, correlationId, seq, from, to, sourceType]) => ({
    type: 'coordination',
    observation: {
      kind,
      state,
      correlationId,
      eventId: `event:dsh:${seq}`,
      fromSessionRef: dshSessionRef(from),
      toSessionRef: dshSessionRef(to),
      provenance: { fidelity: 'recorded', sourceType: `dsh.session-event:${sourceType}`, sourceId: String(seq) },
    },
  })),
];

function bootstrap(id) {
  const isToolSession = id === sessionB;
  const item = {
    event: { provider: 'codex', sessionId: id, messageId: isToolSession ? 'tool-orphan' : 'assistant-a', segment: isToolSession ? 'tool' : 'message' },
    ordinal: 0,
    owner: null,
    role: isToolSession ? 'tool' : 'assistant',
    timestamp: null,
    preview: isToolSession ? 'Standalone tool activity' : 'Earlier session',
    totalChars: 0,
    toolName: isToolSession ? 'orphan-tool' : null,
    ownerMessageId: null,
    replyMetadata: null,
    contentRevisions: {},
  };
  const title = isToolSession ? 'Session B' : 'Session A';
  const entry = {
    event: item.event,
    ordinal: item.ordinal,
    owner: item.owner,
    label: item.preview,
  };
  const items = isToolSession ? [{
    event: { provider: 'codex', sessionId: id, messageId: 'tool-orphan', segment: 'thinking' },
    ordinal: 0,
    owner: item.event,
    role: 'tool',
    timestamp: null,
    preview: 'Recorded reasoning before the tool-only call.',
    totalChars: 0,
    toolName: null,
    ownerMessageId: 'tool-orphan',
    replyMetadata: null,
  }, { ...item, ordinal: 1 }] : [item];
  return {
    session: summary(id, title),
    revision: `revision-${id}`,
    totalItems: items.length,
    segments: [{
      id: 'segment-0',
      pageId: `page-${id}-0`,
      startOrdinal: 0,
      items,
      ownerContext: null,
      previousCursor: null,
      nextCursor: null,
    }],
    toc: { entries: items.map(row => ({ ...entry, event: row.event, ordinal: row.ordinal,
      owner: row.owner, label: row.preview })), previousCursor: null, nextCursor: null },
  };
}

async function startHarness(t, { dshListError = false, extraRows = 0,
  withOpenCode = false, withOrphanDsh = false, onlyOrphanDsh = false,
  withRecentDshChild = false, withCyclicDsh = false, holdStats = false,
  withModelKeyCollision = false,
  staleStatsDayRevisionOnce = false, holdFirstStatsDay = false,
  staleChildCursorOnce = false } = {}) {
  const requireFromUi = createRequire(path.join(uiDir, 'package.json'));
  const { build } = requireFromUi('vite');
  const buildDir = await temporaryDirectory(t, path.join(os.tmpdir(), 'agentsession-v3-ui-build-'));
  await build({
    root: uiDir,
    configFile: path.join(uiDir, 'vite.config.ts'),
    build: { outDir: buildDir, emptyOutDir: true },
    logLevel: 'error',
  });

  const sessionRows = [summary(sessionA, 'Session A'), summary(sessionB, 'Session B'),
    ...Array.from({ length: extraRows }, (_, index) => summary(`s2-ui-extra-${index}`, `Extra session ${index}`))];
  const dshList = onlyOrphanDsh ? [orphanDsh] : withRecentDshChild
    ? dshRows.map((row, index) => ({ ...row, updatedAt: index === 1
      ? 1_790_001_000_000 : 1_789_999_000_000 }))
    : withOrphanDsh ? [...dshRows, orphanDsh] : withCyclicDsh
      ? [...dshRows, dshSummary('dsh-v3-s2-cycle', 'DSH cyclic child', 'dsh-v3-s2-cycle')] : dshRows;
  const libraryRows = [...(onlyOrphanDsh ? [] : sessionRows), ...(dshListError ? [] : dshList),
    ...(withOpenCode ? opencodeRows : [])];
  const libraryKey = row => `${row.session.provider}/${row.session.sessionId}`;
  const rowByKey = new Map(libraryRows.map(row => [libraryKey(row), row]));
  const rootFor = row => {
    let root = row;
    const seen = new Set([libraryKey(row)]);
    while (root.parent && rowByKey.has(libraryKey({ session: root.parent }))
      && !seen.has(libraryKey({ session: root.parent }))) {
      root = rowByKey.get(libraryKey({ session: root.parent }));
      seen.add(libraryKey(root));
    }
    return root;
  };
  const familyOf = row => libraryRows.filter(candidate => libraryKey(rootFor(candidate)) === libraryKey(row));
  const matchesLibrary = (row, search) => !search || [row.title, row.directory || '',
    row.session.provider, row.session.sessionId].some(value => value.toLowerCase().includes(search));
  const libraryNode = (row, search) => {
    const family = familyOf(row);
    const children = libraryRows.filter(child => child.parent && libraryKey({ session: child.parent }) === libraryKey(row));
    return { session: row, matched: matchesLibrary(row, search),
      matchingCount: (libraryKey(rootFor(row)) === libraryKey(row) ? family : [row]).filter(member => matchesLibrary(member, search)).length,
      childCount: children.filter(child => matchesLibrary(child, search)).length,
      totalChildCount: children.length, familyRootId: rootFor(row).session.sessionId,
      familyUpdated: Math.max(...family.map(member => member.updatedAt ?? 0)),
      parentBoundary: row.parent && libraryKey({ session: row.parent }) === libraryKey(row)
        ? 'cyclic-parent' : row.parent && !rowByKey.has(libraryKey({ session: row.parent })) ? 'missing-parent' : null };
  };
  const contentRequests = [];
  const requests = [];
  const statsRequests = [];
  let resolveAStarted;
  const aStarted = new Promise(resolve => { resolveAStarted = resolve; });
  let resolveStatsStarted;
  const statsStarted = new Promise(resolve => { resolveStatsStarted = resolve; });
  let resolveStatsDayStarted;
  const statsDayStarted = new Promise(resolve => { resolveStatsDayStarted = resolve; });
  let releaseStats;
  let heldStatsResponse;
  let heldStatsDayResponse;
  let heldStatsDayBody;
  let releaseStatsDay;
  let statsRevision = statsReport.revision;
  let staleStatsDaySent = false;
  let statsDayHeld = false;
  let heldAResponse;
  let releaseA;
  let staleChildCursor = staleChildCursorOnce;

  const server = createHttpServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    requests.push(`${request.method} ${url.pathname}`);
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/providers') {
      json([{ id: 'codex', available: true }, { id: dshProvider, available: true },
        ...(withOpenCode ? [{ id: 'opencode', available: true }] : [])]);
      return;
    }
    const selectedStatsHarness = url.searchParams.get('providers');
    if (url.pathname === '/api/v3/stats/codex' || (url.pathname === '/api/v3/stats/all' && selectedStatsHarness !== 'opencode')) {
      statsRequests.push(`${url.pathname}?${url.searchParams.toString()}`);
      if (holdStats && url.searchParams.get('days') === '30') {
        heldStatsResponse = response;
        resolveStatsStarted();
        releaseStats = () => {
          if (!heldStatsResponse || heldStatsResponse.writableEnded || heldStatsResponse.destroyed) return;
          json({ ...statsReport, sources: [{ provider: 'codex', status: 'readable', diagnostic: null, overview: statsReport.overview }] });
          heldStatsResponse = undefined;
        };
        return;
      }
      const day = url.searchParams.get('day');
      if (!day && staleStatsDaySent) statsRevision = 'stats-revision-2';
      const revision = day && staleStatsDayRevisionOnce && !staleStatsDaySent
        ? (staleStatsDaySent = true, 'stats-revision-2') : statsRevision;
      const body = { ...statsReport, revision, sources: [{ provider: 'codex', status: 'readable', diagnostic: null, overview: statsReport.overview }], dailyUsage: statsReport.dailyUsage
        .filter(row => !day || row.day === day)
        .map(row => day ? row : { ...row, sessions: [] }) };
      if (holdFirstStatsDay && day && !statsDayHeld) {
        statsDayHeld = true;
        heldStatsDayResponse = response;
        heldStatsDayBody = body;
        resolveStatsDayStarted();
        releaseStatsDay = () => {
          if (!heldStatsDayResponse || heldStatsDayResponse.writableEnded || heldStatsDayResponse.destroyed) return;
          json(heldStatsDayBody);
          heldStatsDayResponse = undefined;
        };
        return;
      }
      json(body);
      return;
    }
    if (withOpenCode && (url.pathname === '/api/v3/stats/opencode' || (url.pathname === '/api/v3/stats/all' && selectedStatsHarness === 'opencode'))) {
      const day = url.searchParams.get('day');
      statsRequests.push(`${url.pathname}?${url.searchParams.toString()}`);
      const collisionRows = withModelKeyCollision ? [
        { model: '["p","m"]', recordedRequestCount: 1,
          knownTokenCount: 3, unknownTokenRequestCount: 0 },
        { model: 'm', modelProvider: 'p', recordedRequestCount: 1,
          knownTokenCount: 2, unknownTokenRequestCount: 0 },
      ] : [];
      json({ ...statsReport, provider: 'opencode', sources: [{ provider: 'opencode', status: 'readable', diagnostic: null, overview: statsReport.overview }],
        modelRanking: [...statsReport.modelRanking,
          { model: 'shared-model', recordedRequestCount: 1,
            knownTokenCount: 3, unknownTokenRequestCount: 0 },
          { model: 'shared-model', modelProvider: 'provider-a', recordedRequestCount: 1,
            knownTokenCount: 5, unknownTokenRequestCount: 0 },
          { model: 'shared-model', modelProvider: 'provider-b', recordedRequestCount: 1,
            knownTokenCount: 4, unknownTokenRequestCount: 0 },
          { model: null, modelProvider: 'provider-only', recordedRequestCount: 1,
            knownTokenCount: 2, unknownTokenRequestCount: 0 }, ...collisionRows],
        dailyUsage: statsReport.dailyUsage.filter(row => !day || row.day === day)
          .map(row => day ? row : { ...row, sessions: [] }),
        availableModels: url.searchParams.get('project') === 'project-b'
          ? [{ model: 'model-one' }] : [...statsReport.availableModels,
            { model: 'shared-model' },
            { model: 'shared-model', modelProvider: 'provider-a' },
            { model: 'shared-model', modelProvider: 'provider-b' },
            ...collisionRows.map(({ model, modelProvider }) => ({ model, modelProvider }))] });
      return;
    }
    if (url.pathname === '/api/v3/sessions') {
      if (dshListError && url.searchParams.get('provider') === dshProvider) {
        json({ error: { code: 'source_error', message: 'DSH source has an unsupported permission/preset record' } }, 500);
        return;
      }
      json(url.searchParams.get('provider') === dshProvider ? dshList
        : url.searchParams.get('provider') === 'opencode' ? opencodeRows
          : onlyOrphanDsh ? [] : sessionRows);
      return;
    }
    if (url.pathname === '/api/v3/library/sessions') {
      const search = (url.searchParams.get('search') || '').trim().toLowerCase();
      const roots = libraryRows.filter(row => libraryKey(rootFor(row)) === libraryKey(row))
        .map(row => libraryNode(row, search)).filter(row => row.matchingCount > 0)
        .sort((a, b) => b.familyUpdated - a.familyUpdated || libraryKey(a.session).localeCompare(libraryKey(b.session)));
      const offset = Number(url.searchParams.get('cursor') || 0);
      const limit = Number(url.searchParams.get('limit') || 30);
      json({ families: roots.slice(offset, offset + limit), total: roots.length,
        matchingSessions: libraryRows.filter(row => matchesLibrary(row, search)).length,
        sourceDiagnostics: dshListError ? [{ provider: dshProvider,
          message: 'DSH source has an unsupported permission/preset record' }] : [],
        nextCursor: offset + limit < roots.length ? String(offset + limit) : null });
      return;
    }
    if (url.pathname === '/api/v3/library/children') {
      const provider = url.searchParams.get('provider');
      const parentId = url.searchParams.get('parentId');
      const parent = libraryRows.find(row => row.session.provider === provider && row.session.sessionId === parentId);
      if (!parent) { json({ error: { code: 'not_found' } }, 404); return; }
      const search = (url.searchParams.get('search') || '').trim().toLowerCase();
      const children = libraryRows.filter(row => row.parent && row.parent.provider === provider
        && row.parent.sessionId === parentId).map(row => libraryNode(row, search))
        .filter(row => row.matchingCount > 0)
        .sort((a, b) => (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0)
          || libraryKey(a.session).localeCompare(libraryKey(b.session)));
      const offset = Number(url.searchParams.get('cursor') || 0);
      if (staleChildCursor && offset > 0) {
        staleChildCursor = false;
        json({ error: { code: 'source_changed', message: 'The library source changed.' } }, 409);
        return;
      }
      const limit = Number(url.searchParams.get('limit') || 20);
      json({ parent: libraryNode(parent, search), children: children.slice(offset, offset + limit),
        total: children.length, nextCursor: offset + limit < children.length ? String(offset + limit) : null });
      return;
    }
    const dshBootstrapMatch = url.pathname.match(/^\/api\/v3\/reader\/deepseek-harness\/([^/]+)\/bootstrap$/);
    if (dshBootstrapMatch) {
      json(dshBootstrap(dshBootstrapMatch[1]));
      return;
    }
    const dshLocateMatch = url.pathname.match(/^\/api\/v3\/reader\/deepseek-harness\/([^/]+)\/locate$/);
    if (dshLocateMatch) {
      const [, id] = dshLocateMatch;
      const data = dshBootstrap(id);
      const target = data.segments[0].items.find(row => row.event.messageId === url.searchParams.get('messageId')
        && row.event.segment === url.searchParams.get('segment'));
      if (!target || url.searchParams.get('revision') !== data.revision) {
        json({ error: { code: 'not_found' } }, 404);
        return;
      }
      json({ session: data.session.session, revision: data.revision, event: target.event,
        ordinal: target.ordinal, owner: target.owner, pageCursor: 'page-0', tocCursor: 'toc-0' });
      return;
    }
    const dshTocMatch = url.pathname.match(/^\/api\/v3\/reader\/deepseek-harness\/([^/]+)\/toc$/);
    if (dshTocMatch) {
      const [, id] = dshTocMatch;
      const data = dshBootstrap(id);
      json({ session: data.session.session, revision: data.revision, toc: data.toc });
      return;
    }
    const dshRelationsMatch = url.pathname.match(/^\/api\/v3\/reader\/deepseek-harness\/([^/]+)\/relations$/);
    if (dshRelationsMatch) {
      const [, id] = dshRelationsMatch;
      const cursor = url.searchParams.get('cursor');
      if (id !== dshIds.root || cursor !== 'dsh-relations-root-0') {
        json({ error: { code: 'invalid_request' } }, 400);
        return;
      }
      json({
        session: dshSessionRef(dshIds.root),
        revision: `revision-${dshIds.root}`,
        entries: dshRelationEntries,
        childPlacements: [],
        nextCursor: null,
      });
      return;
    }
    const bootstrapMatch = url.pathname.match(/^\/api\/v3\/reader\/codex\/([^/]+)\/bootstrap$/);
    if (bootstrapMatch) {
      const [, id] = bootstrapMatch;
      if (id === sessionA) {
        heldAResponse = response;
        resolveAStarted();
        releaseA = () => {
          if (!heldAResponse || heldAResponse.writableEnded || heldAResponse.destroyed) return;
          json.call(null, bootstrap(sessionA));
          heldAResponse = undefined;
        };
        return;
      }
      json(bootstrap(id));
      return;
    }
    const contentMatch = url.pathname.match(/^\/api\/v3\/reader\/codex\/([^/]+)\/content$/);
    if (contentMatch) {
      const [, id] = contentMatch;
      const field = url.searchParams.get('field');
      const offset = Number(url.searchParams.get('offset'));
      const maxChars = Number(url.searchParams.get('maxChars'));
      const source = field === 'toolInput' ? toolInput : field === 'toolOutput' ? toolOutput : '';
      contentRequests.push({ id, field, offset, maxChars });
      if (id !== sessionB || !source || !Number.isInteger(offset) || !Number.isInteger(maxChars) || maxChars < 1) {
        json({ error: { code: 'invalid_request' } }, 400);
        return;
      }
      const text = source.slice(offset, offset + maxChars);
      const nextOffset = offset + text.length < source.length ? offset + text.length : null;
      json({ text, offset, totalChars: source.length, nextOffset, truncated: nextOffset !== null });
      return;
    }
    if (/^\/api\/v3\/resume\/codex\/[^/]+$/.test(url.pathname)) {
      json({ allowTerminalLaunch: false, available: true, diagnostic: null, command: null });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      json({ error: { code: 'not_found' } }, 404);
      return;
    }
    const asset = url.pathname === '/' || !url.pathname.startsWith('/assets/')
      ? path.join(buildDir, 'index.html')
      : path.resolve(buildDir, `.${url.pathname}`);
    if (!asset.startsWith(buildDir + path.sep) && asset !== path.join(buildDir, 'index.html')) {
      response.writeHead(400).end();
      return;
    }
    if (!existsSync(asset)) {
      response.writeHead(404).end();
      return;
    }
    const contentType = asset.endsWith('.html') ? 'text/html; charset=utf-8'
      : asset.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : asset.endsWith('.css') ? 'text/css; charset=utf-8'
          : asset.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
    response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    response.end(readFileSync(asset));
  });

  onCleanup(t, async () => {
    if (heldAResponse && !heldAResponse.writableEnded && !heldAResponse.destroyed) {
      heldAResponse.writeHead(503);
      heldAResponse.end();
    }
    if (heldStatsResponse && !heldStatsResponse.writableEnded && !heldStatsResponse.destroyed) {
      heldStatsResponse.writeHead(503);
      heldStatsResponse.end();
    }
    if (heldStatsDayResponse && !heldStatsDayResponse.writableEnded && !heldStatsDayResponse.destroyed) {
      heldStatsDayResponse.writeHead(503);
      heldStatsDayResponse.end();
    }
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });

  let port;
  let pageResponse;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    port = await freePort();
    await new Promise((resolve, reject) => {
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      const onError = error => {
        server.off('listening', onListening);
        reject(error);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    try {
      pageResponse = await fetch(`http://127.0.0.1:${port}/sessions`, { signal: AbortSignal.timeout(5_000) });
      break;
    } catch (error) {
      if (error?.cause?.message !== 'bad port' || attempt === 4) throw error;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  }
  assert.equal(pageResponse.status, 200, 'The local server must serve the built Reader app');
  assert.match(await pageResponse.text(), /<html/i);

  return {
    origin: `http://127.0.0.1:${port}`,
    aStarted,
    contentRequests,
    requests,
    statsRequests,
    statsStarted,
    releaseStats: () => releaseStats?.(),
    statsDayStarted,
    releaseStatsDay: () => releaseStatsDay?.(),
    releaseA: () => releaseA?.(),
  };
}

async function startBrowser(t, url) {
  const session = `agentsession-v3-ui-${process.pid}-${Date.now()}`;
  const command = (...args) => new Promise((resolve, reject) => {
    const child = spawn(agentBrowserExe, ['--session', session, ...args], {
      cwd: repo,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`agent-browser ${args.join(' ')} timed out after 15 seconds`));
    }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => {
      finish(error);
    });
    child.once('exit', code => {
      if (code !== 0) {
        finish(new Error(`agent-browser ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
        return;
      }
      finish(undefined, stdout.trim());
    });
  });
  onCleanup(t, async () => {
    try { await command('close'); } catch { /* The session may already have closed after a browser error. */ }
  });

  await command('open');
  await command('eval', `window.location.href = ${JSON.stringify(url)}`);
  return { command };
}

async function waitForBrowser(command, predicate, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await command('eval', `Boolean(${predicate})`);
    if (last.includes('true')) return;
    await sleep(75);
  }
  throw new Error(`Timed out waiting for ${description}. Last browser result: ${last}`);
}

async function assertPageText(command, selector, expected) {
  assert.equal((await command('get', 'text', selector)).trim(), expected);
}

test('Reader omits a startup-disabled terminal action while keeping session search available', { skip: skipReason || false, timeout: 60_000 }, async t => {
  const harness = await startHarness(t);
  const { command } = await startBrowser(t, `${harness.origin}/codex/session/${sessionB}`);
  await waitForBrowser(command, "document.querySelector('#reader-title')?.textContent.trim() === 'Session B' && document.querySelector('.reader-find-toggle')?.disabled === false", 'Reader with session search');
  assert.ok(harness.requests.includes(`GET /api/v3/resume/codex/${sessionB}`), 'The Reader reads the startup launch capability');
  assert.equal(await command('eval', `Array.from(document.querySelectorAll('.reader-actions button')).some(button => button.textContent.includes('Resume in terminal'))`), 'false');
});

test('Reader keeps the latest session when an older bootstrap resolves later', { skip: skipReason || false, timeout: 60_000 }, async t => {
  const harness = await startHarness(t);
  let browser;
  try { browser = await startBrowser(t, `${harness.origin}/sessions`); }
  catch (cause) { throw new Error(`${cause.message}; requests=${JSON.stringify(harness.requests)}`); }
  const { command } = browser;

  await command('wait', `a[href="/codex/session/${sessionA}"]`);
  await command('click', `a[href="/codex/session/${sessionA}"]`);
  await harness.aStarted;

  await command('back');
  await command('wait', `a[href="/codex/session/${sessionB}"]`);
  // Activate the intended link directly: the CLI coordinate click can hit <html> after history restoration.
  await command('eval', `document.querySelector('a[href="/codex/session/${sessionB}"]').click()`);
  await waitForBrowser(command, `document.querySelector('#reader-title')?.textContent.trim() === 'Session B'`, 'session B Reader');

  harness.releaseA();
  await sleep(250);
  await assertPageText(command, '#reader-title', 'Session B');
  assert.match(await command('get', 'url'), new RegExp(`/codex/session/${sessionB}$`));
});

test('standalone tool cards continue loading complete multi-page input and output', { skip: skipReason || false, timeout: 60_000 }, async t => {
  const harness = await startHarness(t);
  let browser;
  try { browser = await startBrowser(t, `${harness.origin}/codex/session/${sessionB}`); }
  catch (cause) { throw new Error(`${cause.message}; requests=${JSON.stringify(harness.requests)}`); }
  const { command } = browser;

  await waitForBrowser(command, `document.querySelector('#reader-title')?.textContent.trim() === 'Session B'`, 'session B Reader');
  assert.equal(Number(await command('get', 'count', '.reader-main article.tool-card')), 1, 'The unowned tool must render as a standalone card');
  assert.equal(Number(await command('get', 'count', '.reader-main .attached-tools')), 0, 'The unowned tool must not be placed under an assistant');
  await command('eval', `document.querySelector('article.tool-card .tool-disclosure > summary').click()`);
  await waitForBrowser(command, `document.querySelector('article.tool-card .tool-disclosure')?.open`,
    'expanded standalone tool card');

  for (const [index, field, value] of [[1, 'toolInput', toolInput], [2, 'toolOutput', toolOutput]]) {
    const details = `article.tool-card details.tool-field:nth-child(${index})`;
    // Coordinate clicks can miss while the disclosure and streamed content change the card height.
    await command('eval', `document.querySelector('${details} summary').click()`);
    await waitForBrowser(command,
      `document.querySelector('${details}')?.open && document.querySelector('${details} .event-body')?.textContent.length === 1400`,
      `${field} first page`);
    assert.match(await command('get', 'text', `${details} button.read-more`), /Show more/);
    assert.equal(await command('get', 'text', `${details} .event-body`), value.slice(0, 1400));

    await command('eval', `document.querySelector('${details} button.read-more').click()`);
    await waitForBrowser(command,
      `document.querySelector('${details} .event-body')?.textContent.length === ${value.length} && !document.querySelector('${details} button.read-more')`,
      `${field} second page`);
    assert.equal(await command('get', 'text', `${details} .event-body`), value);
  }

  assert.deepEqual(harness.contentRequests.map(({ field, offset }) => [field, offset]), [
    ['toolInput', 0], ['toolInput', 1400], ['toolOutput', 0], ['toolOutput', 1400],
  ]);
});

test('Library identifies a child whose parent source is absent without promoting it to a root',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { withOrphanDsh: true });
    const { command } = await startBrowser(t, `${harness.origin}/sessions`);
    await command('wait', `a[href="/deepseek-harness/session/dsh-v3-s2-orphan"]`);
    assert.equal(Number(await command('get', 'count', '.session-row')), 3,
      'Only the two Codex sessions and one DSH root are root families');
    assert.equal(Number(await command('get', 'count', '.unlinked-child-row')), 1);
    assert.match(await command('get', 'text', '.unlinked-child-row'), /Parent session unavailable/);
    assert.match(await command('get', 'text', '.unlinked-child-row'), /dsh-v3-s2-missing-parent/);
    await command('click', `a[href="/deepseek-harness/session/dsh-v3-s2-orphan"]`);
    await waitForBrowser(command,
      `document.querySelector('#reader-title')?.textContent.trim() === 'DSH child with missing parent'`,
      'canonical unlinked child Reader');
  });

test('Library counts a readable missing-parent child even when it is the only source session',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { onlyOrphanDsh: true });
    const { command } = await startBrowser(t, `${harness.origin}/sessions`);
    await command('wait', '.unlinked-child-row');
    assert.equal(Number(await command('get', 'count', '.session-row')), 0);
    assert.equal(Number(await command('get', 'count', '.unlinked-child-row')), 1);
    assert.equal(await command('get', 'text', '.rail-link[data-library-view="sessions"] .rail-count'), '1');
    assert.match(await command('get', 'text', '.archive-count'), /1\s+sessions/i);
  });

test('Library labels a cyclic parent boundary without claiming the parent is unavailable',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { withCyclicDsh: true });
    const { command } = await startBrowser(t, `${harness.origin}/sessions`);
    await command('wait', 'a[href="/deepseek-harness/session/dsh-v3-s2-cycle"]');
    assert.match(await command('get', 'text', 'a[href="/deepseek-harness/session/dsh-v3-s2-cycle"]'),
      /Cyclic parent reference: dsh-v3-s2-cycle/);
  });

test('Library orders a family by its latest child activity without changing child dates',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { withRecentDshChild: true });
    const { command } = await startBrowser(t, `${harness.origin}/sessions`);
    await waitForBrowser(command, `document.querySelectorAll('.session-row').length === 3`, 'the grouped Library');
    assert.equal(await command('get', 'attr', '.session-row:first-child', 'href'),
      `/deepseek-harness/session/${dshIds.root}`,
      'A recent child brings its family to the top');
    const activity = await command('get', 'text', '.session-row:first-child .session-date');
    await command('click', `button[data-family-toggle="deepseek-harness/${dshIds.root}"]`);
    await command('wait', `a[href="/deepseek-harness/session/${dshIds.alpha}"] .session-date`);
    assert.equal(activity, await command('get', 'text',
      `a[href="/deepseek-harness/session/${dshIds.alpha}"] .session-date`));
  });

test('Library groups OpenCode children under one canonical root and reveals bounded pages and child title matches',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { withOpenCode: true });
    const { command } = await startBrowser(t, `${harness.origin}/sessions`);
    await waitForBrowser(command, `document.querySelectorAll('.session-row').length === 4`,
      'one top-level row for each of the four root sessions');
    assert.equal(Number(await command('get', 'count', '.family-child-row')), 0,
      'The 73 OpenCode children do not flatten into the default Library');

    await command('fill', 'input[type="search"]', 'OpenCode child 073');
    await waitForBrowser(command,
      `document.querySelectorAll('.session-row').length === 1 && document.querySelectorAll('.family-child-row').length === 1`,
      'the matching child inside its discoverable family');
    assert.equal(Number(await command('get', 'count', 'a[href="/opencode/session/opencode-child-073"]')), 1,
      'The matched child keeps its canonical Reader URL');
    await command('fill', 'input[type="search"]', 'project root');
    await waitForBrowser(command,
      `document.querySelectorAll('.session-row').length === 1 && document.querySelectorAll('.family-child-row').length === 1`,
      'a matching child remains visible when its root title also matches');
    await command('fill', 'input[type="search"]', '');
    await waitForBrowser(command, `document.querySelectorAll('.session-row').length === 4`, 'all root rows');

    await command('click', 'button[data-family-toggle="opencode/opencode-root"]');
    await waitForBrowser(command, `document.querySelectorAll('.family-child-row').length === 20`,
      'the first bounded child page');
    for (const expected of [40, 60, 73]) {
      await command('click', 'button[data-family-more="opencode/opencode-root"]');
      await waitForBrowser(command, `document.querySelectorAll('.family-child-row').length === ${expected}`,
        `${expected} visible OpenCode children`);
    }
    assert.equal(Number(await command('get', 'count', 'button[data-family-more="opencode/opencode-root"]')), 0);
    assert.equal(await command('errors'), '');
  });

test('Library progressively reveals a large root list', { skip: skipReason || false, timeout: 60_000 }, async t => {
  const harness = await startHarness(t, { extraRows: 45 });
  const { command } = await startBrowser(t, `${harness.origin}/sessions`);
  await waitForBrowser(command, `document.querySelectorAll('.session-row').length === 40`,
    'the bounded first root page');
  assert.equal(Number(await command('get', 'count', '.family-child-row')), 0);
  await command('click', '.library-main > .family-more');
  await waitForBrowser(command, `document.querySelectorAll('.session-row').length === 48`,
    'all remaining roots after explicit expansion');
});

test('Library loads bounded family and child pages without the full provider list',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { extraRows: 45, withOpenCode: true });
    const { command } = await startBrowser(t, `${harness.origin}/sessions`);
    await waitForBrowser(command, `document.querySelectorAll('.session-row').length === 40`,
      'the first bounded family page');
    assert.equal(harness.requests.filter(request => request === 'GET /api/v3/sessions').length, 0,
      'Cold Library must use the structured family page');
    assert.equal(harness.requests.filter(request => request === 'GET /api/v3/library/sessions').length, 1);
    await command('click', '.library-main > .family-more');
    await waitForBrowser(command, `document.querySelectorAll('.session-row').length === 49`,
      'later root families');
    assert.equal(Number(await command('get', 'count', '.session-row')), 49);
    assert.equal(Number(await command('get', 'count', 'button[data-family-toggle="opencode/opencode-root"]')), 1,
      await command('eval', 'document.querySelector(".session-table")?.textContent.slice(-600)'));
    await command('click', 'button[data-family-toggle="opencode/opencode-root"]');
    await waitForBrowser(command, `document.querySelectorAll('.family-child-row').length === 20`,
      'the first child page');
    for (const expected of [40, 60, 73]) {
      await command('click', 'button[data-family-more="opencode/opencode-root"]');
      await waitForBrowser(command, `document.querySelectorAll('.family-child-row').length === ${expected}`,
        `${expected} unique children`);
    }
    assert.equal(Number(await command('get', 'count', '.family-child-row')), 73);
  });

test('Library recovers a stale child cursor by reloading that family',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { withOpenCode: true, staleChildCursorOnce: true });
    const { command } = await startBrowser(t, `${harness.origin}/sessions`);
    await command('wait', 'button[data-family-toggle="opencode/opencode-root"]');
    await command('click', 'button[data-family-toggle="opencode/opencode-root"]');
    await waitForBrowser(command, `document.querySelectorAll('.family-child-row').length === 20`, 'first child page');
    await command('click', 'button[data-family-more="opencode/opencode-root"]');
    await command('wait', '.family-children .search-error');
    assert.match(await command('get', 'text', '.family-children .search-error'), /source changed/i);
    await command('click', 'button[data-family-retry="opencode/opencode-root"]');
    await waitForBrowser(command, `document.querySelectorAll('.family-child-row').length === 20`, 'reloaded first page');
    await command('click', 'button[data-family-more="opencode/opencode-root"]');
    await waitForBrowser(command, `document.querySelectorAll('.family-child-row').length === 40`, 'resumed child pagination');
  });

test('Library preserves an expanded DSH family and child query across Reader Back',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t);
    const { command } = await startBrowser(t, `${harness.origin}/sessions`);
    const alphaHref = `/${dshProvider}/session/${dshIds.alpha}`;
    await command('wait', 'button[data-family-toggle="deepseek-harness/dsh-v3-s2-root"]');
    await command('eval', `document.querySelector('button[data-family-toggle="deepseek-harness/dsh-v3-s2-root"]').click()`);
    await waitForBrowser(command, `document.querySelectorAll('.family-child-row').length === 2`,
      'both DSH children in the expanded family');
    await command('fill', 'input[type="search"]', 'DSH S2 alpha child');
    await waitForBrowser(command,
      `document.querySelectorAll('.session-row').length === 1 && document.querySelectorAll('.family-child-row').length === 1`,
      'the filtered DSH family');
    await command('click', `a[href="${alphaHref}"]`);
    await waitForBrowser(command, `document.querySelector('#reader-title')?.textContent.trim() === 'DSH S2 alpha child'`,
      'the DSH child Reader');
    await command('back');
    await waitForBrowser(command,
      `document.querySelector('input[type="search"]')?.value === 'DSH S2 alpha child' && document.querySelectorAll('.family-child-row').length === 1`,
      'the restored query and visible child');
    await command('fill', 'input[type="search"]', '');
    await waitForBrowser(command, `document.querySelectorAll('.family-child-row').length === 2`,
      'the explicit expansion after clearing search');
    await command('open', `${harness.origin}${alphaHref}`);
    await waitForBrowser(command, `document.querySelector('#reader-title')?.textContent.trim() === 'DSH S2 alpha child'`,
      'direct loading of the canonical child route');
    assert.equal(await command('errors'), '');
  });

for (const viewportHeight of [577, 900]) {
test(`Library routes DSH roots and opens child sessions from the relationship graph at 1280x${viewportHeight}`, { skip: skipReason || false, timeout: 60_000 }, async t => {
  const harness = await startHarness(t);
  const rootHref = `/${dshProvider}/session/${dshIds.root}`;
  const alphaHref = `/${dshProvider}/session/${dshIds.alpha}`;
  const betaHref = `/${dshProvider}/session/${dshIds.beta}`;
  let browser;
  try { browser = await startBrowser(t, `${harness.origin}/sessions`); }
  catch (cause) { throw new Error(`${cause.message}; requests=${JSON.stringify(harness.requests)}`); }
  const { command } = browser;
  await command('set', 'viewport', '1280', String(viewportHeight));

  const clickInView = async selector => {
    // The native CLI can dispatch an offscreen center without scrolling first.
    await command('scrollintoview', selector);
    const hit = JSON.parse(await command('eval', `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const target = document.elementFromPoint(x, y);
      return { x, y, viewportHeight: innerHeight, tag: target?.tagName,
        className: target?.className, inside: element.contains(target) };
    })()`));
    assert.equal(hit.inside, true,
      `The target is pointer-accessible after scrolling: ${selector}: ${JSON.stringify(hit)}`);
    await command('click', selector);
  };

  await command('wait', `a[href="${rootHref}"]`);
  await clickInView(`a[href="${rootHref}"]`);
  assert.equal(await command('get', 'url'), `${harness.origin}${rootHref}`,
    'The root row opens its canonical Reader URL');
  await waitForBrowser(command,
    `document.querySelector('#reader-title')?.textContent.trim() === 'DSH S2 root'`,
    'the DSH root Reader');

  const providerLabel = await command('eval',
    `document.querySelector('.reader-byline')?.textContent ?? ''`);
  assert.match(providerLabel, /DeepSeek Harness|\bDSH\b/i, 'The Reader identifies the DSH provider');

  await waitForBrowser(command,
    `document.querySelector('.reader-heading > .content-error') && document.querySelector('.inherited-context-error')`,
    'the original metadata and inherited-context error layout');
  await waitForBrowser(command,
    `document.querySelector('.collaboration-launcher:not([hidden])') || document.querySelector('#collaboration-panel')`,
    'the collaboration launcher or open panel');
  if (await command('eval', `Boolean(document.querySelector('.collaboration-launcher:not([hidden])'))`) === 'true') {
    await clickInView('.collaboration-launcher');
  }
  await waitForBrowser(command,
    `document.querySelector('[data-collaboration-handoff="parallel-inspection:1"] .collaboration-child-node') && document.querySelector('[data-collaboration-handoff="parallel-inspection:2"] .collaboration-child-node')`,
    'both child nodes in the DSH relationship graph');
  assert.doesNotMatch(await command('get', 'text', '#collaboration-panel'),
    /Collaboration sources|Inspect recorded tasks and handoffs|Load more recorded work/,
    'The Reader retains the collaboration graph without its removed source sections');
  for (const [correlationId, href] of [['parallel-inspection:1', alphaHref], ['parallel-inspection:2', betaHref]]) {
    await clickInView(`[data-collaboration-handoff="${correlationId}"] .collaboration-child-node`);
    await waitForBrowser(command, `Boolean(document.querySelector('.collaboration-timeline a[href="${href}"]'))`,
      `selected handoff ${correlationId} child action`);
    assert.equal(Number(await command('get', 'count', `.collaboration-timeline a[href="${href}"]`)), 1,
      'The selected handoff link uses its recorded canonical DSH identity');
    assert.equal(Number(await command('get', 'count', '.collaboration-timeline .collaboration-selected-details')), 1,
      'Recorded handoff details belong to the selected child');
  }

  await clickInView('[data-collaboration-handoff="parallel-inspection:1"] .collaboration-child-node');
  await waitForBrowser(command, `Boolean(document.querySelector('.collaboration-timeline a[href="${alphaHref}"]'))`,
    'the selected graph node’s canonical child link');
  await clickInView(`.collaboration-timeline a[href="${alphaHref}"]`);
  await waitForBrowser(command,
    `(() => { const query = new URLSearchParams(location.hash.slice(7)); const path = JSON.parse(query.get('path') ?? '[]'); return location.hash.startsWith('#child?') && query.get('provider') === '${dshProvider}' && query.get('sessionId') === '${dshIds.alpha}' && path.length === 1 && path[0].provider === '${dshProvider}' && path[0].sessionId === '${dshIds.alpha}'; })()`,
    'the graph link records the canonical DSH alpha child path');
  assert.equal(new URL(await command('get', 'url')).pathname, rootHref,
    'Opening the child from the graph keeps the root Reader route active');
});
}

test('Library retains readable providers and reports a DSH source failure', { skip: skipReason || false, timeout: 60_000 }, async t => {
  const harness = await startHarness(t, { dshListError: true });
  const { command } = await startBrowser(t, `${harness.origin}/sessions`);
  await waitForBrowser(command,
    `document.querySelector('a[href="/codex/session/${sessionA}"]') || document.querySelector('.error-state')`,
    'the Library result or explicit error');
  assert.equal(Number(await command('get', 'count', `a[href="/codex/session/${sessionA}"]`)), 1,
    'A broken DSH source must not hide readable Codex sessions');
  assert.equal(await command('eval', `document.querySelector('.library-source-note').open`), 'false',
    'source issues start folded while readable provider rows remain usable');
  await command('click', '.library-source-note > summary');
  const message = await command('get', 'text', '.library-source-note');
  assert.match(message, /DeepSeek Harness.*unsupported permission\/preset/i);
});

test('Reader attaches recorded reasoning to its assistant turn', { skip: skipReason || false, timeout: 60_000 }, async t => {
  const harness = await startHarness(t);
  const { command } = await startBrowser(t, `${harness.origin}/${dshProvider}/session/${dshIds.root}`);
  await waitForBrowser(command,
    `document.querySelector('#reader-title')?.textContent.trim() === 'DSH S2 root'`,
    'the DSH root Reader');
  assert.equal(Number(await command('get', 'count', '.reader-main .turn-block')), 2,
    'The thinking event must not become an independent assistant turn');
  assert.equal(Number(await command('get', 'count', '.attached-reasoning')), 1);
  assert.equal(Number(await command('get', 'count', '.attached-reasoning > details:not([open])')), 1,
    'Reasoning starts collapsed under its assistant owner');
});

test('Reader attaches source-order reasoning before its tool-only owner', { skip: skipReason || false, timeout: 60_000 }, async t => {
  const harness = await startHarness(t);
  const { command } = await startBrowser(t, `${harness.origin}/codex/session/${sessionB}`);
  await waitForBrowser(command,
    `document.querySelector('#reader-title')?.textContent.trim() === 'Session B'`,
    'the tool-only Reader');
  assert.equal(Number(await command('get', 'count', '.reader-main .turn-block')), 1,
    'Thinking before a tool call must belong to that tool block');
  assert.equal(Number(await command('get', 'count', '.reader-main .turn-block > .attached-reasoning')), 1);
  assert.equal(Number(await command('get', 'count', '.reader-main article.tool-card')), 1);
  assert.match(await command('get', 'text', '.reader-main .attached-reasoning .event-body'),
    /Recorded reasoning before the tool-only call/);
});

test('Reader keeps reasoning out of the outline and opens its canonical source anchor',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t);
    const { command } = await startBrowser(t, `${harness.origin}/${dshProvider}/session/${dshIds.root}`);
    await waitForBrowser(command,
      `document.querySelector('#reader-title')?.textContent.trim() === 'DSH S2 root'`,
      'the DSH root Reader');
    assert.equal(Number(await command('get', 'count', '.attached-reasoning > details:not([open])')), 1);
    assert.equal(Number(await command('get', 'count', '.reader-outline nav a[href*="segment=thinking"]')), 0);
    await command('eval', `(() => { const card = document.querySelector('.thinking-card');
      window.location.hash = '#event?' + new URLSearchParams({ messageId: card.dataset.messageId, segment: 'thinking' }); })()`);
    await waitForBrowser(command, `window.location.hash.includes('segment=thinking')`, 'reasoning source hash');
    assert.equal(await command('eval', `document.querySelector('.attached-reasoning > details')?.open`), 'true',
      'The owner disclosure must open so the reasoning source is visible');
    assert.equal(Number(await command('get', 'count', '.attached-reasoning .thinking-card')), 1);
  });

test('Library keeps its search filter across Reader navigation and Back', { skip: skipReason || false, timeout: 60_000 }, async t => {
  const harness = await startHarness(t);
  const { command } = await startBrowser(t, `${harness.origin}/sessions`);
  await command('wait', 'input[type="search"]');
  await command('fill', 'input[type="search"]', 'Session B');
  await waitForBrowser(command,
    `document.querySelectorAll('.session-row').length === 1`,
    'the filtered library result');
  await command('click', `a[href="/codex/session/${sessionB}"]`);
  await waitForBrowser(command,
    `document.querySelector('#reader-title')?.textContent.trim() === 'Session B'`,
    'the Codex Reader');
  await command('back');
  await command('wait', 'input[type="search"]');
  assert.equal(await command('get', 'value', 'input[type="search"]'), 'Session B');
  assert.equal(Number(await command('get', 'count', '.session-row')), 1);
});

test('Library restores its scroll position after Reader navigation and Back', { skip: skipReason || false, timeout: 60_000 }, async t => {
  const harness = await startHarness(t, { extraRows: 30 });
  const { command } = await startBrowser(t, `${harness.origin}/sessions`);
  await waitForBrowser(command,
    `document.querySelectorAll('.session-row').length === 33`,
    'the long session library');
  const before = Number(await command('eval', 'window.scrollTo({top:800,behavior:"instant"}); window.scrollY'));
  assert.ok(before >= 700, `The Library fixture must have room to scroll; actual ${before}`);
  await command('eval', `document.querySelector('a[href="/codex/session/${sessionB}"]').click()`);
  await waitForBrowser(command,
    `document.querySelector('#reader-title')?.textContent.trim() === 'Session B'`,
    'the opened Reader');
  await command('back');
  await waitForBrowser(command,
    `document.querySelectorAll('.session-row').length === 33`,
    'the restored Library');
  const after = Number(await command('eval', 'window.scrollY'));
  assert.ok(Math.abs(after - before) <= 8, `Library scroll changed from ${before} to ${after}`);
});

test('Stats page exposes source-backed request usage, date range and exports',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t);
    const { command } = await startBrowser(t, `${harness.origin}/sessions`);
    await command('set', 'viewport', '1440', '1000');
    await command('wait', '.session-row');
    await command('click', 'a[href="/stats"]');
    await waitForBrowser(command,
      `document.querySelector('main[aria-label="Token statistics"] h1')?.textContent.includes('Token')`,
      'the Token statistics page');
    await waitForBrowser(command, `document.querySelector('.stats-coverage') !== null`,
      'the loaded statistics report');
    assert.match(await command('get', 'text', '.stats-coverage'), /partial/i);
    assert.match(await command('get', 'text', '.stats-known-tokens'), /47/);
    assert.match(await command('get', 'text', '.stats-unknown-requests'), /1/);
    assert.equal(Number(await command('get', 'count', '.stats-day-row')), 0, 'the chart replaces the duplicate daily table');
    assert.equal(Number(await command('get', 'count', '.chart-day')), 2);
    assert.equal(Number(await command('get', 'count', '.statistics-details:not([open])')), 1,
      'cost, source diagnostics, and per-session details start in one disclosure');
    assert.match(await command('get', 'attr', '.chart-day:last-of-type', 'aria-label'), /unknown/i);
    assert.equal(Number(await command('get', 'count', '.model-distribution-row')), 2);
    assert.match(await command('get', 'text', '.model-distribution'), /Model not recorded/);
    assert.match(await command('get', 'text', '.model-distribution'), /known tokens/i);
    assert.equal(await command('get', 'attr', '.chart-metrics button:last-child', 'aria-pressed'), 'true',
      'Token statistics defaults to tokens');
    assert.match(await command('get', 'text', '.stats-kpis article:first-child'), /Known token subtotal/);
    assert.equal(JSON.parse(await command('eval', `document.querySelector('.model-distribution-row strong').textContent.trim()`)), '100.0%',
      'Model shares use known tokens by default, excluding unknown totals');
    assert.match(await command('get', 'text', '.harness-comparison-title'), /47 known tokens/);
    await command('select', 'select[aria-label="Language"]', 'zh');
    await waitForBrowser(command, `document.querySelector('.chart-day')?.getAttribute('aria-label').includes('个已知 Token')`,
      'chart tooltips update when the statistics language changes');
    await command('select', 'select[aria-label="语言"]', 'en');
    await waitForBrowser(command, `(() => { const r=document.querySelector('.chart-metrics button:last-child').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`,
      'the entire chart metric control inside the viewport');
    await command('click', '.chart-metrics button:last-child');
    await waitForBrowser(command, `document.querySelector('.chart-metrics button:last-child')?.getAttribute('aria-pressed') === 'true'`,
      'the known-token chart metric');
    assert.equal(await command('get', 'attr', '.chart-metrics button:last-child', 'aria-pressed'), 'true');
    assert.equal(Number(await command('get', 'attr', '.chart-day[data-day="2026-09-20"] .chart-bar', 'height')), 0,
      'unknown request totals do not become known-token bars');
    await command('click', '.chart-metrics button:first-child');
    await waitForBrowser(command, `document.querySelector('.chart-metrics button:first-child')?.getAttribute('aria-pressed') === 'true'`,
      'the recorded-request chart metric');
    assert.ok(Number(await command('get', 'attr', '.chart-day[data-day="2026-09-20"] .chart-bar', 'height')) > 0,
      'the recorded unknown-total request remains in the request chart');
    assert.equal(JSON.parse(await command('eval', `document.querySelector('.model-distribution-row strong').textContent.trim()`)), '50.0%',
      'Model shares switch to requests with the daily chart');
    assert.match(await command('get', 'text', '.harness-comparison-title'), /2 requests/);
    await command('click', '.stats-day-toggle[data-day="2026-09-20"]');
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/v3/stats/all?days=30&day=2026-09-20'))`,
      'the selected day request with current report filters');
    await waitForBrowser(command, `document.querySelector('.stats-day-drill')?.textContent.includes('${sessionB}')`,
      'the selected day session drill');
    assert.equal(Number(await command('get', 'count', '.stats-day-session-row')), 1);
    assert.equal(await command('get', 'text', '.stats-day-session-row span:nth-child(2)'), '1');
    assert.equal(await command('get', 'text', '.stats-day-session-row span:nth-child(3)'), '0');
    assert.equal(await command('get', 'text', '.stats-day-session-row span:nth-child(4)'), '1 unknown · 0 unresolved');
    assert.equal(Number(await command('get', 'count', 'a[href*="/api/v3/stats/all/export.csv"]')), 1);
    await command('select', 'select[aria-label="Working directory"]', '/project/a');
    await command('select', 'select[aria-label="Request model"]', 'model-two');
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('directory=%2Fproject%2Fa&model=model-two&modelProvider='))`,
      'the combined directory and model API request');
    assert.match(await command('get', 'attr', '.stats-downloads a:first-child', 'href'),
      /directory=%2Fproject%2Fa&model=model-two&modelProvider=/);
    await command('select', 'select[aria-label="Date range"]', '7');
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/v3/stats/all?days=7'))`,
      'the seven-day API request');
    await command('select', 'select[aria-label="Date range"]', 'custom');
    assert.equal(Number(await command('get', 'count', '.stats-day-row')), 0,
      'The previous range must not remain visible as the custom range');
    assert.equal(await command('get', 'value', 'select[aria-label="Working directory"]'), '/project/a');
    assert.equal(await command('get', 'value', 'select[aria-label="Request model"]'), JSON.stringify([null, 'model-two']));
    await command('eval', `for (const [selector, value] of [
      ['input[aria-label="From UTC date"]', '2026-09-19'],
      ['input[aria-label="To UTC date"]', '2026-09-20']
    ]) { const input = document.querySelector(selector); input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true })); }`);
    await command('click', '.stats-custom-range button');
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/v3/stats/all?days=custom&directory=%2Fproject%2Fa&model=model-two&modelProvider=&from=2026-09-19&to=2026-09-20'))`,
      'the custom UTC request');
    assert.ok(harness.requests.includes('GET /api/v3/stats/all'));
    await command('click', '.harness-trigger');
    assert.equal(Number(await command('get', 'count', '.harness-options input:checked')), 2,
      'global Stats starts with every registered Harness selected');
    await command('find', 'label', 'deepseek-harness', 'click');
    await waitForBrowser(command,
      `new URL(location.href).searchParams.get('providers') === 'codex' && document.querySelector('.stats-downloads a')?.href.includes('providers=codex')`,
      'the selected Harness URL and export');
    assert.equal(Number(await command('get', 'count', '.harness-options input:checked:disabled')), 1,
      'the selection retains at least one Harness');
    assert.equal(await command('get', 'value', 'select[aria-label="Date range"]'), 'custom');
    assert.equal(await command('get', 'value', 'input[aria-label="From UTC date"]'), '2026-09-19');
    assert.equal(await command('get', 'value', 'input[aria-label="To UTC date"]'), '2026-09-20');
    const selectedExports = JSON.parse(await command('eval', `Array.from(document.querySelectorAll('.stats-downloads a')).map(link => new URL(link.href).searchParams.get('providers'))`));
    assert.deepEqual(selectedExports, ['codex', 'codex']);
    await command('click', '.harness-options button:first-of-type');
    await waitForBrowser(command, `location.pathname === '/stats' && !new URL(location.href).searchParams.has('providers')`,
      'the restored all-Harness route');
    assert.equal(Number(await command('get', 'count', '.harness-options input:checked')), 2);
    await command('click', '.harness-options button:last-child');
  });

test('Stats rejects stale day totals until the user refreshes the base report',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { staleStatsDayRevisionOnce: true });
    const { command } = await startBrowser(t, `${harness.origin}/stats`);
    await waitForBrowser(command, `document.querySelector('.stats-coverage') !== null`, 'the base statistics report');
    await command('select', 'select[aria-label="Working directory"]', '/project/a');
    await command('select', 'select[aria-label="Request model"]', 'model-two');
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/v3/stats/all?days=30&directory=%2Fproject%2Fa&model=model-two&modelProvider='))`,
      'the filtered base statistics report');

    await command('click', '.stats-day-toggle[data-day="2026-09-20"]');
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/v3/stats/all?days=30&directory=%2Fproject%2Fa&model=model-two&modelProvider=&day=2026-09-20'))`,
      'the filtered selected-day request');
    await waitForBrowser(command,
      `document.querySelector('.stats-day-drill [role="alert"]')?.textContent.includes('source changed')`,
      'the stale-revision explanation');
    assert.equal(Number(await command('get', 'count', '.stats-day-session-row')), 0,
      'Session totals from a different source revision must not be shown beside the base day bar');
    assert.equal(await command('get', 'attr', '.stats-day-toggle[data-day="2026-09-20"]', 'aria-expanded'), 'true');
    assert.match(await command('get', 'text', '.stats-day-drill [role="alert"] button'), /Refresh report/i);

    const baseUrl = '/api/v3/stats/all?days=30&directory=%2Fproject%2Fa&model=model-two&modelProvider=&providers=codex%2Cdeepseek-harness';
    const dayUrl = baseUrl.replace('&providers=', '&day=2026-09-20&providers=');
    const countUrl = url => harness.statsRequests.filter(request => request.endsWith(url)).length;
    assert.equal(countUrl(dayUrl), 1, 'A revision mismatch must stop without automatically retrying');
    const baseBeforeRefresh = countUrl(baseUrl);
    await command('click', '.stats-day-drill [role="alert"] button');
    await waitForBrowser(command,
      `document.querySelector('.stats-day-session-row')?.textContent.includes('${sessionB}')`,
      'the same selected day after an explicit base-report refresh');
    assert.equal(countUrl(baseUrl), baseBeforeRefresh + 1,
      'The refresh action reloads the base report with the active filters');
    assert.equal(countUrl(dayUrl), 2, 'The refreshed day drill reuses the selected UTC day and filters');
    assert.equal(await command('get', 'attr', '.stats-day-toggle[data-day="2026-09-20"]', 'aria-expanded'), 'true');
    assert.equal(await command('errors'), '');
  });

test('Stats ignores an older in-flight day response after a newer day is selected',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { holdFirstStatsDay: true });
    const { command } = await startBrowser(t, `${harness.origin}/stats`);
    await waitForBrowser(command, `document.querySelector('.stats-coverage') !== null`, 'the base statistics report');
    await command('click', '.stats-day-toggle[data-day="2026-09-19"]');
    await harness.statsDayStarted;
    await command('click', '.stats-day-toggle[data-day="2026-09-20"]');
    await waitForBrowser(command,
      `document.querySelector('.stats-day-session-row')?.textContent.includes('${sessionB}')`,
      'the latest selected-day session row');
    harness.releaseStatsDay();
    await sleep(100);
    assert.equal(await command('get', 'attr', '.stats-day-toggle[data-day="2026-09-20"]', 'aria-expanded'), 'true');
    assert.equal(Number(await command('get', 'count', '.stats-day-session-row')), 1);
    assert.match(await command('get', 'text', '.stats-day-session-row'), new RegExp(sessionB));
    assert.doesNotMatch(await command('get', 'text', '.stats-day-session-row'), new RegExp(sessionA));
  });

test('OpenCode Stats project ID composes with working directory, model, scope and exports',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { withOpenCode: true });
    const { command } = await startBrowser(t, `${harness.origin}/opencode/stats`);
    await waitForBrowser(command, `document.querySelector('.stats-coverage') !== null`, 'OpenCode statistics');
    await command('select', 'select[aria-label="Request model"]', 'model-two');
    await command('select', 'select[aria-label="Project ID"]', 'project-a');
    await command('select', 'select[aria-label="Working directory"]', '/project/a');
    await command('select', 'select[aria-label="Session scope"]', 'root');
    assert.equal(await command('get', 'value', 'select[aria-label="Request model"]'), JSON.stringify([null, 'model-two']),
      'Changing session facets must preserve the selected request model');
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('scope=root&directory=%2Fproject%2Fa&model=model-two&modelProvider=&project=project-a'))`,
      'the combined OpenCode statistics request');
    assert.match(await command('get', 'attr', '.stats-downloads a:first-child', 'href'),
      /scope=root&directory=%2Fproject%2Fa&model=model-two&modelProvider=&project=project-a/);
    await command('click', '.stats-day-toggle[data-day="2026-09-19"]');
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/v3/stats/all?days=30&scope=root&directory=%2Fproject%2Fa&model=model-two&modelProvider=&project=project-a&day=2026-09-19'))`,
      'the selected day request with project, directory, model, and session scope');
});

test('OpenCode Stats keeps model provider identity in filters, downloads, and both languages',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { withOpenCode: true });
    const { command } = await startBrowser(t, `${harness.origin}/opencode/stats`);
    await waitForBrowser(command, `document.querySelector('.stats-coverage') !== null`, 'OpenCode statistics');
    const selector = 'select[aria-label="Request model"]';
    assert.match(await command('get', 'text', selector), /provider-a · shared-model/);
    assert.match(await command('get', 'text', selector), /provider-b · shared-model/);
    assert.match(await command('get', 'text', '.model-distribution'), /provider-a · shared-model/);
    assert.match(await command('get', 'text', '.model-distribution'), /provider-b · shared-model/);
    assert.match(await command('get', 'text', '.model-distribution'), /provider-only · Model not recorded/);
    await command('select', selector, JSON.stringify([null, 'shared-model']));
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('model=shared-model&modelProvider='))`,
      'providerless stats request');
    assert.match(await command('get', 'attr', '.stats-downloads a:first-child', 'href'),
      /model=shared-model&modelProvider=(?:&|$)/);
    await command('click', '.stats-day-toggle[data-day="2026-09-19"]');
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('model=shared-model&modelProvider=&day=2026-09-19'))`,
      'providerless day drill');
    await command('click', '.stats-day-toggle[data-day="2026-09-19"]');
    await command('select', selector, JSON.stringify(['provider-b', 'shared-model']));
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('model=shared-model&modelProvider=provider-b'))`,
      'provider-qualified stats request');
    assert.match(await command('get', 'attr', '.stats-downloads a:first-child', 'href'),
      /model=shared-model&modelProvider=provider-b/);
    await command('click', '.stats-day-toggle[data-day="2026-09-19"]');
    await waitForBrowser(command,
      `performance.getEntriesByType('resource').some(entry => entry.name.includes('model=shared-model&modelProvider=provider-b&day=2026-09-19'))`,
      'provider-qualified day drill');
    await command('select', '.language-select', 'zh');
    assert.match(await command('get', 'text', '.model-distribution'), /记录模型使用分布/);
    assert.match(await command('get', 'text', '.model-distribution'), /provider-b · shared-model/);
  });

test('Stats keeps literal JSON model IDs distinct from provider/model pair option keys',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { withOpenCode: true, withModelKeyCollision: true });
    const { command } = await startBrowser(t, `${harness.origin}/opencode/stats`);
    await waitForBrowser(command, `document.querySelector('.stats-coverage') !== null`, 'OpenCode statistics');
    const options = JSON.parse(await command('eval', `
      [...document.querySelectorAll('select[aria-label="Request model"] option')]
        .map(option => ({ label: option.textContent, value: option.value }))`));
    const literal = options.find(option => option.label === '["p","m"]');
    const qualified = options.find(option => option.label === 'p · m');
    assert.ok(literal, 'the literal model ID remains an option');
    assert.ok(qualified, 'the provider-qualified model remains an option');
    assert.notEqual(literal.value, qualified.value, 'distinct recorded model identities need distinct keys');
  });

test('Stats keeps a selected model when a project has no matching model option',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { withOpenCode: true });
    const { command } = await startBrowser(t, `${harness.origin}/opencode/stats`);
    await waitForBrowser(command, `document.querySelector('.stats-coverage') !== null`, 'OpenCode statistics');
    await command('select', 'select[aria-label="Request model"]', 'model-two');
    await command('select', 'select[aria-label="Project ID"]', 'project-b');
    await waitForBrowser(command,
      `Array.from(document.querySelector('select[aria-label="Request model"]')?.options ?? []).some(option => option.textContent === 'model-one')
        && document.querySelector('.stats-downloads a')
        && performance.getEntriesByType('resource').some(entry => entry.name.includes('model=model-two&modelProvider=&project=project-b'))`,
      'the project-specific model response');
    assert.equal(await command('get', 'value', 'select[aria-label="Request model"]'), JSON.stringify([null, 'model-two']));
    assert.match(await command('get', 'attr', '.stats-downloads a:first-child', 'href'),
      /model=model-two&modelProvider=&project=project-b/);
  });

test('Stats page discards a pending preset response when switching to an unapplied custom range',
  { skip: skipReason || false, timeout: 60_000 }, async t => {
    const harness = await startHarness(t, { holdStats: true });
    const { command } = await startBrowser(t, `${harness.origin}/stats`);
    await harness.statsStarted;
    await command('select', 'select[aria-label="Date range"]', 'custom');
    harness.releaseStats();
    await command('wait', '--load', 'networkidle');
    assert.equal(Number(await command('get', 'count', '.stats-day-row')), 0);
    assert.equal(Number(await command('get', 'count', '.stats-coverage')), 0);
    assert.equal(Number(await command('get', 'count', '.stats-downloads a')), 0,
      'An unapplied custom range must not expose downloads for preset data');
  });
