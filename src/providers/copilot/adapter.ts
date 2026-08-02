import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import { icons } from "../../icons.js";
import type { ProviderAdapter, RawSession } from "../interface.js";
import { buildLinkedMessageSessionViews } from "../shared/linked-message-session.js";
import { buildResolvedSystemPromptEvidence } from "../shared/system-prompt-evidence.js";
import {
  createSessionFileStore,
  createStructuredViewCache,
  createStructuredViewMethods,
  searchNormalizedMessages
} from "../shared/file-adapter-helpers.js";
import {
  buildCopilotMessageBundles,
  extractCopilotMeta,
  extractCopilotSessionId,
  parseCopilotSession
} from "./parser.js";
import { buildCopilotRuntimeEnvironment } from "./runtime-environment.js";
import { copilotDailyTokenStats, readCopilotSessionStore } from "./session-store.js";

function getCopilotDir() {
  return getConfig().copilotDir;
}

function getSessionStateDir() {
  return path.join(getCopilotDir(), "session-state");
}

function discoverSessionFiles() {
  const root = getSessionStateDir();
  if (!existsSync(root)) return [];
  const files: Array<{ sessionId: string; filePath: string }> = [];
  try {
    for (const entry of readdirSync(root)) {
      const sessionDir = path.join(root, entry);
      try {
        const stat = lstatSync(sessionDir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        const eventsPath = path.join(sessionDir, "events.jsonl");
        const eventsStat = lstatSync(eventsPath);
        if (eventsStat.isSymbolicLink() || !eventsStat.isFile()) continue;
        files.push({ sessionId: entry, filePath: eventsPath });
      } catch (error) {
        console.warn("Skipping unreadable Copilot CLI session directory:", sessionDir, error);
      }
    }
  } catch (error) {
    console.warn("Skipping unreadable Copilot CLI session state directory:", root, error);
  }
  return files;
}

const sessionFiles = createSessionFileStore({
  discoverFiles: discoverSessionFiles,
  readEntry(entry) {
    const records = parseCopilotSession(entry.filePath);
    if (!records.length) throw new Error("Copilot CLI event log has no parseable records");
    const sessionId = extractCopilotSessionId(records, entry.sessionId);
    const session = extractCopilotMeta(records, sessionId);
    return {
      records,
      session,
      messages: buildCopilotMessageBundles(session, records)[0].messages
    };
  },
  onError(filePath, error) {
    console.warn("Skipping unparseable Copilot CLI event log:", filePath, error);
  }
});

function resolvedSession(session: RawSession) {
  const catalog = readCopilotSessionStore(getCopilotDir()).catalog.get(session.id);
  if (!catalog) return session;
  const metadata = {
    ...(session.metadata || {}),
    ...(catalog.repository ? { repository: catalog.repository } : {}),
    ...(catalog.branch ? { branch: catalog.branch } : {})
  };
  return {
    ...session,
    title: session.title || catalog.summary || null,
    directory: catalog.cwd || session.directory,
    timeCreated: session.timeCreated || catalog.createdAt,
    timeUpdated: Math.max(session.timeUpdated, catalog.updatedAt),
    tokenCount: catalog.tokenCount || session.tokenCount,
    metadata: Object.keys(metadata).length ? metadata : null
  };
}

function bundlesForEntry(entry: { session: RawSession; records: any[] }) {
  const session = resolvedSession(entry.session);
  const usages = readCopilotSessionStore(getCopilotDir()).usagesBySession.get(session.id) || [];
  return buildCopilotMessageBundles(session, entry.records, usages);
}

function generateCopilotViews(sessionId: string) {
  const entry = sessionFiles.get(sessionId);
  if (!entry) return null;
  const bundles = bundlesForEntry(entry);
  return buildLinkedMessageSessionViews(bundles[0].session.id, bundles);
}

const getCopilotViews = createStructuredViewCache(generateCopilotViews);

const copilot = {
  id: "copilot",
  name: "GitHub Copilot CLI",
  icon: icons.copilot,
  lifecycle: "legacy",
  capabilities: {
    localManagement: true,
    sessionAnalysis: false,
    structuredSessionViews: true
  },

  detect() {
    return existsSync(getSessionStateDir());
  },

  getDataPath() {
    return getSessionStateDir();
  },

  async *scan() {
    for (const entry of sessionFiles.list()) {
      if (entry.records.length) yield resolvedSession(entry.session);
    }
  },

  getSession(sessionId) {
    const entry = sessionFiles.get(sessionId);
    return entry ? resolvedSession(entry.session) : null;
  },

  getMessages(sessionId) {
    const entry = sessionFiles.get(sessionId);
    return entry ? bundlesForEntry(entry)[0].messages : [];
  },

  getRuntimeEnvironment(sessionId) {
    const entry = sessionFiles.get(sessionId);
    const session = entry ? resolvedSession(entry.session) : null;
    return session?.directory
      ? buildCopilotRuntimeEnvironment(session.id, session.directory as string, getCopilotDir())
      : null;
  },

  getSystemPrompts(sessionId) {
    const entry = sessionFiles.get(sessionId);
    if (!entry) return null;
    const bundles = bundlesForEntry(entry);
    const session = bundles[0].session;
    const runtimeEnvironment = session.directory
      ? buildCopilotRuntimeEnvironment(session.id, session.directory as string, getCopilotDir())
      : null;
    return buildResolvedSystemPromptEvidence({
      providerName: "GitHub Copilot CLI",
      mode: "copilot-resolved",
      session,
      messages: bundles.flatMap((bundle) => bundle.messages),
      runtimeEnvironment
    });
  },

  ...createStructuredViewMethods(getCopilotViews),

  getTokenStats(days = 30) {
    return copilotDailyTokenStats(getCopilotDir(), days);
  },

  getStatsRevision() {
    return `${sessionFiles.getStatsRevision()}:${readCopilotSessionStore(getCopilotDir()).signature}`;
  },

  searchMessages(query, limit = 20) {
    return searchNormalizedMessages(
      sessionFiles.list().map((entry) => {
        const bundles = bundlesForEntry(entry);
        return {
          session: bundles[0].session,
          messages: bundles.flatMap((bundle) => bundle.messages)
        };
      }),
      query,
      limit
    );
  }
} satisfies ProviderAdapter;

export default copilot;
