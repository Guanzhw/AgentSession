import type { ProviderAdapter } from "./interface.js";
import {
  defaultCapabilityDescriptor,
  emptySessionProtocol,
  type CapabilityDescriptor,
  type ProtocolDomain,
  type SessionProtocol
} from "./shared/session-protocol.js";

export function supportsLocalManagement(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.localManagement === true;
}

export function usesOpenCodeStatsStore(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.openCodeStatsStore === true;
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

export function supportsSessionProtocol(adapter: ProviderAdapter | null | undefined) {
  return typeof adapter?.getSessionProtocol === "function";
}

/**
 * Truthful descriptor for one standardized protocol domain. Providers may
 * declare descriptors only for domains their `getSessionProtocol` actually
 * populates; anything else defaults to support "none".
 */
export function protocolCapability(
  adapter: ProviderAdapter | null | undefined,
  domain: ProtocolDomain
): CapabilityDescriptor {
  return adapter?.protocolCapabilities?.[domain] ?? defaultCapabilityDescriptor();
}

export function supportsProtocolDomain(
  adapter: ProviderAdapter | null | undefined,
  domain: ProtocolDomain
): boolean {
  return protocolCapability(adapter, domain).support !== "none";
}

/** Fixed-shape descriptor map over every standardized protocol domain. */
export function protocolCapabilityDescriptors(
  adapter: ProviderAdapter | null | undefined
): Record<ProtocolDomain, CapabilityDescriptor> {
  return {
    sessionEvents: protocolCapability(adapter, "sessionEvents"),
    sessionRelationships: protocolCapability(adapter, "sessionRelationships"),
    tasks: protocolCapability(adapter, "tasks"),
    agentRuns: protocolCapability(adapter, "agentRuns"),
    contextArtifacts: protocolCapability(adapter, "contextArtifacts")
  };
}

/**
 * Shared protocol access with stable empty arrays: returns the adapter's
 * protocol for the session, an empty protocol when the adapter supports the
 * protocol but the session has none, and null when the adapter does not
 * implement the accessor at all.
 */
export function getSessionProtocolOrDefault(
  adapter: ProviderAdapter | null | undefined,
  sessionId: string
): SessionProtocol | null {
  if (!supportsSessionProtocol(adapter)) return null;
  return adapter!.getSessionProtocol!(sessionId) ?? emptySessionProtocol(sessionId);
}

export function providerFeatureMatrix(adapter: ProviderAdapter | null | undefined) {
  return {
    localManagement: supportsLocalManagement(adapter),
    openCodeStatsStore: usesOpenCodeStatsStore(adapter),
    sessionAnalysis: supportsSessionAnalysis(adapter),
    agentLoopViews: supportsAgentLoopViews(adapter),
    sessionTrace: supportsSessionTrace(adapter),
    systemPromptEvidence: supportsSystemPromptEvidence(adapter),
    runtimeEnvironment: supportsRuntimeEnvironment(adapter),
    protocolEvents: supportsProtocolDomain(adapter, "sessionEvents"),
    protocolRelationships: supportsProtocolDomain(adapter, "sessionRelationships"),
    protocolTasks: supportsProtocolDomain(adapter, "tasks"),
    protocolAgentRuns: supportsProtocolDomain(adapter, "agentRuns"),
    protocolContextArtifacts: supportsProtocolDomain(adapter, "contextArtifacts"),
    resume: Boolean(adapter?.resumeCommand || adapter?.getResumeCommandSpec)
  };
}
