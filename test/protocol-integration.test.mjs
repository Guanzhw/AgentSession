import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

// Provider directories come from config flags, so initialize config against
// per-test temp roots before touching the adapters' stores.
const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-protocol-integration-"));
const piRoot = path.join(temp, "pi");
const claudeRoot = path.join(temp, "claude");
const hermesRoot = path.join(temp, "hermes");
mkdirSync(path.join(piRoot, "sessions"), { recursive: true });
mkdirSync(path.join(claudeRoot, "projects", "proj-a", "subagents"), { recursive: true });
mkdirSync(hermesRoot, { recursive: true });

// Pi fixture: the shared pi-current fixture, copied into the temp sessions dir.
writeFileSync(
  path.join(piRoot, "sessions", "019f7b00-0000-7000-8000-000000000001.jsonl"),
  readFileSync(path.join(process.cwd(), "test", "fixtures", "pi-current.jsonl"), "utf-8")
);

// Claude fixture: a parent transcript that launches a subagent via a Task tool
// call and receives a task notification, plus the sidechain transcript.
const claudeParent = [
  { type: "user", uuid: "user-1", timestamp: "2026-06-01T10:00:00.000Z", cwd: "D:\\WorkSpace", message: { content: [{ type: "text", text: "Check this project" }] } },
  { type: "assistant", uuid: "assistant-1", timestamp: "2026-06-01T10:00:01.000Z", message: { content: [{ type: "tool_use", id: "task-call-1", name: "Task", input: { description: "Review the docs" } }] } },
  { type: "user", uuid: "notif-1", timestamp: "2026-06-01T10:00:02.000Z", message: { content: [{ type: "text", text: "<task-notification><task-id>side-agent-1</task-id><tool-use-id>task-call-1</tool-use-id><status>completed</status><summary>Review done</summary></task-notification>" }] } },
  { type: "assistant", uuid: "assistant-2", timestamp: "2026-06-01T10:00:03.000Z", message: { content: [{ type: "text", text: "Done." }] } }
].map((record) => JSON.stringify(record)).join("\n");
writeFileSync(path.join(claudeRoot, "projects", "proj-a", "par-session-1.jsonl"), claudeParent);
const claudeSidechain = [
  { isSidechain: true, agentId: "side-agent-1", sessionId: "par-session-1" },
  { type: "user", uuid: "child-user", timestamp: "2026-06-01T10:00:02.500Z", message: { content: [{ type: "text", text: "Review the docs" }] } },
  { type: "assistant", uuid: "child-asst", timestamp: "2026-06-01T10:00:02.900Z", message: { content: [{ type: "text", text: "Review complete" }] } }
].map((record) => JSON.stringify(record)).join("\n");
writeFileSync(path.join(claudeRoot, "projects", "proj-a", "subagents", "agent-side-agent-1.jsonl"), claudeSidechain);

// Hermes fixture: root session, one compression continuation, one delegate.
const dbPath = path.join(hermesRoot, "state.db");
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT, model TEXT, model_config TEXT, system_prompt TEXT,
    parent_session_id TEXT, started_at REAL, ended_at REAL, end_reason TEXT, title TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
    cache_write_tokens INTEGER, reasoning_tokens INTEGER, cwd TEXT, billing_provider TEXT,
    archived INTEGER DEFAULT 0
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT,
    tool_calls TEXT, tool_name TEXT, effect_disposition TEXT, timestamp REAL,
    finish_reason TEXT, reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT,
    platform_message_id TEXT, active INTEGER DEFAULT 1
  );
`);
const started = Date.parse("2026-08-02T02:00:00.000Z") / 1000;
const insertSession = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
insertSession.run("hermes-root", "cli", "deepseek-v4-flash", "{}", null, null, started, started + 5.5, "compression", "Hermes fixture", 40, 15, 10, 0, 5, hermesRoot, "deepseek", 0);
insertSession.run("hermes-compression", "cli", "deepseek-v4-flash", "{}", null, "hermes-root", started + 6, started + 7, "compression", null, 0, 0, 0, 0, 0, hermesRoot, "deepseek", 0);
insertSession.run("hermes-delegate", "delegate", "deepseek-v4-flash", JSON.stringify({ _delegate_from: "hermes-root" }), null, "hermes-root", started + 8, started + 9, "stop", "Review delegate", 0, 0, 0, 0, 0, hermesRoot, "deepseek", 0);
const insertMessage = db.prepare("INSERT INTO messages (session_id, role, content, tool_calls, timestamp, finish_reason, reasoning, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)");
insertMessage.run("hermes-root", "user", "Hermes marker", null, started, null, null);
insertMessage.run("hermes-root", "assistant", "", JSON.stringify([{ id: "hdelegate", function: { name: "delegate_task", arguments: JSON.stringify({ task: "Summarize the workspace" }) } }]), started + 4, "tool_calls", null);
db.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp, active) VALUES (?, 'tool', ?, ?, ?, ?, 1)").run("hermes-root", JSON.stringify({ task: "Summarize the workspace", status: "ok" }), "hdelegate", "delegate_task", started + 5);
insertMessage.run("hermes-root", "assistant", "Hermes ready", null, started + 3, "stop", null);
insertMessage.run("hermes-compression", "user", "Root compression question", null, started + 6.2, null, null);
insertMessage.run("hermes-compression", "assistant", "Root compression reply", null, started + 6.8, "stop", null);
insertMessage.run("hermes-delegate", "user", "Delegate request", null, started + 8, null, null);
insertMessage.run("hermes-delegate", "assistant", "Delegate response text", null, started + 9, "stop", null);
db.close();

const { initConfig } = await import("../dist/src/config.js");
initConfig(["--pi-dir", piRoot, "--claude-dir", claudeRoot, "--hermes-dir", hermesRoot]);
const pi = (await import("../dist/src/providers/pi/adapter.js")).default;
const claudeCode = (await import("../dist/src/providers/claude-code/adapter.js")).default;
const hermes = (await import("../dist/src/providers/hermes/adapter.js")).default;

test.after(() => {
  try { rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("Pi adapter protocol reaches the real store and view path without fabricating subagents", () => {
  const sessionId = "019f7b00-0000-7000-8000-000000000001";
  const protocol = pi.getSessionProtocol(sessionId);
  assert.ok(protocol, "adapter exposes a protocol for the fixture session");
  assert.equal(protocol.sessionId, sessionId);
  const compactionEvents = protocol.events.filter((event) => event.kind === "context.compaction");
  assert.equal(compactionEvents.length, 1);
  assert.equal(compactionEvents[0].compaction.strategy, "summary");
  assert.equal(compactionEvents[0].provenance.fidelity, "recorded");
  assert.equal(protocol.tasks.length, 0);
  assert.equal(protocol.agentRuns.length, 0);
  assert.equal(protocol.relationships.length, 1);
  assert.equal(protocol.relationships[0].type, "parent");
  const artifact = protocol.contextArtifacts[0];
  assert.equal(artifact.kind, "summary");
  assert.equal(artifact.contentAccess, "metadata-only");
  assert.equal(artifact.summary, null);
  assert.deepEqual(artifact.sourceSessionIds, [sessionId]);

  // The real view path (adapter store -> linked message session views) runs
  // with the protocol evidence attached and stays subagent-free.
  const tree = pi.getSessionTree(sessionId);
  assert.ok(tree, "structured tree builds from the fixture");
  assert.equal(tree.metrics.toolCallCount, 1);
  assert.equal(tree.metrics.descendantCount, 0, "parent lineage never fabricates subagent branches");
  const flow = pi.getSessionFlow(sessionId);
  assert.equal(flow.summary.subagents, 0);

  // Compatibility system messages remain marked as derived.
  const messages = pi.getMessages(sessionId);
  const compactionMessage = messages.find((message) => message.metadata?.type === "compaction");
  assert.ok(compactionMessage);
  assert.equal(compactionMessage.metadata.compatibility, true);
  assert.equal(compactionMessage.metadata.protocolKind, "context.compaction");
});

test("Claude adapter protocol evidence reaches buildLinkedMessageSessionViews through the real store", () => {
  const parentId = "par-session-1";
  const childId = "side-agent-1";

  const protocol = claudeCode.getSessionProtocol(parentId);
  assert.ok(protocol, "adapter exposes a protocol for the parent session");
  assert.equal(protocol.tasks.length, 1);
  assert.equal(protocol.tasks[0].id, childId);
  assert.equal(protocol.tasks[0].toolCallId, "task-call-1");
  assert.equal(protocol.tasks[0].status, "completed");
  assert.equal(protocol.agentRuns.length, 1);
  assert.equal(protocol.agentRuns[0].childSessionId, childId);
  assert.equal(
    protocol.relationships.some((relationship) => (
      relationship.type === "spawned"
      && relationship.fromSessionId === parentId
      && relationship.toSessionId === childId
      && relationship.correlationId === "task-call-1"
    )),
    true
  );

  // The adapter's structured views consume the same protocol evidence: the
  // Task tool call attaches the sidechain child explicitly (not inferred).
  const tree = claudeCode.getSessionTree(parentId);
  assert.ok(tree, "structured tree builds from the claude fixture");
  const taskPart = tree.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool" && part.tool === "Task");
  assert.ok(taskPart, "Task tool part exists");
  assert.equal(taskPart.childSessions[0].session.id, childId);
  assert.equal(tree.detachedChildren.length, 0);
  assert.equal(tree.metrics.descendantCount, 1);
  assert.equal(tree.metrics.totalMessages, 5, "parent messages plus the attached child");
  const flow = claudeCode.getSessionFlow(parentId);
  assert.equal(flow.summary.subagents, 1);

  // The child's own protocol names the recorded sidechain relationship.
  const childProtocol = claudeCode.getSessionProtocol(childId);
  assert.equal(
    childProtocol.relationships.some((relationship) => (
      relationship.type === "spawned"
      && relationship.fromSessionId === parentId
      && relationship.provenance.fidelity === "recorded"
    )),
    true
  );
});

test("Hermes adapter protocol evidence reaches the merged lineage view path", () => {
  const protocol = hermes.getSessionProtocol("hermes-root");
  assert.ok(protocol);
  assert.equal(
    protocol.relationships.some((relationship) => (
      relationship.type === "compacted-into"
      && relationship.toSessionId === "hermes-compression"
    )),
    true
  );
  const compactionEvents = protocol.events.filter((event) => event.kind === "context.compaction");
  assert.equal(compactionEvents.length, 1);
  assert.equal(compactionEvents[0].compaction.continuationSessionId, "hermes-compression");
  assert.equal(protocol.tasks.length, 1);
  assert.equal(protocol.tasks[0].kind, "delegate");
  assert.equal(protocol.tasks[0].mode, undefined);
  assert.equal(protocol.agentRuns.length, 1);
  assert.equal(protocol.agentRuns[0].childSessionId, "hermes-delegate");
  assert.equal(protocol.contextArtifacts.length, 1);
  assert.equal(protocol.contextArtifacts[0].kind, "summary");
  assert.equal(protocol.contextArtifacts[0].contentAccess, "metadata-only");
  assert.equal(protocol.contextArtifacts[0].summary, null);

  // The view path merges compression segments into one logical session and
  // keeps the delegate attached without recursion or cache loops.
  const tree = hermes.getSessionTree("hermes-root");
  assert.ok(tree);
  assert.equal(tree.session.id, "hermes-root");
  const texts = tree.messages.flatMap((message) => message.parts).map((part) => part.data?.text).filter(Boolean);
  assert.ok(texts.some((text) => String(text).includes("Root compression question")), "compression segment merged");
  assert.ok(texts.some((text) => String(text).includes("Hermes ready")));
  const delegatePart = tree.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool" && part.tool === "delegate_task");
  assert.ok(delegatePart, "delegate spawn part exists");
  assert.equal(delegatePart.childSessions[0].session.id, "hermes-delegate");
  assert.equal(hermes.getSessionFlow("hermes-root").summary.subagents, 1);
  // The compression continuation is not a subagent branch.
  const childTree = hermes.getSessionTree("hermes-compression");
  assert.equal(childTree.session.id, "hermes-root", "compression resolves back to the logical base");
});

test("protocol accessors answer null for unknown sessions on real adapters", () => {
  assert.equal(pi.getSessionProtocol("no-such-session"), null);
  assert.equal(claudeCode.getSessionProtocol("no-such-session"), null);
  assert.equal(hermes.getSessionProtocol("no-such-session"), null);
  assert.equal(pi.getSessionProtocol(""), null);
});
