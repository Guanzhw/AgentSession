import { buildSessionContext } from "../shared/context.js";

export function buildCodeAgentSessionContext(sessionId: string, dbPath: string | undefined = undefined) {
  return buildSessionContext(sessionId, dbPath, "CodeAgent");
}
