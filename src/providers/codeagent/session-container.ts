import { buildSessionContainer } from "../shared/session-container.js";
import { buildCodeAgentSessionTree } from "./session-tree.js";

export function buildCodeAgentSessionContainer(sessionId: string, dbPath = undefined) {
  return buildSessionContainer(sessionId, dbPath, buildCodeAgentSessionTree);
}
