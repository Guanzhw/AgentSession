import { buildFlowTree } from "../shared/flow-tree.js";
import { buildCodeAgentSessionContainer } from "./session-container.js";
import { buildCodeAgentSessionMetrics } from "./session-metrics.js";

export function buildCodeAgentFlowTree(sessionId: string, dbPath: string | undefined = undefined) {
  return buildFlowTree(
    sessionId,
    dbPath,
    buildCodeAgentSessionContainer,
    buildCodeAgentSessionMetrics
  );
}
