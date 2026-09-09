import type { RawSession } from "../interface.js";
import {
  capabilityDescriptor, compactionEnvelope, compactionSummaryArtifact, contextCompactionEvent,
  finalizeSessionProtocol, protocolRevision, sessionEvent, sessionRelationship, sequenceEventsBySource,
  type EventProvenance, type SessionBranch, type SessionEventEnvelope, type SessionProtocol
} from "../shared/session-protocol.js";
import {
  actor, contextTransformation, contextVersion, coordinationObservation, goal,
  protocolCoverage, protocolDomainCoverage, usageRecord,
  type Actor, type CoordinationObservation, type Goal, type SessionProtocolV3, type UsageRecord
} from "../shared/session-protocol-v3.js";
import { agentRun } from "../shared/session-protocol.js";
import { activeOpenClawRecords, type OpenClawRecord } from "./parser.js";

export interface OpenClawActorFact { type: "human" | "agent" | "system"; id: string | null; label: string | null; }
export interface OpenClawGoalFact { id: string; objective: string; status: string | null; createdAt: number | null; updatedAt: number | null; tokenBudget: number | null; }
/** Fields normalized once by sqlite-store.ts from session_nodes.entry_json. */
export interface OpenClawSqliteSessionFacts {
  agentId: string; goal: OpenClawGoalFact | null; createdActor: OpenClawActorFact | null;
  owner: { actor: OpenClawActorFact | null; assignedBy: OpenClawActorFact | null; assignedAt: number | null } | null;
  createdVia: string | null; spawnDepth: number | null; subagentRole: "orchestrator" | "leaf" | null;
  startedAt: number | null; endedAt: number | null; runtimeMs: number | null; status: string | null; lastRunError: string | null;
  swarmGroupId: string | null; swarmCollector: boolean | null; completionOwnerSessionKey: string | null;
  usageFamilyKey: string | null; usageFamilySessionIds: string[]; windowReason: string | null;
}
export interface OpenClawProtocolChild { session: RawSession; records: OpenClawRecord[]; facts?: OpenClawSqliteSessionFacts; }
export interface OpenClawSessionProtocolInput { session: RawSession; records: OpenClawRecord[]; children: OpenClawProtocolChild[]; agentId?: string | null; facts?: OpenClawSqliteSessionFacts | null; }

export const openClawProtocolCapabilities = {
  sessionEvents: capabilityDescriptor("full", "recorded", "All non-header provider records are canonical events"),
  sessionRelationships: capabilityDescriptor("full", "recorded", "session_nodes lineage columns and in-file parentId"),
  tasks: capabilityDescriptor("none", "derived", "OpenClaw core task tables are intentionally deferred"),
  agentRuns: capabilityDescriptor("none", "derived", "Native runs are additive v3 facts; v2 keeps this domain empty"),
  contextArtifacts: capabilityDescriptor("full", "recorded", "Compaction and branch-summary records carry metadata-only artifacts"),
  branches: capabilityDescriptor("full", "recorded", "In-file/in-window parentId branch topology")
};
export interface OpenClawSqliteLineageFacts { forkedFromSessionKey?: string | null; facts?: OpenClawSqliteSessionFacts | null; }

function eventTime(record: OpenClawRecord): number | null {
  const value = record.message?.timestamp ?? record.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || "")); return Number.isFinite(parsed) ? parsed : null;
}
function recordId(record: OpenClawRecord): string | null { return typeof record.id === "string" && record.id ? record.id : null; }
function canonicalRecords(records: OpenClawRecord[]) { return records.filter((record) => record.type !== "session" && recordId(record)); }
function summaryOf(record: OpenClawRecord): string | null {
  return (record.type === "compaction" || record.type === "branch_summary") && typeof record.summary === "string" && record.summary.trim() ? record.summary : null;
}
function eventKind(record: OpenClawRecord): string {
  const message = record.message || {};
  if (record.type === "message") {
    if (message.role === "user") return "message.user";
    if (message.role === "assistant") return "message.assistant";
    if (message.role === "toolResult") return message.isError ? "tool.failed" : "tool.completed";
  }
  if (record.type === "toolCall" || record.type === "tool_call") return "tool.called";
  if (record.type === "compaction" || record.type === "branch_summary") return "context.compaction";
  return `control.${String(record.type || "record")}`;
}

function buildCanonicalEvents(sessionId: string, records: OpenClawRecord[], sourcePrefix: string, sessionTimestamp: number | null): SessionEventEnvelope[] {
  const source = canonicalRecords(records), ids = new Set(source.map((record) => recordId(record)!));
  const events: SessionEventEnvelope[] = [sessionEvent({
    id: `session.started:${sessionId}`, sessionId, timestamp: sessionTimestamp, kind: "session.started", phase: "started",
    provenance: { fidelity: "recorded", sourceType: sourcePrefix === "openclaw" ? "openclaw.session" : "openclaw.sqlite.session_nodes", sourceId: sessionId }
  })];
  for (const record of source) {
    const id = recordId(record)!;
    const parentEventId = typeof record.parentId === "string" && ids.has(record.parentId) ? `record:${record.parentId}` : null;
    const kind = eventKind(record);
    const provenance: EventProvenance = { fidelity: "recorded", sourceType: `${sourcePrefix}.${String(record.type || "record")}`, sourceId: id };
    if (kind === "context.compaction") {
      const summary = summaryOf(record);
      events.push(compactionEnvelope({
        id: `record:${id}`, sessionId, timestamp: eventTime(record), parentEventId, correlationId: id, provenance,
        providerData: { recordType: String(record.type), retainedFromEntryId: typeof record.firstKeptEntryId === "string" && ids.has(record.firstKeptEntryId) ? record.firstKeptEntryId : typeof record.fromId === "string" && ids.has(record.fromId) ? record.fromId : null }
      }, contextCompactionEvent({
        trigger: "unknown", strategy: summary ? "summary" : "opaque", summary,
        tokensBefore: typeof record.tokensBefore === "number" ? record.tokensBefore : null,
        retainedFromEventId: typeof record.firstKeptEntryId === "string" && ids.has(record.firstKeptEntryId) ? `record:${record.firstKeptEntryId}` : typeof record.fromId === "string" && ids.has(record.fromId) ? `record:${record.fromId}` : null
      })));
      continue;
    }
    const message = record.message || {};
    events.push(sessionEvent({ id: `record:${id}`, sessionId, timestamp: eventTime(record), kind,
      phase: kind.endsWith("called") ? "started" : kind.endsWith("failed") ? "failed" : "updated", turnId: message.role ? id : null,
      parentEventId, provenance, providerData: { parentId: record.parentId || null, role: message.role || null } }));
  }
  return sequenceEventsBySource(events);
}

function ancestorPath(id: string, parentById: Map<string, string | null>): string[] {
  const result: string[] = [], seen = new Set<string>(); let current: string | null = id;
  while (current && !seen.has(current)) { result.unshift(current); seen.add(current); current = parentById.get(current) || null; }
  return result;
}
function branchProjection(records: OpenClawRecord[], active: OpenClawRecord[]): SessionBranch[] {
  const source = canonicalRecords(records); if (!source.length) return [];
  const ids = new Set(source.map((record) => recordId(record)!));
  const parentById = new Map(source.map((record) => [recordId(record)!, typeof record.parentId === "string" && ids.has(record.parentId) ? record.parentId : null]));
  const parents = new Set<string>(); for (const parent of parentById.values()) if (parent) parents.add(parent);
  const leaves = source.filter((record) => !parents.has(recordId(record)!));
  const common = leaves.length > 1 ? ancestorPath(recordId(leaves[0])!, parentById).filter((candidate) => leaves.every((leaf) => ancestorPath(recordId(leaf)!, parentById).includes(candidate))) : [];
  const fork = common.at(-1) || null, activeHead = recordId(active.at(-1) || {});
  return leaves.map((head) => ({ id: `branch:${recordId(head)}`, parentBranchId: null, forkEventId: fork ? `record:${fork}` : null,
    headEventId: `record:${recordId(head)}`, selected: recordId(head) === activeHead,
    provenance: { fidelity: "recorded", sourceType: "openclaw.record.parentId", sourceId: recordId(head) } }));
}
function artifactsFor(sessionId: string, records: OpenClawRecord[]) {
  return canonicalRecords(records).flatMap((record) => {
    const id = recordId(record), summary = summaryOf(record); if (!id || !summary) return [];
    return [compactionSummaryArtifact({ id: `artifact:${id}`, sessionId, sourceSessionIds: [sessionId],
      provenance: { fidelity: "recorded", sourceType: `openclaw.${String(record.type)}`, sourceId: id }, timeCreated: eventTime(record),
      metadata: { recordType: String(record.type), retainedFromEntryId: typeof record.firstKeptEntryId === "string" ? record.firstKeptEntryId : typeof record.fromId === "string" ? record.fromId : null,
        tokensBefore: typeof record.tokensBefore === "number" ? record.tokensBefore : null } })];
  });
}

function baseProtocol(session: RawSession, records: OpenClawRecord[], children: OpenClawProtocolChild[], revision: string | number, sourcePrefix: string, facts: OpenClawSqliteLineageFacts = {}): SessionProtocol {
  const sessionId = String(session.id), active = activeOpenClawRecords(records), relationships: ReturnType<typeof sessionRelationship>[] = [];
  if (sourcePrefix === "openclaw") {
    for (const child of children) {
      const childId = String(child.session.id);
      if (childId === sessionId || String(child.session.parentId || "") !== sessionId) continue;
      relationships.push(sessionRelationship({ type: "spawned", fromSessionId: sessionId, toSessionId: childId,
        timestamp: child.session.timeCreated || null,
        provenance: { fidelity: "recorded", sourceType: "openclaw.registry.spawnedBy", sourceId: childId } }));
    }
    if (session.parentId && String(session.parentId) !== sessionId) relationships.push(sessionRelationship({
      type: "parent", fromSessionId: sessionId, toSessionId: String(session.parentId), timestamp: session.timeCreated || null,
      provenance: { fidelity: "recorded", sourceType: "openclaw.registry.spawnedBy", sourceId: sessionId }
    }));
  } else {
  const parentOf = (value: RawSession) => typeof value.metadata?.parentSessionKey === "string" && value.metadata.parentSessionKey ? value.metadata.parentSessionKey : null;
  const spawnedBy = (value: RawSession) => typeof value.metadata?.spawnedBy === "string" && value.metadata.spawnedBy ? value.metadata.spawnedBy : null;
  for (const child of children) {
    const childId = String(child.session.id); if (childId === sessionId) continue;
    const parent = parentOf(child.session), spawned = spawnedBy(child.session);
    if (parent === sessionId && spawned === sessionId) relationships.push(sessionRelationship({ type: "parent", fromSessionId: childId, toSessionId: sessionId, timestamp: child.session.timeCreated || null, provenance: { fidelity: "recorded", sourceType: `${sourcePrefix}.session_nodes.parent_session_key`, sourceId: childId } }));
    else {
      if (parent === sessionId) relationships.push(sessionRelationship({ type: "parent", fromSessionId: childId, toSessionId: sessionId, timestamp: child.session.timeCreated || null, provenance: { fidelity: "recorded", sourceType: `${sourcePrefix}.session_nodes.parent_session_key`, sourceId: childId } }));
      if (spawned === sessionId) relationships.push(sessionRelationship({ type: "spawned", fromSessionId: sessionId, toSessionId: childId, timestamp: child.session.timeCreated || null, provenance: { fidelity: "recorded", sourceType: `${sourcePrefix}.session_nodes.spawned_by`, sourceId: childId } }));
    }
  }
  const ownParent = parentOf(session), ownSpawned = spawnedBy(session);
  if (ownParent && ownParent !== sessionId) relationships.push(sessionRelationship({ type: "parent", fromSessionId: sessionId, toSessionId: ownParent, timestamp: session.timeCreated || null, provenance: { fidelity: "recorded", sourceType: `${sourcePrefix}.session_nodes.parent_session_key`, sourceId: sessionId } }));
  if (ownSpawned && ownSpawned !== sessionId && ownSpawned !== ownParent) relationships.push(sessionRelationship({ type: "spawned", fromSessionId: ownSpawned, toSessionId: sessionId, timestamp: session.timeCreated || null, provenance: { fidelity: "recorded", sourceType: `${sourcePrefix}.session_nodes.spawned_by`, sourceId: sessionId } }));
  if (facts.forkedFromSessionKey && facts.forkedFromSessionKey !== sessionId) relationships.push(sessionRelationship({ type: "forked", fromSessionId: facts.forkedFromSessionKey, toSessionId: sessionId, timestamp: session.timeCreated || null, provenance: { fidelity: "recorded", sourceType: `${sourcePrefix}.fork_source`, sourceId: sessionId } }));
  }
  const eventSourcePrefix = sourcePrefix === "openclaw.sqlite"
    ? "openclaw.sqlite.transcript_events"
    : sourcePrefix;
  return finalizeSessionProtocol({ sessionId, events: buildCanonicalEvents(sessionId, records, eventSourcePrefix, session.timeCreated || null), relationships, tasks: [], agentRuns: [], contextArtifacts: artifactsFor(sessionId, records), branches: branchProjection(records, active) },
    { provider: "openclaw", session, capabilities: openClawProtocolCapabilities, revision: protocolRevision(revision) });
}
export function buildOpenClawSqliteSessionProtocol(session: RawSession, records: OpenClawRecord[], children: OpenClawProtocolChild[], revision: string | number, facts: OpenClawSqliteLineageFacts = {}): SessionProtocol { return baseProtocol(session, records, children, revision, "openclaw.sqlite", facts); }
export function buildOpenClawSessionProtocol(session: RawSession, records: OpenClawRecord[], children: OpenClawProtocolChild[], revision: string | number): SessionProtocol { return baseProtocol(session, records, children, revision, "openclaw", {}); }

function statusFor(value: string | null): "queued" | "running" | "completed" | "failed" | "cancelled" | null {
  switch (String(value || "").toLowerCase()) {
    case "queued": return "queued";
    case "running": return "running";
    case "done": return "completed";
    case "failed": return "failed";
    case "timeout": return "failed";
    case "killed": return "cancelled";
    default: return null;
  }
}
function rawGoalStatus(value: string | null): "active" | "paused" | "blocked" | "completed" | "unknown" { switch (value) { case "active": return "active"; case "paused": return "paused"; case "blocked": case "usage_limited": case "budget_limited": return "blocked"; case "complete": return "completed"; default: return "unknown"; } }
function actorId(fact: OpenClawActorFact, prefix: string): string {
  return fact.id ? `actor:openclaw:${fact.type}:${fact.id}` : `actor:openclaw:${prefix}:${fact.type}:anonymous`;
}

function buildNativeV3(input: OpenClawSessionProtocolInput, base: SessionProtocol, facts: OpenClawSqliteSessionFacts | null): SessionProtocolV3 {
  const sessionId = String(input.session.id), ownRef = { provider: "openclaw", sessionId }, actors: Actor[] = [], addActor = (value: Actor) => { if (!actors.some((candidate) => candidate.id === value.id)) actors.push(value); };
  const agentId = facts?.agentId || input.agentId || (typeof input.session.metadata?.agentId === "string" ? input.session.metadata.agentId : null);
  if (agentId) addActor(actor({ id: `actor:openclaw:agent:${agentId}`, kind: "agent", name: agentId, providerActorId: agentId, sessionRef: ownRef, provenance: { fidelity: "recorded", sourceType: "openclaw.agent-directory", sourceId: agentId } }));
  for (const [value, source] of [[facts?.createdActor || null, "createdActor"], [facts?.owner?.actor || null, "owner"], [facts?.owner?.assignedBy || null, "owner.assignedBy"]] as Array<[OpenClawActorFact | null, string]>) {
    if (!value) continue; addActor(actor({ id: actorId(value, source), kind: value.type, name: value.label || value.id, providerActorId: value.id, provenance: { fidelity: "recorded", sourceType: `openclaw.session.entry_json.${source}`, sourceId: value.id } }));
  }
  const goals: Goal[] = [];
  if (facts?.goal) { const status = rawGoalStatus(facts.goal.status), rawStatus = facts.goal.status || "missing"; goals.push(goal({ id: `goal:${facts.goal.id}`, sessionId, title: null, description: facts.goal.objective, status, taskIds: [], timeCreated: facts.goal.createdAt, timeUpdated: facts.goal.updatedAt, timeCompleted: status === "completed" ? facts.goal.updatedAt : null, provenance: { fidelity: "recorded", sourceType: `openclaw.session_nodes.entry_json.goal.status:${rawStatus.slice(0, 64)}`, sourceId: facts.goal.id } })); }
  const runs = [], coordination: CoordinationObservation[] = [];
  for (const child of input.children || []) {
    const childId = String(child.session.id), childFacts = child.facts; if (childId === sessionId || !childFacts) continue;
    const spawnEvidence = childFacts.createdVia === "spawn" || (childFacts.spawnDepth !== null && childFacts.spawnDepth > 0); if (!spawnEvidence) continue;
    const status = statusFor(childFacts.status), mode = childFacts.swarmGroupId || childFacts.swarmCollector === true ? "team" : "subagent", runId = status ? `run:openclaw:${childId}` : null;
    if (status && runId) runs.push(agentRun({ id: runId, sessionId, taskId: null, status, mode, agent: typeof child.session.metadata?.agentId === "string" ? child.session.metadata.agentId : null, model: typeof child.session.metadata?.model === "string" ? child.session.metadata.model : null, childSessionId: childId, childSessionAvailable: true, timeStart: childFacts.startedAt, timeEnd: childFacts.endedAt, failureReason: childFacts.lastRunError, provenance: { fidelity: "recorded", sourceType: "openclaw.session_nodes.entry_json.spawn", sourceId: childId }, metadata: { spawnDepth: childFacts.spawnDepth, subagentRole: childFacts.subagentRole, swarmGroupId: childFacts.swarmGroupId, swarmCollector: childFacts.swarmCollector, completionOwnerSessionKey: childFacts.completionOwnerSessionKey, runtimeMs: childFacts.runtimeMs } }));
    const relation = base.relationships.find((candidate) => candidate.type === "spawned" && candidate.toSessionId === childId && candidate.fromSessionId === sessionId);
    coordination.push(coordinationObservation({ id: `coord:openclaw:spawn:${childId}`, sessionId, kind: "spawn", state: "started", fromSessionRef: ownRef, toSessionRef: { provider: "openclaw", sessionId: childId }, relationshipType: relation ? "spawned" : null, runId, eventId: relation?.triggerEventId || null, correlationId: childId, timestamp: childFacts.startedAt ?? child.session.timeCreated ?? null, provenance: { fidelity: "recorded", sourceType: "openclaw.session_nodes.entry_json.spawn", sourceId: childId } }));
  }
  const activeIds = new Set(activeOpenClawRecords(input.records).map((record) => recordId(record)).filter((id): id is string => Boolean(id))), eventBySource = new Map(base.events.map((event) => [event.provenance.sourceId, event])), usageRecords: UsageRecord[] = [], byIdentity = new Map<string, number>(), activeByIdentity = new Map<string, boolean>();
  for (const record of canonicalRecords(input.records)) {
    if (record.type !== "message" || record.message?.role !== "assistant" || !record.message?.usage) continue;
    const usage = record.message.usage as Record<string, unknown>, number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const inputTokens = number(usage.input), cacheRead = number(usage.cacheRead), cacheWrite = number(usage.cacheWrite), rawOutput = number(usage.output), reasoning = Math.min(rawOutput, number(usage.reasoningTokens)), output = rawOutput - reasoning;
    if (inputTokens === 0 && cacheRead === 0 && cacheWrite === 0 && rawOutput === 0 && reasoning === 0) continue;
    const sum = inputTokens + cacheRead + cacheWrite + output + reasoning, hasTotal = Object.prototype.hasOwnProperty.call(usage, "totalTokens"), explicitTotal = number(usage.totalTokens), id = recordId(record)!;
    const total = hasTotal ? (explicitTotal === sum ? explicitTotal : null) : sum, responseId = typeof record.message.responseId === "string" && record.message.responseId ? record.message.responseId : null, identity = responseId ? `response:${responseId}` : `entry:${id}`, event = eventBySource.get(id);
    const candidate = usageRecord({ id: `usage:${sessionId}:request:${identity}`, scope: "request", sessionRef: ownRef, timestamp: eventTime(record), model: typeof record.message.responseModel === "string" && record.message.responseModel ? record.message.responseModel : typeof record.message.model === "string" ? record.message.model : null, runId: null, eventId: event?.id || null, turnId: event?.turnId || null, tokens: { input: inputTokens, cacheRead, cacheWrite, output, reasoning, total }, contextOriginSlices: [], provenance: { fidelity: "recorded", sourceType: "openclaw.transcript.message.assistant.usage", sourceId: id } });
    const candidateActive = activeIds.has(id), existing = byIdentity.get(identity);
    if (existing === undefined) { byIdentity.set(identity, usageRecords.length); activeByIdentity.set(identity, candidateActive); usageRecords.push(candidate); }
    else if (candidateActive && !activeByIdentity.get(identity)) { usageRecords[existing] = candidate; activeByIdentity.set(identity, true); }
  }
  const activeOps = activeOpenClawRecords(input.records).filter((record) => (record.type === "compaction" || record.type === "branch_summary") && summaryOf(record)), artifactBySource = new Map(base.contextArtifacts.map((artifact) => [artifact.provenance.sourceId, artifact])), contextVersions = [], contextTransformations = [];
  for (const record of activeOps) { const sourceId = recordId(record)!; const artifact = artifactBySource.get(sourceId), event = eventBySource.get(sourceId); if (!artifact || !event) continue; const versionId = `context-version:openclaw:${sourceId}`; contextVersions.push(contextVersion({ id: versionId, sessionId, sequence: event.sequence, parentVersionIds: [], artifactIds: [artifact.id], createdAt: eventTime(record), provenance: { fidelity: "recorded", sourceType: `openclaw.${record.type}`, sourceId } })); contextTransformations.push(contextTransformation({ id: `context-transformation:openclaw:${sourceId}`, sessionId, kind: "compaction", sourceVersionIds: [], resultVersionId: versionId, sourceArtifactIds: [], resultArtifactIds: [artifact.id], eventId: event.id, timestamp: eventTime(record), provenance: { fidelity: "recorded", sourceType: `openclaw.${record.type}`, sourceId } })); }
  const hasOperation = input.records.some((record) => record.type === "compaction" || record.type === "branch_summary" || record.type === "reset") || facts?.windowReason === "compaction", contextState = contextVersions.length ? "observed" : hasOperation ? "unknown" : "not-observed";
  return { sessionId, version: 3, session: base.session, events: base.events, relationships: base.relationships, tasks: base.tasks, agentRuns: runs, contextArtifacts: base.contextArtifacts, branches: base.branches, revision: base.revision, goals, actors, coordination, contextVersions, contextTransformations, usageRecords, coverage: protocolCoverage({ work: protocolDomainCoverage(goals.length ? "observed" : "not-observed", goals.length ? "recorded OpenClaw SessionGoal" : "no recorded OpenClaw SessionGoal"), execution: protocolDomainCoverage(actors.length || runs.length ? "observed" : "not-observed", actors.length || runs.length ? "recorded agent-directory identities and spawn runs" : "no recorded agent identity or spawn run"), coordination: protocolDomainCoverage(coordination.length ? "observed" : "not-observed", coordination.length ? "recorded spawn relationships" : "no explicit spawn evidence"), context: protocolDomainCoverage(contextState, contextState === "observed" ? "active readable OpenClaw compaction summary" : hasOperation ? "operation exists without an active readable summary" : "no OpenClaw context operation evidence"), usage: protocolDomainCoverage(usageRecords.length ? "observed" : "not-observed", usageRecords.length ? "one request record per distinct assistant response" : "no assistant request usage evidence") }) };
}
export function buildOpenClawSqliteSessionProtocolV3(input: OpenClawSessionProtocolInput, base: SessionProtocol, facts: OpenClawSqliteSessionFacts | null = input.facts || null): SessionProtocolV3 { return buildNativeV3(input, base, facts); }
export function buildOpenClawSessionProtocolV3(input: OpenClawSessionProtocolInput, base: SessionProtocol): SessionProtocolV3 { return buildNativeV3(input, base, null); }
