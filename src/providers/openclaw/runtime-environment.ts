import path from "node:path";
import type { RuntimeExtensionReference } from "../interface.js";
import {
  buildRuntimeEnvironment,
  projectDirectories,
  runtimeInstructionFiles,
  scanRuntimeChildren
} from "../shared/runtime-environment.js";

export function buildOpenClawRuntimeEnvironment(
  sessionId: string,
  directory: string,
  stateDir: string,
  agentId: string
) {
  const entries: RuntimeExtensionReference[] = [];
  const workspace = path.join(stateDir, "workspace");
  entries.push(...runtimeInstructionFiles({
    provider: "openclaw",
    scope: "user",
    files: ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md"].map(name => path.join(workspace, name)),
    note: "OpenClaw workspace context files"
  }));
  for (const base of [path.join(stateDir, "skills"), path.join(stateDir, "agents", agentId, "skills")]) {
    entries.push(...scanRuntimeChildren({
      provider: "openclaw", scope: "user", kind: "skill", root: base, markerFile: "SKILL.md",
      note: "OpenClaw user or agent skills"
    }));
  }
  for (const base of projectDirectories(directory)) {
    entries.push(...runtimeInstructionFiles({
      provider: "openclaw",
      scope: "project",
      files: [path.join(base, "AGENTS.md"), path.join(base, "CLAUDE.md")],
      note: "Project context files visible to OpenClaw"
    }));
  }
  return buildRuntimeEnvironment(
    sessionId,
    "Resolved from the current OpenClaw state and project directories. The transcript does not prove the exact historical extension set.",
    entries
  );
}
