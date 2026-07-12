import { buildSessionMetrics } from "../shared/session-metrics.js";
import { buildCodeAgentSessionContainer } from "./session-container.js";
import { buildCodeAgentSessionContext } from "./context.js";

export function buildCodeAgentSessionMetrics(sessionId: string, dbPath: string | undefined = undefined) {
  return buildSessionMetrics(
    sessionId,
    dbPath,
    buildCodeAgentSessionContainer,
    buildCodeAgentSessionContext
  );
}
