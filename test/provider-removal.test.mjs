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
    const configPath = path.join(temp, "legacy.json");
    const legacyConfig = {
      geminiDir: "C:\\old-gemini",
      copilotDir: "C:\\old-copilot",
      projectPaths: {
        gemini: { old: "C:\\old-gemini-project" },
        copilot: { old: "C:\\old-copilot-project" },
        codex: { current: "C:\\current-codex-project" }
      },
      resumeCommands: {
        gemini: { executable: "gemini", args: ["--resume", "{sessionId}"] },
        copilot: { executable: "copilot", args: ["--resume", "{sessionId}"] },
        codex: { executable: "codex", args: ["resume", "{sessionId}"] }
      }
    };
    writeFileSync(configPath, JSON.stringify(legacyConfig));
    const config = parseArgs(["--config", configPath, "--gemini-dir", "C:\\removed-gemini", "--copilot-dir", "C:\\removed-copilot"]);
    assert.equal(Object.hasOwn(config, "geminiDir"), false);
    assert.equal(Object.hasOwn(config, "copilotDir"), false);
    assert.deepEqual(config.projectPaths, { codex: { current: "C:\\current-codex-project" } });
    assert.deepEqual(config.resumeCommands, { codex: { executable: "codex", args: ["resume", "{sessionId}"] } });

    const savedPath = path.join(temp, "saved.json");
    writeUserConfig(savedPath, legacyConfig);
    const saved = JSON.parse(readFileSync(savedPath, "utf8"));
    assert.deepEqual(saved.projectPaths, { codex: { current: "C:\\current-codex-project" } });
    assert.deepEqual(saved.resumeCommands, { codex: { executable: "codex", args: ["resume", "{sessionId}"] } });
    assert.equal(Object.hasOwn(saved, "geminiDir"), false);
    assert.equal(Object.hasOwn(saved, "copilotDir"), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
