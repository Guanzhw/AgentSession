import os from "node:os";
import path from "node:path";
import { statSync } from "node:fs";
import { icons } from "../../icons.js";
import { createOpenCodeSqliteAdapter } from "./sqlite-adapter.js";
import { buildOpenCodeSessionContainer } from "./session-container.js";
import { buildOpenCodeSessionMetrics } from "./session-metrics.js";
import { buildOpenCodeSessionTree } from "./session-tree.js";
import { buildOpenCodeSystemPrompts } from "./system-prompts.js";
import { buildOpenCodeRuntimeEnvironment } from "./runtime-environment.js";
import { buildOpenCodeSessionProtocol, openCodeProtocolCapabilities } from "./protocol.js";
import { createStructuredViewCache } from "../shared/file-adapter-helpers.js";

function defaultDataPath() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "opencode", "opencode.db");
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

export function defaultOpenCodeDataPath() {
  return defaultDataPath();
}

const baseAdapter = createOpenCodeSqliteAdapter({
  id: "opencode",
  name: "OpenCode",
  icon: icons.opencode,
  defaultDataPath,
  useConfiguredDbPath: true,
  resumeCommand: {
    executable: "opencode",
    args: ["--session", "{sessionId}"]
  },
  capabilities: {
    localManagement: true,
    openCodeStatsStore: true,
    structuredSessionViews: true
  },
  protocolCapabilities: openCodeProtocolCapabilities
});

const getOpenCodeTree = createStructuredViewCache((sessionId: string) => (
  buildOpenCodeSessionTree(sessionId, baseAdapter.getDataPath() || undefined)
));

const opencode = {
  ...baseAdapter,
  getRuntimeEnvironment(sessionId: string) {
    const session = baseAdapter.getSession(sessionId);
    return typeof session?.directory === "string"
      ? buildOpenCodeRuntimeEnvironment(sessionId, session.directory)
      : null;
  },
  getSessionTree(sessionId: string) {
    return getOpenCodeTree(sessionId);
  },
  getSessionContainer(sessionId: string) {
    return buildOpenCodeSessionContainer(sessionId, baseAdapter.getDataPath() || undefined);
  },
  getSessionMetrics(sessionId: string) {
    return buildOpenCodeSessionMetrics(sessionId, baseAdapter.getDataPath() || undefined);
  },
  getSessionProtocol(sessionId: string) {
    const tree = getOpenCodeTree(sessionId);
    if (!tree) return null;
    return buildOpenCodeSessionProtocol(tree, this.getStatsRevision());
  },
  getStatsRevision() {
    const dbPath = baseAdapter.getDataPath();
    if (!dbPath) return "missing";
    try {
      const stat = statSync(dbPath);
      return `${dbPath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${dbPath}:missing`;
    }
  },
  getSystemPrompts(sessionId: string) {
    return buildOpenCodeSystemPrompts(sessionId, baseAdapter.getDataPath() || undefined);
  }
};

export default opencode;
