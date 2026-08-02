import path from "node:path";
import type { RuntimeExtensionReference } from "../interface.js";
import {
  buildRuntimeEnvironment,
  createRuntimeExtension,
  projectDirectories,
  runtimeInstructionFiles,
  scanRuntimeChildren
} from "../shared/runtime-environment.js";

export function buildHermesRuntimeEnvironment(sessionId: string, directory: string, hermesDir: string) {
  const entries: RuntimeExtensionReference[] = [];
  entries.push(...runtimeInstructionFiles({
    provider: "hermes", scope: "user",
    files: [path.join(hermesDir, "SOUL.md"), path.join(hermesDir, "AGENTS.md")],
    note: "Hermes user-level instructions"
  }));
  entries.push(...scanRuntimeChildren({
    provider: "hermes", scope: "user", kind: "skill",
    root: path.join(hermesDir, "skills"), markerFile: "SKILL.md",
    note: "Hermes user skills"
  }));
  for (const name of ["config.yaml", "config.yml"]) {
    const sourcePath = path.join(hermesDir, name);
    entries.push(createRuntimeExtension({
      provider: "hermes", scope: "user", kind: "rule", name: "Hermes configuration",
      source: sourcePath, sourcePath, sourceType: "config",
      note: "Current Hermes provider, model, tool, and runtime settings"
    }));
  }
  for (const base of projectDirectories(directory)) {
    entries.push(...runtimeInstructionFiles({
      provider: "hermes", scope: "project",
      files: [path.join(base, "AGENTS.md"), path.join(base, "CLAUDE.md")],
      note: "Project context files visible to Hermes"
    }));
  }
  return buildRuntimeEnvironment(
    sessionId,
    "Resolved from the current Hermes home and project directories. Stored session prompts are presented separately as historical evidence.",
    entries
  );
}
