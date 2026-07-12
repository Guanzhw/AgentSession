import { buildFlowTree } from "../shared/flow-tree.js";
import { buildOpenCodeSessionContainer } from "./session-container.js";
import { buildOpenCodeSessionMetrics } from "./session-metrics.js";

export type { FlowNode, FlowTree } from "../shared/flow-tree.js";

export function buildOpenCodeFlowTree(sessionId: string, dbPath: string | undefined = undefined) {
  return buildFlowTree(
    sessionId,
    dbPath,
    buildOpenCodeSessionContainer,
    buildOpenCodeSessionMetrics
  );
}
