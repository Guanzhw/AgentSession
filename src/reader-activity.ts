import { createHash } from "node:crypto";
import type { ReaderRelations } from "./reader-relations.js";
import type { SessionRef } from "./providers/shared/session-protocol.js";
import type { CoordinationKind } from "./providers/shared/session-protocol-v3.js";
import type { SessionTree } from "./providers/shared/session-tree.js";
import { anchorId } from "./views/anchors.js";

export const READER_ACTIVITY_WINDOW_MS = 10 * 60 * 1000;
export const READER_ACTIVITY_MAX_LANES = 20;
export const READER_ACTIVITY_MAX_POINTS = 100;

export interface ReaderActivityPoint {
  id: string;
  kind: CoordinationKind | "parent-text";
  timestamp: number;
  source: { provider: string; sessionId: string; eventId?: string; anchor?: string };
  excerpt?: string;
}

export interface ReaderActivityLane {
  id: string;
  name: string | null;
  childSession: SessionRef | null;
  /** Earliest/latest recorded key observations, not inferred execution duration. */
  span: { start: number; end: number } | null;
  points: ReaderActivityPoint[];
}

export interface ReaderActivityProjection {
  provider: string;
  sessionId: string;
  parentLaneId: string;
  windowMs: number;
  /** Aligned half-open interval [start, end); null when no time is recorded. */
  range: { start: number; end: number } | null;
  extent: { start: number; end: number } | null;
  lanes: ReaderActivityLane[];
  /** Source counts cover the complete owned input; missing categories can overlap. */
  coverage: {
    textParts: number;
    observations: number;
    ordinaryMessages: number;
    untimedTextParts: number;
    untimedObservations: number;
    unassignedObservations: number;
    missingSourceObservations: number;
    /** All canonical task lanes plus the parent lane when owned prose exists. */
    totalLanes: number;
    /** Timed lanes whose recorded span intersects this window, before paging. */
    windowLanes: number;
    windowPoints: number;
    returnedLanes: number;
    returnedPoints: number;
  };
  /** One position per window point, or per crossing lane with no window points. */
  offset: number;
  nextOffset: number | null;
  revision: string;
  anchor: { id: string; timestamp: number | null; state: "located" | "untimed" | "not-found" } | null;
}

export interface ReaderActivityInput {
  provider: string;
  sessionId: string;
  /** Root-owned tree only: child sessions and inherited context are never traversed. */
  tree: SessionTree | null;
  relations: ReaderRelations | null;
}

export interface ReaderActivityQuery {
  from?: number;
  anchor?: string;
  offset?: number;
  revision?: string;
}

export class ReaderActivityError extends Error {
  constructor(public code: "invalid_input" | "stale_page", message: string) {
    super(message);
  }
}

/** Parse the HTTP boundary once; callers inside the projection use typed values. */
export function parseReaderActivityQuery(params: URLSearchParams): ReaderActivityQuery {
  const numberParam = (name: string) => {
    const raw = params.get(name);
    if (raw === null) return undefined;
    if (!/^\d+$/.test(raw)) throw new ReaderActivityError("invalid_input", `Invalid activity ${name}.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new ReaderActivityError("invalid_input", `Invalid activity ${name}.`);
    return value;
  };
  const from = numberParam("from");
  const offset = numberParam("offset") ?? 0;
  const anchor = params.get("anchor") || undefined;
  const revision = params.get("revision") || undefined;
  if (from !== undefined && (anchor || from > 8640000000000000 - READER_ACTIVITY_WINDOW_MS)) {
    throw new ReaderActivityError("invalid_input", "Activity from and anchor must name one valid window.");
  }
  if (offset && (from === undefined || !revision)) {
    throw new ReaderActivityError("invalid_input", "Activity continuation requires its window and revision.");
  }
  return { from, anchor, offset, revision };
}

function extendSpan(lane: ReaderActivityLane, timestamp: number) {
  if (!lane.span) lane.span = { start: timestamp, end: timestamp };
  else {
    lane.span.start = Math.min(lane.span.start, timestamp);
    lane.span.end = Math.max(lane.span.end, timestamp);
  }
}

function hasTime(timestamp: number | null): timestamp is number {
  return timestamp !== null && timestamp > 0;
}

function missingSource(item: ReaderRelations["milestones"][number] | ReaderRelations["unplaced"][number]): boolean {
  return !item.sourceEventRef || ("reason" in item && item.reason === "source_missing");
}

function anchorPageOffset(lanes: ReaderActivityLane[], observationId: string): number {
  let position = 0;
  let pageOffset = 0;
  let pageLanes = 0;
  let pagePoints = 0;
  for (const lane of lanes) {
    const target = lane.points.findIndex((point) => point.kind !== "parent-text" && point.id === observationId);
    let index = 0;
    do {
      if (pageLanes === READER_ACTIVITY_MAX_LANES || pagePoints === READER_ACTIVITY_MAX_POINTS) {
        pageOffset = position;
        pageLanes = 0;
        pagePoints = 0;
      }
      const count = Math.min(lane.points.length - index, READER_ACTIVITY_MAX_POINTS - pagePoints);
      if (target >= index && target < index + count) return pageOffset;
      pageLanes += 1;
      pagePoints += count;
      position += Math.max(1, count);
      index += count;
    } while (index < lane.points.length);
  }
  return 0;
}

/** Full source coverage, bounded output: no Conversation card/channel limit is used. */
export function projectReaderActivity(input: ReaderActivityInput, query: ReaderActivityQuery = {}): ReaderActivityProjection {
  const { provider, sessionId, tree, relations } = input;
  const parentLaneId = `parent:${provider}:${sessionId}`;
  const parent: ReaderActivityLane = { id: parentLaneId, name: null, childSession: null, span: null, points: [] };
  const lanes = new Map<string, ReaderActivityLane>((relations?.lanes || []).map((lane) => [lane.id,
    { id: lane.id, name: lane.name, childSession: lane.childSession, span: null, points: [] }]));
  const coverage: ReaderActivityProjection["coverage"] = {
    textParts: 0, observations: 0, ordinaryMessages: 0, untimedTextParts: 0, untimedObservations: 0,
    unassignedObservations: 0, missingSourceObservations: 0,
    totalLanes: lanes.size, windowLanes: 0, windowPoints: 0, returnedLanes: 0, returnedPoints: 0
  };
  let firstTime = Infinity;
  let lastTime = -Infinity;
  const recordTime = (timestamp: number) => {
    firstTime = Math.min(firstTime, timestamp);
    lastTime = Math.max(lastTime, timestamp);
  };
  const textParts = (tree?.messages || []).flatMap((message) => {
    if (message.sessionId !== sessionId || (message.data.contentScope && message.data.contentScope !== "owned")) return [];
    return message.parts.filter((part) => part.sessionId === sessionId && part.type === "text"
      && Boolean(part.data.text) && (!part.data.contentScope || part.data.contentScope === "owned"));
  });
  for (const part of textParts) {
    coverage.textParts += 1;
    if (!(part.timeStart > 0)) coverage.untimedTextParts += 1;
    else {
      extendSpan(parent, part.timeStart);
      recordTime(part.timeStart);
    }
  }
  if (coverage.textParts) coverage.totalLanes += 1;
  const observations = [...(relations?.milestones || []), ...(relations?.unplaced || [])];
  let selectedAnchor: ReaderActivityProjection["anchor"] = query.anchor
    ? { id: query.anchor, timestamp: null, state: "not-found" } : null;
  for (const item of observations) {
    coverage.observations += 1;
    if (item.kind === "message") coverage.ordinaryMessages += 1;
    if (!hasTime(item.timestamp)) coverage.untimedObservations += 1;
    if (!item.laneId) coverage.unassignedObservations += 1;
    if (missingSource(item)) coverage.missingSourceObservations += 1;
    if (item.id === query.anchor) {
      selectedAnchor = { id: item.id, timestamp: hasTime(item.timestamp) ? item.timestamp : null,
        state: hasTime(item.timestamp) ? "located" : "untimed" };
    }
    if (item.kind === "message" || !hasTime(item.timestamp)) continue;
    recordTime(item.timestamp);
    if (item.laneId) extendSpan(lanes.get(item.laneId)!, item.timestamp);
  }

  const extent = firstTime === Infinity ? null : { start: firstTime, end: lastTime };
  const timestamp = query.from ?? selectedAnchor?.timestamp ?? extent?.end;
  const range = timestamp === undefined ? null : {
    start: Math.floor(timestamp / READER_ACTIVITY_WINDOW_MS) * READER_ACTIVITY_WINDOW_MS,
    end: (Math.floor(timestamp / READER_ACTIVITY_WINDOW_MS) + 1) * READER_ACTIVITY_WINDOW_MS
  };
  const inWindow = (time: number) => Boolean(range && time >= range.start && time < range.end);
  // Parent is always the first eligible lane, independent of recorded task names.
  const windowLanes = [parent, ...lanes.values()].filter((lane) => lane.span && range
    && lane.span.start < range.end && lane.span.end >= range.start);
  const visible = new Map(windowLanes.map((lane) => [lane.id, lane]));
  for (const part of textParts) {
    if (!hasTime(part.timeStart) || !inWindow(part.timeStart)) continue;
    visible.get(parentLaneId)!.points.push({ id: part.id, kind: "parent-text", timestamp: part.timeStart,
      source: { provider, sessionId, anchor: anchorId("part", part.id) },
      excerpt: String(part.data.text).trim().slice(0, 100).replace(/\s+/g, " ") });
  }
  const placedIds = new Set((relations?.milestones || []).map((item) => item.id));
  for (const item of observations) {
    if (item.kind === "message" || !hasTime(item.timestamp) || !inWindow(item.timestamp) || !item.laneId || missingSource(item)) continue;
    const source = item.sourceEventRef!;
    visible.get(item.laneId)!.points.push({ id: item.id, kind: item.kind, timestamp: item.timestamp,
      source: { provider: source.session.provider, sessionId: source.session.sessionId, eventId: source.eventId,
        ...(placedIds.has(item.id) ? { anchor: anchorId("milestone", item.id) } : {}) } });
  }
  for (const lane of windowLanes) lane.points.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  coverage.windowLanes = windowLanes.length;
  coverage.windowPoints = windowLanes.reduce((sum, lane) => sum + lane.points.length, 0);
  const revision = createHash("sha256").update(JSON.stringify({ provider, sessionId, range, lanes: windowLanes })).digest("hex");
  if (query.revision && query.revision !== revision) throw new ReaderActivityError("stale_page", "Recorded activity changed; reload this window.");

  // A clicked milestone must be present on the returned page, including when
  // earlier parent prose or task lanes exhaust the first page's bounds.
  const offset = query.anchor ? anchorPageOffset(windowLanes, query.anchor) : query.offset ?? 0;
  const result: ReaderActivityLane[] = [];
  let position = 0;
  let consumed = offset;
  let points = 0;
  let stopped = false;
  for (const lane of windowLanes) {
    const size = Math.max(1, lane.points.length);
    if (position + size <= offset) { position += size; continue; }
    if (result.length === READER_ACTIVITY_MAX_LANES || points === READER_ACTIVITY_MAX_POINTS) { stopped = true; break; }
    const start = Math.max(0, offset - position);
    const pagePoints = lane.points.slice(start, start + READER_ACTIVITY_MAX_POINTS - points);
    result.push({ ...lane, points: pagePoints });
    points += pagePoints.length;
    consumed = position + (lane.points.length ? start + pagePoints.length : 1);
    position += size;
    if (consumed < position) { stopped = true; break; }
  }
  if (offset > position && !stopped) throw new ReaderActivityError("invalid_input", "Activity offset exceeds this window.");
  coverage.returnedLanes = result.length;
  coverage.returnedPoints = points;
  return { provider, sessionId, parentLaneId, windowMs: READER_ACTIVITY_WINDOW_MS, range, extent,
    lanes: result, coverage, offset, nextOffset: stopped ? consumed : null, revision, anchor: selectedAnchor };
}
