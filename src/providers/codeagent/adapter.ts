import os from "node:os";
import path from "node:path";
import { icons } from "../../icons.js";
import { getMessages as getDatabaseMessages } from "../../db.js";
import { createSqliteSessionAdapter } from "../shared/sqlite-adapter.js";
import { buildCodeAgentFlowTree } from "./flow-tree.js";
import { buildCodeAgentSessionContainer } from "./session-container.js";
import { buildCodeAgentSessionMetrics } from "./session-metrics.js";
import { buildCodeAgentSessionTree } from "./session-tree.js";
import { enrichCodeAgentSession } from "./schema.js";

function defaultDataPath() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "db", "ngagent.db");
}

const baseAdapter = createSqliteSessionAdapter({
  id: "codeagent",
  name: "CodeAgent",
  icon: icons.codeagent,
  defaultDataPath,
  resumeCommand: {
    executable: "codeagent",
    args: ["--session", "{sessionId}"]
  },
  capabilities: {
    localManagement: true,
    sqliteSessionStore: true,
    structuredSessionViews: true
  }
});

const codeagent = {
  ...baseAdapter,
  getSession(sessionId: string) {
    const session = baseAdapter.getSession(sessionId);
    if (!session) {
      return null;
    }
    return enrichCodeAgentSession(
      session,
      getDatabaseMessages(sessionId, baseAdapter.getDataPath() || undefined)
    );
  },
  getSessionTree(sessionId: string) {
    return buildCodeAgentSessionTree(sessionId, baseAdapter.getDataPath() || undefined);
  },
  getSessionContainer(sessionId: string) {
    return buildCodeAgentSessionContainer(sessionId, baseAdapter.getDataPath() || undefined);
  },
  getSessionMetrics(sessionId: string) {
    return buildCodeAgentSessionMetrics(sessionId, baseAdapter.getDataPath() || undefined);
  },
  getSessionFlow(sessionId: string) {
    return buildCodeAgentFlowTree(sessionId, baseAdapter.getDataPath() || undefined);
  }
};

export default codeagent;
