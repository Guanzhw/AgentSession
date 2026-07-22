import type { ProviderAdapter } from "./interface.js";

export function supportsLocalManagement(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.localManagement === true;
}

export function usesSqliteSessionStore(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.sqliteSessionStore === true;
}

export function supportsSessionAnalysis(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.sessionAnalysis === true;
}

export function supportsStructuredSessionViews(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.structuredSessionViews === true;
}

/**
 * The Tree/Container/Metrics/Flow bundle is the common rendered form of the
 * Agent Loop. Check both the declaration and its concrete methods so a future
 * provider cannot advertise a half-implemented view bundle.
 */
export function supportsAgentLoopViews(adapter: ProviderAdapter | null | undefined) {
  return supportsStructuredSessionViews(adapter)
    && typeof adapter?.getSessionTree === "function"
    && typeof adapter?.getSessionContainer === "function"
    && typeof adapter?.getSessionMetrics === "function"
    && typeof adapter?.getSessionFlow === "function";
}

export function supportsSessionTrace(adapter: ProviderAdapter | null | undefined) {
  return supportsAgentLoopViews(adapter) && typeof adapter?.getTrace === "function";
}

export function supportsSystemPromptEvidence(adapter: ProviderAdapter | null | undefined) {
  return typeof adapter?.getSystemPrompts === "function";
}

export function supportsRuntimeEnvironment(adapter: ProviderAdapter | null | undefined) {
  return typeof adapter?.getRuntimeEnvironment === "function";
}

export function providerFeatureMatrix(adapter: ProviderAdapter | null | undefined) {
  return {
    localManagement: supportsLocalManagement(adapter),
    sqliteSessionStore: usesSqliteSessionStore(adapter),
    sessionAnalysis: supportsSessionAnalysis(adapter),
    agentLoopViews: supportsAgentLoopViews(adapter),
    sessionTrace: supportsSessionTrace(adapter),
    systemPromptEvidence: supportsSystemPromptEvidence(adapter),
    runtimeEnvironment: supportsRuntimeEnvironment(adapter),
    resume: Boolean(adapter?.resumeCommand)
  };
}
