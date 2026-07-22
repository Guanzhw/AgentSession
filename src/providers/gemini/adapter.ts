import { existsSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import { parseSession, extractMeta, dataToMessages } from "./parser.js";
import { icons } from "../../icons.js";
import type { ProviderAdapter } from "../interface.js";
import { buildGeminiRuntimeEnvironment } from "./runtime-environment.js";
import { buildMessageSessionViews } from "../shared/message-session.js";
import { buildResolvedSystemPromptEvidence } from "../shared/system-prompt-evidence.js";
import { withConfiguredProjectDirectory } from "../shared/project-directory.js";
import {
  createSessionFileStore,
  createStructuredViewCache,
  createStructuredViewMethods,
  createIncrementalTokenStats,
  searchNormalizedMessages,
  type TokenFieldMapping
} from "../shared/file-adapter-helpers.js";

function getGeminiDir() {
  return getConfig().geminiDir;
}

function discoverSessionFiles() {
  const tmpDir = path.join(getGeminiDir(), "tmp");
  if (!existsSync(tmpDir)) return [];
  const files = [];

  try {
    for (const projectDir of readdirSync(tmpDir)) {
      const projectPath = path.join(tmpDir, projectDir);
      const projectStat = lstatSync(projectPath);
      if (projectStat.isSymbolicLink()) continue;
      const chatsDir = path.join(projectPath, "chats");
      if (!existsSync(chatsDir)) continue;
      try {
        for (const entry of readdirSync(chatsDir)) {
          if (entry.endsWith(".json")) {
            files.push({
              sessionId: entry.replace(/\.json$/, ""),
              filePath: path.join(chatsDir, entry)
            });
          }
        }
      } catch (err) { console.warn("Skipping unreadable chat directory:", chatsDir, err); /* skip */ }
    }
  } catch (err) { console.warn("Skipping unreadable project directory:", tmpDir, err); /* skip */ }

  return files;
}

const sessionFiles = createSessionFileStore({
  discoverFiles: discoverSessionFiles,
  readEntry: (entry) => {
    const records = parseSession(entry.filePath);
    const session = extractMeta(records);
    if (!session.id) {
      throw new Error("Gemini session file has no canonical sessionId");
    }
    return {
      records,
      session,
      messages: dataToMessages(records, session.id)
    };
  },
  onError: (filePath, error) => {
    console.warn("Skipping unparseable Gemini session file:", filePath, error);
  }
});

function configuredGeminiSession(session: ReturnType<typeof extractMeta>) {
  return withConfiguredProjectDirectory("gemini", session, getConfig());
}

function getConfiguredGeminiSession(sessionId: string) {
  const session = sessionFiles.get(sessionId)?.session;
  return session ? configuredGeminiSession(session) : null;
}

function generateGeminiViews(sessionId: string) {
  const entry = sessionFiles.get(sessionId);
  return entry
    ? buildMessageSessionViews(configuredGeminiSession(entry.session), entry.messages)
    : null;
}

const getGeminiViews = createStructuredViewCache(generateGeminiViews);

const geminiTokenMapping: TokenFieldMapping = {
  filterRecord: (m) => m.type === "gemini" && !!m.tokenUsage,
  getTimestamp: (m) => m.timestamp ? new Date(m.timestamp).getTime() : 0,
  // Gemini reports cached content as a subset of prompt tokens.
  inputTokens: (m) => Math.max(0, (m.tokenUsage.input || 0) - (m.tokenUsage.cached || 0)),
  outputTokens: (m) => m.tokenUsage.output || 0,
  totalTokens: (m) => m.tokenUsage.total || 0,
  reasoningTokens: (m) => m.tokenUsage.thoughts || 0,
  cacheReadTokens: (m) => m.tokenUsage.cached || 0,
  cacheWriteTokens: () => 0,
};

const getGeminiTokenStats = createIncrementalTokenStats(
  () => sessionFiles.getFileSignatures(),
  (filePath) => sessionFiles.getByFilePath(filePath)?.records || { messages: [] },
  geminiTokenMapping,
);

const gemini = {
  id: "gemini",
  name: "Gemini CLI",
  icon: icons.gemini,
  resumeCommand: {
    executable: "gemini",
    args: ["--resume", "{sessionId}"]
  },
  capabilities: {
    localManagement: true,
    sessionAnalysis: true,
    structuredSessionViews: true
  },

  detect() {
    return existsSync(path.join(getGeminiDir(), "tmp"));
  },

  getDataPath() {
    return path.join(getGeminiDir(), "tmp");
  },

  async *scan() {
    for (const entry of sessionFiles.list()) {
      yield configuredGeminiSession(entry.session);
    }
  },

  getSession(sessionId) {
    return getConfiguredGeminiSession(sessionId);
  },

  getRuntimeEnvironment(sessionId) {
    const session = getConfiguredGeminiSession(sessionId);
    return session?.directory
      ? buildGeminiRuntimeEnvironment(session.id, session.directory as string, getGeminiDir())
      : null;
  },

  getSystemPrompts(sessionId) {
    const entry = sessionFiles.get(sessionId);
    if (!entry) return null;
    const session = configuredGeminiSession(entry.session);
    const runtimeEnvironment = session.directory
      ? buildGeminiRuntimeEnvironment(session.id, session.directory as string, getGeminiDir())
      : null;
    return buildResolvedSystemPromptEvidence({
      providerName: "Gemini CLI",
      mode: "gemini-resolved",
      session,
      messages: entry.messages,
      runtimeEnvironment
    });
  },

  getMessages(sessionId) {
    return sessionFiles.get(sessionId)?.messages || [];
  },

  ...createStructuredViewMethods(getGeminiViews),

  getTokenStats(days = 30) {
    return getGeminiTokenStats(days);
  },

  getStatsRevision() {
    return sessionFiles.getStatsRevision();
  },

  searchMessages(query, limit = 20) {
    return searchNormalizedMessages(sessionFiles.list(), query, limit);
  },

} satisfies ProviderAdapter;

export default gemini;
