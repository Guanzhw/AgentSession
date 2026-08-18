import { existsSync } from "node:fs";
import path from "node:path";
import type { RuntimeExtensionReference } from "../interface.js";
import {
  buildRuntimeEnvironment,
  createRuntimeExtension,
  projectDirectories,
  runtimeInstructionFiles,
  scanRuntimeChildren
} from "../shared/runtime-environment.js";

/** DSH patches may contain endpoint and credential references, so expose only metadata. */
function safePatchReference(
  entries: RuntimeExtensionReference[],
  scope: "project" | "user",
  configPath: string,
  note: string
) {
  if (!existsSync(configPath)) return;
  const reference = createRuntimeExtension({
    provider: "deepseek-harness",
    scope,
    kind: "rule",
    name: path.basename(configPath),
    source: configPath,
    sourcePath: configPath,
    sourceType: "config",
    note
  });
  entries.push({ ...reference, sourcePath: null, capturable: false });
}

function addProfileDirectories(entries: RuntimeExtensionReference[], scope: "project" | "user", root: string, note: string) {
  entries.push(...scanRuntimeChildren({
    provider: "deepseek-harness",
    scope,
    kind: "plugin",
    root,
    note
  }).map((entry) => ({ ...entry, capturable: false })));
}

export function buildDshRuntimeEnvironment(sessionId: string, directory: string, dshDir: string) {
  const entries: RuntimeExtensionReference[] = [];
  entries.push(...runtimeInstructionFiles({
    provider: "deepseek-harness",
    scope: "user",
    files: [path.join(dshDir, "AGENTS.md")],
    note: "DeepSeek Harness user-global instructions"
  }));
  safePatchReference(entries, "user", path.join(dshDir, "cordis.patch.yml"), "DeepSeek Harness user patch metadata (content intentionally withheld)");
  addProfileDirectories(entries, "user", path.join(dshDir, "profiles"), "DeepSeek Harness user profile directory");

  for (const base of projectDirectories(directory)) {
    entries.push(...runtimeInstructionFiles({
      provider: "deepseek-harness",
      scope: "project",
      files: [path.join(base, "AGENTS.md")],
      note: "DeepSeek Harness project instructions"
    }));
    const projectDsh = path.join(base, ".dsh");
    safePatchReference(entries, "project", path.join(projectDsh, "cordis.patch.yml"), "DeepSeek Harness project patch metadata (content intentionally withheld)");
    addProfileDirectories(entries, "project", path.join(projectDsh, "profiles"), "DeepSeek Harness project profile directory");
  }

  return buildRuntimeEnvironment(
    sessionId,
    "Resolved from the current DeepSeek Harness user and project configuration. Credentials and patch contents are intentionally never exposed; the persisted request header is shown separately when present.",
    entries
  );
}
