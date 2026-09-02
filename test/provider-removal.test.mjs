import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs, writeUserConfig } from "../dist/src/config.js";
import { getAllProviders, getProvider } from "../dist/src/providers/index.js";

test("removed Gemini and Copilot providers stay unavailable at the public boundary", () => {
  const providerIds = getAllProviders().map((provider) => provider.id);
  assert.deepEqual(providerIds, ["opencode", "claude-code", "codex", "openclaw", "hermes", "pi", "deepseek-harness"]);
  assert.equal(getProvider("gemini"), null);
  assert.equal(getProvider("copilot"), null);

  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-provider-removal-"));
  try {
    // This test validates retired-config cleanup, not Windows path semantics:
    // paths are derived from the temp directory so they are absolute on every platform.
    const legacyGeminiDir = path.join(temp, "old-gemini");
    const legacyCopilotDir = path.join(temp, "old-copilot");
    const legacyGeminiProject = path.join(temp, "old-gemini-project");
    const legacyCopilotProject = path.join(temp, "old-copilot-project");
    const legacyCodexProject = path.join(temp, "current-codex-project");
    const removedGeminiDir = path.join(temp, "removed-gemini");
    const removedCopilotDir = path.join(temp, "removed-copilot");
    const configPath = path.join(temp, "legacy.json");
    const legacyConfig = {
      geminiDir: legacyGeminiDir,
      copilotDir: legacyCopilotDir,
      projectPaths: {
        gemini: { old: legacyGeminiProject },
        copilot: { old: legacyCopilotProject },
        codex: { current: legacyCodexProject }
      },
      resumeCommands: {
        gemini: { executable: "gemini", args: ["--resume", "{sessionId}"] },
        copilot: { executable: "copilot", args: ["--resume", "{sessionId}"] },
        codex: { executable: "codex", args: ["resume", "{sessionId}"] }
      }
    };
    writeFileSync(configPath, JSON.stringify(legacyConfig));
    const config = parseArgs(["--config", configPath, "--gemini-dir", removedGeminiDir, "--copilot-dir", removedCopilotDir]);
    assert.equal(Object.hasOwn(config, "geminiDir"), false);
    assert.equal(Object.hasOwn(config, "copilotDir"), false);
    assert.deepEqual(config.projectPaths, { codex: { current: legacyCodexProject } });
    assert.deepEqual(config.resumeCommands, { codex: { executable: "codex", args: ["resume", "{sessionId}"] } });

    const savedPath = path.join(temp, "saved.json");
    writeUserConfig(savedPath, legacyConfig);
    const saved = JSON.parse(readFileSync(savedPath, "utf8"));
    assert.deepEqual(saved.projectPaths, { codex: { current: legacyCodexProject } });
    assert.deepEqual(saved.resumeCommands, { codex: { executable: "codex", args: ["resume", "{sessionId}"] } });
    assert.equal(Object.hasOwn(saved, "geminiDir"), false);
    assert.equal(Object.hasOwn(saved, "copilotDir"), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
