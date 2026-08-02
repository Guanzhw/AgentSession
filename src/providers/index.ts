// src/providers/index.ts
import type { ProviderAdapter } from "./interface.js";
import opencode from "./opencode/adapter.js";
import claudeCode from "./claude-code/adapter.js";
import codex from "./codex/adapter.js";
import openclaw from "./openclaw/adapter.js";
import hermes from "./hermes/adapter.js";
import copilot from "./copilot/adapter.js";
import gemini from "./gemini/adapter.js";
import pi from "./pi/adapter.js";

const ALL_PROVIDERS: readonly ProviderAdapter[] = [
  opencode,
  claudeCode,
  codex,
  openclaw,
  hermes,
  copilot,
  gemini,
  pi
];
const PROVIDERS_BY_ID = new Map(ALL_PROVIDERS.map(provider => [provider.id, provider]));
if (PROVIDERS_BY_ID.size !== ALL_PROVIDERS.length) {
  throw new Error("Provider registry contains duplicate IDs");
}

export function getAvailableProviders() {
  return ALL_PROVIDERS.filter((p) => p.detect());
}

export function getProvider(id: string): ProviderAdapter | null {
  return PROVIDERS_BY_ID.get(id as ProviderAdapter["id"]) || null;
}

export function getAllProviders() {
  return [...ALL_PROVIDERS];
}
