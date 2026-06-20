import os from "node:os";
import path from "node:path";
import { icons } from "../../icons.js";
import { createSqliteSessionAdapter } from "../shared/sqlite-adapter.js";
import { buildOpenCodeFlowTree } from "./flow-tree.js";
import { buildOpenCodeSessionContainer } from "./session-container.js";
import { buildOpenCodeSessionMetrics } from "./session-metrics.js";
import { buildOpenCodeSessionTree } from "./session-tree.js";
import { buildOpenCodeSystemPrompts } from "./system-prompts.js";
import { buildOpenCodeRuntimeEnvironment } from "./runtime-environment.js";

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

const baseAdapter = createSqliteSessionAdapter({
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
    sqliteSessionStore: true,
    structuredSessionViews: true
  }
});

const opencode = {
  ...baseAdapter,
  getRuntimeEnvironment(sessionId: string) {
    const session = baseAdapter.getSession(sessionId);
    return typeof session?.directory === "string"
      ? buildOpenCodeRuntimeEnvironment(sessionId, session.directory)
      : null;
  },
  getSessionTree(sessionId: string) {
    return buildOpenCodeSessionTree(sessionId, baseAdapter.getDataPath() || undefined);
  },
  getSessionContainer(sessionId: string) {
    return buildOpenCodeSessionContainer(sessionId, baseAdapter.getDataPath() || undefined);
  },
  getSessionMetrics(sessionId: string) {
    return buildOpenCodeSessionMetrics(sessionId, baseAdapter.getDataPath() || undefined);
  },
  getSessionFlow(sessionId: string) {
    return buildOpenCodeFlowTree(sessionId, baseAdapter.getDataPath() || undefined);
  },
  getSystemPrompts(sessionId: string) {
    return buildOpenCodeSystemPrompts(sessionId, baseAdapter.getDataPath() || undefined);
  }
};

export default opencode;
