import { buildSessionContext } from "../shared/context.js";

export function buildCodeAgentSessionContext(sessionId: string, dbPath = undefined) {
  return buildSessionContext(sessionId, dbPath, "CodeAgent");
}
