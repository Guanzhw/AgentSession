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

function addHooks(entries: RuntimeExtensionReference[], scope: "project" | "user", configPath: string) {
  const config = readJsonLike(configPath);
  if (!config || typeof config.hooks !== "object" || !config.hooks) return;
  entries.push(createRuntimeExtension({
    provider: "copilot",
    scope,
    kind: "hook",
    name: `${scope} hooks`,
    source: `${configPath}#hooks`,
    sourcePath: configPath,
    sourceType: "config",
    note: `Hooks configured in ${configPath}`
  }));
}

function addCopilotExtensions(entries: RuntimeExtensionReference[], scope: "project" | "user", root: string) {
  entries.push(
    ...scanRuntimeChildren({
      provider: "copilot",
      scope,
      kind: "agent",
      root: path.join(root, "agents"),
      fileExtensions: [".md"],
      note: `${scope}-scoped Copilot custom agents`
    }),
    ...scanRuntimeChildren({
      provider: "copilot",
      scope,
      kind: "skill",
      root: path.join(root, "skills"),
      markerFile: "SKILL.md",
      note: `${scope}-scoped Copilot skills`
    }),
    ...scanRuntimeChildren({
      provider: "copilot",
      scope,
      kind: "plugin",
      root: path.join(root, "plugins"),
      note: `${scope}-scoped Copilot plugins`
    }),
    ...scanRuntimeChildren({
      provider: "copilot",
      scope,
      kind: "hook",
      root: path.join(root, "hooks"),
      fileExtensions: [".json"],
      note: `${scope}-scoped Copilot hooks`
    })
  );
}

export function buildCopilotRuntimeEnvironment(sessionId: string, directory: string, copilotDir: string) {
  const entries: RuntimeExtensionReference[] = [];
  addCopilotExtensions(entries, "user", copilotDir);
  entries.push(...runtimeInstructionFiles({
    provider: "copilot",
    scope: "user",
    files: [
      path.join(copilotDir, "AGENTS.md"),
      path.join(copilotDir, "copilot-instructions.md")
    ],
    note: "User Copilot CLI instructions"
  }));
  addHooks(entries, "user", path.join(copilotDir, "config.json"));

  for (const base of projectDirectories(directory)) {
    const githubDir = path.join(base, ".github");
    addCopilotExtensions(entries, "project", githubDir);
    entries.push(...runtimeInstructionFiles({
      provider: "copilot",
      scope: "project",
      files: [
        path.join(base, "AGENTS.md"),
        path.join(githubDir, "copilot-instructions.md")
      ],
      note: "Project Copilot CLI instructions"
    }));
    entries.push(...scanRuntimeChildren({
      provider: "copilot",
      scope: "project",
      kind: "instruction",
      root: path.join(githubDir, "instructions"),
      fileExtensions: [".md"],
      note: "Project Copilot instruction files"
    }));
    addHooks(entries, "project", path.join(githubDir, "settings.json"));
  }

  return buildRuntimeEnvironment(
    sessionId,
    "Resolved from current Copilot CLI instruction, agent, skill, plugin, and hook sources. Provider-managed system events are intentionally not reconstructed from the transcript.",
    entries
  );
}
