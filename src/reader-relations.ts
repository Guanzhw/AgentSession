import { readerCoordinationAssignment } from "./reader-coordination.js";
import { deriveReaderMemberRails, type ReaderMemberRails } from "./reader-member-rails.js";
import type { SessionEventEnvelope, SessionRef } from "./providers/shared/session-protocol.js";
import type { CoordinationKind, SessionEventRef, SessionProtocolV3 } from "./providers/shared/session-protocol-v3.js";

export interface ReaderRelationLane {
  id: string;
  name: string | null;
  /** Recorded task title or agent path; distinct from the actor display name. */
  purpose?: string | null;
  childSession: SessionRef | null;
  runIds: string[];
}

export interface ReaderRelationPosition {
  /** Owning document message, which may belong to a merged rendered turn. */
  messageId: string;
  partId: string | null;
  side: "before" | "after";
  /** Recorded between two events of this coalesced execution, not before the call. */
  withinExecution?: boolean;
}

export interface ReaderRelationMilestone {
  id: string;
  laneId: string;
  kind: CoordinationKind;
  eventId: string;
  sequence: number;
  timestamp: number | null;
  runId: string | null;
  state: string;
  turnId: string | null;
  senderActorId: string | null;
  senderName: string | null;
  recipientActorId: string | null;
  recipientName: string | null;
  senderIsCurrentSession: boolean;
  recipientIsCurrentSession: boolean;
  /** Only explicit co-membership makes a message a Team peer handoff. */
  teamPeerMessage: boolean;
  /** Presentation label for recorded messages; it never changes the source kind. */
  messageAction: "handoff" | "follow-up" | "message" | "received-message" | null;
  sourceEventRef: SessionEventRef;
  position: ReaderRelationPosition;
}

export interface ReaderRelationUnplaced {
  id: string;
  laneId: string | null;
  kind: CoordinationKind;
  eventId: string | null;
  sequence: number | null;
  timestamp: number | null;
  runId: string | null;
  sourceEventRef: SessionEventRef | null;
  reason: "unassigned" | "source_missing" | "external_source" | "position_missing";
}

export interface ReaderRelations {
  lanes: ReaderRelationLane[];
  milestones: ReaderRelationMilestone[];
  unplaced: ReaderRelationUnplaced[];
  memberRails?: ReaderMemberRails;
}

interface ReaderDocument {
  messages: any[];
  partsByMessage: Map<string, any[]>;
}

interface NativePart {
  position: ReaderRelationPosition;
  order: number;
  type: string;
  callId: string | null;
  text: string | null;
}

function actorLabel(actor: SessionProtocolV3["actors"][number] | undefined): string | null {
  return actor?.name || actor?.providerActorId || actor?.id || null;
}

function teamMemberships(protocol: SessionProtocolV3): Map<string, Set<string>> {
  const memberships = new Map<string, Set<string>>();
  for (const team of protocol.actors) {
    if (team.kind !== "team") continue;
    for (const memberId of team.memberActorIds || []) {
      const values = memberships.get(memberId) || new Set<string>();
      values.add(team.id);
      memberships.set(memberId, values);
    }
  }
  return memberships;
}

function actorIdentityIndex(protocol: SessionProtocolV3): Map<string, SessionProtocolV3["actors"][number]> {
  const index = new Map(protocol.actors.map((actor) => [actor.id, actor]));
  for (const actor of protocol.actors) {
    if (actor.providerActorId && !index.has(actor.providerActorId)) index.set(actor.providerActorId, actor);
  }
  return index;
}

function taskActors(task: SessionProtocolV3["tasks"][number], actors: Map<string, SessionProtocolV3["actors"][number]>): string[] {
  return [...new Set([task.owner, task.assignee]
    .filter((value): value is string => Boolean(value))
    .map((value) => actors.get(value)?.id)
    .filter((value): value is string => Boolean(value)))];
}

function isTeamPeerMessage(
  kind: CoordinationKind,
  senderActorId: string | null | undefined,
  recipientActorId: string | null | undefined,
  memberships: Map<string, Set<string>>
): boolean {
  if ((kind !== "message" && kind !== "mailbox-delivery") || !senderActorId || !recipientActorId || senderActorId === recipientActorId) return false;
  const senderTeams = memberships.get(senderActorId);
  const recipientTeams = memberships.get(recipientActorId);
  return Boolean(senderTeams && recipientTeams && [...senderTeams].some((teamId) => recipientTeams.has(teamId)));
}

function sameSession(left: SessionRef, right: SessionRef): boolean {
  return left.provider === right.provider && left.sessionId === right.sessionId;
}

/** Resolve existing normalized identities; never manufacture a part ID from a call ID. */
function nativeEventPart(
  event: Pick<SessionEventEnvelope, "partId" | "messageId" | "toolCallId" | "normalizedKind">,
  byPart: Map<string, NativePart>,
  byMessage: Map<string, NativePart[]>
): NativePart | null {
  if (event.partId) return byPart.get(event.partId) || null;
  const exactPart = event.messageId ? byPart.get(event.messageId) : undefined;
  if (exactPart) return exactPart;
  const parts = (event.messageId ? byMessage.get(event.messageId) : undefined)
    || (event.toolCallId ? byMessage.get(event.toolCallId) : undefined)
    || [];
  if (event.toolCallId) {
    const tools = parts.filter((part) => part.type === "tool");
    const calls = tools.filter((part) => part.callId === event.toolCallId);
    if (calls.length) return calls.length === 1 ? calls[0] : null;
    const callPart = byPart.get(event.toolCallId);
    if (callPart) return callPart;
    return tools.length === 1 && !tools[0].callId ? tools[0] : null;
  }
  if (event.normalizedKind?.includes("reason")) {
    return parts.find((part) => part.type === "reasoning")
      || parts.find((part) => part.type === "text") || null;
  }
  return parts.find((part) => part.type === "text")
    || parts.find((part) => part.type === "reasoning") || null;
}

/** Shared exact source lookup for reading positions and source-evidence navigation. */
export function createReaderNativeSourceResolver(document: ReaderDocument) {
  const byPart = new Map<string, NativePart>();
  const byMessage = new Map<string, NativePart[]>();
  for (const message of document.messages) {
    const parts: NativePart[] = [];
    for (const part of document.partsByMessage.get(message.id) || []) {
      const type = part.data.type;
      if (type !== "tool" && !((type === "text" || type === "reasoning") && part.data.text)) continue;
      const native: NativePart = {
        position: { messageId: message.id, partId: part.id, side: "before" },
        order: byPart.size,
        type,
        callId: part.data.callID || null,
        text: type === "text" ? part.data.text : null
      };
      byPart.set(part.id, native);
      parts.push(native);
    }
    byMessage.set(message.id, parts);
  }
  return (event: Pick<SessionEventEnvelope, "partId" | "messageId" | "toolCallId" | "normalizedKind">): NativePart | null => (
    nativeEventPart(event, byPart, byMessage)
  );
}

function sourcePositions(events: SessionEventEnvelope[], resolve: ReturnType<typeof createReaderNativeSourceResolver>): Map<string, ReaderRelationPosition> {
  const nativeParts = events.map(resolve);
  const nextParts: Array<NativePart | null> = new Array(events.length);
  let next: NativePart | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    nextParts[index] = next;
    if (nativeParts[index]) next = nativeParts[index];
  }
  const positions = new Map<string, ReaderRelationPosition>();
  let previous: NativePart | null = null;
  events.forEach((event, index) => {
    const native = nativeParts[index];
    if (native) {
      positions.set(event.id, native.position);
      previous = native;
      return;
    }
    if (event.partId) return;
    const following = nextParts[index];
    // A coalesced tool has a recorded interval even though its UI has one
    // anchor. Label that interval explicitly rather than implying a dispatch
    // happened before the call. Coalesced prose has no such execution span.
    if (previous && following && previous === following && previous.type === "tool") {
      positions.set(event.id, { ...previous.position, withinExecution: true });
      return;
    }
    // Reversed document/source order cannot establish a reading position.
    if (previous && following && previous.order >= following.order) return;
    if (following) positions.set(event.id, following.position);
    else if (previous) positions.set(event.id, { ...previous.position, side: "after" });
  });
  return positions;
}

/** Reading positions over finalized protocol facts and the already-loaded owned document. */
export function deriveReaderRelations(protocol: SessionProtocolV3, document: ReaderDocument, resolve = createReaderNativeSourceResolver(document)): ReaderRelations {
  const owner = protocol.session!.ref;
  const assignment = readerCoordinationAssignment(protocol);
  const runs = new Map(protocol.agentRuns.map((run) => [run.id, run]));
  const tasks = new Map(protocol.tasks.map((task) => [task.id, task]));
  const actors = new Map(protocol.actors.map((actor) => [actor.id, actor]));
  const actorsByIdentity = actorIdentityIndex(protocol);
  const memberships = teamMemberships(protocol);
  const lanesById = new Map<string, ReaderRelationLane>();
  const laneByCard = new Map<string, ReaderRelationLane>();
  for (const card of assignment.cards) {
    const run = card.runId ? runs.get(card.runId) : undefined;
    const task = card.taskId ? tasks.get(card.taskId) : undefined;
    const childSession = run?.childSessionId ? { provider: owner.provider, sessionId: run.childSessionId } : null;
    const id = childSession
      ? `child:${encodeURIComponent(childSession.provider)}:${encodeURIComponent(childSession.sessionId)}`
      : `${encodeURIComponent(owner.provider)}:${encodeURIComponent(owner.sessionId)}:${card.key}`;
    let lane = lanesById.get(id);
    if (!lane) {
      const actorName = card.actorIds.map((actorId) => actors.get(actorId)?.name).find(Boolean);
      lane = {
        id,
        name: actorName || run?.agent || task?.assignee || task?.owner || task?.title || task?.agentPath || null,
        purpose: task?.title || task?.agentPath || null,
        childSession,
        runIds: []
      };
      lanesById.set(id, lane);
    }
    if (run) lane.runIds.push(run.id);
    laneByCard.set(card.key, lane);
  }

  // Team messages can have neither task nor run on their recorded event.  Keep
  // them on an explicit member work lane, never on an inferred communication edge.
  const teamLanesByActor = new Map<string, ReaderRelationLane[]>();
  const addTeamLane = (actorId: string, lane: ReaderRelationLane) => {
    const values = teamLanesByActor.get(actorId) || [];
    if (!values.includes(lane)) values.push(lane);
    teamLanesByActor.set(actorId, values);
  };
  for (const team of protocol.actors) {
    if (team.kind !== "team") continue;
    for (const memberId of team.memberActorIds || []) {
      const member = actors.get(memberId);
      if (!member) continue;
      const memberTasks = protocol.tasks.filter((task) => taskActors(task, actorsByIdentity).includes(member.id));
      const purpose = memberTasks.length === 1 ? memberTasks[0].title || memberTasks[0].agentPath || null : null;
      const id = member.sessionRef
        ? `child:${encodeURIComponent(member.sessionRef.provider)}:${encodeURIComponent(member.sessionRef.sessionId)}`
        : `team:${encodeURIComponent(team.id)}:${encodeURIComponent(member.id)}`;
      const lane: ReaderRelationLane = lanesById.get(id) || {
        id,
        name: actorLabel(member),
        purpose,
        childSession: member.sessionRef || null,
        runIds: member.runIds ? [...member.runIds] : []
      };
      if (!lane.purpose) lane.purpose = purpose;
      lanesById.set(id, lane);
      addTeamLane(member.id, lane);
    }
  }
  const uniqueTeamLane = (actorId: string | null | undefined): ReaderRelationLane | null => {
    if (!actorId) return null;
    const values = teamLanesByActor.get(actorId) || [];
    return values.length === 1 ? values[0] : null;
  };
  const teamLaneForObservation = (observation: SessionProtocolV3["coordination"][number]): ReaderRelationLane | null => {
    const task = observation.taskId ? tasks.get(observation.taskId) : undefined;
    const taskLaneCandidates = task
      ? taskActors(task, actorsByIdentity).map(uniqueTeamLane).filter((lane): lane is ReaderRelationLane => Boolean(lane))
      : [];
    if (taskLaneCandidates.length === 1) return taskLaneCandidates[0];
    const run = observation.runId ? runs.get(observation.runId) : undefined;
    const runLaneCandidates = run
      ? protocol.actors.filter((actor) => (actor.runIds || []).includes(run.id)).map((actor) => uniqueTeamLane(actor.id)).filter((lane): lane is ReaderRelationLane => Boolean(lane))
      : [];
    if (runLaneCandidates.length === 1) return runLaneCandidates[0];
    // The sender owns a recorded message; a root-to-member request falls back
    // to its explicit member recipient.  Multiple memberships stay unassigned.
    return uniqueTeamLane(observation.senderActorId) || uniqueTeamLane(observation.recipientActorId);
  };
  const currentSessionActorIds = new Set(protocol.actors
    .filter((actor) => actor.sessionRef && sameSession(actor.sessionRef, owner))
    .map((actor) => actor.id));

  const events = protocol.events.filter((event) => event.sessionId === owner.sessionId)
    .sort((left, right) => left.sequence - right.sequence);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const positions = sourcePositions(events, resolve);
  const milestones: ReaderRelationMilestone[] = [];
  const unplaced: ReaderRelationUnplaced[] = [];
  protocol.coordination.forEach((observation, index) => {
    const card = assignment.byObservation[index];
    const lane = card ? laneByCard.get(card.key) : teamLaneForObservation(observation) || undefined;
    const explicitSource = observation.sourceEventRef;
    const sourceEventRef = explicitSource && sameSession(explicitSource.session, owner)
      ? explicitSource
      : observation.eventId
        ? { session: owner, eventId: observation.eventId }
        : explicitSource || null;
    const localSource = sourceEventRef && sameSession(sourceEventRef.session, owner);
    const event = localSource ? eventsById.get(sourceEventRef.eventId) : undefined;
    const position = event ? positions.get(event.id) : undefined;
    const senderIsCurrentSession = Boolean(observation.senderActorId && currentSessionActorIds.has(observation.senderActorId));
    const recipientIsCurrentSession = Boolean(observation.recipientActorId && currentSessionActorIds.has(observation.recipientActorId));
    const peerMessage = !senderIsCurrentSession && !recipientIsCurrentSession
      && isTeamPeerMessage(observation.kind, observation.senderActorId, observation.recipientActorId, memberships);
    const messageAction: ReaderRelationMilestone["messageAction"] = peerMessage ? "handoff"
      : observation.kind === "mailbox-delivery" && recipientIsCurrentSession ? "received-message"
      : observation.kind === "message" ? (senderIsCurrentSession ? "follow-up" : "message") : null;
    const fields = {
      id: observation.id,
      kind: observation.kind,
      eventId: sourceEventRef?.eventId || null,
      sequence: event?.sequence ?? null,
      timestamp: event ? event.timestamp : observation.timestamp,
      runId: card?.runId ?? observation.runId ?? null,
      state: observation.state || "unknown",
      turnId: observation.turnId ?? null,
      senderActorId: observation.senderActorId ?? null,
      senderName: actorLabel(observation.senderActorId ? actors.get(observation.senderActorId) : undefined),
      recipientActorId: observation.recipientActorId ?? null,
      recipientName: actorLabel(observation.recipientActorId ? actors.get(observation.recipientActorId) : undefined),
      teamPeerMessage: peerMessage,
      senderIsCurrentSession,
      recipientIsCurrentSession,
      messageAction,
      sourceEventRef
    };
    if (!lane || !localSource || !event || !position) {
      unplaced.push({
        ...fields,
        laneId: lane?.id || null,
        reason: !lane ? "unassigned" : sourceEventRef && !localSource ? "external_source" : !event ? "source_missing" : "position_missing"
      });
      return;
    }
    milestones.push({
      ...fields,
      laneId: lane.id,
      eventId: event.id,
      sequence: event.sequence,
      sourceEventRef,
      position
    });
  });
  milestones.sort((left, right) => left.sequence - right.sequence);
  const firstSequenceByLane = new Map<string, number>();
  for (const milestone of milestones) {
    if (!firstSequenceByLane.has(milestone.laneId)) firstSequenceByLane.set(milestone.laneId, milestone.sequence);
  }
  const lanes = [...lanesById.values()].sort((left, right) => (
    (firstSequenceByLane.get(left.id) ?? Infinity) - (firstSequenceByLane.get(right.id) ?? Infinity)
  ));
  return { lanes, milestones, unplaced, memberRails: deriveReaderMemberRails(protocol, milestones) };
}
