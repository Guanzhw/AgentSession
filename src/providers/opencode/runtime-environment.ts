import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import type { RuntimeExtensionReference } from "../interface.js";
import {
  buildRuntimeEnvironment,
  createRuntimeExtension,
  projectDirectories,
  readJsonLike,
  scanRuntimeChildren
} from "../shared/runtime-environment.js";

function globalConfigDir() {
  return process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
}

function addDirectoryKinds(
  entries: RuntimeExtensionReference[],
  scope: "project" | "user",
  base: string
) {
  const definitions = [
    ["skill", "skills", [], "SKILL.md"],
    ["agent", "agents", [".md"], ""],
    ["command", "commands", [".md"], ""],
    ["plugin", "plugins", [".js", ".mjs", ".cjs", ".ts"], ""],
    ["hook", "hooks", [".js", ".mjs", ".cjs", ".ts", ".json"], ""],
    ["tool", "tools", [".js", ".mjs", ".cjs", ".ts"], ""]
  ] as const;
  for (const [kind, directory, fileExtensions, markerFile] of definitions) {
    entries.push(...scanRuntimeChildren({
      provider: "opencode",
      scope,
      kind,
      root: path.join(base, directory),
      fileExtensions: [...fileExtensions],
      markerFile,
      note: `${scope}-scoped OpenCode ${directory}`
    }));
  }
}

function addConfiguredPlugins(
  entries: RuntimeExtensionReference[],
  scope: "project" | "user",
  configPath: string
) {
  if (!existsSync(configPath)) return;
  const config = readJsonLike(configPath);
  const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
  for (const plugin of plugins) {
    if (typeof plugin !== "string" || !plugin.trim()) continue;
    entries.push(createRuntimeExtension({
      provider: "opencode",
      scope,
      kind: "plugin",
      name: plugin,
      source: `${configPath}#plugin:${plugin}`,
      sourceType: "package",
      note: `Configured in ${configPath}`
    }));
  }
}

export function buildOpenCodeRuntimeEnvironment(sessionId: string, directory: string) {
  const entries: RuntimeExtensionReference[] = [];
  const userConfigDirs = [...new Set([
    globalConfigDir(),
    process.env.OPENCODE_CONFIG_DIR || "",
    path.join(os.homedir(), ".opencode")
  ].filter(Boolean).map((entry) => path.resolve(entry)))];
  for (const userConfig of userConfigDirs) {
    addDirectoryKinds(entries, "user", userConfig);
    addConfiguredPlugins(entries, "user", path.join(userConfig, "opencode.json"));
    addConfiguredPlugins(entries, "user", path.join(userConfig, "opencode.jsonc"));
  }
  if (process.env.OPENCODE_CONFIG) {
    addConfiguredPlugins(entries, "user", path.resolve(process.env.OPENCODE_CONFIG));
  }

  for (const base of projectDirectories(directory)) {
    addDirectoryKinds(entries, "project", path.join(base, ".opencode"));
    addConfiguredPlugins(entries, "project", path.join(base, "opencode.json"));
    addConfiguredPlugins(entries, "project", path.join(base, "opencode.jsonc"));
  }

  const skillRoots: Array<["project" | "user", string]> = [
    ["user", path.join(os.homedir(), ".claude", "skills")],
    ["user", path.join(os.homedir(), ".agents", "skills")]
  ];
  for (const base of projectDirectories(directory)) {
    skillRoots.push(
      ["project", path.join(base, ".claude", "skills")],
      ["project", path.join(base, ".agents", "skills")]
    );
  }
  for (const [scope, root] of skillRoots) {
    entries.push(...scanRuntimeChildren({
      provider: "opencode",
      scope,
      kind: "skill",
      root,
      markerFile: "SKILL.md",
      note: `${scope}-scoped compatible skill directory`
    }));
  }

  return buildRuntimeEnvironment(
    sessionId,
    "Resolved from the current local OpenCode configuration and session project. Transcripts do not prove the exact historical runtime set.",
    entries
  );
}
