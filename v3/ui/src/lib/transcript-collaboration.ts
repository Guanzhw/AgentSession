import type { ReaderEventRef, RelationEntry, SessionRef } from './api';

type Observation = Extract<RelationEntry, { type: 'coordination' }>['observation'];

export interface ReaderCollaborationIdentity {
  from: string | null;
  to: string | null;
  fromSession: SessionRef | null;
  toSession: SessionRef | null;
  fromKey: string | null;
  toKey: string | null;
}

export interface TranscriptHandoff {
  id: string;
  correlationId: string;
  dispatch: ReaderEventRef | null;
  returned: ReaderEventRef | null;
  agent: string | null;
  agentKey: string;
  child: SessionRef | null;
}

export interface TranscriptHandoffLayout extends TranscriptHandoff {
  dispatchY: number | null;
  returnY: number | null;
  lane: number;
}

export interface TranscriptEndpointGroup {
  y: number;
  choices: { id: string; kind: 'dispatch' | 'return'; agent: string | null; agentKey: string; event: ReaderEventRef | null }[];
}

export function collaborationEventKey(event: ReaderEventRef): string {
  return [event.provider, event.sessionId, event.messageId, event.segment].join('\0');
}

/** Shorten a recorded actor path for display while keeping its full identity. */
export function actorLabel(actor: string | null): string | null {
  return actor?.split('/').filter(Boolean).at(-1) ?? null;
}

/** An identity keeps its appearance when pages, endpoint positions, or lanes change. */
export function agentAppearance(identity: string): { color: string; icon: string } {
  let hash = 2166136261;
  for (const character of identity) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  const color = `hsl(${hash % 360} ${52 + (hash >>> 12) % 18}% ${36 + (hash >>> 20) % 9}%)`;
  // A symmetric 5×5 fingerprint distinguishes actors without a growing icon catalog.
  const bits = (hash ^ (hash >>> 16)) | 16;
  let icon = '';
  for (let row = 0; row < 5; row++) for (let column = 0; column < 3; column++) {
    if (!(bits & (1 << (row * 3 + column)))) continue;
    icon += `M${column} ${row}h1v1h-1z`;
    if (column < 2) icon += `M${4 - column} ${row}h1v1h-1z`;
  }
  return { color, icon };
}

function actorKey(source: SessionRef, session: SessionRef | null, actor: string | null | undefined, participant: Observation['fromParticipant']): string | null {
  if (session) return ['session', session.provider, session.sessionId].join('\0');
  if (actor) return ['actor', source.provider, source.sessionId, actor].join('\0');
  if (participant) return ['participant', source.provider, source.sessionId, participant.id].join('\0');
  return null;
}

export function coordinationIdentity(observation: Observation, source: SessionRef, observations: Observation[]): ReaderCollaborationIdentity {
  const started = observations.find(item => item.kind === 'spawn' && item.state === 'started' && item.correlationId === observation.correlationId);
  const child = started?.toSessionRef ?? null;
  const fromActor = observation.fromActorPath ?? (observation.kind === 'result' ? started?.toActorPath : null);
  const fromParticipant = observation.fromParticipant ?? (observation.kind === 'result' ? started?.toParticipant : null);
  const toActor = observation.toActorPath ?? (observation.kind === 'spawn' ? started?.toActorPath : null);
  const toParticipant = observation.toParticipant ?? (observation.kind === 'spawn' ? started?.toParticipant : null);
  return {
    from: fromParticipant?.name ?? fromActor ?? null,
    to: toParticipant?.name ?? toActor ?? null,
    fromSession: observation.fromSessionRef,
    toSession: observation.toSessionRef,
    fromKey: actorKey(source, observation.fromSessionRef ?? (observation.kind === 'result' ? child : null), fromActor, fromParticipant),
    toKey: actorKey(source, observation.toSessionRef ?? (observation.kind === 'spawn' ? child : null), toActor, toParticipant),
  };
}

/** Names come from recorded participants/actor paths, never from reply prose. */
export function readerCollaborationIdentity(entries: RelationEntry[], event: ReaderEventRef): ReaderCollaborationIdentity | null {
  const observations = entries.flatMap(entry => entry.type === 'coordination' &&
    entry.observation.readerEvent && collaborationEventKey(entry.observation.readerEvent) === collaborationEventKey(event)
    ? [entry.observation] : []);
  const observation = observations.find(item => item.kind === 'result') ??
    observations.find(item => item.state === 'started') ?? observations[0];
  return observation ? coordinationIdentity(observation, event, entries.flatMap(entry => entry.type === 'coordination' ? [entry.observation] : [])) : null;
}

/** Correlation IDs are normalized by the owning provider; absent anchors remain absent. */
export function transcriptHandoffs(entries: RelationEntry[], source: SessionRef): TranscriptHandoff[] {
  const groups = new Map<string, Observation[]>();
  for (const entry of entries) {
    if (entry.type !== 'coordination') continue;
    const item = entry.observation;
    if (item.kind !== 'spawn' && item.kind !== 'result') continue;
    if (item.readerEvent && (item.readerEvent.provider !== source.provider || item.readerEvent.sessionId !== source.sessionId)) continue;
    const group = groups.get(item.correlationId) ?? [];
    group.push(item);
    groups.set(item.correlationId, group);
  }
  return [...groups.entries()].flatMap(([correlationId, observations]) => {
    const dispatch = observations.find(item => item.kind === 'spawn' && item.state === 'requested' && item.readerEvent)
      ?? observations.find(item => item.kind === 'spawn' && item.readerEvent);
    const started = observations.find(item => item.kind === 'spawn' && item.state === 'started');
    const results = observations.filter(item => item.kind === 'result' && item.readerEvent);
    return (results.length ? results : [null]).map(returned => {
      const child = started?.toSessionRef ?? returned?.fromSessionRef ?? dispatch?.toSessionRef ?? null;
      const actor = returned?.fromActorPath ?? started?.toActorPath ?? dispatch?.toActorPath;
      const participant = returned?.fromParticipant ?? started?.toParticipant ?? dispatch?.toParticipant;
      return {
        id: returned?.eventId ?? dispatch?.eventId ?? correlationId,
        correlationId,
        dispatch: dispatch?.readerEvent ?? null,
        returned: returned?.readerEvent ?? null,
        agent: participant?.name ?? actor ?? null,
        agentKey: actorKey(source, child, actor, participant) ?? ['handoff', source.provider, source.sessionId, correlationId].join('\0'),
        child,
      };
    });
  });
}

/** Missing endpoints reserve their open span; they never end at a sibling's anchor. */
export function layoutTranscriptHandoffs(handoffs: TranscriptHandoff[], points: Map<string, number>): TranscriptHandoffLayout[] {
  const visible = handoffs.map(handoff => ({ ...handoff,
    dispatchY: handoff.dispatch ? points.get(collaborationEventKey(handoff.dispatch)) ?? null : null,
    returnY: handoff.returned ? points.get(collaborationEventKey(handoff.returned)) ?? null : null,
    lane: 0,
  })).filter(item => item.dispatchY !== null || item.returnY !== null)
    .sort((a, b) => (a.dispatchY ?? -Infinity) - (b.dispatchY ?? -Infinity));
  const ends: number[] = [];
  for (const item of visible) {
    const start = item.dispatchY === null ? -Infinity : Math.min(item.dispatchY, item.returnY ?? Infinity);
    const end = item.returnY === null ? Infinity : Math.max(item.dispatchY ?? -Infinity, item.returnY);
    const available = ends.findIndex(previous => previous < start);
    item.lane = available < 0 ? ends.length : available;
    ends[item.lane] = end;
  }
  return visible;
}

/** A collapsed execution anchor offers every canonical destination through one hub. */
export function transcriptEndpointGroups(layout: TranscriptHandoffLayout[]): TranscriptEndpointGroup[] {
  const groups = new Map<number, TranscriptEndpointGroup>();
  function add(y: number, item: TranscriptHandoffLayout, kind: 'dispatch' | 'return', event: ReaderEventRef | null): void {
    const group = groups.get(y) ?? { y, choices: [] };
    group.choices.push({ id: item.id + ':' + kind, kind, agent: item.agent, agentKey: item.agentKey, event });
    groups.set(y, group);
  }
  for (const item of layout) {
    if (item.dispatchY !== null && item.dispatchY !== item.returnY) add(item.dispatchY, item, 'dispatch', item.returned);
    if (item.returnY !== null) add(item.returnY, item, 'return', item.dispatch);
  }
  return [...groups.values()];
}
