import type { ProviderAdapter } from "./interface.js";
import {
  defaultCapabilityDescriptor,
  type CapabilityDescriptor,
  type ProtocolDomain
} from "./shared/session-protocol.js";

export function supportsLocalManagement(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.localManagement === true;
}

export function usesOpenCodeStatsStore(adapter: ProviderAdapter | null | undefined) {
  return adapter?.capabilities?.openCodeStatsStore === true;
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

/** Fixed-shape descriptor map over every standardized protocol domain. */
export function protocolCapabilityDescriptors(
  adapter: ProviderAdapter | null | undefined
): Record<ProtocolDomain, CapabilityDescriptor> {
  return {
    sessionEvents: protocolCapability(adapter, "sessionEvents"),
    sessionRelationships: protocolCapability(adapter, "sessionRelationships"),
    tasks: protocolCapability(adapter, "tasks"),
    agentRuns: protocolCapability(adapter, "agentRuns"),
    contextArtifacts: protocolCapability(adapter, "contextArtifacts"),
    branches: protocolCapability(adapter, "branches")
  };
}
