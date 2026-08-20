import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import { icons } from "../../icons.js";
import type { ProviderAdapter } from "../interface.js";
import { buildLinkedMessageSessionViews } from "../shared/linked-message-session.js";
import { buildResolvedSystemPromptEvidence } from "../shared/system-prompt-evidence.js";
import {
  createIncrementalTokenStats,
  createSessionFileStore,
  createStructuredViewCache,
  createStructuredViewMethods,
  searchNormalizedMessages,
  type SessionFileDescriptor,
  type TokenFieldMapping
} from "../shared/file-adapter-helpers.js";
import {
  extractOpenClawMeta,
  openClawAssistantUsageRecords,
  openClawRecordsToMessages,
  openClawUsageToTokens,
  parseOpenClawSession
} from "./parser.js";
import { buildOpenClawRuntimeEnvironment } from "./runtime-environment.js";
import { buildOpenClawSessionProtocol, openClawProtocolCapabilities } from "./protocol.js";

interface OpenClawDescriptor extends SessionFileDescriptor {
  agentId: string;
  registry: Record<string, any> | null;
}

function getOpenClawDir() {
  return getConfig().openclawDir;
}

function readRegistryDocument(sessionsDir: string) {
  const registryPath = path.join(sessionsDir, "sessions.json");
  if (!existsSync(registryPath)) return {} as Record<string, Record<string, any>>;
  try {
    const document = JSON.parse(readFileSync(registryPath, "utf8"));
    return document && typeof document === "object" && !Array.isArray(document)
      ? document as Record<string, Record<string, any>>
      : {};
  } catch (error) {
    console.warn("Ignoring unreadable OpenClaw session registry:", registryPath, error);
    return {};
  }
}

function discoverSessionFiles(): OpenClawDescriptor[] {
  const agentsDir = path.join(getOpenClawDir(), "agents");
  if (!existsSync(agentsDir)) return [];
  const files: OpenClawDescriptor[] = [];
  const agents = readdirSync(agentsDir).flatMap(agentId => {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    return existsSync(sessionsDir)
      ? [{ agentId, sessionsDir, registry: readRegistryDocument(sessionsDir) }]
      : [];
  });
  const sessionIdByKey = new Map<string, string>();
  const registryPaths = agents.map(agent => path.join(agent.sessionsDir, "sessions.json"));
  for (const agent of agents) {
    for (const [sessionKey, row] of Object.entries(agent.registry)) {
      const sessionId = String(row?.sessionId || "");
      if (sessionId) sessionIdByKey.set(sessionKey, sessionId);
    }
  }
  for (const { agentId, sessionsDir, registry } of agents) {
    const registryById = new Map<string, Record<string, any>>();
    for (const [sessionKey, row] of Object.entries(registry)) {
      const sessionId = String(row?.sessionId || "");
      if (!sessionId) continue;
      const spawnedBy = typeof row.spawnedBy === "string"
        ? sessionIdByKey.get(row.spawnedBy) || null
        : null;
      registryById.set(sessionId, { ...row, sessionKey, spawnedBy });
    }
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".jsonl") || name.endsWith(".trajectory.jsonl")) continue;
      const filePath = path.join(sessionsDir, name);
      try {
        const stat = lstatSync(filePath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          files.push({
            // OpenClaw names transcript files <canonical session ID>.jsonl;
            // the parser still treats the header ID as authoritative.
            sessionId: name.slice(0, -6),
            filePath,
            agentId,
            registry: registryById.get(name.slice(0, -6)) || null,
            dependencyPaths: registryPaths
          });
        }
      } catch (error) {
        console.warn("Skipping unreadable OpenClaw session entry:", filePath, error);
      }
    }
  }
  return files;
}

const sessionFiles = createSessionFileStore({
  discoverFiles: discoverSessionFiles,
  readEntry(descriptor) {
    const entry = descriptor as OpenClawDescriptor;
    const records = parseOpenClawSession(entry.filePath);
    const session = extractOpenClawMeta(records, entry.sessionId, entry.agentId, entry.registry);
    return { records, session, messages: openClawRecordsToMessages(records, session.id) };
  },
  onError(filePath, error) {
    console.warn("Skipping unparseable OpenClaw session:", filePath, error);
  }
});

function runtimeFor(sessionId: string) {
  const entry = sessionFiles.get(sessionId);
  const agentId = String(entry?.session.metadata?.agentId || "main");
  return entry?.session.directory
    ? buildOpenClawRuntimeEnvironment(entry.session.id, entry.session.directory, getOpenClawDir(), agentId)
    : null;
}

const getViews = createStructuredViewCache((sessionId: string) => {
  const entry = sessionFiles.get(sessionId);
  return entry ? buildLinkedMessageSessionViews(entry.session.id, sessionFiles.getFamily(entry.session.id)) : null;
});

const tokenMapping: TokenFieldMapping = {
  filterRecord: record => record.type === "message" && record.message?.role === "assistant" && Boolean(record.message?.usage),
  getTimestamp: record => Number(record.message?.timestamp) || (record.timestamp ? Date.parse(record.timestamp) : 0),
  inputTokens: record => openClawUsageToTokens(record.message?.usage)?.input || 0,
  outputTokens: record => openClawUsageToTokens(record.message?.usage)?.output || 0,
  totalTokens: record => openClawUsageToTokens(record.message?.usage)?.total || 0,
  reasoningTokens: record => openClawUsageToTokens(record.message?.usage)?.reasoning || 0,
  cacheReadTokens: record => openClawUsageToTokens(record.message?.usage)?.cache?.read || 0,
  cacheWriteTokens: record => openClawUsageToTokens(record.message?.usage)?.cache?.write || 0
};

const getTokenStats = createIncrementalTokenStats(
  () => sessionFiles.getFileSignatures(),
  filePath => openClawAssistantUsageRecords(sessionFiles.getByFilePath(filePath)?.records || []),
  tokenMapping
);

const openclaw = {
  id: "openclaw",
  name: "OpenClaw",
  icon: icons.openclaw,
  resumeCommand: { executable: "openclaw", args: ["tui", "--local", "--session", "{sessionId}"] },
  getResumeCommandSpec(sessionId) {
    const sessionKey = sessionFiles.get(sessionId)?.session.metadata?.sessionKey;
    return typeof sessionKey === "string" && sessionKey
      ? { executable: "openclaw", args: ["tui", "--local", "--session", sessionKey] }
      : null;
  },
  capabilities: { localManagement: true, structuredSessionViews: true },
  protocolCapabilities: openClawProtocolCapabilities,
  detect() { return existsSync(path.join(getOpenClawDir(), "agents")); },
  getUnavailableReason() {
    const agentsDir = path.join(getOpenClawDir(), "agents");
    return existsSync(agentsDir)
      ? null
      : `OpenClaw agents directory was not found at ${agentsDir}. Set OPENCLAW_STATE_DIR or --openclaw-dir.`;
  },
  getDataPath() { return getOpenClawDir(); },
  async *scan() { for (const entry of sessionFiles.list()) yield entry.session; },
  getSession(sessionId) { return sessionFiles.get(sessionId)?.session || null; },
  getMessages(sessionId) { return sessionFiles.get(sessionId)?.messages || []; },
  getRuntimeEnvironment: runtimeFor,
  getSystemPrompts(sessionId) {
    const entry = sessionFiles.get(sessionId);
    if (!entry) return null;
    return buildResolvedSystemPromptEvidence({
      providerName: "OpenClaw",
      mode: "openclaw-resolved",
      session: entry.session,
      messages: entry.messages,
      runtimeEnvironment: runtimeFor(sessionId)
    });
  },
  ...createStructuredViewMethods(getViews),
  getTokenStats(days = 30) { return getTokenStats(days); },
  getStatsRevision() { return sessionFiles.getStatsRevision(); },
  getSessionProtocol(sessionId: string) {
    const entry = sessionFiles.get(sessionId);
    if (!entry) return null;
    const family = sessionFiles.getFamily(sessionId);
    return buildOpenClawSessionProtocol(
      entry.session,
      entry.records,
      family.filter((child) => String(child.session.id) !== String(entry.session.id)),
      sessionFiles.getStatsRevision()
    );
  },
  searchMessages(query, limit = 20) { return searchNormalizedMessages(sessionFiles.list(), query, limit); },
  exportSession(sessionId) {
    const entry = sessionFiles.get(sessionId);
    return entry ? { session: entry.session, messages: entry.messages, records: entry.records } : null;
  }
} satisfies ProviderAdapter;

export default openclaw;
