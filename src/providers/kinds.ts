import type { ProviderAdapter } from "./interface.js";

export function supportsLocalManagement(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.localManagement === true;
}

export function usesSqliteSessionStore(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.sqliteSessionStore === true;
}

export function supportsStructuredSessionViews(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.structuredSessionViews === true;
}
