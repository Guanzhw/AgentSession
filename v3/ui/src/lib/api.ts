export interface SessionRef {
  provider: string;
  sessionId: string;
}

export interface ProviderSummary {
  id: string;
  name?: string;
  available: boolean;
  manageable?: boolean;
  storageDiagnostic?: {
    schema: 'v1' | 'v2' | 'missing' | 'unsupported' | 'unreadable';
    path: string;
    note: string | null;
  } | null;
}

export interface SettingsSnapshot {
  configFile: { path: string; loaded: boolean };
  startup: {
    port: number;
    sources: Record<string, string>;
    state: Record<string, string>;
  };
  runtimeEditable: string[];
  runtime: RuntimeSettings;
}

export interface RuntimeSettings {
  tokenPricing: Record<string, TokenPricingEntry>;
  projectPaths: Record<string, Record<string, string>>;
  resumeCommands: Record<string, { executable: string; args: string[]; cwd?: string | null } | false | null>;
  resumeShell: { executable: string; args?: string[] } | null;
}

export interface TokenPricingEntry {
  currency: string;
  inputPerMillion: number;
  outputPerMillion: number;
  reasoningPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  sourceLabel?: string;
  sourceUrl?: string;
  asOf?: string;
}

export interface SourceDiagnostic {
  provider: string;
  message: string;
}

export interface SearchSourceDiagnostic {
  code: string;
  affectedSessions?: number;
  affectedSources?: number;
}

export interface SearchProviderDiagnostic {
  provider: string;
  status: 'ok' | 'partial' | 'error' | 'unavailable';
  message?: string;
  sourceDiagnostics?: SearchSourceDiagnostic[];
}

export interface StatsReport {
  insights?: {
    averageDailyRequests: number; activeDays: number; selectedDays: number;
    unusualDays: string[];
    recentWeekRequests: number | null; precedingWeekRequests: number | null;
    recentWeekFrom: string | null; recentWeekTo: string | null;
    precedingWeekFrom: string | null; precedingWeekTo: string | null;
    unattributedModelRequests: number;
  };
  sources?: Array<{ provider: string; status: 'readable' | 'failed' | 'unavailable'; diagnostic: string | null; overview: StatsReport['overview'] | null }>;
  costEstimate: {
    totalCost: number | null;
    currency: string;
    sourceLabel: string;
    sourceUrl: string;
    asOf: string;
    breakdown: Partial<Record<'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite', { tokens: number; cost: number }>>;
    omittedDimensions: string[];
  } | null;
  provider: string;
  scope: 'active_source_sessions';
  revision: string;
  coverage: 'partial';
  usageCoverage: 'partial' | 'not-observed';
  overview: {
    totalSessions: number;
    totalMessages: number;
    excludedSourceSessionCount: number;
    totalTokens: number | null;
    recordedRequestCount: number;
    knownTokenCount: number;
    unknownTokenRequestCount: number;
    untimedRequestCount: number;
    unresolvedUsageObservationCount: number;
  };
  sourceDiagnostics: Array<{ code: string; affectedSessions: number }>;
  sourceDiagnosticsTruncated: boolean;
  sessions: Array<{
    session: SessionRef;
    createdAt: number | null;
    updatedAt: number | null;
    messageCount: number;
    tokenCount: number | null;
    recordedRequestCount: number;
    knownTokenCount: number;
    unknownTokenRequestCount: number;
    unresolvedUsageObservationCount: number;
  }>;
  dailyUsage: Array<{
    day: string;
    recordedRequestCount: number;
    knownTokenCount: number;
    unknownTokenRequestCount: number;
    unresolvedUsageObservationCount: number;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    totalTokens: number | null;
    sessions: Array<{
      session: SessionRef;
      recordedRequestCount: number;
      knownTokenCount: number;
      unknownTokenRequestCount: number;
      unresolvedUsageObservationCount: number;
    }>;
  }>;
  modelRanking: Array<{
    model: string | null;
    modelProvider?: string;
    recordedRequestCount: number;
    knownTokenCount: number;
    unknownTokenRequestCount: number;
  }>;
  usageRange: { fromDay: string | null; toDay: string | null; selectedDay: string | null; scope: 'all' | 'root'; directory: string | null; model: string | null; modelProvider?: string; project: string | null };
  availableDirectories: string[];
  availableModels: Array<{ model: string; modelProvider?: string }>;
  availableProjects: string[];
}

export type StatsDays = '7' | '30' | '90' | 'custom';

function statsParams(days: StatsDays, from: string, to: string, scope: 'all' | 'root', directory: string, model: string, project: string, day = '', modelProvider?: string): URLSearchParams {
  const params = new URLSearchParams({ days });
  if (scope === 'root') params.set('scope', scope);
  if (directory) params.set('directory', directory);
  if (model) params.set('model', model);
  if (modelProvider !== undefined) params.set('modelProvider', modelProvider);
  if (project) params.set('project', project);
  if (days === 'custom') {
    params.set('from', from);
    params.set('to', to);
  }
  if (day) params.set('day', day);
  return params;
}

export function statsUrl(provider: string | string[], days: StatsDays, from = '', to = '', scope: 'all' | 'root' = 'all', directory = '', model = '', project = '', day = '', modelProvider?: string): string {
  const params = statsParams(days, from, to, scope, directory, model, project, day, modelProvider);
  if (Array.isArray(provider)) params.set('providers', provider.join(','));
  return '/api/v3/stats/' + (Array.isArray(provider) ? 'all' : encodeURIComponent(provider)) + '?' + params;
}

export function statsExportUrl(provider: string | string[], format: 'json' | 'csv', days: StatsDays, from = '', to = '', scope: 'all' | 'root' = 'all', directory = '', model = '', project = '', modelProvider?: string): string {
  const url = statsUrl(provider, days, from, to, scope, directory, model, project, '', modelProvider);
  return url.replace('?', '/export.' + format + '?');
}

export function getStats(provider: string | string[], days: StatsDays, from = '', to = '', scope: 'all' | 'root' = 'all', directory = '', model = '', project = '', day = '', modelProvider?: string): Promise<StatsReport> {
  return runtimeJson<StatsReport>(statsUrl(provider, days, from, to, scope, directory, model, project, day, modelProvider));
}

export interface SessionSummary {
  session: SessionRef;
  title: string;
  diagnostic?: string;
  directory: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number;
  tokenCount: number | null;
  durationMs?: number | null;
  parent: SessionRef | null;
}

export interface LibraryNode {
  session: SessionSummary;
  matched: boolean;
  matchingCount: number;
  childCount: number;
  totalChildCount: number;
  familyRootId: string;
  familyUpdated: number | null;
  parentBoundary: 'missing-parent' | 'hidden-parent' | 'cyclic-parent' | null;
}

export interface LibraryFamilyPage {
  families: LibraryNode[];
  total: number;
  matchingSessions: number;
  sourceDiagnostics: SourceDiagnostic[];
  nextCursor: string | null;
}

export interface LibraryFilters {
  provider?: string;
  project?: string;
  range?: 'today' | 'week' | 'month';
  sort?: 'updated-desc' | 'updated-asc' | 'title-asc' | 'title-desc';
}

export interface LibraryChildrenPage {
  parent: LibraryNode;
  children: LibraryNode[];
  total: number;
  nextCursor: string | null;
}

export interface SearchMatch {
  session: SessionRef;
  event: ReaderEventRef | null;
  matchField: string;
  matchRole: string | null;
  snippet: string;
  title: string;
  directory: string | null;
  updatedAt: number;
  untrustedContent: boolean;
}

export interface SearchPage {
  matches: SearchMatch[];
  diagnostics: SearchProviderDiagnostic[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface ViewerMeta {
  provider: string;
  sessionId: string;
  customTitle: string | null;
  starred: boolean;
  deleted: boolean;
  permanent: boolean;
  timeStarred: number | null;
  timeDeleted: number | null;
  timeRenamed: number | null;
}

export type BatchAction = 'star' | 'unstar' | 'delete';
export interface BatchResult {
  ok: boolean;
  affected: number;
  skipped: number;
}

export interface ReaderEventRef extends SessionRef {
  messageId: string;
  segment: string;
}

export interface RuntimeEvent {
  id: string;
  sequence: number;
  sourceOrder: { record: number; ordinal: number };
  timestamp: number | null;
  category: string;
  kind: string;
  provenance: { fidelity: 'recorded' | 'derived'; sourceType: string; sourceId: string | null };
  readerEvent: ReaderEventRef | null;
}

export interface RuntimeExecutionObservation {
  id: string;
  kind: 'async-tool' | 'process';
  phase: 'started' | 'yielded' | 'polled' | 'input' | 'interruption-requested' | 'completed' | 'failed';
  handle: string;
  toolName: string;
  label?: string;
}

export interface RuntimeEventPage {
  session: SessionRef;
  revision: string;
  coverage: 'partial';
  events: RuntimeEvent[];
  nextCursor: string | null;
  scannedEvents: number;
}

export interface RuntimeExecutionEvent extends Omit<RuntimeEvent, 'readerEvent'> {
  readerEvent: ReaderEventRef;
  execution: RuntimeExecutionObservation;
}

export interface RuntimeExecutionEventPage extends Omit<RuntimeEventPage, 'events'> {
  events: RuntimeExecutionEvent[];
}

export interface RuntimeWorkEntry {
  type: 'task' | 'agentRun' | 'lifecycle';
  id: string;
  kind: string;
  turnId: string | null;
  status: 'unknown' | 'completed' | 'failed' | 'cancelled';
  pairing: string | null;
  timeStart: number | null;
  timeEnd: number | null;
  timestamp: number | null;
  sourceOrder: { record: number; ordinal: number };
  evidence: { eventId: string; provenance: RuntimeEvent['provenance'] };
  terminalEvidence: { eventId: string; provenance: RuntimeEvent['provenance'] } | null;
  readerEvent: ReaderEventRef | null;
  terminalReaderEvent: ReaderEventRef | null;
}

export interface RuntimeWorkPage {
  session: SessionRef;
  revision: string;
  coverage: 'partial';
  domainCoverage: { state: 'observed' | 'not-observed' | 'unknown'; details: string };
  entries: RuntimeWorkEntry[];
  nextCursor: string | null;
  scannedEntries: number;
}

export interface RuntimeEventDetail {
  session: SessionRef;
  revision: string;
  coverage: 'partial';
  event: RuntimeEvent;
}

export class RuntimeApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function runtimeJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.text();
    let code = 'request_failed';
    let message = body || 'The Runtime request failed.';
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
      if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
    } catch { /* Keep the transport response. */ }
    throw new RuntimeApiError(code, message);
  }
  return response.json() as Promise<T>;
}

export async function getRuntimeEvents(
  provider: string, sessionId: string,
  query: { category?: string; kind?: string; cursor?: string; limit?: number } = {},
): Promise<RuntimeEventPage> {
  const params = new URLSearchParams({ limit: String(query.limit ?? 25) });
  if (query.category) params.set('category', query.category);
  if (query.kind) params.set('kind', query.kind);
  if (query.cursor) params.set('cursor', query.cursor);
  const url = '/api/v3/runtime/' + encodeURIComponent(provider) + '/' + encodeURIComponent(sessionId) + '/events?' + params;
  return runtimeJson<RuntimeEventPage>(url);
}

export function getReaderExecutionEvents(
  provider: string, sessionId: string, revision: string, query: { cursor?: string; limit?: number } = {},
): Promise<RuntimeExecutionEventPage> {
  const params = new URLSearchParams({ revision, limit: String(query.limit ?? 200) });
  if (query.cursor) params.set('cursor', query.cursor);
  return getJson<RuntimeExecutionEventPage>(readerEndpoint(provider, sessionId, 'executions', params));
}

export function getRuntimeWork(
  provider: string, sessionId: string,
  query: { kind?: string; status?: string; cursor?: string; limit?: number } = {},
): Promise<RuntimeWorkPage> {
  const params = new URLSearchParams({ limit: String(query.limit ?? 50) });
  if (query.kind) params.set('kind', query.kind);
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  return runtimeJson<RuntimeWorkPage>('/api/v3/runtime/' + encodeURIComponent(provider) + '/'
    + encodeURIComponent(sessionId) + '/work?' + params);
}

export function runtimeEventDetailUrl(provider: string, sessionId: string, eventId: string, revision: string): string {
  return '/api/v3/runtime/' + encodeURIComponent(provider) + '/' + encodeURIComponent(sessionId)
    + '/events/' + encodeURIComponent(eventId) + '?' + new URLSearchParams({ revision });
}

export function getRuntimeEventDetail(provider: string, sessionId: string, eventId: string, revision: string): Promise<RuntimeEventDetail> {
  return runtimeJson<RuntimeEventDetail>(runtimeEventDetailUrl(provider, sessionId, eventId, revision));
}

export interface ReaderFactProvenance {
  fidelity: 'recorded' | 'derived';
  sourceType: string;
  sourceId: string | null;
}

export interface ReaderTokenComponents {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
}

export interface ReaderRequestUsage {
  recordId: string;
  tokens: ReaderTokenComponents;
  provenance: ReaderFactProvenance;
}

export interface ReaderReplyMetadata {
  model: string | null;
  modelProvider: string | null;
  modelProvenance: ReaderFactProvenance | null;
  requestUsage: ReaderRequestUsage | null;
}

export interface ReaderToolMetadata {
  summary: string | null;
  directory: string | null;
  taskName: string | null;
  model: string | null;
  reasoningEffort: string | null;
  forkTurns: string | null;
  inputState: 'recorded' | 'encrypted';
}

export interface ReaderItem {
  event: ReaderEventRef;
  ordinal: number;
  owner: ReaderEventRef | null;
  role: string;
  timestamp: number | null;
  preview: string;
  totalChars: number;
  contentRevisions: Partial<Record<ContentField, string>>;
  toolName: string | null;
  toolMetadata?: ReaderToolMetadata | null;
  ownerMessageId?: string | null;
  presentationPhase: 'commentary' | 'final_answer' | null;
  processId: number | null;
  processCount: number | null;
  replyMetadata: ReaderReplyMetadata | null;
}

export interface ReaderSegment {
  id: string;
  pageId: string;
  startOrdinal: number;
  items: ReaderItem[];
  ownerContext: ReaderItem | null;
  previousCursor: string | null;
  nextCursor: string | null;
}

export interface ReaderTocEntry {
  event: ReaderEventRef;
  ordinal: number;
  owner: ReaderEventRef | null;
  role: string;
  label: string;
  processId: number | null;
  processCount: number | null;
}

export interface ReaderTocPage {
  entries: ReaderTocEntry[];
  previousCursor: string | null;
  nextCursor: string | null;
}

export interface ReaderBootstrap {
  session: SessionSummary;
  revision: string;
  totalItems: number;
  segments: ReaderSegment[];
  toc: ReaderTocPage;
  relations?: RelationSummary;
  targetLocation?: ReaderLocation;
  openingToc?: ReaderTocPage;
}

export interface MemoryArtifact {
  id: string;
  kind: 'memory' | 'summary';
  hash: string;
  sourcePath: string;
  timeCreated: number;
  contentSourceTime: number;
  productionEvidence: { startedAt: number | null; completedAt: number; inputUpdatedAt: number } | null;
}

export interface MemoryArtifacts {
  artifacts: MemoryArtifact[];
  sourceState: { state: 'available' | 'unavailable' | 'invalid'; code: string | null; sourcePath: string };
  revision: string;
}

export interface MemoryContentPage extends ContentPage {
  artifactId: string;
  format: 'markdown';
}

export function getMemoryArtifacts(sessionId: string): Promise<MemoryArtifacts> {
  return runtimeJson<MemoryArtifacts>('/api/v3/reader/codex/' + encodeURIComponent(sessionId) + '/artifacts');
}

export function getMemoryContent(sessionId: string, artifactId: string, revision: string,
  offset: number, maxChars = 2048): Promise<MemoryContentPage> {
  return runtimeJson<MemoryContentPage>('/api/v3/reader/codex/' + encodeURIComponent(sessionId)
    + '/artifacts/' + encodeURIComponent(artifactId) + '/content?'
    + new URLSearchParams({ revision, offset: String(offset), maxChars: String(maxChars) }));
}

export type PromptProvenance = 'recorded' | 'current-local';

export interface SystemPromptItem {
  kind: string;
  title: string;
  preview: string;
  content: string;
  source: string;
  sourcePath: string | null;
  sourceMetadata: unknown | null;
  provenance: PromptProvenance;
  resolution: string;
  time: number;
}

export interface SystemPromptSection {
  title: string;
  note: string;
  items: SystemPromptItem[];
}

export interface SystemPromptDiagnostic {
  code: string;
  message: string;
  source: string | null;
}

export interface SystemPromptEvidence {
  sessionId: string;
  mode: string;
  hiddenPromptStored: boolean;
  selectedAgent: string | null;
  firstUserMessage: unknown | null;
  note: string;
  sections: SystemPromptSection[];
  diagnostics: SystemPromptDiagnostic[];
}

export interface RelationSummary {
  taskCount: number;
  observationCount: number;
  firstCursor: string | null;
}

export interface RelationProvenance {
  fidelity: string;
  sourceType: string;
  sourceId: string;
}

export interface RelationParticipant {
  id: string;
  kind: 'member' | 'sender';
  name: string;
  description?: string | null;
  provenance: RelationProvenance;
}

export type RelationEntry =
  | { type: 'task'; task: { id: string; kind: string; status: string; owner: string | null; subject?: string | null; description?: string | null; ownerParticipant?: RelationParticipant | null; readerEvent?: ReaderEventRef | null; provenance: RelationProvenance } }
  | {
      type: 'coordination';
      observation: {
        kind: string;
        state: string;
        correlationId: string;
        eventId: string;
        fromSessionRef: SessionRef | null;
        toSessionRef: SessionRef | null;
        fromActorPath?: string | null;
        toActorPath?: string | null;
        fromParticipant?: RelationParticipant | null;
        toParticipant?: RelationParticipant | null;
        messageExcerpt?: string | null;
        messageExcerptTruncated?: boolean | null;
        launchRequest?: { model: string | null; reasoningEffort: string | null; forkTurns: string | null } | null;
        readerEvent?: ReaderEventRef | null;
        provenance: RelationProvenance;
      };
    };

export interface ReaderRelationsResponse {
  session: SessionRef;
  revision: string;
  entries: RelationEntry[];
  childPlacements: ReaderChildPlacement[];
  nextCursor: string | null;
}

export interface ReaderCollaborationSnapshot {
  revision: string;
  summary: RelationSummary | null;
  entries: RelationEntry[];
  nextCursor: string | null;
  loading: boolean;
  error: string;
}

export interface ReaderChildPlacement {
  child: SessionRef;
  afterEvent: ReaderEventRef | null;
  sourceEventId: string;
  diagnostic: string | null;
}

export interface ReaderChildLocation {
  session: SessionRef;
  revision: string;
  placement: ReaderChildPlacement | null;
  location: ReaderLocation | null;
  diagnostic: string | null;
}

export interface ReaderLocation {
  session: SessionRef;
  revision: string;
  event: ReaderEventRef;
  ordinal: number;
  owner: ReaderEventRef | null;
  pageCursor: string;
  tocCursor: string;
}

export interface ReaderSegmentResponse {
  session: SessionRef;
  revision: string;
  page: ReaderSegment;
}

export interface ReaderTocResponse {
  session: SessionRef;
  revision: string;
  toc: ReaderTocPage;
}

export type ContentField = 'body' | 'toolInput' | 'toolOutput';

export interface ReaderSearchMatch {
  event: ReaderEventRef;
  owner: ReaderEventRef | null;
  ordinal: number;
  field: ContentField;
  offset: number;
  matchLength: number;
  excerpt: string;
  excerptStart: number;
  totalChars: number;
}

export type ReaderSearchTarget = Pick<ReaderSearchMatch, 'event' | 'field' | 'offset' | 'matchLength'>;

export interface ReaderSearchPage {
  session: SessionRef;
  revision: string;
  scope: 'owned';
  coverage: 'complete-owned-content';
  matches: ReaderSearchMatch[];
  nextCursor: string | null;
}

export interface ContentPage {
  text: string;
  offset: number;
  totalChars: number;
  nextOffset: number | null;
  truncated: boolean;
}

export interface InheritedContextItem {
  ordinal: number;
  messageId: string;
  segment: string;
  role: string;
  preview: string;
  totalChars: number;
  timestamp: number | null;
  toolName: string | null;
}

export interface InheritedContextPage {
  session: SessionRef;
  revision: string;
  scope: 'inherited-context';
  sourceSession: SessionRef | null;
  totalItems: number;
  items: InheritedContextItem[];
  nextCursor: string | null;
}

export interface InheritedContextContentPage extends ContentPage {
  revision: string;
}

export class ApiRequestError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface ContentProgress {
  text: string;
  hasLoaded: boolean;
  totalChars: number;
  nextOffset: number | null;
  done: boolean;
  loading: boolean;
  error: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    const detail = await response.text();
    let message = detail;
    let code = 'request_failed';
    try {
      const parsed = JSON.parse(detail);
      if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
      if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
    } catch { /* Non-JSON transport errors retain their original text. */ }
    throw new ApiRequestError(code, message || 'The local service returned HTTP ' + response.status + '.');
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: object): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    let message = detail;
    try {
      const parsed = JSON.parse(detail);
      if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
    } catch { /* Preserve non-JSON transport details. */ }
    throw new Error(message || 'The local service returned HTTP ' + response.status + '.');
  }
  return response.json() as Promise<T>;
}

export async function getProviders(): Promise<ProviderSummary[]> {
  const providers = await getJson<ProviderSummary[]>('/api/providers');
  if (!Array.isArray(providers)) throw new Error('The provider list response was not an array.');
  return providers;
}

export function getSettings(): Promise<SettingsSnapshot> {
  return getJson<SettingsSnapshot>('/api/settings');
}

export function saveSettings(settings: Partial<RuntimeSettings>): Promise<SettingsSnapshot> {
  return postJson<SettingsSnapshot>('/api/settings', settings);
}

export async function getSessions(provider: string): Promise<SessionSummary[]> {
  const sessions = await getJson<SessionSummary[]>('/api/v3/sessions?' + new URLSearchParams({ provider }));
  if (!Array.isArray(sessions)) throw new Error('The session list response was not an array.');
  return sessions;
}

export function getLibraryFamilies(search: string, cursor?: string, filters: LibraryFilters = {}): Promise<LibraryFamilyPage> {
  const params = new URLSearchParams({ limit: '40' });
  if (search) params.set('search', search);
  if (cursor) params.set('cursor', cursor);
  if (filters.provider) params.set('provider', filters.provider);
  if (filters.project) params.set('project', filters.project);
  if (filters.range) params.set('range', filters.range);
  if (filters.sort) params.set('sort', filters.sort);
  return getJson<LibraryFamilyPage>('/api/v3/library/sessions?' + params);
}

export function getLibraryChildren(parent: SessionRef, search: string, cursor?: string,
  filters: LibraryFilters = {}): Promise<LibraryChildrenPage> {
  const params = new URLSearchParams({ provider: filters.provider || parent.provider,
    parentId: parent.sessionId, limit: '20' });
  if (search) params.set('search', search);
  if (cursor) params.set('cursor', cursor);
  if (filters.project) params.set('project', filters.project);
  if (filters.range) params.set('range', filters.range);
  if (filters.sort) params.set('sort', filters.sort);
  return getJson<LibraryChildrenPage>('/api/v3/library/children?' + params);
}

export function searchSessions(query: string, cursor?: string, providers = ''): Promise<SearchPage> {
  const params = new URLSearchParams({ q: query, limit: '20' });
  if (cursor) params.set('cursor', cursor);
  if (providers) params.set('provider', providers);
  return getJson<SearchPage>('/api/v3/search?' + params);
}

export function getViewerMeta(provider: string, sessionId: string): Promise<ViewerMeta | null> {
  return getJson<ViewerMeta | null>('/api/v3/meta/' + encodeURIComponent(provider) + '/' + encodeURIComponent(sessionId));
}

export function getViewerTrash(provider: string): Promise<ViewerMeta[]> {
  return getJson<ViewerMeta[]>('/api/v3/trash?' + new URLSearchParams({ provider }));
}

export function mutateViewer(
  provider: string, sessionId: string, action: 'star' | 'rename' | 'delete' | 'restore' | 'permanent-delete',
  title?: string,
): Promise<ViewerMeta> {
  const url = '/api/' + encodeURIComponent(provider) + '/session/' + encodeURIComponent(sessionId) + '/' + action;
  return postJson<ViewerMeta>(url, title === undefined ? {} : { title });
}

export function batchViewer(action: BatchAction, items: SessionRef[]): Promise<BatchResult> {
  return postJson<BatchResult>('/api/sessions/batch', {
    action, items: items.map(item => ({ provider: item.provider, id: item.sessionId })),
  });
}

export function getReaderBootstrap(provider: string, sessionId: string, target?: URLSearchParams): Promise<ReaderBootstrap> {
  if (target) {
    if (!target.has('messageId')) target.set('messageId', '');
    if (!target.has('segment')) target.set('segment', '');
  }
  return getJson<ReaderBootstrap>('/api/v3/reader/' + encodeURIComponent(provider) + '/' + encodeURIComponent(sessionId)
    + '/bootstrap' + (target ? '?' + target : ''));
}

export function getSystemPromptEvidence(provider: string, sessionId: string): Promise<SystemPromptEvidence> {
  const url = '/api/' + encodeURIComponent(provider) + '/session/' + encodeURIComponent(sessionId) + '/system-prompts';
  return getJson<SystemPromptEvidence>(url);
}

function readerEndpoint(provider: string, sessionId: string, name: string, query: URLSearchParams): string {
  return '/api/v3/reader/' + encodeURIComponent(provider) + '/' + encodeURIComponent(sessionId) + '/' + name + '?' + query;
}

export function getReaderSegment(provider: string, sessionId: string, cursor: string): Promise<ReaderSegmentResponse> {
  return getJson<ReaderSegmentResponse>(readerEndpoint(provider, sessionId, 'segments', new URLSearchParams({ cursor })));
}

export function getReaderToc(provider: string, sessionId: string, cursor: string, limit = 64): Promise<ReaderTocResponse> {
  return getJson<ReaderTocResponse>(readerEndpoint(provider, sessionId, 'toc', new URLSearchParams({ cursor, limit: String(limit) })));
}

export function getReaderSearch(provider: string, sessionId: string, revision: string,
  q: string, cursor?: string): Promise<ReaderSearchPage> {
  const params = new URLSearchParams({ q, revision, limit: '25' });
  if (cursor) params.set('cursor', cursor);
  return getJson<ReaderSearchPage>(readerEndpoint(provider, sessionId, 'search', params));
}

export function getReaderLocation(
  provider: string,
  sessionId: string,
  revision: string,
  target: ReaderEventRef | 'end',
  sourceRevision?: string,
): Promise<ReaderLocation> {
  const query = new URLSearchParams({ revision });
  if (sourceRevision) query.set('sourceRevision', sourceRevision);
  if (target === 'end') query.set('edge', 'end');
  else {
    query.set('messageId', target.messageId);
    query.set('segment', target.segment);
  }
  return getJson<ReaderLocation>(readerEndpoint(provider, sessionId, 'locate', query));
}

export function getContentPage(
  provider: string,
  sessionId: string,
  event: ReaderEventRef,
  revision: string,
  offset: number,
  field: ContentField = 'body',
  maxChars = 1400,
  contentRevision?: string,
): Promise<ContentPage> {
  const query = new URLSearchParams({
    messageId: event.messageId,
    segment: event.segment,
    field,
    offset: String(offset),
    maxChars: String(maxChars),
    revision,
  });
  if (contentRevision) query.set('contentRevision', contentRevision);
  return getJson<ContentPage>(
    readerEndpoint(provider, sessionId, 'content', query),
  );
}

export function getTeamMessageContentPage(provider: string, sessionId: string,
  sequence: string, messageId: string, revision: string, offset: number,
  maxChars = 2048): Promise<ContentPage> {
  const query = new URLSearchParams({
    sequence, messageId, revision, offset: String(offset), maxChars: String(maxChars),
  });
  return getJson<ContentPage>(readerEndpoint(provider, sessionId, 'team-message/content', query));
}

async function inheritedContextJson<T>(url: string, allowNoContent = false): Promise<T | null> {
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 204 && allowNoContent) return null;
  if (!response.ok) {
    const detail = await response.text();
    let code = 'request_failed';
    let message = detail || 'The inherited context request failed.';
    try {
      const parsed = JSON.parse(detail);
      if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
      if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
    } catch { /* Keep the transport response. */ }
    throw new ApiRequestError(code, message);
  }
  return response.json() as Promise<T>;
}

export function getInheritedContextPage(
  child: SessionRef,
  cursor?: string,
): Promise<InheritedContextPage | null> {
  const query = new URLSearchParams({ limit: '40' });
  if (cursor) query.set('cursor', cursor);
  const url = '/api/v3/reader/' + encodeURIComponent(child.provider) + '/'
    + encodeURIComponent(child.sessionId) + '/inherited-context?' + query;
  return inheritedContextJson<InheritedContextPage>(url, true);
}

export function getInheritedContextContent(
  child: SessionRef,
  item: Pick<InheritedContextItem, 'ordinal' | 'messageId' | 'segment'>,
  revision: string,
  field: ContentField,
  offset: number,
  maxChars = 2048,
): Promise<InheritedContextContentPage> {
  const query = new URLSearchParams({
    ordinal: String(item.ordinal),
    messageId: item.messageId,
    segment: item.segment,
    field,
    offset: String(offset),
    maxChars: String(maxChars),
    revision,
  });
  const url = '/api/v3/reader/' + encodeURIComponent(child.provider) + '/'
    + encodeURIComponent(child.sessionId) + '/inherited-context/content?' + query;
  return inheritedContextJson<InheritedContextContentPage>(url).then(page => {
    if (!page) throw new ApiRequestError('invalid_response', 'The inherited content response was empty.');
    return page;
  });
}

export function getReaderRelations(provider: string, sessionId: string, cursor: string): Promise<ReaderRelationsResponse> {
  return getJson<ReaderRelationsResponse>(readerEndpoint(provider, sessionId, 'relations', new URLSearchParams({ cursor })));
}

export function getReaderChildLocation(provider: string, sessionId: string, revision: string, child: SessionRef): Promise<ReaderChildLocation> {
  return getJson<ReaderChildLocation>(readerEndpoint(provider, sessionId, 'child-location', new URLSearchParams({
    revision, childProvider: child.provider, childSessionId: child.sessionId,
  })));
}
