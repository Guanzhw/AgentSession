import { buildSessionContext } from "../shared/context.js";

export type {
  ContextDiff,
  ContextItem,
  ContextStep,
  SessionContextView
} from "../shared/context.js";

export function buildOpenCodeSessionContext(sessionId: string, dbPath = undefined) {
  return buildSessionContext(sessionId, dbPath, "OpenCode");
}
