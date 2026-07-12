import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeExtensionReference } from "../interface.js";
import {
  buildRuntimeEnvironment,
  createRuntimeExtension,
  projectDirectories,
  runtimeInstructionFiles,
  scanRuntimeChildren
} from "../shared/runtime-environment.js";

function addSkills(
  entries: RuntimeExtensionReference[],
  scope: "project" | "user",
  root: string,
  note: string
) {
  entries.push(...scanRuntimeChildren({
    provider: "codex",
    scope,
    kind: "skill",
    root,
    markerFile: "SKILL.md",
    note
  }));
}

function addPluginConfig(
  entries: RuntimeExtensionReference[],
  scope: "project" | "user",
  configPath: string
) {
  if (!existsSync(configPath)) return;
  let text = "";
  try {
    text = readFileSync(configPath, "utf-8");
  } catch (err) {
    console.warn("Failed to read plugin config:", configPath, err);
    return;
  }
  const names = [...text.matchAll(/^\s*\[plugins\.([^\]]+)\]\s*$/gm)]
    .map((match) => match[1].trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  for (const name of names) {
    entries.push(createRuntimeExtension({
      provider: "codex",
      scope,
      kind: "plugin",
      name,
      source: `${configPath}#plugins.${name}`,
      sourcePath: configPath,
      sourceType: "config",
      note: `Configured in ${configPath}`
    }));
  }
}

function firstExisting(paths: string[]) {
  return paths.find((filePath) => existsSync(filePath)) || "";
}

export function buildCodexRuntimeEnvironment(
  sessionId: string,
  directory: string,
  codexDir: string
) {
  const entries: RuntimeExtensionReference[] = [];
  const globalInstruction = firstExisting([
    path.join(codexDir, "AGENTS.override.md"),
    path.join(codexDir, "AGENTS.md")
  ]);
  entries.push(...runtimeInstructionFiles({
    provider: "codex",
    scope: "user",
    files: globalInstruction ? [globalInstruction] : [],
    note: "Global Codex instructions"
  }));
  addSkills(entries, "user", path.join(os.homedir(), ".agents", "skills"), "User-scoped Codex skills");
  addSkills(entries, "user", path.join(codexDir, "skills"), "Codex-managed user and bundled skills");
  entries.push(...scanRuntimeChildren({
    provider: "codex",
    scope: "user",
    kind: "rule",
    root: path.join(codexDir, "rules"),
    note: "User-scoped Codex rules"
  }));
  addPluginConfig(entries, "user", path.join(codexDir, "config.toml"));

  for (const base of projectDirectories(directory)) {
    const instruction = firstExisting([
      path.join(base, "AGENTS.override.md"),
      path.join(base, "AGENTS.md")
    ]);
    entries.push(...runtimeInstructionFiles({
      provider: "codex",
      scope: "project",
      files: instruction ? [instruction] : [],
      note: "Project Codex instructions"
    }));
    addSkills(entries, "project", path.join(base, ".agents", "skills"), "Project-scoped Codex skills");
    addSkills(entries, "project", path.join(base, ".codex", "skills"), "Project Codex skills");
    entries.push(...scanRuntimeChildren({
      provider: "codex",
      scope: "project",
      kind: "rule",
      root: path.join(base, ".codex", "rules"),
      note: "Project-scoped Codex rules"
    }));
    addPluginConfig(entries, "project", path.join(base, ".codex", "config.toml"));
  }
  return buildRuntimeEnvironment(
    sessionId,
    "Resolved from current Codex user and project configuration. The transcript does not contain an immutable historical extension manifest.",
    entries
  );
}
