import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-protocol-v2-adapters-"));
const piRoot = path.join(temp, "pi");
mkdirSync(path.join(piRoot, "sessions"), { recursive: true });
copyFileSync(
  path.join(process.cwd(), "test", "fixtures", "pi-current.jsonl"),
  path.join(piRoot, "sessions", "019f7b00-0000-7000-8000-000000000001.jsonl")
);

const { initConfig } = await import("../dist/src/config.js");
initConfig(["--pi-dir", piRoot]);
const pi = (await import("../dist/src/providers/pi/adapter.js")).default;
const claude = (await import("../dist/src/providers/claude-code/adapter.js")).default;
const codex = (await import("../dist/src/providers/codex/adapter.js")).default;
const hermes = (await import("../dist/src/providers/hermes/adapter.js")).default;

test.after(() => {
  try { rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("Pi adapter returns a finalized v2 protocol with truthful branch topology", async () => {
  const sessions = [];
  for await (const session of pi.scan()) sessions.push(session);
  assert.equal(sessions.length, 1);
  const protocol = pi.getSessionProtocol(sessions[0].id);
  assert.ok(protocol);
  assert.equal(protocol.version, 2);
  assert.deepEqual(protocol.session.ref, { provider: "pi", sessionId: sessions[0].id });
  assert.equal(protocol.validation.ok, true);
  assert.equal(protocol.branches.length, 1);
  assert.equal(protocol.branches[0].parentBranchId, sessions[0].parentId ? `branch:${sessions[0].parentId}` : null);
  assert.equal(protocol.relationships.some((relationship) => relationship.type === "spawned"), false);
  assert.equal(protocol.agentRuns.length, 0);
});

test("migrated provider capabilities keep canonical v2 branch and mixed-fidelity claims explicit", () => {
  assert.equal(pi.protocolCapabilities.branches.support, "partial");
  assert.equal(codex.protocolCapabilities.branches.support, "none");
  assert.equal(hermes.protocolCapabilities.branches.support, "none");
  assert.equal(claude.protocolCapabilities.sessionRelationships.support, "partial");
  assert.equal(claude.protocolCapabilities.sessionRelationships.provenance, "derived");
});
