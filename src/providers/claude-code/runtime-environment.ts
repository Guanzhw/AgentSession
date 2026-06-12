import path from "node:path";
import type { RuntimeExtensionReference } from "../interface.js";
import {
  buildRuntimeEnvironment,
  createRuntimeExtension,
  projectDirectories,
  readJsonLike,
  scanRuntimeChildren
} from "../shared/runtime-environment.js";

function addClaudeDirectory(
  entries: RuntimeExtensionReference[],
  scope: "project" | "user",
  base: string
) {
  entries.push(
    ...scanRuntimeChildren({
      provider: "claude-code",
      scope,
      kind: "skill",
      root: path.join(base, "skills"),
      markerFile: "SKILL.md",
      note: `${scope}-scoped Claude Code skills`
    }),
    ...scanRuntimeChildren({
      provider: "claude-code",
      scope,
      kind: "agent",
      root: path.join(base, "agents"),
      fileExtensions: [".md"],
      note: `${scope}-scoped Claude Code subagents`
    }),
    ...scanRuntimeChildren({
      provider: "claude-code",
      scope,
      kind: "command",
      root: path.join(base, "commands"),
      fileExtensions: [".md"],
      note: `${scope}-scoped Claude Code commands`
    }),
    ...scanRuntimeChildren({
      provider: "claude-code",
      scope,
      kind: "plugin",
      root: path.join(base, "plugins"),
      note: `${scope}-scoped Claude Code plugins`
    })
  );
}

function addSettings(
  entries: RuntimeExtensionReference[],
  scope: "project" | "user",
  settingsPath: string
) {
  const settings = readJsonLike(settingsPath);
  if (!settings) return;
  if (settings.hooks && typeof settings.hooks === "object") {
    entries.push(createRuntimeExtension({
      provider: "claude-code",
      scope,
      kind: "hook",
      name: `${scope} hooks`,
      source: `${settingsPath}#hooks`,
      sourcePath: settingsPath,
      sourceType: "config",
      note: `Hooks configured in ${settingsPath}`
    }));
  }
  const enabledPlugins = settings.enabledPlugins && typeof settings.enabledPlugins === "object"
    ? Object.keys(settings.enabledPlugins).filter((name) => settings.enabledPlugins[name] !== false)
    : [];
  for (const plugin of enabledPlugins) {
    entries.push(createRuntimeExtension({
      provider: "claude-code",
      scope,
      kind: "plugin",
      name: plugin,
      source: `${settingsPath}#enabledPlugins:${plugin}`,
      sourceType: "package",
      note: `Enabled in ${settingsPath}`
    }));
  }
}

export function buildClaudeCodeRuntimeEnvironment(
  sessionId: string,
  directory: string,
  claudeDir: string
) {
  const entries: RuntimeExtensionReference[] = [];
  addClaudeDirectory(entries, "user", claudeDir);
  addSettings(entries, "user", path.join(claudeDir, "settings.json"));
  for (const base of projectDirectories(directory)) {
    const projectClaudeDir = path.join(base, ".claude");
    addClaudeDirectory(entries, "project", projectClaudeDir);
    addSettings(entries, "project", path.join(projectClaudeDir, "settings.json"));
    addSettings(entries, "project", path.join(projectClaudeDir, "settings.local.json"));
  }
  return buildRuntimeEnvironment(
    sessionId,
    "Resolved from current Claude Code user and project configuration. Plugin-provided components are represented by the plugin when separately discoverable files are unavailable.",
    entries
  );
}
