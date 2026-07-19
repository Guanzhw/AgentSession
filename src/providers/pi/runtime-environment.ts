import { existsSync } from "node:fs";
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

function addPiDirectory(entries: RuntimeExtensionReference[], scope: "project" | "user", base: string) {
  const definitions = [
    ["skill", "skills", [], "SKILL.md"],
    ["agent", "agents", [".md"], ""],
    ["extension", "extensions", [".js", ".mjs", ".cjs", ".ts"], ""],
    ["command", "prompts", [".md"], ""],
    ["command", "prompt-templates", [".md"], ""]
  ] as const;
  for (const [kind, directory, fileExtensions, markerFile] of definitions) {
    entries.push(...scanRuntimeChildren({
      provider: "pi",
      scope,
      kind,
      root: path.join(base, directory),
      fileExtensions: [...fileExtensions],
      markerFile,
      note: `${scope}-scoped Pi ${directory}`
    }));
  }

  const settingsPath = path.join(base, "settings.json");
  if (existsSync(settingsPath)) {
    entries.push(createRuntimeExtension({
      provider: "pi",
      scope,
      kind: "rule",
      name: `${scope} settings`,
      source: settingsPath,
      sourcePath: settingsPath,
      sourceType: "config",
      note: `Pi settings resolved from ${settingsPath}`
    }));
    const settings = readJsonLike(settingsPath);
    const packages = Array.isArray(settings?.packages) ? settings.packages : [];
    for (const packageEntry of packages) {
      const packageName = typeof packageEntry === "string"
        ? packageEntry.trim()
        : typeof packageEntry?.source === "string"
          ? packageEntry.source.trim()
          : "";
      if (!packageName) continue;
      entries.push(createRuntimeExtension({
        provider: "pi",
        scope,
        kind: "plugin",
        name: packageName,
        source: `${settingsPath}#package:${packageName}`,
        sourceType: "package",
        note: `Pi package configured in ${settingsPath}`
      }));
    }
  }
}

export function buildPiRuntimeEnvironment(sessionId: string, directory: string, piDir: string) {
  const entries: RuntimeExtensionReference[] = [];
  addPiDirectory(entries, "user", piDir);
  entries.push(...runtimeInstructionFiles({
    provider: "pi",
    scope: "user",
    files: [path.join(piDir, "AGENTS.md"), path.join(piDir, "CLAUDE.md")],
    note: "Pi user-level context files"
  }));

  for (const base of projectDirectories(directory)) {
    addPiDirectory(entries, "project", path.join(base, ".pi"));
    entries.push(...runtimeInstructionFiles({
      provider: "pi",
      scope: "project",
      files: [path.join(base, "AGENTS.md"), path.join(base, "CLAUDE.md")],
      note: "Pi project context files"
    }));
  }

  return buildRuntimeEnvironment(
    sessionId,
    "Resolved from the current Pi user and project configuration. Session transcripts do not prove the exact historical extension set.",
    entries
  );
}
