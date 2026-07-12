import { buildSessionContainer } from "../shared/session-container.js";
import { buildOpenCodeSessionTree } from "./session-tree.js";

export type {
  MessageContainer,
  PartContainer,
  SessionContainer
} from "../shared/session-container.js";

export function buildOpenCodeSessionContainer(sessionId: string, dbPath: string | undefined = undefined) {
  return buildSessionContainer(sessionId, dbPath, buildOpenCodeSessionTree);
}
