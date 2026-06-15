import path from "node:path";
import type { RuntimeExtensionReference } from "../interface.js";
import {
  buildRuntimeEnvironment,
  createRuntimeExtension,
  projectDirectories,
  readJsonLike,
  runtimeInstructionFiles,
  scanRuntimeChildren
} from "../shared/runtime-environment.js";

function addGeminiDirectory(
  entries: RuntimeExtensionReference[],
  scope: "project" | "user",
  base: string
) {
  entries.push(
    ...scanRuntimeChildren({
      provider: "gemini",
      scope,
      kind: "extension",
      root: path.join(base, "extensions"),
      markerFile: "gemini-extension.json",
      note: `${scope}-scoped Gemini CLI extensions`
    }),
    ...scanRuntimeChildren({
      provider: "gemini",
      scope,
      kind: "skill",
      root: path.join(base, "skills"),
      markerFile: "SKILL.md",
      note: `${scope}-scoped Gemini CLI skills`
    }),
    ...scanRuntimeChildren({
      provider: "gemini",
      scope,
      kind: "agent",
      root: path.join(base, "agents"),
      fileExtensions: [".md"],
      note: `${scope}-scoped Gemini CLI subagents`
    }),
    ...scanRuntimeChildren({
      provider: "gemini",
      scope,
      kind: "command",
      root: path.join(base, "commands"),
      fileExtensions: [".toml"],
      note: `${scope}-scoped Gemini CLI commands`
    })
  );
}

function addHooks(
  entries: RuntimeExtensionReference[],
  scope: "project" | "user",
  settingsPath: string
) {
  const settings = readJsonLike(settingsPath);
  if (!settings?.hooks || typeof settings.hooks !== "object") return;
  entries.push(createRuntimeExtension({
    provider: "gemini",
    scope,
    kind: "hook",
    name: `${scope} hooks`,
    source: `${settingsPath}#hooks`,
    sourcePath: settingsPath,
    sourceType: "config",
    note: `Hooks configured in ${settingsPath}`
  }));
}

export function buildGeminiRuntimeEnvironment(
  sessionId: string,
  directory: string,
  geminiDir: string
) {
  const entries: RuntimeExtensionReference[] = [];
  addGeminiDirectory(entries, "user", geminiDir);
  entries.push(...runtimeInstructionFiles({
    provider: "gemini",
    scope: "user",
    files: [path.join(geminiDir, "GEMINI.md")],
    note: "Global Gemini CLI context"
  }));
  addHooks(entries, "user", path.join(geminiDir, "settings.json"));
  for (const base of projectDirectories(directory)) {
    const projectGeminiDir = path.join(base, ".gemini");
    addGeminiDirectory(entries, "project", projectGeminiDir);
    entries.push(...runtimeInstructionFiles({
      provider: "gemini",
      scope: "project",
      files: [path.join(base, "GEMINI.md")],
      note: "Project Gemini CLI context"
    }));
    addHooks(entries, "project", path.join(projectGeminiDir, "settings.json"));
  }
  return buildRuntimeEnvironment(
    sessionId,
    "Resolved from current Gemini CLI user and workspace configuration. Selected Gemini extensions may contain commands, hooks, skills, and subagents.",
    entries
  );
}
