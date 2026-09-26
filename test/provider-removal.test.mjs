import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyRuntimeUserConfig, parseArgs, writeUserConfig } from "../dist/src/config.js";
import { getAllProviders, getProvider } from "../dist/src/providers/index.js";

test("retired providers stay unavailable at the public boundary", () => {
  const providerIds = getAllProviders().map((provider) => provider.id);
  assert.deepEqual(providerIds, ["opencode", "claude-code", "codex", "pi", "deepseek-harness"]);
  for (const id of ["gemini", "copilot", "openclaw", "hermes"]) {
    assert.equal(getProvider(id), null);
  }

  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-provider-removal-"));
  try {
    // This test validates retired-config cleanup, not Windows path semantics:
    // paths are derived from the temp directory so they are absolute on every platform.
    const legacyGeminiDir = path.join(temp, "old-gemini");
    const legacyCopilotDir = path.join(temp, "old-copilot");
    const legacyGeminiProject = path.join(temp, "old-gemini-project");
    const legacyCopilotProject = path.join(temp, "old-copilot-project");
    const legacyOpenClawProject = path.join(temp, "old-openclaw-project");
    const legacyHermesProject = path.join(temp, "old-hermes-project");
    const legacyCodexProject = path.join(temp, "current-codex-project");
    const removedGeminiDir = path.join(temp, "removed-gemini");
    const removedCopilotDir = path.join(temp, "removed-copilot");
    const configPath = path.join(temp, "legacy.json");
    const legacyConfig = {
      geminiDir: legacyGeminiDir,
      copilotDir: legacyCopilotDir,
      openclawDir: path.join(temp, "old-openclaw"),
      hermesDir: path.join(temp, "old-hermes"),
      projectPaths: {
        gemini: { old: legacyGeminiProject },
        copilot: { old: legacyCopilotProject },
        openclaw: { old: legacyOpenClawProject },
        hermes: { old: legacyHermesProject },
        codex: { current: legacyCodexProject }
      },
      resumeCommands: {
        gemini: { executable: "gemini", args: ["--resume", "{sessionId}"] },
        copilot: { executable: "copilot", args: ["--resume", "{sessionId}"] },
        openclaw: { executable: "openclaw", args: ["--resume", "{sessionId}"] },
        hermes: { executable: "hermes", args: ["--resume", "{sessionId}"] },
        codex: { executable: "codex", args: ["resume", "{sessionId}"] }
      }
    };
    writeFileSync(configPath, JSON.stringify(legacyConfig));
    const config = parseArgs(["--config", configPath, "--gemini-dir", removedGeminiDir, "--copilot-dir", removedCopilotDir]);
    assert.equal(Object.hasOwn(config, "geminiDir"), false);
    assert.equal(Object.hasOwn(config, "copilotDir"), false);
    assert.equal(Object.hasOwn(config, "openclawDir"), false);
    assert.equal(Object.hasOwn(config, "hermesDir"), false);
    assert.deepEqual(config.projectPaths, { codex: { current: legacyCodexProject } });
    assert.deepEqual(config.resumeCommands, { codex: { executable: "codex", args: ["resume", "{sessionId}"] } });
    for (const flag of ["--openclaw-dir", "--hermes-dir"]) {
      assert.throws(() => parseArgs([flag, temp]), /not supported in AgentSession 2\.0/);
    }

    const runtime = applyRuntimeUserConfig({}, legacyConfig);
    assert.deepEqual(runtime.projectPaths, { codex: { current: legacyCodexProject } });
    assert.deepEqual(runtime.resumeCommands, { codex: { executable: "codex", args: ["resume", "{sessionId}"] } });

    const savedPath = path.join(temp, "saved.json");
    writeUserConfig(savedPath, legacyConfig);
    const saved = JSON.parse(readFileSync(savedPath, "utf8"));
    assert.deepEqual(saved.projectPaths, { codex: { current: legacyCodexProject } });
    assert.deepEqual(saved.resumeCommands, { codex: { executable: "codex", args: ["resume", "{sessionId}"] } });
    assert.equal(Object.hasOwn(saved, "geminiDir"), false);
    assert.equal(Object.hasOwn(saved, "copilotDir"), false);
    assert.equal(Object.hasOwn(saved, "openclawDir"), false);
    assert.equal(Object.hasOwn(saved, "hermesDir"), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
