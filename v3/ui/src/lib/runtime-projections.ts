import type { ReaderEventRef, SessionRef, RuntimeEvent } from './api';
import { RuntimeApiError } from './api';

export interface DomainCoverage {
  state: 'observed' | 'not-observed' | 'unknown';
  details: string;
}

interface ProjectionBase {
  revision: string;
}

export interface RuntimeSummary extends ProjectionBase {
  session: SessionRef;
  completeness: 'partial' | 'complete';
  validation: { ok: boolean; completeness: string; errors: unknown[]; warnings: unknown[] };
  counts: { events: number; relationships: number; tasks: number; agentRuns: number; branches?: number;
    contextArtifacts: number; coordination: number; usageRecords: number };
  categories: Record<string, number>;
  coverage: Record<string, DomainCoverage>;
}

export interface RuntimeGraph extends ProjectionBase {
  focus: SessionRef;
  coverage: 'partial' | 'complete';
  domainCoverage: Record<string, DomainCoverage>;
  nodes: Array<{ id: string; kind: string; label: string; status: string | null;
    timeStart: number | null; timeEnd: number | null; session: SessionRef;
    resolution: 'resolved' | 'unverified'; provenance: RuntimeEvent['provenance'] | null; focus: boolean }>;
  edges: Array<{ id: string; type: string; from: string; to: string;
    provenance: RuntimeEvent['provenance']; inferred: boolean }>;
  truncated: boolean;
  maxNodes: number;
}

export type RuntimeDomain = 'execution' | 'coordination' | 'context';

export interface DomainFact {
  id?: string;
  kind?: string;
  state?: string;
  status?: string;
  phase?: string;
  category?: string;
  execution?: { phase: string; toolName: string; handle: string; label?: string } | null;
  pairing?: string;
  turnId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  correlationId?: string;
  fromActorPath?: string | null;
  toActorPath?: string | null;
  fromSessionRef?: SessionRef | null;
  toSessionRef?: SessionRef | null;
  from?: SessionRef;
  to?: SessionRef;
  timestamp?: number | null;
  timeStart?: number | null;
  timeEnd?: number | null;
  timeCreated?: number | null;
  summaryAvailable?: boolean;
  trigger?: string | null;
  preCompactTokens?: number | null;
  title?: string | null;
  summary?: string | null;
  scope?: string;
  origin?: string;
  contentAccess?: string;
  sourcePath?: string;
  model?: string | null;
  tokens?: { input?: number | null; cacheRead?: number | null; cacheWrite?: number | null;
    output?: number | null; reasoning?: number | null; total?: number | null };
  provenance?: RuntimeEvent['provenance'];
  evidence?: { eventId: string; provenance: RuntimeEvent['provenance'] };
  readerEvent?: ReaderEventRef | null;
  transformation?: { id: string; kind: string; eventId: string; timestamp: number | null;
    retainedFrom: { sourceId: string; eventId: string | null } | null;
    retainedTailCount: number | null; shadowedRange?: { start: number; end: number };
    shadowedSeqs?: number[]; shadowedTokenCount?: number;
    provenance: RuntimeEvent['provenance'] };
  version?: { id: string; sequence: number; readerEvent: ReaderEventRef | null };
}

export interface DomainPage extends ProjectionBase {
  session: SessionRef;
  coverage: 'partial' | 'complete';
  domainCoverage: DomainCoverage;
  entries: Array<{ type: string; kind: string;
    sourceOrder: { record: number; ordinal: number } | null; fact: DomainFact }>;
  nextCursor: string | null;
  scannedEntries: number;
}

async function projectionJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.text();
    let code = 'request_failed';
    let message = body || 'The Runtime request failed.';
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
      if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
    } catch { /* The HTTP response is still useful. */ }
    throw new RuntimeApiError(code, message);
  }
  return response.json() as Promise<T>;
}

function base(provider: string, sessionId: string): string {
  return '/api/v3/runtime/' + encodeURIComponent(provider) + '/' + encodeURIComponent(sessionId);
}

export function getRuntimeSummary(provider: string, sessionId: string): Promise<RuntimeSummary> {
  return projectionJson<RuntimeSummary>(base(provider, sessionId) + '/summary');
}

export function getRuntimeGraph(provider: string, sessionId: string, maxNodes = 100): Promise<RuntimeGraph> {
  return projectionJson<RuntimeGraph>(base(provider, sessionId) + '/graph?'
    + new URLSearchParams({ maxNodes: String(maxNodes) }));
}

export function getRuntimeDomain(provider: string, sessionId: string, domain: RuntimeDomain,
  query: { kind?: string; cursor?: string; limit?: number } = {}): Promise<DomainPage> {
  const params = new URLSearchParams({ limit: String(query.limit ?? 25) });
  if (query.kind) params.set('kind', query.kind);
  if (query.cursor) params.set('cursor', query.cursor);
  return projectionJson<DomainPage>(base(provider, sessionId) + '/' + domain + '?' + params);
}
