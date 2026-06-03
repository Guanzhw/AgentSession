// src/providers/index.ts
import type { ProviderAdapter } from "./interface.js";
import opencode from "./opencode/adapter.js";
import codeagent from "./codeagent/adapter.js";
import claudeCode from "./claude-code/adapter.js";
import codex from "./codex/adapter.js";
import gemini from "./gemini/adapter.js";

const ALL_PROVIDERS: ProviderAdapter[] = [];

export function registerProvider(adapter: ProviderAdapter) {
  ALL_PROVIDERS.push(adapter);
}

export function getAvailableProviders() {
  return ALL_PROVIDERS.filter((p) => p.detect());
}

export function getProvider(id: string): ProviderAdapter | null {
  return ALL_PROVIDERS.find((p) => p.id === id) || null;
}

export function getAllProviders() {
  return [...ALL_PROVIDERS];
}

// --- Provider registration (MUST be after ALL_PROVIDERS declaration) ---
registerProvider(opencode);
registerProvider(codeagent);
registerProvider(claudeCode);
registerProvider(codex);
registerProvider(gemini);
