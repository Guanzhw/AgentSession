import type { ProviderId } from "./interface.js";

export function isOpenCodeLikeProvider(providerId: string | ProviderId | null | undefined) {
  return providerId === "opencode" || providerId === "codeagent";
}
