import { buildSessionMetrics } from "../shared/session-metrics.js";
import { buildOpenCodeSessionContainer } from "./session-container.js";
import { buildOpenCodeSessionContext } from "./context.js";

export type { SessionMetricsView } from "../shared/session-metrics.js";

export function buildOpenCodeSessionMetrics(sessionId: string, dbPath = undefined) {
  return buildSessionMetrics(
    sessionId,
    dbPath,
    buildOpenCodeSessionContainer,
    buildOpenCodeSessionContext
  );
}
