import type { DailyTokenStat, LibrarySessionMetadata, OwnedReaderChildDescriptor, ProviderAdapter, RawSession } from "../interface.js";
import { getDb } from "../../db.js";
import { icons } from "../../icons.js";
import { buildAgentLoop } from "../shared/agent-loop.js";
import { buildMessageSessionTree, buildMessageSessionViewsFromTree } from "../shared/message-session.js";
import { isSubagentToolName } from "../shared/subagent-tools.js";
import { iterateNormalizedMessageSearch, searchNormalizedMessages } from "../shared/file-adapter-helpers.js";
import { capabilityDescriptor, compactionEnvelope, finalizeSessionProtocol, sessionEvent, sessionRelationship, type SessionRelationship } from "../shared/session-protocol.js";
import { decodeV2Record, normalizeV2Messages, v2Tokens, v2Total, type V2MessageRow } from "./v2-parser.js";
import { openCodeStorageRevision } from "./storage.js";

type Row = Record<string, any>;
const capabilities = {
  sessionEvents: capabilityDescriptor("partial", "derived", "v2 ordered message projection, tools and compaction; event log and pending inbox are not replayed"),
  sessionRelationships: capabilityDescriptor("partial", "recorded", "v2 parent and fork source IDs; copied fork context is separated from owned messages"),
  tasks: capabilityDescriptor("none", "derived"),
  agentRuns: capabilityDescriptor("none", "derived"),
  contextArtifacts: capabilityDescriptor("none", "derived"),
  branches: capabilityDescriptor("none", "derived")
};

export function createOpenCodeV2Adapter(dataPath: () => string): ProviderAdapter {
  const db = () => getDb(dataPath());
  const identity = (row: Row): LibrarySessionMetadata => ({
    id: row.id, provider: "opencode", parentId: row.parent_id || null,
    title: row.title || row.slug || null, directory: row.directory || null,
    timeCreated: row.time_created, timeUpdated: row.time_updated
  });
  const session = (row: Row): RawSession => ({
    ...identity(row), messageCount: row.message_count,
    tokenCount: row.tokens_input + row.tokens_output + row.tokens_reasoning + row.tokens_cache_read + row.tokens_cache_write,
    metadata: { schema: "v2", forkSessionId: row.fork_session_id, forkBoundary: row.fork_boundary,
      agent: row.agent, model: row.model, cost: row.cost, outcome: row.idle_outcome }
  });
  // projectFork copies settled rows under msg_<fork-event>_<source-seq> IDs,
  // preserves seq/timestamps, and resets session usage. These are inherited,
  // not new messages/usage belonging to the fork (v2.0.10 projector.ts).
  const owned = "(s.fork_session_id IS NULL OR substr(m.id, -length(CAST(m.seq AS TEXT))-1) != '_' || m.seq)";
  const select = `SELECT s.*, (SELECT COUNT(*) FROM session_message m WHERE m.session_id=s.id AND ${owned} AND m.type IN ('user','assistant')) AS message_count FROM session_v2 s`;
  const getSession = (id: string) => {
    const row = db().prepare(`${select} WHERE s.id=?`).get(id);
    return row ? session(row) : null;
  };
  const rows = (id: string) => (db().prepare(`
    SELECT m.* FROM session_message m JOIN session_v2 s ON s.id=m.session_id
    WHERE m.session_id=? AND ${owned} ORDER BY m.seq ASC
  `).all(id) as V2MessageRow[]).map(decodeV2Record);
  const list = () => db().prepare(`${select} WHERE s.time_archived IS NULL ORDER BY s.time_updated DESC, s.id`).all().map(session);
  const messages = (id: string) => normalizeV2Messages(rows(id));
  function* searchEntries() {
    for (const current of list()) yield { session: current, messages: messages(current.id) };
  }
  function protocol(id: string) {
    const current = getSession(id);
    if (!current) return null;
    const records = rows(id);
    const events = records.flatMap(row => {
      const provenance = { fidelity: "recorded" as const, sourceType: "opencode.session_message", sourceId: row.id };
      const fields = { id: `event:${row.id}`, sessionId: id, timestamp: row.time_created, messageId: row.id, provenance };
      if (row.type === "compaction") return [compactionEnvelope({ ...fields, phase: row.data.status === "running" ? "started" : row.data.status === "failed" ? "failed" : "completed" }, {
        trigger: row.data.reason === "manual" ? "manual" : row.data.reason === "auto" ? "automatic" : "unknown",
        strategy: "unknown", summary: row.data.status === "completed" ? row.data.summary || null : null
      })];
      const event = sessionEvent({ ...fields, kind: ["user", "assistant", "system"].includes(row.type) ? `message.${row.type}` : row.type === "idle" ? "session.idle" : `opencode.${row.type}` });
      if (row.type !== "assistant") return [event];
      return [event, ...row.data.content.flatMap((part: any, index: number) => part.type === "tool" ? [sessionEvent({
        ...fields, id: `event:${row.id}:tool:${index}`, kind: part.state.status === "error" ? "tool.failed" : part.state.status === "completed" ? "tool.completed" : "tool.called",
        correlationId: part.id, toolCallId: part.id, partId: `${row.id}:content:${index}:tool`, turnId: row.id, timestamp: part.time?.completed ?? part.time?.created ?? row.time_created
      })] : [])];
    });
    const relationships: SessionRelationship[] = [];
    const add = (type: SessionRelationship["type"], from: string, to: string) => relationships.push(sessionRelationship({ type, fromSessionId: from, toSessionId: to,
      provenance: { fidelity: "recorded", sourceType: "opencode.session_v2", sourceId: id } }));
    if (current.parentId) add("parent", id, current.parentId);
    if (typeof current.metadata?.forkSessionId === "string") add("forked", current.metadata.forkSessionId, id);
    for (const child of db().prepare("SELECT id FROM session_v2 WHERE parent_id=?").all(id)) add("spawned", id, child.id);
    return finalizeSessionProtocol({ sessionId: id, events, relationships, tasks: [], agentRuns: [], contextArtifacts: [], completeness: "partial" }, {
      provider: "opencode", session: current, capabilities, revision: openCodeStorageRevision(dataPath())
    });
  }
  function views(id: string) {
    const current = getSession(id);
    if (!current) return null;
    const normalized = messages(id);
    const loop = buildAgentLoop(normalized);
    return buildMessageSessionViewsFromTree(buildMessageSessionTree(current, normalized, loop), loop);
  }
  return {
    id: "opencode", name: "OpenCode", icon: icons.opencode,
    resumeCommand: { executable: "opencode", args: ["--session", "{sessionId}"] },
    capabilities: { localManagement: true, openCodeStatsStore: false }, protocolCapabilities: capabilities,
    detect: () => true, getDataPath: dataPath,
    async *scan() { yield* list(); },
    getLibrarySessions() { return db().prepare("SELECT * FROM session_v2 WHERE time_archived IS NULL ORDER BY time_updated DESC, id").all().map(identity); },
    getSearchIndexSources() {
      const revision = openCodeStorageRevision(dataPath());
      return db().prepare("SELECT id FROM session_v2 WHERE time_archived IS NULL ORDER BY id").all()
        .map((row: Row) => ({ sessionId: row.id, revision }));
    },
    getSession, getMessages: messages, getSessionProtocol: protocol,
    getOwnedReaderProjection(id) {
      const current = getSession(id);
      if (!current) return null;
      const records = rows(id);
      const rootTree = buildMessageSessionTree(current, normalizeV2Messages(records));
      const children = db().prepare("SELECT id, title, slug FROM session_v2 WHERE parent_id=? ORDER BY time_created, id").all(id) as Row[];
      const byId = new Map(children.map(child => [child.id, child]));
      const parts = new Set(rootTree.messages.flatMap(message => message.parts.map(part => part.id)));
      const anchors = new Map<string, string>();
      for (const row of records) {
        if (row.type !== "assistant") continue;
        row.data.content.forEach((part: any, index: number) => {
          if (part.type !== "tool" || !(isSubagentToolName(part.name) || part.name === "subagent")) return;
          const recordedId = part.state?.metadata?.sessionId;
          const outputId = recordedId === undefined
            ? (Array.isArray(part.state?.content) ? part.state.content : [])
              .filter((content: any) => content.type === "text" && typeof content.text === "string")
              .flatMap((content: any) => content.text.split(/\r?\n/))
              .map((line: string) => /^task_id:\s*(\S+)\s*$/.exec(line)?.[1])
              .find((value: string | undefined) => value && byId.has(value))
            : undefined;
          const childId = recordedId ?? outputId;
          const partId = `${row.id}:content:${index}:tool`;
          if (typeof childId === "string" && byId.has(childId) && parts.has(partId) && !anchors.has(childId)) {
            anchors.set(childId, partId);
          }
        });
      }
      const linked: OwnedReaderChildDescriptor[] = children.map(child => ({
        provider: "opencode", sessionId: child.id, title: child.title || child.slug || null,
        available: true, link: anchors.has(child.id) ? "explicit" : "inferred",
        parentPartId: anchors.get(child.id) || null, detached: !anchors.has(child.id)
      }));
      return { rootTree, children: linked };
    },
    getInheritedContext(id) {
      const current = getSession(id);
      if (typeof current?.metadata?.forkSessionId !== "string") return null;
      const inheritedMessages: ReturnType<typeof normalizeV2Messages> = [];
      // Node 22 may finalize a temporary StatementSync before its iterator finishes.
      const inheritedStatement = db().prepare(`SELECT m.* FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE s.id=? AND NOT ${owned} ORDER BY m.seq ASC`);
      for (const raw of inheritedStatement.iterate(id)) {
        inheritedMessages.push(...normalizeV2Messages([decodeV2Record(raw as V2MessageRow)]));
      }
      return { sourceSession: { provider: "opencode", sessionId: current.metadata.forkSessionId },
        messages: inheritedMessages, total: inheritedMessages.length, truncated: false };
    },
    getSessionTree(id) { return views(id)?.tree || null; },
    getSessionContainer(id) { return views(id)?.container || null; },
    getSessionMetrics(id) { return views(id)?.metrics || null; },
    getStatsRevision: () => openCodeStorageRevision(dataPath()),
    getTokenSessionCount(days = 30, fromDate, toDate) {
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const cutoff = today.getTime() - (Math.max(1, days) - 1) * 86400000;
      const start = fromDate ? Math.max(cutoff, Date.parse(`${fromDate}T00:00:00Z`)) : cutoff;
      const end = toDate ? Date.parse(`${toDate}T00:00:00Z`) + 86400000 : Number.MAX_SAFE_INTEGER;
      const row = db().prepare(`SELECT COUNT(DISTINCT m.session_id) AS count
        FROM session_message m JOIN session_v2 s ON s.id=m.session_id
        WHERE ${owned} AND m.type IN ('assistant','compaction')
          AND m.time_created >= ? AND m.time_created < ?
          AND json_type(m.data, '$.tokens') IS NOT NULL`).get(start, end);
      return Number(row.count);
    },
    getTokenStats(days = 30) {
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const cutoff = today.getTime() - (Math.max(1, days) - 1) * 86400000;
      const totals = new Map<string, DailyTokenStat>();
      const records = db().prepare(`SELECT m.* FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE ${owned} AND m.type IN ('assistant','compaction') AND m.time_created >= ? ORDER BY m.time_created`).all(cutoff) as V2MessageRow[];
      for (const raw of records) {
        const row = decodeV2Record(raw), tokens = v2Tokens(row.data.tokens);
        if (!tokens) continue;
        const day = new Date(row.time_created).toISOString().slice(0, 10);
        const stat = totals.get(day) || { day, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, messageCount: 0 };
        stat.inputTokens += tokens.input || 0; stat.outputTokens += tokens.output || 0; stat.reasoningTokens! += tokens.reasoning || 0;
        stat.cacheReadTokens! += tokens.cache?.read || 0; stat.cacheWriteTokens! += tokens.cache?.write || 0;
        stat.totalTokens += v2Total(tokens); stat.messageCount++; totals.set(day, stat);
      }
      return [...totals.values()];
    },
    searchMessages(query, limit = 20, offset = 0) {
      return searchNormalizedMessages(searchEntries(), query, limit, offset);
    },
    iterateSearchMessages(query) { return iterateNormalizedMessageSearch(searchEntries(), query); },
    exportSession(id) {
      const current = getSession(id);
      return current ? { session: current, messages: messages(id), sourceRecords: rows(id) } : null;
    }
  };
}
