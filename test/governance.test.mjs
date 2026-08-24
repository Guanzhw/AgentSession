import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concreteProviderIdLiterals,
  concreteProviderImports,
  runChecks,
  validateDecisionFile,
  verifyMarkdownLinks
} from "../scripts/verify-governance.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("repository governance checks pass", () => {
  assert.deepEqual(runChecks(), []);
});

test("decision records enforce lifecycle and required sections", () => {
  const file = join(repoRoot, ".agents", "decisions", "implemented", "2026-08-24-agent-native-governance.md");
  assert.deepEqual(validateDecisionFile(file), []);
});

test("decision records accept CRLF and reject malformed or empty records", () => {
  const root = mkdtempSync(join(tmpdir(), "agentsession-governance-"));
  const directory = join(root, "implemented");
  mkdirSync(directory);
  const valid = [
    "---",
    "status: implemented",
    "date: 2026-08-24",
    "decision: Keep the record testable.",
    "---",
    "",
    "# Decision",
    "",
    "## Context",
    "Context.",
    "## Decision",
    "Decision.",
    "## Alternatives considered",
    "Alternative.",
    "## Consequences",
    "Consequence.",
    "## Verification",
    "Verification."
  ].join("\r\n");
  try {
    const validFile = join(directory, "2026-08-24-valid-record.md");
    writeFileSync(validFile, valid);
    assert.deepEqual(validateDecisionFile(validFile), []);

    const malformedFile = join(directory, "2026-08-24-malformed-record.md");
    writeFileSync(malformedFile, valid.replace("\r\n---\r\n\r\n# Decision", "\r\n\r\n# Decision"));
    assert.match(validateDecisionFile(malformedFile).join("\n"), /closed YAML front matter/);

    const invalidDateFile = join(directory, "2026-08-24-invalid-date.md");
    writeFileSync(invalidDateFile, valid.replace("date: 2026-08-24", "date: 2026-99-99"));
    assert.match(validateDecisionFile(invalidDateFile).join("\n"), /real YYYY-MM-DD calendar date/);

    const emptyFile = join(directory, "2026-08-24-empty-section.md");
    writeFileSync(emptyFile, valid.replace("## Consequences\r\nConsequence.", "## Consequences\r\n"));
    assert.match(validateDecisionFile(emptyFile).join("\n"), /Consequences.*must not be empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Markdown checks cover inline and reference-style local targets", () => {
  const root = mkdtempSync(join(tmpdir(), "agentsession-markdown-"));
  try {
    const inline = join(root, "inline.md");
    const reference = join(root, "reference.md");
    writeFileSync(inline, "[missing](missing.md)\n");
    writeFileSync(reference, "[missing][ref]\n\n[ref]: other-missing.md\n");
    assert.equal(verifyMarkdownLinks([inline, reference]).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("architecture probes reject concrete provider paths and identifiers", () => {
  assert.deepEqual(concreteProviderImports('import { build } from "../codex/protocol.js";'), ["../codex/protocol.js"]);
  assert.deepEqual(concreteProviderImports('const value = await import("../../deepseek-harness/parser.js");'), ["../../deepseek-harness/parser.js"]);
  assert.deepEqual(concreteProviderImports('import type { ProviderAdapter } from "../interface.js";'), []);
  assert.deepEqual(concreteProviderIdLiterals('if (id !== "codex") return;'), ["codex"]);
  assert.deepEqual(concreteProviderIdLiterals('switch (provider.id) { case "pi": break; }'), ["pi"]);
});

test("local pre-push and CI quality gates have distinct evidence scopes", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["pre-push"], "npm run review");
  assert.equal(packageJson.scripts["ci:quality"], "npm run review && npm test");

  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "quality.yml"), "utf8");
  assert.match(workflow, /run: npm run ci:quality/);
  assert.doesNotMatch(workflow, /run: npm run pre-push/);
});
