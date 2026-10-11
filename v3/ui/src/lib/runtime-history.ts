import type { RuntimeDomain } from './runtime-projections';
import type { ReaderEventRef } from './api';

export type RuntimeLens = 'events' | 'work' | 'summary' | 'sessions' | RuntimeDomain;
export interface RuntimePageState {
  revision: string | null;
  cursor: string | null;
  kind: string;
}
export interface RuntimeEventsState extends RuntimePageState { category: string }
export interface RuntimeWorkState extends RuntimePageState { status: string }
export interface RuntimeNavigationSnapshot {
  provider: string;
  sessionId: string;
  lens: RuntimeLens;
  scrollY: number;
  events?: RuntimeEventsState;
  work?: RuntimeWorkState;
  domains: Partial<Record<RuntimeDomain, RuntimePageState>>;
  summaryRevision?: string | null;
  sessionsRevision?: string | null;
  focusNodeId: string | null;
}

interface RuntimeHistoryState { agentSessionRuntime?: RuntimeNavigationSnapshot }

export function readRuntimeHistory(provider: string, sessionId: string): RuntimeNavigationSnapshot | null {
  const saved = (window.history.state as RuntimeHistoryState | null)?.agentSessionRuntime;
  return saved?.provider === provider && saved.sessionId === sessionId ? saved : null;
}

export function runtimeLensFromHash(): RuntimeLens | null {
  if (!window.location.hash.startsWith('#runtime?')) return null;
  const lens = new URLSearchParams(window.location.hash.slice(9)).get('lens');
  return lens === 'events' || lens === 'work' || lens === 'summary' || lens === 'sessions' ||
    lens === 'execution' || lens === 'coordination' || lens === 'context' ? lens : 'events';
}

export function runtimeHash(lens: RuntimeLens, focusNodeId: string | null = null): string {
  const query = new URLSearchParams({ lens });
  if (lens === 'sessions' && focusNodeId) query.set('node', focusNodeId);
  return '#runtime?' + query;
}

export function runtimeSourceHash(event: ReaderEventRef, sourceRevision: string): string {
  return '#event?' + new URLSearchParams({ messageId: event.messageId, segment: event.segment, sourceRevision });
}

export function saveRuntimeHistory(snapshot: RuntimeNavigationSnapshot): void {
  window.history.replaceState({ ...window.history.state, agentSessionRuntime: snapshot }, '',
    window.location.pathname + window.location.search + runtimeHash(snapshot.lens, snapshot.focusNodeId));
}
