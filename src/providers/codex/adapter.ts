import { existsSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import {
  parseSession,
  readCodexSessionSnapshot,
  type CodexSessionReadSnapshot,
  extractCodexSessionId,
  extractMeta,
  recordsToMessages,
  recordsToInheritedMessages,
  codexOwnedTokenUsageRecords,
  codexUsagePayload,
  codexUsageToTokens,
  resolveCodexInheritedContext,
  countCodexRenderedMessages,
  classifyCodexRecordProvenance,
  codexNeedsParentRecordsForProvenance
} from "./parser.js";
import {
  buildCodexSessionProtocol,
  buildCodexSessionProtocolV3,
  codexProtocolChildFactsFromRecords
} from "./protocol.js";
import { normalizeCodexContextChangeResult } from "./context-result.js";
import { finalizeSessionProtocol, protocolRevision } from "../shared/session-protocol.js";
import { finalizeSessionProtocolV3 } from "../shared/session-protocol-v3.js";
import { icons } from "../../icons.js";
import type { InheritedContextView, Message, OwnedReaderLinkEvidence, OwnedReaderProjection, ProviderAdapter, RawSession } from "../interface.js";
import { buildLinkedMessageSessionViews, buildOwnedReaderChildLinks } from "../shared/linked-message-session.js";
import { buildMessageSessionTree, buildMessageSessionViews } from "../shared/message-session.js";
import { buildResolvedSystemPromptEvidence } from "../shared/system-prompt-evidence.js";
import { buildCodexRuntimeEnvironment } from "./runtime-environment.js";
import {
  createStructuredViewCache,
  createStructuredViewMethods,
  createSessionFileStore,
  createIncrementalTokenStats,
  searchNormalizedMessages,
  sessionFileSignature,
  type TokenFieldMapping
} from "../shared/file-adapter-helpers.js";

function getCodexDir() {
  return getConfig().codexDir;
}

function discoverSessionFiles() {
  const sessionsDir = path.join(getCodexDir(), "sessions");
  if (!existsSync(sessionsDir)) return [];
  const files: any[] = [];
  const visited = new Set();

  function walk(dir: any) {
    try {
      const dirStat = lstatSync(dir);
      if (dirStat.isSymbolicLink()) return;
      const key = `${dirStat.dev}:${dirStat.ino}`;
      if (visited.has(key)) return;
      visited.add(key);

      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        try {
          const stat = lstatSync(full);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) walk(full);
          else if (/\.jsonl(?:\.zst)?$/i.test(entry)) {
            // Codex compresses cold rollouts as `.jsonl.zst`; prefer the
            // plain sibling while a representation transition is in flight.
            if (/\.jsonl\.zst$/i.test(entry) && existsSync(full.replace(/\.zst$/i, ""))) continue;
            const stem = entry.replace(/\.jsonl(?:\.zst)?$/i, "").replace(/^rollout-/, "");
            const canonicalSuffix = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
            const sessionId = canonicalSuffix?.[0] || stem;
            files.push({ sessionId, filePath: full });
          }
        } catch (err) { console.warn("Skipping unreadable directory entry:", full, err); /* skip */ }
      }
    } catch (err) { console.warn("Skipping unreadable directory:", dir, err); /* skip */ }
  }

  walk(sessionsDir);
  return files;
}

function readSnapshotPayload(filePath: string, canonicalId: string, snapshot: CodexSessionReadSnapshot) {
  const { records } = readCodexSessionSnapshot(filePath, snapshot);
  return { records, messages: recordsToMessages(records, canonicalId) };
}

const sessionFiles = createSessionFileStore({
  discoverFiles: discoverSessionFiles,
  // Keep the full canonical index while bounding retained transcript bodies.
  // A single rollout over this budget remains readable and is cached whole.
  maxCachedSourceBytes: 64 * 1024 * 1024,
  readEntry(entry) {
    const captured = /\.jsonl\.zst$/i.test(entry.filePath) ? null : readCodexSessionSnapshot(entry.filePath);
    const records = captured?.records ?? parseSession(entry.filePath);
    const canonicalId = extractCodexSessionId(records, entry.sessionId);
    const messages = recordsToMessages(records, canonicalId);
    const session = extractMeta(records, entry.sessionId, messages);
    return {
      records,
      session,
      messages,
      payloadSnapshot: captured ? {
        signature: sessionFileSignature(entry.filePath, captured.snapshot),
        sourceBytes: captured.snapshot.size,
        read: readSnapshotPayload.bind(null, entry.filePath, canonicalId, captured.snapshot)
      } : undefined
    };
  },
  onError(filePath, err) {
    console.warn("Could not load Codex session file:", filePath, err);
  }
});

function parentEntryFor(entry: { session: RawSession }) {
  const parent = entry.session.parentId
    ? sessionFiles.get(String(entry.session.parentId))
    : null;
  return parent && String(parent.session.id) !== String(entry.session.id)
    ? parent
    : null;
}

function ownedTokenCount(records: any[], parentRecords: any[] = []) {
  return codexOwnedTokenUsageRecords(records, parentRecords).reduce(
    (total, record) => total + (codexUsageToTokens(codexUsagePayload(record))?.total || 0),
    0
  );
}

function resolveEntryPayload(
  entry: { session: RawSession },
  records: any[],
  messages: Message[],
  parentRecords: any[] | null
) {
  const sourceMessages = parentRecords
    ? recordsToMessages(records, entry.session.id, parentRecords)
    : messages;
  const sourceSession = parentRecords
    ? extractMeta(records, entry.session.id, sourceMessages, parentRecords)
    : entry.session;
  const resolved = resolveCodexInheritedContext(sourceMessages, []);
  const inheritedContext = sourceSession.metadata?.inheritedContext;
  const session = {
    ...sourceSession,
    tokenCount: ownedTokenCount(records, parentRecords || []) || null,
    messageCount: countCodexRenderedMessages(resolved.messages),
    metadata: inheritedContext ? {
      ...sourceSession.metadata,
      inheritedContext: {
        ...inheritedContext,
        excludedUserMessages: resolved.excludedUserMessages
      }
    } : sourceSession.metadata
  };
  return { session, messages: resolved.messages };
}

function resolveEntry(entry: { session: RawSession; messages: Message[]; records: any[] }) {
  // Capture a body before loading its parent: either may evict the other from
  // the cache, but provenance must use the same record object identities.
  const records = entry.records;
  const messages = entry.messages;
  const parent = codexNeedsParentRecordsForProvenance(records)
    ? parentEntryFor(entry)
    : null;
  return resolveEntryPayload(entry, records, messages, parent?.records || null);
}

function inheritedContextFor(entry: { session: RawSession; records: any[] }): InheritedContextView | null {
  const parentSessionId = entry.session.parentId ? String(entry.session.parentId) : "";
  if (!parentSessionId) return null;
  const records = entry.records;
  const parent = codexNeedsParentRecordsForProvenance(records)
    ? parentEntryFor(entry)
    : null;
  // The child boundary remains evidence even when the parent file is no
  // longer readable; classification can still use the recorded parent id and
  // task envelope without guessing any source text.
  const messages = recordsToInheritedMessages(records, String(entry.session.id), parent?.records || []);
  if (!messages.length) return null;
  return {
    sourceSession: {
      provider: "codex",
      sessionId: parentSessionId
    },
    messages,
    total: messages.length,
    truncated: false
  };
}

function resolveFamily(sessionId: string) {
  const root = sessionFiles.get(sessionId);
  if (!root) return null;
  const canonicalId = String(root.session.id);
  return sessionFiles.getFamily(canonicalId).map(resolveEntry);
}

function generateCodexViews(sessionId: string) {
  const root = sessionFiles.get(sessionId);
  if (!root) return null;
  const canonicalId = String(root.session.id);
  const family = resolveFamily(sessionId);
  if (!family) return null;
  const protocol = buildCodexSessionProtocolFor(canonicalId);
  return buildLinkedMessageSessionViews(canonicalId, family, protocol ? {
    tasks: protocol.tasks,
    agentRuns: protocol.agentRuns,
    relationships: protocol.relationships
  } : undefined);
}

function buildCodexOwnedReaderProjection(sessionId: string, evidence?: OwnedReaderLinkEvidence): OwnedReaderProjection | null {
  const root = sessionFiles.get(sessionId);
  if (!root) return null;
  const rootRecords = root.records;
  const rootMessages = root.messages;
  const parent = codexNeedsParentRecordsForProvenance(rootRecords)
    ? parentEntryFor(root)
    : null;
  const rootEntry = resolveEntryPayload(root, rootRecords, rootMessages, parent?.records || null);
  const rootTree = buildMessageSessionTree(rootEntry.session, rootEntry.messages);
  const canonicalId = String(root.session.id);
  const directChildren = sessionFiles.getFamily(canonicalId).filter((entry) => (
    entry.session.parentId && String(entry.session.parentId) === canonicalId
  ));
  const links = buildOwnedReaderChildLinks(
    canonicalId,
    rootTree,
    directChildren.map((entry) => ({ session: entry.session as Record<string, any> })),
    evidence
  );
  return {
    rootTree,
    children: links.map((link) => ({
      provider: "codex",
      sessionId: String(link.session.id),
      title: typeof link.session.title === "string" ? link.session.title : null,
      available: link.session.available !== false,
      link: link.link,
      parentPartId: link.parentPartId,
      detached: link.detached
    }))
  };
}

function generateCodexMetrics(sessionId: string) {
  const root = sessionFiles.get(sessionId);
  if (!root) return null;
  const canonicalId = String(root.session.id);
  const rootRecords = root.records;
  const rootMessages = root.messages;
  const rootParent = codexNeedsParentRecordsForProvenance(rootRecords)
    ? parentEntryFor(root)
    : null;
  const family = sessionFiles.getFamily(canonicalId);
  const childrenByParent = new Map<string, typeof family>();
  for (const entry of family) {
    const parentId = entry.session.parentId;
    if (!parentId) continue;
    const key = String(parentId);
    const children = childrenByParent.get(key) || [];
    children.push(entry);
    childrenByParent.set(key, children);
  }
  const totals = {
    messages: 0, toolCalls: 0, branches: Math.max(0, family.length - 1), steps: 0,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, directInputTokens: 0, directOutputTokens: 0, directReasoningTokens: 0,
    directCacheReadTokens: 0, directCacheWriteTokens: 0, directTotalTokens: 0, cost: 0, runtimeMs: 0
  };
  const tools = new Map<string, number>();
  let timeStart = 0;
  let timeEnd = 0;
  let rootSteps: any[] = [];
  const seen = new Set<string>();
  const visit = (entry: typeof family[number], parentRecords: any[] | null, isRoot = false) => {
    const id = String(entry.session.id);
    if (seen.has(id)) return;
    seen.add(id);
    const records = isRoot ? rootRecords : entry.records;
    const messages = isRoot ? rootMessages : entry.messages;
    const resolved = resolveEntryPayload(entry, records, messages, parentRecords);
    const directView = buildMessageSessionViews(resolved.session, resolved.messages);
    const direct = directView.metrics;
    totals.messages += direct.totals.messages;
    totals.toolCalls += direct.totals.toolCalls;
    totals.inputTokens += direct.totals.directInputTokens;
    totals.outputTokens += direct.totals.directOutputTokens;
    totals.reasoningTokens += direct.totals.directReasoningTokens;
    totals.cacheReadTokens += direct.totals.directCacheReadTokens;
    totals.cacheWriteTokens += direct.totals.directCacheWriteTokens;
    totals.totalTokens += direct.totals.directTotalTokens;
    if (isRoot) {
      totals.directInputTokens = direct.totals.directInputTokens;
      totals.directOutputTokens = direct.totals.directOutputTokens;
      totals.directReasoningTokens = direct.totals.directReasoningTokens;
      totals.directCacheReadTokens = direct.totals.directCacheReadTokens;
      totals.directCacheWriteTokens = direct.totals.directCacheWriteTokens;
      totals.directTotalTokens = direct.totals.directTotalTokens;
      rootSteps = direct.steps;
    }
    for (const tool of direct.tools) tools.set(tool.name, (tools.get(tool.name) || 0) + tool.count);
    const directStart = directView.tree.metrics.timeStart;
    const directEnd = directView.tree.metrics.timeEnd;
    if (directStart && (!timeStart || directStart < timeStart)) timeStart = directStart;
    if (directEnd > timeEnd) timeEnd = directEnd;
    for (const child of childrenByParent.get(id) || []) visit(child, records, false);
  };
  visit(root, rootParent?.records || null, true);
  totals.runtimeMs = timeStart && timeEnd ? Math.max(0, timeEnd - timeStart) : 0;
  return {
    sessionId: canonicalId,
    totals: { ...totals, steps: rootSteps.length },
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
    steps: rootSteps
  };
}

const codexProtocolCapabilities = {
  sessionEvents: { support: "partial" as const, provenance: "derived" as const, details: "derived message envelopes plus recorded compaction, NEW_TASK, and session-turn lifecycle events" },
  sessionRelationships: { support: "partial" as const, provenance: "derived" as const, details: "recorded incoming thread spawns plus derived outgoing edges and forks" },
  tasks: { support: "partial" as const, provenance: "derived" as const, details: "recorded NEW_TASK envelopes plus spawn tool-call derivations bound via sub_agent_activity and call-output evidence" },
  agentRuns: { support: "partial" as const, provenance: "derived" as const, details: "recorded session-owned turn runs plus child rollout sessions bound to spawn calls through recorded activity/call-output evidence" },
  contextArtifacts: { support: "full" as const, provenance: "recorded" as const, details: "compaction records, metadata-only summaries" },
  branches: { support: "none" as const, provenance: "derived" as const, details: "Codex fork lineage remains a session relationship" }
};

function loadCodexProtocolInput(sessionId: string) {
  const root = sessionFiles.get(sessionId);
  if (!root) return null;
  const canonicalId = String(root.session.id);
  // Freeze the provider revision before reading large bodies so finalization
  // cannot refresh the index and label an older payload with newer metadata.
  const revision = protocolRevision(sessionFiles.getStatsRevision());
  // Capture the indexed family before reading a potentially
  // very large root body. This keeps the metadata selection on one refresh
  // even if parsing the root crosses the store refresh interval.
  const family = sessionFiles.getFamily(canonicalId);
  // Keep the root payload and its precomputed messages before loading a
  // parent: the bounded store may evict either body while the other is read.
  const rootRecords = root.records;
  const rootMessages = root.messages;
  const parent = codexNeedsParentRecordsForProvenance(rootRecords)
    ? parentEntryFor(root)
    : null;
  const parentRecords = parent?.records || null;
  const recordProvenance = root.session.parentId
    ? classifyCodexRecordProvenance(rootRecords, parentRecords || [])
    : null;
  const ownedRecords = recordProvenance
    ? rootRecords.filter((record) => recordProvenance.get(record) === "session")
    : rootRecords;
  const rootEntry = resolveEntryPayload(root, rootRecords, rootMessages, parentRecords);
  // getFamily() returns indexed entries without touching their payloads. Only
  // direct children belong in this protocol input; grandchildren remain
  // indexed for lookup but must not be loaded as a side effect here.
  const children = family.filter((item) => (
    item.session.parentId && String(item.session.parentId) === canonicalId
  ));
  return {
    canonicalId,
    revision,
    rootEntry,
    input: {
      session: rootEntry.session,
      messages: rootEntry.messages,
      records: ownedRecords,
      children: children.map((child) => {
        // A direct child always inherits from this root. Capture its body once
        // and classify against the same root record objects held above.
        const childRecords = child.records;
        const childMessages = child.messages;
        const childEntry = resolveEntryPayload(child, childRecords, childMessages, rootRecords);
        const childProvenance = classifyCodexRecordProvenance(childRecords, rootRecords);
        const ownedChildRecords = childRecords.filter((record) => (
          childProvenance.get(record) === "session"
        ));
        return {
          session: childEntry.session,
          facts: codexProtocolChildFactsFromRecords(ownedChildRecords)
        };
      })
    }
  };
}

function finalizeCodexV2Protocol(loaded: NonNullable<ReturnType<typeof loadCodexProtocolInput>>) {
  return finalizeSessionProtocol(buildCodexSessionProtocol(loaded.input), {
    provider: "codex",
    session: loaded.rootEntry.session,
    capabilities: codexProtocolCapabilities,
    revision: loaded.revision
  });
}

function buildCodexSessionProtocolFor(sessionId: string) {
  const loaded = loadCodexProtocolInput(sessionId);
  return loaded ? finalizeCodexV2Protocol(loaded) : null;
}

function buildCodexSessionProtocolV3For(sessionId: string) {
  const loaded = loadCodexProtocolInput(sessionId);
  if (!loaded) return null;
  const base = finalizeCodexV2Protocol(loaded);
  return finalizeSessionProtocolV3(buildCodexSessionProtocolV3(loaded.input, base));
}

const getCodexViews = createStructuredViewCache(generateCodexViews);

export function codexDailyTokenComponents(usage: any) {
  const input = Number(usage?.input_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  const reasoning = Number(usage?.reasoning_output_tokens) || 0;
  const cacheRead = Number(usage?.cached_input_tokens) || 0;
  const cacheWrite = Number(usage?.cache_write_input_tokens) || 0;
  const uncachedInput = Math.max(0, input - cacheRead - cacheWrite);
  const visibleOutput = Math.max(0, output - reasoning);
  return {
    input: uncachedInput,
    output: visibleOutput,
    reasoning,
    cacheRead,
    cacheWrite,
    total: Number(usage?.total_tokens) || uncachedInput + visibleOutput + reasoning + cacheRead + cacheWrite,
  };
}

const codexTokenMapping: TokenFieldMapping = {
  filterRecord: (r) => Boolean(codexUsagePayload(r)),
  getTimestamp: (r) => r.timestamp ? new Date(r.timestamp).getTime() : 0,
  inputTokens: (r) => {
    return codexDailyTokenComponents(codexUsagePayload(r)).input;
  },
  outputTokens: (r) => {
    return codexDailyTokenComponents(codexUsagePayload(r)).output;
  },
  totalTokens: (r) => codexDailyTokenComponents(codexUsagePayload(r)).total,
  reasoningTokens: (r) => codexDailyTokenComponents(codexUsagePayload(r)).reasoning,
  cacheReadTokens: (r) => codexDailyTokenComponents(codexUsagePayload(r)).cacheRead,
  cacheWriteTokens: (r) => codexDailyTokenComponents(codexUsagePayload(r)).cacheWrite,
};

let tokenStatsGroupPath: string | null = null;
let tokenStatsParentRecords: any[] | null = null;

function resetTokenStatsParentSnapshot() {
  tokenStatsGroupPath = null;
  tokenStatsParentRecords = null;
}

const getCodexTokenStatsBase = createIncrementalTokenStats(
  () => {
    const signatures = sessionFiles.getFileSignatures();
    const signatureByPath = new Map(signatures.map(({ filePath, signature }) => [filePath, signature]));
    const files = signatures.map((file) => {
      const entry = sessionFiles.getByFilePath(file.filePath);
      const parent = entry ? parentEntryFor(entry) : null;
      return {
        ...file,
        groupPath: parent?.filePath || file.filePath,
        hasParent: Boolean(parent),
        // A child token prefix depends on its declared parent's records too.
        signature: `${file.signature}|parent:${parent ? signatureByPath.get(parent.filePath) || "missing" : "none"}`
      };
    });
    files.sort((left, right) => (
      left.groupPath.localeCompare(right.groupPath)
      || Number(left.hasParent) - Number(right.hasParent)
      || left.filePath.localeCompare(right.filePath)
    ));
    return files;
  },
  (filePath) => {
    const entry = sessionFiles.getByFilePath(filePath);
    const parent = entry ? parentEntryFor(entry) : null;
    const groupPath = parent?.filePath || entry?.filePath || filePath;
    if (groupPath !== tokenStatsGroupPath) {
      tokenStatsGroupPath = null;
      tokenStatsParentRecords = null;
      const capturedParentRecords = parent?.records || entry?.records || [];
      tokenStatsParentRecords = capturedParentRecords;
      tokenStatsGroupPath = groupPath;
    }
    return codexOwnedTokenUsageRecords(entry?.records || [], parent ? tokenStatsParentRecords || [] : []);
  },
  codexTokenMapping,
);

function getCodexTokenStats(days = 30) {
  resetTokenStatsParentSnapshot();
  try {
    return getCodexTokenStatsBase(days);
  } finally {
    resetTokenStatsParentSnapshot();
  }
}

const codex = {
  id: "codex",
  name: "Codex CLI",
  icon: icons.codex,
  resumeCommand: {
    executable: "codex",
    args: ["resume", "{sessionId}"]
  },
  capabilities: {
    localManagement: true
  },
  protocolCapabilities: {
    ...codexProtocolCapabilities
  },

  detect() {
    return existsSync(path.join(getCodexDir(), "sessions"));
  },

  getDataPath() {
    return path.join(getCodexDir(), "sessions");
  },

  async *scan() {
    for (const entry of sessionFiles.list()) {
      try {
        if (entry.records.length) yield resolveEntry(entry).session;
      } catch (error) {
        console.warn("Skipping unreadable Codex session during scan:", entry.filePath, error);
      }
    }
  },

  getSession(sessionId) {
    const entry = sessionFiles.get(sessionId);
    return entry ? resolveEntry(entry).session : null;
  },

  getRuntimeEnvironment(sessionId) {
    const session = this.getSession(sessionId);
    return session?.directory
      ? buildCodexRuntimeEnvironment(sessionId, session.directory as string, getCodexDir())
      : null;
  },

  getSystemPrompts(sessionId) {
    const entry = sessionFiles.get(sessionId);
    if (!entry) return null;
    const resolved = resolveEntry(entry);
    const runtimeEnvironment = resolved.session.directory
      ? buildCodexRuntimeEnvironment(resolved.session.id, resolved.session.directory as string, getCodexDir())
      : null;
    return buildResolvedSystemPromptEvidence({
      providerName: "Codex CLI",
      mode: "codex-resolved",
      session: resolved.session,
      messages: resolved.messages,
      runtimeEnvironment
    });
  },

  getMessages(sessionId) {
    const entry = sessionFiles.get(sessionId);
    return entry ? resolveEntry(entry).messages : [];
  },

  getInheritedContext(sessionId) {
    const entry = sessionFiles.get(sessionId);
    return entry ? inheritedContextFor(entry) : null;
  },

  getSessionProtocol(sessionId) {
    return buildCodexSessionProtocolFor(sessionId);
  },

  getSessionProtocolV3(sessionId) {
    return buildCodexSessionProtocolV3For(sessionId);
  },

  getContextChangeResult(sessionId, checkpointId) {
    const loaded = loadCodexProtocolInput(sessionId);
    return loaded ? normalizeCodexContextChangeResult(loaded.input.records, checkpointId) : null;
  },

  getOwnedReaderProjection(sessionId, evidence) {
    return buildCodexOwnedReaderProjection(sessionId, evidence);
  },

  ...createStructuredViewMethods(getCodexViews),

  getSessionMetrics(sessionId) {
    return generateCodexMetrics(sessionId);
  },

  getTokenStats(days = 30) {
    return getCodexTokenStats(days);
  },

  getStatsRevision() {
    return sessionFiles.getStatsRevision();
  },

  searchMessages(query, limit = 20) {
    function* entries() {
      for (const entry of sessionFiles.list()) yield resolveEntry(entry);
    }
    return searchNormalizedMessages(
      entries(),
      query,
      limit
    );
  },

} satisfies ProviderAdapter;

export default codex;
