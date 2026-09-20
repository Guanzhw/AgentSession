import { createHash } from "node:crypto";
import { t } from "./i18n.js";
import type { Task, TaskStatus } from "./providers/shared/session-protocol.js";
import type { Actor, CoordinationObservation, SessionProtocolV3 } from "./providers/shared/session-protocol-v3.js";

export const READER_TEAM_DIRECTORY_SIZE = 8;
export const READER_TEAM_DIRECTORY_MAX_SIZE = 24;
export const READER_TEAM_EXCHANGE_SIZE = 50;
export const READER_TEAM_EXCHANGE_MAX_SIZE = 50;
export const READER_TEAM_TASK_SIZE = 12;
export const READER_TEAM_TASK_MAX_SIZE = 50;

export interface ReaderTeamMember {
  teamId: string;
  actorId: string;
  providerActorId: string | null;
  name: string;
  hasDescription: boolean;
  sessionRef: Actor["sessionRef"];
  assignmentCount: number;
  messageCount: number;
  responsibility: string | null;
}

export interface ReaderTeamCommunication {
  teamId: string;
  key: string;
  senderActorId: string;
  senderName: string;
  recipientActorId: string;
  recipientName: string;
  messageCount: number;
}

export type ReaderTeamDirectoryItem =
  | { kind: "member"; key: string; teamId: string; teamName: string; member: ReaderTeamMember }
  | { kind: "communication"; key: string; teamId: string; teamName: string; communication: ReaderTeamCommunication };

export interface ReaderTeamDirectoryPage {
  ok: true;
  provider: string;
  sessionId: string;
  query: string;
  size: number;
  offset: number;
  total: number;
  items: ReaderTeamDirectoryItem[];
  nextCursor: string | null;
}

export interface ReaderTeamExchange {
  observation: CoordinationObservation;
  senderName: string | null;
  recipientName: string | null;
  delivered: boolean;
  deliveredAt: number | null;
}

export interface ReaderTeamTaskPage {
  ok: true;
  provider: string;
  sessionId: string;
  selection: Extract<ReaderTeamDirectoryItem, { kind: "member" }>;
  tasks: ReaderTeamTaskSummary[];
  offset: number;
  total: number;
  size: number;
  nextCursor: string | null;
}

export interface ReaderTeamTaskSummary {
  id: string;
  title: string | null;
  status: TaskStatus;
  revision: number | null;
  hasDescription: boolean;
}

export interface ReaderTeamTaskContent {
  ok: true;
  task: Task;
  description: string;
  revision: string;
}

export interface ReaderTeamDetailPage {
  ok: true;
  provider: string;
  sessionId: string;
  selection: ReaderTeamDirectoryItem;
  tasks: ReaderTeamTaskSummary[];
  taskOffset: number;
  taskTotal: number;
  taskSize: number;
  taskNextCursor: string | null;
  exchanges: ReaderTeamExchange[];
  offset: number;
  total: number;
  size: number;
  nextCursor: string | null;
}

export type ReaderTeamsErrorCode = "invalid_input" | "selection_not_found" | "stale_cursor";
export interface ReaderTeamsError { ok: false; code: ReaderTeamsErrorCode; error: string }

interface Cursor {
  identity: Record<string, unknown>;
  lastKey: string;
  prefixHash: string;
  prefixCount: number;
}

interface ReaderTeamIndex {
  actors: Map<string, Actor>;
  directory: ReaderTeamDirectoryItem[];
  tasksByActor: Map<string, Task[]>;
  messagesByActor: Map<string, CoordinationObservation[]>;
  messagesByEdge: Map<string, CoordinationObservation[]>;
  deliveredAt: Map<string, number | null>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readableSummary(value: string | null, limit = 160): string | null {
  if (!value) return null;
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length <= limit ? flattened : `${flattened.slice(0, limit - 1).trimEnd()}…`;
}

function taskSummary(task: Task): ReaderTeamTaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    revision: task.revision ?? null,
    hasDescription: Boolean(optionalString(task.description))
  };
}

function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return decoded && typeof decoded === "object" ? decoded as Cursor : null;
  } catch {
    return null;
  }
}

function prefixSummary(values: string[]) {
  return {
    prefixHash: createHash("sha256").update(JSON.stringify(values), "utf8").digest("hex"),
    prefixCount: values.length
  };
}

function sameIdentity(left: Record<string, unknown>, right: Record<string, unknown>) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSession(protocol: SessionProtocolV3, provider: string, sessionId: string): boolean {
  const ref = protocol.session?.ref;
  return Boolean(provider && sessionId && protocol.sessionId === sessionId
    && (!ref || (ref.provider === provider && ref.sessionId === sessionId)));
}

function isCurrentSessionAgent(actor: Actor | undefined, protocol: SessionProtocolV3): boolean {
  const session = protocol.session?.ref;
  return Boolean(actor && !actor.name
    && actor.kind === "agent"
    && actor.sessionRef?.provider === session?.provider
    && actor.sessionRef?.sessionId === session?.sessionId);
}

function actorName(actor: Actor | undefined, protocol?: SessionProtocolV3): string {
  if (protocol && isCurrentSessionAgent(actor, protocol)) return t("detail.reader_team_session_agent");
  return actor?.name || actor?.providerActorId || actor?.id || "";
}

function teamName(team: Actor): string {
  return team.name || t("runtime.team");
}

function communicationKey(teamId: string, senderActorId: string, recipientActorId: string): string {
  return `communication:${teamId}:${senderActorId}:${recipientActorId}`;
}

function memberKey(teamId: string, actorId: string): string {
  return `member:${teamId}:${actorId}`;
}

function pushMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function actorIdentityIndex(actors: Actor[]): Map<string, Actor> {
  const index = new Map(actors.map((actor) => [actor.id, actor]));
  for (const actor of actors) {
    if (actor.providerActorId && !index.has(actor.providerActorId)) index.set(actor.providerActorId, actor);
  }
  return index;
}

/** Build one request-local index with one pass over tasks and coordination facts. */
function buildReaderTeamIndex(protocol: SessionProtocolV3): ReaderTeamIndex {
  const actors = new Map(protocol.actors.map((actor) => [actor.id, actor]));
  const actorByIdentity = actorIdentityIndex(protocol.actors);
  const teams = protocol.actors.filter((actor) => actor.kind === "team");
  const teamIdsByMember = new Map<string, string[]>();
  for (const team of teams) {
    for (const memberId of team.memberActorIds || []) pushMapValue(teamIdsByMember, memberId, team.id);
  }

  const tasksByActor = new Map<string, Task[]>();
  for (const task of protocol.tasks) {
    const owners = new Set([task.owner, task.assignee].filter((value): value is string => Boolean(value)));
    const actorIds = new Set([...owners].map((owner) => actorByIdentity.get(owner)?.id).filter((value): value is string => Boolean(value)));
    for (const actorId of actorIds) pushMapValue(tasksByActor, actorId, task);
  }

  const messagesByActor = new Map<string, CoordinationObservation[]>();
  const messagesByEdge = new Map<string, CoordinationObservation[]>();
  const deliveredAt = new Map<string, number | null>();
  for (const observation of protocol.coordination) {
    if (observation.kind === "mailbox-delivery" && observation.correlationId) {
      deliveredAt.set(observation.correlationId, observation.timestamp);
      continue;
    }
    if (observation.kind !== "message" || !observation.senderActorId || !observation.recipientActorId) continue;
    pushMapValue(messagesByActor, observation.senderActorId, observation);
    if (observation.recipientActorId !== observation.senderActorId) pushMapValue(messagesByActor, observation.recipientActorId, observation);
    const teamIds = new Set([
      ...(teamIdsByMember.get(observation.senderActorId) || []),
      ...(teamIdsByMember.get(observation.recipientActorId) || [])
    ]);
    for (const teamId of teamIds) pushMapValue(messagesByEdge, communicationKey(teamId, observation.senderActorId, observation.recipientActorId), observation);
  }

  const directory: ReaderTeamDirectoryItem[] = [];
  for (const team of teams) {
    const teamDisplayName = teamName(team);
    for (const memberId of team.memberActorIds || []) {
      const member = actors.get(memberId);
      if (!member) continue;
      const tasks = tasksByActor.get(member.id) || [];
      directory.push({
        kind: "member", key: memberKey(team.id, member.id), teamId: team.id, teamName: teamDisplayName,
        member: {
          teamId: team.id, actorId: member.id, providerActorId: optionalString(member.providerActorId),
          name: actorName(member, protocol), hasDescription: Boolean(optionalString(member.description)), sessionRef: member.sessionRef || null,
          assignmentCount: tasks.length, messageCount: (messagesByActor.get(member.id) || []).length,
          responsibility: readableSummary(optionalString(member.description)) || tasks.find((task) => task.title)?.title || null
        }
      });
    }
    for (const [key, messages] of messagesByEdge) {
      if (!key.startsWith(`communication:${team.id}:`) || !messages.length) continue;
      const first = messages[0];
      const sender = actors.get(first.senderActorId!);
      const recipient = actors.get(first.recipientActorId!);
      if (!sender || !recipient) continue;
      directory.push({
        kind: "communication", key, teamId: team.id, teamName: teamDisplayName,
        communication: {
          teamId: team.id, key,
          senderActorId: sender.id, senderName: actorName(sender, protocol),
          recipientActorId: recipient.id, recipientName: actorName(recipient, protocol),
          messageCount: messages.length
        }
      });
    }
  }
  return { actors, directory, tasksByActor, messagesByActor, messagesByEdge, deliveredAt };
}

/** Only explicit v3 team actors create Teams UI; session lineage is never upgraded into membership. */
export function readerTeamDirectory(protocol: SessionProtocolV3): ReaderTeamDirectoryItem[] {
  return buildReaderTeamIndex(protocol).directory;
}

/** Task facts fully owned by explicit Team members and rendered by the Teams Reader. */
export function readerTeamCoveredTaskIds(protocol: SessionProtocolV3): Set<string> {
  const actors = actorIdentityIndex(protocol.actors);
  const members = new Set(protocol.actors
    .filter((actor) => actor.kind === "team")
    .flatMap((team) => team.memberActorIds || []));
  const covered = new Set<string>();
  for (const task of protocol.tasks) {
    const owners = [task.owner, task.assignee].filter((value): value is string => Boolean(value));
    if (owners.some((owner) => {
      const actor = actors.get(owner);
      return Boolean(actor && members.has(actor.id));
    })) covered.add(task.id);
  }
  return covered;
}

/** Runs explicitly linked to Team member actors and already reachable from the Teams Reader. */
export function readerTeamCoveredRunIds(protocol: SessionProtocolV3): Set<string> {
  const actors = new Map(protocol.actors.map((actor) => [actor.id, actor]));
  const covered = new Set<string>();
  for (const team of protocol.actors) {
    if (team.kind !== "team") continue;
    for (const memberId of team.memberActorIds || []) {
      for (const runId of actors.get(memberId)?.runIds || []) covered.add(runId);
    }
  }
  return covered;
}

function cursorOffset<T>(values: T[], keyOf: (value: T) => string, identity: Record<string, unknown>, cursorValue: string | null | undefined): number | ReaderTeamsError {
  if (!cursorValue) return 0;
  const cursor = decodeCursor(cursorValue);
  if (!cursor || !sameIdentity(cursor.identity, identity)) return { ok: false, code: "stale_cursor", error: "The Reader team continuation is stale." };
  const index = values.findIndex((value) => keyOf(value) === cursor.lastKey);
  if (index < 0) return { ok: false, code: "stale_cursor", error: "The Reader team continuation is stale." };
  const prefix = prefixSummary(values.slice(0, index + 1).map(keyOf));
  return prefix.prefixHash === cursor.prefixHash && prefix.prefixCount === cursor.prefixCount
    ? index + 1
    : { ok: false, code: "stale_cursor", error: "The Reader team continuation is stale." };
}

function nextCursor<T>(values: T[], page: T[], nextOffset: number, keyOf: (value: T) => string, identity: Record<string, unknown>): string | null {
  if (nextOffset >= values.length || !page.length) return null;
  return encodeCursor({ identity, lastKey: keyOf(page.at(-1)!), ...prefixSummary(values.slice(0, nextOffset).map(keyOf)) });
}

export function deriveReaderTeamDirectoryPage(protocol: SessionProtocolV3, query: {
  provider: string; sessionId: string; query?: string | null; size?: number; cursor?: string | null;
}): ReaderTeamDirectoryPage | ReaderTeamsError {
  const size = query.size ?? READER_TEAM_DIRECTORY_SIZE;
  if (!validateSession(protocol, query.provider, query.sessionId)
    || !Number.isSafeInteger(size) || size < 1 || size > READER_TEAM_DIRECTORY_MAX_SIZE) {
    return { ok: false, code: "invalid_input", error: "Invalid Reader team directory request." };
  }
  const search = (query.query || "").trim().toLocaleLowerCase();
  const identity = { provider: query.provider, sessionId: query.sessionId, query: search, size };
  const index = buildReaderTeamIndex(protocol);
  const all = index.directory.filter((item) => {
    if (!search) return true;
    const value = item.kind === "member"
      ? [item.teamName, item.member.name, index.actors.get(item.member.actorId)?.description,
        ...(index.tasksByActor.get(item.member.actorId) || []).flatMap((task) => [task.title, task.description])
      ].filter(Boolean).join(" ")
      : [item.teamName, item.communication.senderName, item.communication.recipientName].join(" ");
    return value.toLocaleLowerCase().includes(search);
  });
  const offset = cursorOffset(all, (item) => item.key, identity, query.cursor);
  if (typeof offset !== "number") return offset;
  const items = all.slice(offset, offset + size);
  const end = offset + items.length;
  return { ok: true, provider: query.provider, sessionId: query.sessionId, query: search, size,
    offset, total: all.length, items, nextCursor: nextCursor(all, items, end, (item) => item.key, identity) };
}

function selectionFrom(index: ReaderTeamIndex, key: string | null): ReaderTeamDirectoryItem | null {
  return key ? index.directory.find((item) => item.key === key) || null : null;
}

function taskCursorKey(task: Task): string {
  return `${task.id}:${task.revision ?? ""}:${task.status}`;
}

function taskPage(index: ReaderTeamIndex, selection: ReaderTeamDirectoryItem, query: {
  provider: string; sessionId: string; size: number; cursor?: string | null;
}): ReaderTeamTaskPage | ReaderTeamsError {
  if (selection.kind !== "member") return { ok: false, code: "selection_not_found", error: "Task pages require a team member." };
  const tasks = index.tasksByActor.get(selection.member.actorId) || [];
  const identity = { provider: query.provider, sessionId: query.sessionId, key: selection.key, kind: "tasks", size: query.size };
  const offset = cursorOffset(tasks, taskCursorKey, identity, query.cursor);
  if (typeof offset !== "number") return offset;
  const selected = tasks.slice(offset, offset + query.size);
  const end = offset + selected.length;
  return { ok: true, provider: query.provider, sessionId: query.sessionId, selection,
    tasks: selected.map(taskSummary), offset, total: tasks.length, size: query.size,
    nextCursor: nextCursor(tasks, selected, end, taskCursorKey, identity) };
}

export function deriveReaderTeamTaskPage(protocol: SessionProtocolV3, query: {
  provider: string; sessionId: string; key: string | null; size?: number; cursor?: string | null;
}): ReaderTeamTaskPage | ReaderTeamsError {
  const size = query.size ?? READER_TEAM_TASK_SIZE;
  if (!validateSession(protocol, query.provider, query.sessionId) || !query.key
    || !Number.isSafeInteger(size) || size < 1 || size > READER_TEAM_TASK_MAX_SIZE) {
    return { ok: false, code: "invalid_input", error: "Invalid Reader team task request." };
  }
  const index = buildReaderTeamIndex(protocol);
  const selection = selectionFrom(index, query.key);
  return selection ? taskPage(index, selection, { ...query, size })
    : { ok: false, code: "selection_not_found", error: "The selected team member is unavailable." };
}

export function resolveReaderTeamTaskContent(protocol: SessionProtocolV3, query: {
  provider: string; sessionId: string; taskId: string | null;
}): ReaderTeamTaskContent | ReaderTeamsError {
  if (!validateSession(protocol, query.provider, query.sessionId) || !query.taskId) {
    return { ok: false, code: "invalid_input", error: "Invalid Reader team task content request." };
  }
  const index = buildReaderTeamIndex(protocol);
  const memberActorIds = new Set(index.directory
    .filter((item): item is Extract<ReaderTeamDirectoryItem, { kind: "member" }> => item.kind === "member")
    .map((item) => item.member.actorId));
  const task = [...memberActorIds]
    .flatMap((actorId) => index.tasksByActor.get(actorId) || [])
    .find((candidate) => candidate.id === query.taskId);
  const description = task ? optionalString(task.description) : null;
  if (!task || !description) {
    return { ok: false, code: "selection_not_found", error: "The selected team task description is unavailable." };
  }
  const revision = createHash("sha256")
    .update(JSON.stringify([task.id, task.revision ?? null, description]), "utf8")
    .digest("hex");
  return { ok: true, task, description, revision };
}

export function resolveReaderTeamMemberContent(protocol: SessionProtocolV3, query: {
  provider: string; sessionId: string; actorId: string | null;
}): Omit<ReaderTeamTaskContent, "task"> & { actor: Actor } | ReaderTeamsError {
  if (!validateSession(protocol, query.provider, query.sessionId) || !query.actorId) {
    return { ok: false, code: "invalid_input", error: "Invalid Reader team member content request." };
  }
  const index = buildReaderTeamIndex(protocol);
  const member = index.directory.find((item) => item.kind === "member" && item.member.actorId === query.actorId);
  const actor = member ? index.actors.get(query.actorId) : null;
  const description = actor ? optionalString(actor.description) : null;
  if (!actor || !description) {
    return { ok: false, code: "selection_not_found", error: "The selected team member description is unavailable." };
  }
  const revision = createHash("sha256")
    .update(JSON.stringify([actor.id, description]), "utf8")
    .digest("hex");
  return { ok: true, actor, description, revision };
}

export function deriveReaderTeamDetailPage(protocol: SessionProtocolV3, query: {
  provider: string; sessionId: string; key: string | null; size?: number; cursor?: string | null;
}): ReaderTeamDetailPage | ReaderTeamsError {
  const size = query.size ?? READER_TEAM_EXCHANGE_SIZE;
  if (!validateSession(protocol, query.provider, query.sessionId) || !query.key
    || !Number.isSafeInteger(size) || size < 1 || size > READER_TEAM_EXCHANGE_MAX_SIZE) {
    return { ok: false, code: "invalid_input", error: "Invalid Reader team detail request." };
  }
  const index = buildReaderTeamIndex(protocol);
  const selection = selectionFrom(index, query.key);
  if (!selection) return { ok: false, code: "selection_not_found", error: "The selected team member or relationship is unavailable." };
  const observations = selection.kind === "member"
    ? index.messagesByActor.get(selection.member.actorId) || []
    : index.messagesByEdge.get(selection.communication.key) || [];
  const identity = { provider: query.provider, sessionId: query.sessionId, key: selection.key, kind: "exchanges", size };
  const offset = cursorOffset(observations, (item) => item.id, identity, query.cursor);
  if (typeof offset !== "number") return offset;
  const page = observations.slice(offset, offset + size);
  const exchanges = page.map((observation) => ({
    observation,
    senderName: observation.senderActorId ? actorName(index.actors.get(observation.senderActorId), protocol) || null : null,
    recipientName: observation.recipientActorId ? actorName(index.actors.get(observation.recipientActorId), protocol) || null : null,
    delivered: Boolean(observation.correlationId && index.deliveredAt.has(observation.correlationId)),
    deliveredAt: observation.correlationId ? index.deliveredAt.get(observation.correlationId) ?? null : null
  }));
  const initialTasks = selection.kind === "member"
    ? taskPage(index, selection, { provider: query.provider, sessionId: query.sessionId, size: READER_TEAM_TASK_SIZE })
    : null;
  if (initialTasks && !initialTasks.ok) return initialTasks;
  const end = offset + page.length;
  return {
    ok: true, provider: query.provider, sessionId: query.sessionId, selection,
    tasks: initialTasks?.tasks || [], taskOffset: initialTasks?.offset || 0,
    taskTotal: initialTasks?.total || 0, taskSize: initialTasks?.size || READER_TEAM_TASK_SIZE,
    taskNextCursor: initialTasks?.nextCursor || null,
    exchanges, offset, total: observations.length, size,
    nextCursor: nextCursor(observations, page, end, (item) => item.id, identity)
  };
}

export function hasReaderTeams(protocol: SessionProtocolV3): boolean {
  return protocol.actors.some((actor) => actor.kind === "team" && (actor.memberActorIds || []).length > 0);
}
