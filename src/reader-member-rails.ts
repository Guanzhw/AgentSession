import type { SessionRef } from "./providers/shared/session-protocol.js";
import type { Actor, CoordinationObservation, SessionProtocolV3 } from "./providers/shared/session-protocol-v3.js";
import type { ReaderRelationMilestone } from "./reader-relations.js";

export interface ReaderMemberRail {
  id: string;
  name: string;
  purpose: string | null;
  childSession: SessionRef | null;
  color: number;
}

export interface ReaderMemberRailPoint {
  id: string;
  from: string;
  to: string;
  kind: CoordinationObservation["kind"];
  state: string;
  sequence: number;
}

export interface ReaderMemberRailEdge {
  id: string;
  from: string;
  to: string;
  start: string;
  end: string;
  kind: "create" | "message" | "return";
  received: boolean;
}

export interface ReaderMemberRails {
  members: ReaderMemberRail[];
  points: ReaderMemberRailPoint[];
  edges: ReaderMemberRailEdge[];
}

const sendKinds = new Set<CoordinationObservation["kind"]>(["message", "follow-up", "handoff"]);
const receiveKinds = new Set<CoordinationObservation["kind"]>(["mailbox-delivery", "result-delivery"]);
const sessionKey = (ref: SessionRef) => `session:${encodeURIComponent(ref.provider)}:${encodeURIComponent(ref.sessionId)}`;

/** Actor and message meaning is resolved here, before the browser measures the document. */
export function deriveReaderMemberRails(protocol: SessionProtocolV3, milestones: ReaderRelationMilestone[]): ReaderMemberRails {
  const ownerKey = sessionKey(protocol.session!.ref);
  const actors = new Map(protocol.actors.map((actor) => [actor.id, actor]));
  const observations = new Map(protocol.coordination.map((observation) => [observation.id, observation]));
  const members = new Map<string, ReaderMemberRail>();
  const candidates = new Map<string, { actor: Actor | null; ref: SessionRef | null }>();

  const endpoint = (actorId: string | null | undefined, recordedRef: SessionRef | null | undefined): string | null => {
    const actor = actorId ? actors.get(actorId) : undefined;
    if (actor && actor.kind !== "agent") return null;
    const ref = actor?.sessionRef || recordedRef || null;
    if (!actor && !ref) return null;
    const id = ref ? sessionKey(ref) : `actor:${actor!.id}`;
    if (id === ownerKey) return "main";
    const previous = candidates.get(id);
    if (!previous || (!previous.actor?.name && actor?.name)) candidates.set(id, { actor: actor || null, ref });
    return id;
  };

  const points: ReaderMemberRailPoint[] = [];
  const correlations = new Map<string, { sends: ReaderMemberRailPoint[]; receives: ReaderMemberRailPoint[] }>();
  for (const milestone of milestones) {
    const observation = observations.get(milestone.id)!;
    const state = observation.state || "unknown";
    const received = receiveKinds.has(observation.kind) && state === "delivered";
    const sent = sendKinds.has(observation.kind) && ["requested", "started", "unknown"].includes(state);
    const created = observation.kind === "spawn" && ["started", "completed", "delivered"].includes(state);
    if (!created && !sent && !received) continue;
    const from = endpoint(observation.senderActorId, observation.fromSessionRef);
    const to = endpoint(observation.recipientActorId, observation.toSessionRef);
    // An absent endpoint has no visual direction. The original record remains in the Reader.
    if (!from || !to || from === to) continue;
    const point: ReaderMemberRailPoint = {
      id: milestone.id, from, to, kind: observation.kind,
      state, sequence: milestone.sequence
    };
    points.push(point);
    if (observation.correlationId && (sent || received)) {
      const key = JSON.stringify([observation.correlationId, from, to]);
      const group = correlations.get(key) || { sends: [], receives: [] };
      (received ? group.receives : group.sends).push(point);
      correlations.set(key, group);
    }
  }
  points.sort((left, right) => left.sequence - right.sequence);
  for (const point of points) {
    for (const id of [point.from, point.to]) {
      if (id === "main" || members.has(id)) continue;
      const { actor, ref } = candidates.get(id)!;
      members.set(id, {
        id, name: actor?.name || actor?.providerActorId || ref?.sessionId || actor!.id,
        purpose: actor?.description || null, childSession: ref, color: members.size % 6
      });
    }
  }

  const paired = new Map<string, ReaderMemberRailPoint>();
  const pairedReceipts = new Set<string>();
  for (const { sends, receives } of correlations.values()) {
    if (sends.length !== 1 || receives.length !== 1 || sends[0].sequence >= receives[0].sequence) continue;
    paired.set(sends[0].id, receives[0]);
    pairedReceipts.add(receives[0].id);
  }
  const edges: ReaderMemberRailEdge[] = [];
  for (const point of points) {
    if (pairedReceipts.has(point.id)) continue;
    const receipt = paired.get(point.id);
    const received = Boolean(receipt) || (receiveKinds.has(point.kind) && point.state === "delivered");
    const created = point.kind === "spawn";
    edges.push({
      id: point.id, from: point.from, to: point.to, start: point.id, end: receipt?.id || point.id,
      kind: created ? "create" : received && point.to === "main" ? "return" : "message",
      received
    });
  }
  return { members: [...members.values()], points, edges };
}
