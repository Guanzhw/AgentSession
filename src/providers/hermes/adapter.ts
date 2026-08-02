import { existsSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import { icons } from "../../icons.js";
import type { Message, ProviderAdapter, RawSession } from "../interface.js";
import { buildLinkedMessageSessionViews } from "../shared/linked-message-session.js";
import { asNumber } from "../shared/parser.js";
import { buildResolvedSystemPromptEvidence } from "../shared/system-prompt-evidence.js";
import {
  createStructuredViewCache,
  createStructuredViewMethods,
  searchNormalizedMessages
} from "../shared/file-adapter-helpers.js";
import { buildHermesRuntimeEnvironment } from "./runtime-environment.js";
import {
  createHermesSessionStore,
  hermesDailyTokenStats,
  type HermesSessionEntry
} from "./session-store.js";

function getHermesDir() {
  return getConfig().hermesDir;
}

function getHermesDbPath() {
  return path.join(getHermesDir(), "state.db");
}

function getHermesExecutable() {
  const bundled = process.platform === "win32"
    ? path.join(getHermesDir(), "hermes-agent", "venv", "Scripts", "hermes.exe")
    : path.join(getHermesDir(), "hermes-agent", "venv", "bin", "hermes");
  return existsSync(bundled) ? bundled : "hermes";
}

const sessions = createHermesSessionStore(getHermesDbPath);

interface HermesViewBundle {
  session: RawSession;
  messages: Message[];
}

function compressionParentId(entry: HermesSessionEntry | undefined) {
  const value = entry?.session.metadata?.compressionParentId;
  return value ? String(value) : null;
}

/**
 * Hermes compression-lineage transform for structured views (Hermes only).
 *
 * Hermes state stores one session row per compression segment: a compressed
 * session continues in a new row whose `parent_session_id` names the previous
 * segment. Those segments are lineage, not subagent runs (hermes_state_common
 * keeps compression continuations hidden), so the linked message-session views
 * must present one logical session per compression chain.
 *
 * The store family already resolves a requested compression segment back to
 * its logical base, so the first family entry is the view root. This transform
 * clones the family's view data (never mutating store entries), merges every
 * compression segment's messages into its ultimate non-compression base
 * bundle, removes the merged bundles so they cannot become detached or ghost
 * subagents, and reparents real delegates whose spawn parent is a compression
 * segment onto the ultimate base. Malformed lineages (missing parent or a
 * cycle) keep the bundle untouched so its messages are never dropped.
 */
function buildHermesLinkedViews(sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  const family = sessions.getFamily(sessionId);
  if (!family.length) return null;
  const rootSessionId = family[0].session.id;
  const byId = new Map(family.map(candidate => [candidate.session.id, candidate]));
  const bundles = new Map<string, HermesViewBundle>();
  const orderByMessage = new Map<Message, { segment: number; index: number }>();
  family.forEach((familyEntry, segmentIndex) => {
    bundles.set(familyEntry.session.id, {
      session: { ...familyEntry.session },
      messages: [...familyEntry.messages]
    });
    familyEntry.messages.forEach((message, index) => {
      orderByMessage.set(message, { segment: segmentIndex, index });
    });
  });

  // Resolve a compression segment to its ultimate non-compression base.
  // Returns null on malformed lineage so the caller preserves the bundle.
  const resolveBaseId = (segment: HermesSessionEntry): string | null => {
    let current = compressionParentId(segment);
    if (!current) return segment.session.id;
    const seen = new Set<string>([segment.session.id]);
    let base = segment;
    while (current) {
      if (seen.has(current)) return null; // cycle: malformed lineage
      const parent = byId.get(current);
      if (!parent) return null; // missing parent: malformed lineage
      seen.add(current);
      base = parent;
      current = compressionParentId(parent);
    }
    return base.session.id;
  };

  const mergedSegments = new Set<string>();
  for (const familyEntry of family) {
    if (!compressionParentId(familyEntry)) continue;
    const baseId = resolveBaseId(familyEntry);
    if (!baseId || baseId === familyEntry.session.id) continue;
    const base = bundles.get(baseId);
    const segment = bundles.get(familyEntry.session.id);
    if (!base || !segment) continue;
    mergedSegments.add(familyEntry.session.id);
    base.messages.push(...segment.messages);
    base.session.messageCount = (base.session.messageCount || 0) + (segment.session.messageCount || 0);
    const baseTokens = asNumber(base.session.tokenCount);
    const segmentTokens = asNumber(segment.session.tokenCount);
    base.session.tokenCount = baseTokens && segmentTokens
      ? baseTokens + segmentTokens
      : (baseTokens || segmentTokens || null);
    if (asNumber(segment.session.timeCreated)) {
      base.session.timeCreated = Math.min(
        asNumber(base.session.timeCreated) || Infinity,
        asNumber(segment.session.timeCreated)
      );
    }
    if (asNumber(segment.session.timeUpdated)) {
      base.session.timeUpdated = Math.max(
        asNumber(base.session.timeUpdated) || 0,
        asNumber(segment.session.timeUpdated)
      );
    }
  }

  // One logical conversation: sort merged messages by timestamp, breaking
  // ties by original segment order and message order within each segment.
  for (const bundle of bundles.values()) {
    bundle.messages.sort((left, right) => {
      const timeLeft = asNumber(left.timestamp);
      const timeRight = asNumber(right.timestamp);
      if (timeLeft !== timeRight) return timeLeft - timeRight;
      const orderLeft = orderByMessage.get(left) || { segment: 0, index: 0 };
      const orderRight = orderByMessage.get(right) || { segment: 0, index: 0 };
      return orderLeft.segment - orderRight.segment || orderLeft.index - orderRight.index;
    });
  }

  // Real delegates spawned from inside a compression segment name that
  // segment as their parent; point them at the segment's ultimate base so
  // they attach inside the merged lineage instead of dangling. Malformed
  // chains keep the original parentId (the delegate stays detached, never
  // silently attached to the wrong parent).
  for (const familyEntry of family) {
    if (mergedSegments.has(familyEntry.session.id) || !familyEntry.session.parentId) continue;
    const parent = byId.get(String(familyEntry.session.parentId));
    if (!parent || !compressionParentId(parent)) continue;
    const baseId = resolveBaseId(parent);
    if (!baseId) continue;
    const bundle = bundles.get(familyEntry.session.id);
    if (bundle) bundle.session.parentId = baseId;
  }

  for (const id of mergedSegments) bundles.delete(id);
  return buildLinkedMessageSessionViews(rootSessionId, [...bundles.values()]);
}

function runtimeFor(sessionId: string) {
  const entry = sessions.get(sessionId);
  return entry?.session.directory
    ? buildHermesRuntimeEnvironment(entry.session.id, entry.session.directory, getHermesDir())
    : null;
}

const getViews = createStructuredViewCache((sessionId: string) => buildHermesLinkedViews(sessionId));

const hermes = {
  id: "hermes",
  name: "Hermes Agent",
  icon: icons.hermes,
  resumeCommand: { executable: "hermes", args: ["chat", "--resume", "{sessionId}"] },
  getResumeCommandSpec(sessionId) {
    return sessions.get(sessionId)
      ? { executable: getHermesExecutable(), args: ["chat", "--resume", sessionId] }
      : null;
  },
  capabilities: {
    localManagement: true,
    sessionAnalysis: true,
    structuredSessionViews: true
  },
  detect() { return existsSync(getHermesDbPath()); },
  getUnavailableReason() {
    return existsSync(getHermesDbPath())
      ? null
      : `Hermes state database was not found at ${getHermesDbPath()}. Set HERMES_HOME or --hermes-dir.`;
  },
  getDataPath() { return getHermesDbPath(); },
  async *scan() { for (const entry of sessions.list()) yield entry.session; },
  getSession(sessionId) { return sessions.get(sessionId)?.session || null; },
  getMessages(sessionId) { return sessions.get(sessionId)?.messages || []; },
  getRuntimeEnvironment: runtimeFor,
  getSystemPrompts(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    return buildResolvedSystemPromptEvidence({
      providerName: "Hermes Agent",
      mode: "hermes-stored-and-resolved",
      session: entry.session,
      messages: entry.messages,
      runtimeEnvironment: runtimeFor(sessionId),
      storedSystemPrompt: entry.rawSession.system_prompt ? {
        content: String(entry.rawSession.system_prompt),
        source: "hermes.state.db:sessions.system_prompt",
        title: "Session system prompt snapshot"
      } : null
    });
  },
  ...createStructuredViewMethods(getViews),
  getTokenStats(days = 30) { return hermesDailyTokenStats(sessions.list(), days); },
  getStatsRevision() { return sessions.getRevision(); },
  searchMessages(query, limit = 20) { return searchNormalizedMessages(sessions.list(), query, limit); },
  exportSession(sessionId) {
    const entry = sessions.get(sessionId);
    return entry ? { session: entry.session, messages: entry.messages } : null;
  }
} satisfies ProviderAdapter;

export default hermes;
