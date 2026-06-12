import os from "node:os";
import path from "node:path";
import type { RuntimeExtensionReference } from "../interface.js";
import {
  buildRuntimeEnvironment,
  projectDirectories,
  scanRuntimeChildren
} from "../shared/runtime-environment.js";

function addKnownRoots(
  entries: RuntimeExtensionReference[],
  scope: "project" | "user",
  base: string
) {
  const kinds = ["skills", "agents", "commands", "plugins", "hooks"] as const;
  for (const directory of kinds) {
    entries.push(...scanRuntimeChildren({
      provider: "codeagent",
      scope,
      kind: directory === "skills" ? "skill" : directory.slice(0, -1) as "agent" | "command" | "plugin" | "hook",
      root: path.join(base, directory),
      markerFile: directory === "skills" ? "SKILL.md" : "",
      note: `${scope}-scoped CodeAgent ${directory}`
    }));
  }
}

export function buildCodeAgentRuntimeEnvironment(sessionId: string, directory: string) {
  const entries: RuntimeExtensionReference[] = [];
  addKnownRoots(entries, "user", path.join(os.homedir(), ".codeagent"));
  addKnownRoots(entries, "user", path.join(os.homedir(), ".agents"));
  for (const base of projectDirectories(directory)) {
    addKnownRoots(entries, "project", path.join(base, ".codeagent"));
    addKnownRoots(entries, "project", path.join(base, ".agents"));
  }
  return buildRuntimeEnvironment(
    sessionId,
    "Resolved from current known CodeAgent user and project extension directories.",
    entries
  );
}
