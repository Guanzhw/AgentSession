import assert from "node:assert/strict";
import {
  createHash
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";

import { initConfig } from "../dist/src/config.js";
import { getAllProviders } from "../dist/src/providers/index.js";
import dsh, { discoverSessionFiles, getDshStorageDiagnostic } from "../dist/src/providers/deepseek-harness/adapter.js";
import { DSH_COMPATIBILITY_SNAPSHOT } from "../dist/src/providers/deepseek-harness/compatibility.js";
import {
  DshSessionParseError,
  DSH_KNOWN_EVENT_TYPES,
  decodeDshStorageRecord,
  dshAssistantUsageRecords,
  dshHeader,
  dshInheritedEventCount,
  dshOwnedEvents,
  dshApprovalLifecycle,
  dshPendingApprovalEventIdsFromLifecycle,
  dshUsageOf,
  dshUsageToTokens,
  dshRecordsToMessages,
  dshSessionStatus,
  dshUsageRecords,
  extractDshMeta,
  parseDshSession
} from "../dist/src/providers/deepseek-harness/parser.js";
import { buildDshSessionProtocol } from "../dist/src/providers/deepseek-harness/protocol.js";

function header(id, overrides = {}) {
  return {
    type: "session",
    version: 0,
    id,
    createdAt: Date.now(),
    cwd: "D:\\WorkSpace\\dsh-fixture",
    delegationDepth: 0,
    ...overrides
  };
}

function events(specs, startSeq = 0) {
  const now = Date.now();
  return specs.map((spec, index) => ({
    type: spec.type,
    seq: startSeq + index,
    time: now + startSeq + index,
    data: spec.data || {},
    ...(spec.surfaceOp !== undefined ? { surfaceOp: spec.surfaceOp } : {}),
    ...(spec.sourceEventSeqs !== undefined ? { sourceEventSeqs: spec.sourceEventSeqs } : {}),
    ...(spec.ignorable ? { ignorable: true } : {})
  }));
}

function writeJsonl(filePath, records) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function parentRecords(parentId, childId) {
  return [
    header(parentId, { agentPreset: "standard" }),
    ...events([
      { type: "permission/preset", data: { preset: "read-only" } },
      { type: "sandbox/mode", data: { mode: "read-only" } },
      { type: "approval/policy", data: { policy: "ask" } },
      { type: "turn/start", data: { turn: 1 } },
      { type: "step/start", data: { turn: 1, step: 1 } },
      {
        type: "user/message",
        surfaceOp: "append",
        data: { id: "dsh-user", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "DSH visible user marker" }] }
      },
      {
        type: "user/message",
        surfaceOp: "append",
        data: { id: "dsh-plugin", role: "user", source: { kind: "plugin", plugin: "system", form: "snapshot" }, content: [{ type: "text", text: "DSH hidden plugin marker" }] }
      },
      { type: "session/title", data: { title: "DSH parent title", messageSeqs: [5], source: { kind: "fallback" } } },
      { type: "request/header", data: { reason: "initial", header: { system: "DSH_STORED_SYSTEM_MARKER", config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } },
      { type: "request/context", data: { provider: "deepseek-official", model: "deepseek-v4-flash", contextWindow: 1000000 } },
      {
        type: "assistant/message",
        surfaceOp: "append",
        sourceEventSeqs: [],
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "dsh-assistant",
            role: "assistant",
            source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
            content: [
              { type: "reasoning", text: "DSH reasoning marker" },
              { type: "text", text: "DSH assistant marker" },
              { type: "tool-call", id: "dsh-call", name: "read", arguments: "{\"path\":\"README.md\"}" }
            ]
          },
          usage: { inputTokens: 10, outputTokens: 8, reasoningTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 }
        }
      },
      {
        type: "assistant/message",
        surfaceOp: "append",
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "dsh-zero-usage",
            role: "assistant",
            source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
            content: []
          },
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
      },
      { type: "tool/call", data: { turn: 1, step: 1, callId: "dsh-call", name: "read", arguments: "{\"path\":\"README.md\"}" } },
      {
        type: "tool/result",
        surfaceOp: "append",
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "dsh-tool-result",
            role: "user",
            source: { kind: "tool", callId: "dsh-call" },
            content: [{ type: "tool-result", toolCallId: "dsh-call", content: [{ type: "text", text: "DSH tool output marker" }], isError: false }]
          },
          meta: { path: "README.md" }
        }
      },
      { type: "compaction/start", data: { compactionId: "compact-1", turn: 1 } },
      {
        type: "compaction/summary",
        data: {
          compactionId: "compact-1",
          summary: [{ type: "text", text: "DSH compaction marker" }],
          shadowedRange: { start: 5, end: 10 },
          shadowedSeqs: [5, 6, 10],
          shadowedTokenCount: 20,
          provider: "deepseek-official",
          model: "deepseek-v4-flash"
        }
      },
      {
        type: "user/message",
        surfaceOp: { op: "replace", start: 5, end: 10 },
        sourceEventSeqs: [5, 6, 10],
        data: { id: "dsh-compaction-surface", role: "user", source: { kind: "plugin", plugin: "compaction" }, content: [{ type: "text", text: "DSH hidden compacted context" }] }
      },
      { type: "compaction/end", data: { compactionId: "compact-1", turn: 1 } },
      { type: "tool-workflow/agent-start", data: { runId: "workflow-1", seq: 0, label: "Inspect child", childId } },
      { type: "tool-workflow/agent-end", data: { runId: "workflow-1", seq: 0, outcome: { kind: "completed" } } },
      { type: "agent/inbox/spliced", data: { operation: "claim", messageIds: ["dsh-user"] } },
      {
        type: "team/member",
        data: {
          version: 1,
          teamId: parentId,
          member: { id: childId, name: "inspector", description: "Inspect child", provider: "subagent", context: "fresh", phase: "active" }
        }
      },
      {
        type: "team/task",
        data: {
          version: 1,
          teamId: parentId,
          task: { id: "task-1", revision: 1, subject: "Inspect", description: "Inspect the repository", status: "in_progress", ownerId: childId, blockedBy: [], writeScopes: ["src"] }
        }
      },
      {
        type: "team/message/queued",
        data: {
          version: 1,
          teamId: parentId,
          message: { id: "team-message-1", senderId: parentId, senderName: "lead", targetId: childId, delivery: "quiet", content: [{ type: "text", text: "Inspect this" }] }
        }
      },
      { type: "team/message/delivered", data: { version: 1, teamId: parentId, messageId: "team-message-1", targetId: childId } },
      { type: "step/end", data: { turn: 1, step: 1 } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
    ])
  ];
}

function childRecords(parentId, childId) {
  return [
    header(childId, { parentSession: parentId, origin: "subagent", delegationDepth: 1 }),
    ...events([
      { type: "subagent/descriptor", data: { version: 2, mode: "one-shot", provider: "subagent", label: "Inspect child" } },
      { type: "turn/start", data: { turn: 1 } },
      { type: "step/start", data: { turn: 1, step: 1 } },
      { type: "user/message", surfaceOp: "append", data: { id: "child-user", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "DSH child marker" }] } },
      { type: "assistant/message", surfaceOp: "append", sourceEventSeqs: [], data: { turn: 1, step: 1, message: { id: "child-assistant", role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-pro" }, content: [{ type: "text", text: "DSH child result" }] }, usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
      { type: "step/end", data: { turn: 1, step: 1 } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
    ])
  ];
}

test("DeepSeek Harness provider reads current raw sessions, system evidence, workflow children, and token stats", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-"));
  try {
    const parentId = "session-dsh-parent";
    const childId = "session-dsh-child";
    const parentFile = path.join(root, "sessions", "--dsh-fixture--", "parent-alias", "session.jsonl");
    const childFile = path.join(root, "sessions", "--dsh-fixture--", "child-alias", "session.jsonl");
    writeJsonl(parentFile, parentRecords(parentId, childId));
    writeJsonl(childFile, childRecords(parentId, childId));
    writeFileSync(path.join(root, "AGENTS.md"), "DSH user instruction marker");
    writeFileSync(path.join(root, "cordis.patch.yml"), "credential: SHOULD_NOT_APPEAR");
    initConfig(["--dsh-dir", root]);

    const scanned = [];
    for await (const session of dsh.scan()) scanned.push(session);
    assert.deepEqual(scanned.map((session) => session.id).sort(), [childId, parentId]);
    assert.equal(dsh.getSession("parent-alias")?.id, parentId);
    assert.equal(dsh.getSession(parentId)?.title, "DSH parent title");
    assert.equal(dsh.getSession(childId)?.parentId, parentId);
    assert.equal(dsh.getSession(parentId)?.metadata?.agentPreset, "standard");

    const messages = dsh.getMessages(parentId);
    assert.equal(messages.some((message) => message.content.includes("DSH hidden plugin marker")), false);
    assert.equal(messages.some((message) => message.content.includes("DSH hidden compacted context")), false);
    assert.equal(messages.some((message) => message.content.includes("Inspect this")), false);
    const assistant = messages.find((message) => message.id === "dsh-assistant");
    assert.equal(assistant?.thinking, "DSH reasoning marker");
    assert.deepEqual(assistant?.tokens, { input: 10, output: 5, reasoning: 3, total: 20, cache: { read: 2, write: 0 } });
    const tool = messages.find((message) => message.role === "tool" && message.metadata?.callId === "dsh-call");
    assert.equal(tool?.toolName, "read");
    assert.deepEqual(tool?.toolInput, { path: "README.md" });
    assert.equal(tool?.toolOutput, "DSH tool output marker");
    assert.deepEqual(dsh.searchMessages("DSH visible user marker").map((result) => result.sessionId), [parentId]);
    assert.deepEqual(dsh.searchMessages("DSH hidden plugin marker"), []);

    const protocol = dsh.getSessionProtocol(parentId);
    assert.ok(protocol?.events.some((event) => event.kind === "context.compaction" && event.compaction?.summary === "DSH compaction marker"));
    assert.equal(protocol?.contextArtifacts[0]?.contentAccess, "metadata-only");
    assert.equal(protocol?.contextArtifacts[0]?.summary, null);
    assert.equal(protocol?.tasks[0]?.status, "completed");
    assert.equal(protocol?.agentRuns[0]?.childSessionId, childId);
    assert.ok(protocol?.relationships.some((relationship) => relationship.type === "spawned" && relationship.toSessionId === childId));
    // Team/inbox records are accepted as DSH control facts but remain
    // log-only in this slice; they must not be projected as ordinary
    // normalized messages or require a protocol-v2 mapping.
    assert.deepEqual(protocol?.events.map((event) => event.sequence), Array.from({ length: protocol?.events.length || 0 }, (_, index) => index + 1));
    assert.ok(dsh.getSessionTree(parentId));
    assert.ok(dsh.getSessionMetrics(parentId)?.totals.steps);

    const promptEvidence = dsh.getSystemPrompts(parentId);
    assert.match(JSON.stringify(promptEvidence), /DSH_STORED_SYSTEM_MARKER/);
    assert.doesNotMatch(JSON.stringify(promptEvidence), /SHOULD_NOT_APPEAR/);
    assert.match(JSON.stringify(dsh.getRuntimeEnvironment(parentId)), /AGENTS\.md/);
    const tokenStats = dsh.getTokenStats(30);
    assert.equal(tokenStats.reduce((total, day) => total + day.totalTokens, 0), 27);
    assert.equal(tokenStats.reduce((total, day) => total + day.messageCount, 0), 2);
    // Once a newer canonical generation appears, a malformed winner must
    // invalidate the cached v0 entry rather than resurrecting old content.
    writeJsonl(path.join(path.dirname(parentFile), "session.v2.jsonl"), [
      { type: "session", version: 2, id: parentId, createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: "future/malformed", seq: 0, time: 2, data: {} }
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(dsh.getSession(parentId), null);
    assert.equal(dsh.resumeCommand, undefined);
    assert.equal(dsh.capabilities.localManagement, true);
    assert.ok(getAllProviders().some((provider) => provider.id === "deepseek-harness"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DeepSeek Harness status waits only on an unmatched approval in the current open turn", () => {
  // Source: deepseek-ai/deepseek-harness b2e3b2a0125854567a4a5fcba75782e42fe84901,
  // packages/interaction/user-approval/src/invariant.ts and tests/invariant.spec.ts.
  const completedApproval = [
    header("session-dsh-completed-approval"),
    ...events([
      { type: "turn/start", data: { turn: 1 } },
      { type: "approval/asked", data: { id: "completed-ask", toolName: "bash" } },
      { type: "approval/decided", data: { id: "completed-ask", outcome: "cancelled" } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
    ])
  ];
  assert.equal(dshSessionStatus(completedApproval), "completed");

  const currentAsk = [
    header("session-dsh-pending-approval"),
    ...events([
      { type: "turn/start", data: { turn: 1 } },
      { type: "approval/asked", data: { id: "historical-ask", toolName: "bash" } },
      { type: "approval/decided", data: { id: "historical-ask", outcome: "cancelled" } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
      { type: "turn/start", data: { turn: 2 } },
      { type: "approval/asked", data: { id: "current-ask", toolName: "bash" } }
    ])
  ];
  assert.equal(dshSessionStatus(currentAsk), "waiting_input");
  assert.deepEqual(dshPendingApprovalEventIdsFromLifecycle(dshApprovalLifecycle(currentAsk)), ["event:dsh:5"]);

  const currentResolved = [
    header("session-dsh-resolved-approval"),
    ...events([
      { type: "turn/start", data: { turn: 1 } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
      { type: "turn/start", data: { turn: 2 } },
      { type: "approval/asked", data: { id: "resolved-ask", toolName: "bash" } },
      { type: "approval/decided", data: { id: "resolved-ask", outcome: "allowed-once" } }
    ])
  ];
  assert.equal(dshSessionStatus(currentResolved), "running");
  assert.deepEqual(dshPendingApprovalEventIdsFromLifecycle(dshApprovalLifecycle(currentResolved)), []);
});

test("DeepSeek Harness protocol retains approval audit detail and current canonical refs", () => {
  const records = [
    header("session-dsh-approval-protocol"),
    ...events([
      { type: "turn/start", data: { turn: 1 } },
      { type: "approval/asked", data: { id: "ask-1", toolName: "bash", callId: "call-1", reason: "Need permission" } },
      { type: "approval/decided", data: { id: "ask-1", outcome: "cancelled" } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
      { type: "turn/start", data: { turn: 2 } },
      { type: "approval/asked", data: { id: "ask-2", toolName: "write" } }
    ])
  ];
  const protocol = buildDshSessionProtocol({
    session: extractDshMeta(records),
    records,
    messages: dshRecordsToMessages(records, "session-dsh-approval-protocol"),
    children: []
  });
  assert.equal(protocol.session.state, "waiting_input");
  assert.deepEqual(protocol.session.pendingApprovalEventIds, ["event:dsh:5"]);
  assert.deepEqual(protocol.events[1].approval, {
    state: "asked", toolName: "bash", callId: "call-1", reason: "Need permission", outcome: null
  });
  assert.equal(protocol.events[1].correlationId, "ask-1");
  assert.deepEqual(protocol.events[2].approval, {
    state: "decided", toolName: null, callId: null, reason: null, outcome: "cancelled"
  });
  assert.equal(protocol.events[2].correlationId, "ask-1");
  assert.deepEqual(protocol.events[5].approval, {
    state: "asked", toolName: "write", callId: null, reason: null, outcome: null
  });
});

test("DeepSeek Harness alpha.2 compatibility snapshot and SQLite diagnostic are explicit", () => {
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.commit, "b2e3b2a0125854567a4a5fcba75782e42fe84901");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.headCommit, "b2e3b2a0125854567a4a5fcba75782e42fe84901");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.tag, "dsh-v0.1.5-alpha.2");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.npm.current, "0.1.5-alpha.2");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.sessionFormatVersion, 3);
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.sqliteSchemaVersion, null);
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousRelease.sqliteSchemaVersion, 17);
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousRelease.package, "@deepseek-ai/dsh");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousRelease.version, "0.1.1-rc.2");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousRelease.commit, "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousRelease.tag, "dsh-v0.1.1-rc.2");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousSnapshot.tag, "dsh-v0.1.2-alpha.3");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousSnapshot.fixture.provenance, "derived-current-shape");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousSnapshot.requiredEventTypes.includes("tool/code-dispatch"), true);
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousSnapshot.requiredEventTypes.includes("tool/ptc-dispatch"), false);
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousRelease.requiredEventTypes.includes("system/message"), false);
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousRelease.requiredEventTypes.includes("subagent/catalog"), false);
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.legacyFixture.tag, "dsh-v0.1.0-rc.8");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.fixture.provenance, "official-checked-in-v3-fixture");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.fixture.commit, "b2e3b2a0125854567a4a5fcba75782e42fe84901");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.fixture.sha256, "eb7ecaf5fdd8a2b95959ef9cc5eebba5761848f014e4e1a99eaf6134515898cb");
  assert.ok(DSH_COMPATIBILITY_SNAPSHOT.requiredEventTypes.includes("agent/inbox/spliced"));
  assert.ok(DSH_COMPATIBILITY_SNAPSHOT.requiredEventTypes.includes("team/message/delivered"));
  for (const type of ["model/selection", "session-log-deepseek/delivery-accepted", "subagent/model-selection-policy"]) {
    assert.ok(DSH_COMPATIBILITY_SNAPSHOT.requiredEventTypes.includes(type));
    assert.ok(DSH_KNOWN_EVENT_TYPES.has(type));
    assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousRelease.requiredEventTypes.includes(type), false);
    // The historical alpha.3 snapshot already tracked these facts.
    assert.equal(DSH_COMPATIBILITY_SNAPSHOT.previousSnapshot.requiredEventTypes.includes(type), true);
  }
  assert.deepEqual(
    [...DSH_KNOWN_EVENT_TYPES].sort(),
    [...DSH_COMPATIBILITY_SNAPSHOT.requiredEventTypes].sort()
  );

  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-sqlite-"));
  try {
    writeFileSync(path.join(root, "sessions.sqlite"), Buffer.from("SQLite format 3\u0000fixture"));
    const diagnostic = getDshStorageDiagnostic(root);
    assert.deepEqual(diagnostic && {
      backend: diagnostic.backend,
      status: diagnostic.status,
      detectedSchema: diagnostic.detectedSchema,
      expectedSchema: diagnostic.expectedSchema
    }, { backend: "sqlite", status: "unsupported", detectedSchema: null, expectedSchema: 17 });
    assert.match(diagnostic?.message || "", /schema 17/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official alpha.5 checked-in web snapshot validates after upstream envelope synthesis", () => {
  const fixturePath = path.join(process.cwd(), "test/fixtures/dsh-alpha5-fresh-round-trip.jsonl");
  const hash = createHash("sha256").update(readFileSync(fixturePath)).digest("hex");
  assert.equal(hash, "0747344224d4222f861dd9692c4332badfba221afc6e686c3dee18177055d845", "fixture must stay byte-identical to upstream");

  // Upstream seeds the envelope-free web snapshot through parseSessionLog:
  // seq is synthesised by log order (packed rows advance by their expanded
  // count), timing is 0, and provenance ranges decode at the same boundary.
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-a5-"));
  try {
    const materialized = path.join(root, "alpha5.jsonl");
    const rows = [];
    let nextSeq = 0;
    let headerSkipped = false;
    for (const line of readFileSync(fixturePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      if (!headerSkipped) {
        headerSkipped = true;
        rows.push(typeof value.cwd === "string" && path.isAbsolute(value.cwd) ? value : { ...value, cwd: process.cwd() });
        continue;
      }
      const packed = value.type === "text-chunks" || value.type === "reasoning-chunks" || value.type === "tool-call-chunks";
      const seqKey = packed ? "seq0" : "seq";
      const timeKey = packed ? "time0" : "time";
      if (!Object.hasOwn(value, seqKey)) value[seqKey] = nextSeq;
      if (!Object.hasOwn(value, timeKey)) value[timeKey] = 0;
      rows.push(value);
      nextSeq += decodeDshStorageRecord(value).length;
    }
    writeJsonl(materialized, rows);

    const parsed = parseDshSession(materialized);
    assert.equal(parsed.length, 102);
    assert.deepEqual(dshUsageToTokens({ inputTokens: 1, outputTokens: 1 }), {
      input: 1, output: 1, reasoning: 0, total: 2, cache: { read: 0, write: 0 }
    });
    assert.equal(dshUsageToTokens({ inputTokens: 1, outputTokens: 2, totalTokens: 10 })?.total, 10);
    assert.equal(dshUsageToTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 11 }), null);
    const header = dshHeader(parsed);
    assert.equal(header?.version, 0);
    assert.equal(header?.agentPreset, "standard");
    assert.equal(header?.seedLength, undefined, "unseeded official snapshot has no seedLength");
    const meta = extractDshMeta(parsed, "alpha5-official-fixture");
    assert.equal(meta.id, "{{session:1}}");
    assert.equal(meta.title, "Use the bash tool to");
    assert.equal(meta.messageCount, 4);
    const messages = dshRecordsToMessages(parsed, meta.id);
    const assistants = messages.filter((message) => message.role === "assistant");
    assert.equal(assistants.length, 2);
    assert.ok(assistants.every((message) => message.tokens?.total > 0));
    assert.equal(assistants.length, 2);
    const tool = messages.find((message) => message.role === "tool" && message.metadata?.callId === "call_00_BYXlxjFaalMg95YVqEeF2495");
    assert.equal(tool?.toolName, "bash");
    assert.deepEqual(tool?.toolInput, { command: "echo WEB_E2E_OK", description: "Echo the test string" });
    assert.equal(tool?.toolOutput, "WEB_E2E_OK\n");
    assert.equal(dshAssistantUsageRecords(parsed).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DeepSeek Harness rejects unknown required events and incompatible session versions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-reject-"));
  try {
    const versionPath = path.join(root, "future-version.jsonl");
    writeJsonl(versionPath, [header("session-dsh-future-version", { version: 1 })]);
    assert.throws(() => parseDshSession(versionPath), /Unsupported DeepSeek Harness session version 1/);

    const requiredPath = path.join(root, "future-required.jsonl");
    writeJsonl(requiredPath, [
      header("session-dsh-future-required"),
      { type: "future/required", seq: 0, time: Date.now(), data: {} }
    ]);
    assert.throws(() => parseDshSession(requiredPath), /Unsupported required DeepSeek Harness event/);

    // v0 has no ignorable-event escape hatch; that marker was introduced by
    // the released v1/v2 envelope codecs.
    const ignorablePath = path.join(root, "ignorable.jsonl");
    writeJsonl(ignorablePath, [
      header("session-dsh-ignorable"),
      { type: "future/plugin", seq: 0, time: Date.now(), data: {}, ignorable: true }
    ]);
    assert.throws(() => parseDshSession(ignorablePath), /Unsupported required/);
    const v2IgnorablePath = path.join(root, "v2-ignorable", "session.v2.jsonl");
    writeJsonl(v2IgnorablePath, [
      { type: "session", version: 2, id: "v2-ignorable", createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: "future/plugin", seq: 0, time: Date.now(), data: {}, ignorable: true }
    ]);
    assert.doesNotThrow(() => parseDshSession(v2IgnorablePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DeepSeek Harness parser expands multi-frame Zstd chunks, rejects unsafe vocabulary, and accepts torn prefixes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-zstd-"));
  try {
    const id = "session-dsh-zstd";
    const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(header(id))}\n`));
    const eventFrame = zstdCompressSync(Buffer.from(`${JSON.stringify({
      type: "text-chunks",
      seq0: 0,
      time0: Date.now(),
      data: { turn: 1, step: 1, index: 0, texts: ["packed ", "text"], dt: [1] }
    })}\n${JSON.stringify({
      type: "reasoning-chunks",
      seq0: 2,
      time0: Date.now() + 2,
      data: { turn: 1, step: 1, index: 1, texts: ["reason", "ing"], dt: [2] }
    })}\n${JSON.stringify({
      type: "tool-call-chunks",
      seq0: 4,
      time0: Date.now() + 4,
      data: { turn: 1, step: 1, index: 2, id: "packed-call", name: "read", args: ["{\"path\":", "\"x\"}"], dt: [3] }
    })}\n${JSON.stringify({
      type: "assistant/message",
      seq: 6,
      time: Date.now() + 6,
      data: { turn: 1, step: 1, message: { id: "packed-assistant", role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" }, content: [{ type: "text", text: "packed text" }] } }
    })}\n`));
    const zstdPath = path.join(root, "session.jsonl.zstd");
    writeFileSync(zstdPath, Buffer.concat([headerFrame, eventFrame]));
    const parsed = parseDshSession(zstdPath);
    assert.equal(parsed.length, 8);
    assert.deepEqual(parsed.slice(1).map((event) => event.seq), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(parsed[3]?.data?.chunk?.type, "reasoning-delta");
    assert.deepEqual(parsed[6]?.data?.chunk, {
      type: "tool-call-delta",
      index: 2,
      id: "packed-call",
      name: "read",
      argumentsDelta: "\"x\"}"
    });
    assert.equal(dshRecordsToMessages(parsed, id)[0]?.content, "packed text");
    assert.equal(extractDshMeta(parsed).id, id);

    const alphaPath = path.join(root, "alpha-ranges.jsonl");
    writeJsonl(alphaPath, [
      header("session-dsh-alpha-ranges"),
      ...events([
        { type: "model/selection", data: { provider: "deepseek", model: "deepseek-v4-flash" } },
        { type: "session-log-deepseek/delivery-accepted", data: { sessionId: "session-dsh-alpha-ranges", throughSeq: 0 } },
        { type: "subagent/model-selection-policy", data: { allowedModels: [{ provider: "deepseek-official", model: "deepseek-v4-flash" }] } },
        { type: "assistant/message", sourceEventSeqs: [[0, 2]], data: { message: { id: "alpha-assistant", role: "assistant", content: [{ type: "text", text: "alpha" }] } } }
      ])
    ]);
    const alphaRecords = parseDshSession(alphaPath);
    assert.deepEqual(alphaRecords[4]?.sourceEventSeqs, [0, 1, 2]);

    assert.deepEqual(
      decodeDshStorageRecord({ type: "assistant/message", seq: 4, time: 1, sourceEventSeqs: [0, [1, 3]], data: {} })[0].sourceEventSeqs,
      [0, 1, 2, 3]
    );
    assert.throws(() => decodeDshStorageRecord({ type: "assistant/message", seq: 4, time: 1, sourceEventSeqs: [[3, 2]], data: {} }), /range/);
    assert.throws(() => decodeDshStorageRecord({ type: "assistant/message", seq: 4, time: 1, sourceEventSeqs: [1, [1, 2]], data: {} }), /Non-increasing/);
    assert.throws(() => decodeDshStorageRecord({ type: "assistant/message", seq: 2, time: 1, sourceEventSeqs: [0, [1, 2]], data: {} }), /Too many/);
    assert.throws(() => decodeDshStorageRecord({ type: "assistant/message", seq: 4, time: 1, sourceEventSeqs: [[0, 1, 2]], data: {} }), /range/);
    assert.throws(() => decodeDshStorageRecord({ type: "assistant/message", seq: 4, time: 1, sourceEventSeqs: [-1], data: {} }), /entry/);
    assert.deepEqual(
      decodeDshStorageRecord({ type: "assistant/message", seq: 3, time: 1, sourceEventSeqs: [2, 1], data: {} })[0].sourceEventSeqs,
      [2, 1],
      "flat legacy provenance remains byte-order compatible"
    );

    assert.throws(() => decodeDshStorageRecord({ type: "text-chunks", seq0: 0, time0: 1, data: { turn: 1, step: 1, index: 0, texts: ["bad"], dt: [1] } }), DshSessionParseError);
    assert.throws(() => decodeDshStorageRecord({ type: "tool-call-chunks", seq0: 0, time0: 1, data: { turn: 1, step: 1, index: 0, id: "call", name: 1, args: ["{}"], dt: [] } }), DshSessionParseError);
    assert.throws(() => decodeDshStorageRecord({ type: "text-chunks", seq0: Number.MAX_SAFE_INTEGER, time0: 1, data: { turn: 1, step: 1, index: 0, texts: ["a", "b", "c"], dt: [1, 1] } }), DshSessionParseError);
    assert.throws(() => decodeDshStorageRecord({ type: "text-chunks", seq0: 0, time0: 1, data: { turn: 1, step: 1, index: 0, texts: ["a", "b", "c"], dt: [1, 1], future: true } }), DshSessionParseError);
    const badPath = path.join(root, "unknown.jsonl");
    writeJsonl(badPath, [header("session-dsh-unknown"), { type: "future/required", seq: 0, time: Date.now(), data: {} }]);
    assert.throws(() => parseDshSession(badPath), /Unsupported required/);

    const tornPath = path.join(root, "torn.jsonl.zstd");
    const tornEventFrame = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "turn/start", seq: 0, time: Date.now(), data: { turn: 1 } })}\n`));
    writeFileSync(tornPath, Buffer.concat([headerFrame, tornEventFrame.subarray(0, -5)]));
    assert.deepEqual(parseDshSession(tornPath).map((record) => record.type), ["session"]);

    const rawTornPath = path.join(root, "torn.jsonl");
    writeFileSync(rawTornPath, `${JSON.stringify(header("session-dsh-raw-torn"))}\n${JSON.stringify({ type: "turn/start", seq: 0, time: Date.now(), data: { turn: 1 } })}\n{\"type\":\"turn/end\"`);
    assert.deepEqual(parseDshSession(rawTornPath).map((record) => record.type), ["session", "turn/start"]);

    const missingDepthPath = path.join(root, "missing-depth.jsonl");
    const missingDepth = header("session-dsh-missing-depth");
    delete missingDepth.delegationDepth;
    writeJsonl(missingDepthPath, [missingDepth]);
    assert.equal(parseDshSession(missingDepthPath)[0].delegationDepth, undefined, "rc.8 root-session snapshots may omit delegationDepth");

    const badDepthPath = path.join(root, "bad-depth.jsonl");
    writeJsonl(badDepthPath, [header("session-dsh-bad-depth", { delegationDepth: -1 })]);
    assert.throws(() => parseDshSession(badDepthPath), /session\.delegationDepth/);

    const badPresetPath = path.join(root, "bad-agent-preset.jsonl");
    writeJsonl(badPresetPath, [header("session-dsh-bad-agent-preset", { agentPreset: 42 })]);
    assert.throws(() => parseDshSession(badPresetPath), /session\.agentPreset/);

    const badSeedPath = path.join(root, "bad-seed.jsonl");
    writeJsonl(badSeedPath, [header("session-dsh-bad-seed", { seedLength: 2 }), { type: "turn/start", seq: 0, time: Date.now(), data: { turn: 1 } }]);
    assert.throws(() => parseDshSession(badSeedPath), /seedLength/);

    const badBoundaryPath = path.join(root, "bad-boundary.jsonl");
    writeJsonl(badBoundaryPath, [header("session-dsh-bad-boundary", { seedLength: 1 }), { type: "session/end-seed", seq: 0, time: Date.now(), data: {} }]);
    assert.throws(() => parseDshSession(badBoundaryPath), /end-seed boundary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DeepSeek Harness respects durable seed lineage, all tool result blocks, and interrupted protocol phases", () => {
  const seededId = "session-dsh-seeded";
  const seeded = [
    header(seededId, { seedLength: 1 }),
    ...events([
      {
        type: "assistant/message",
        data: {
          turn: 0,
          step: 0,
          message: {
            id: "inherited-assistant",
            role: "assistant",
            source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
            content: [{ type: "text", text: "inherited seed marker" }]
          },
          usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
      },
      { type: "turn/start", data: { turn: 1 } },
      { type: "session/end-seed", data: {} },
      { type: "user/message", surfaceOp: "append", data: { id: "live-user", source: { kind: "user" }, content: [{ type: "text", text: "live suffix marker" }] } },
      {
        type: "assistant/message",
        surfaceOp: "append",
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "live-assistant",
            role: "assistant",
            source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
            content: [{ type: "text", text: "live result marker" }]
          },
          usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
      }
    ])
  ];
  assert.deepEqual(dshOwnedEvents(seeded).map((event) => event.seq), [1, 2, 3, 4]);
  const seededMessages = dshRecordsToMessages(seeded, seededId);
  assert.equal(seededMessages.some((message) => message.content.includes("inherited seed marker")), false);
  assert.equal(seededMessages.some((message) => message.content.includes("live suffix marker")), true);
  assert.equal(dshAssistantUsageRecords(seeded).length, 1);
  assert.equal(extractDshMeta(seeded).tokenCount, 5);

  const toolId = "session-dsh-multi-result";
  const multiResult = [
    header(toolId),
    ...events([
      { type: "tool/call", data: { turn: 1, step: 1, callId: "call-a", name: "read", arguments: "{}" } },
      { type: "tool/call", data: { turn: 1, step: 1, callId: "call-b", name: "list", arguments: "{}" } },
      {
        type: "tool/result",
        surfaceOp: "append",
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "combined-result",
            source: { kind: "tool", callId: "call-a" },
            content: [
              { type: "tool-result", toolCallId: "call-a", content: [{ type: "text", text: "output A" }] },
              { type: "tool-result", toolCallId: "call-b", content: [{ type: "text", text: "output B" }] }
            ]
          }
        }
      }
    ])
  ];
  assert.deepEqual(
    dshRecordsToMessages(multiResult, toolId)
      .filter((message) => message.role === "tool")
      .map((message) => [message.metadata?.callId, message.toolOutput]),
    [["call-a", "output A"], ["call-b", "output B"]]
  );

  const interruptedId = "session-dsh-interrupted";
  const interrupted = [
    header(interruptedId),
    ...events([
      { type: "turn/start", data: { turn: 1 } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "interrupted" } } }
    ])
  ];
  const interruptedProtocol = buildDshSessionProtocol({
    session: extractDshMeta(interrupted),
    records: interrupted,
    messages: dshRecordsToMessages(interrupted, interruptedId),
    children: []
  });
  assert.equal(interruptedProtocol.events.at(-1)?.phase, "failed");
});

test("DeepSeek Harness selects the highest canonical generation and projects v2 surface/attempt semantics", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opensession-dsh-v2-"));
  try {
    const selectedDir = path.join(root, "sessions", "project", "selected");
    const v0 = header("old-id");
    const v1 = header("canonical-id", { version: 1 });
    writeJsonl(path.join(selectedDir, "session.jsonl"), [v0]);
    writeJsonl(path.join(selectedDir, "session.v1.jsonl"), [v1]);
    const mixedDir = path.join(root, "sessions", "project", "mixed");
    writeJsonl(path.join(mixedDir, "session.v1.jsonl"), [header("mixed-v1", { version: 1 })]);
    writeFileSync(path.join(mixedDir, "session.v2.jsonl.zstd"), zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "session", version: 2, id: "mixed-v2", createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n`)));

    const selected = discoverSessionFiles(root);
    assert.ok(selected.some((entry) => /session\.v1\.jsonl$/.test(entry.filePath)));
    const v1Records = [v1, { type: "turn/start", seq: 0, time: 2, data: { turn: 1 } }];
    const v1RawPath = path.join(root, "v1-raw", "session.v1.jsonl");
    writeJsonl(v1RawPath, v1Records);
    assert.equal(parseDshSession(v1RawPath)[0].version, 1);
    const v1ZstdPath = path.join(root, "v1-zstd", "session.v1.jsonl.zstd");
    mkdirSync(path.dirname(v1ZstdPath), { recursive: true });
    writeFileSync(v1ZstdPath, zstdCompressSync(Buffer.from(`${v1Records.map((record) => JSON.stringify(record)).join("\n")}\n`)));
    assert.equal(parseDshSession(v1ZstdPath)[0].version, 1);
    const v1UnknownPath = path.join(root, "v1-unknown", "session.v1.jsonl");
    writeJsonl(v1UnknownPath, [v1, { type: "future/ignorable", seq: 0, time: 2, data: {}, ignorable: true }]);
    assert.doesNotThrow(() => parseDshSession(v1UnknownPath));
    const v2UnknownPath = path.join(root, "v2-unknown", "session.v2.jsonl");
    writeJsonl(v2UnknownPath, [{ type: "session", version: 2, id: "v2-unknown", createdAt: 1, isSeeded: false, delegationDepth: 0 }, { type: "future/ignorable", seq: 0, time: 2, data: {}, ignorable: true }]);
    assert.doesNotThrow(() => parseDshSession(v2UnknownPath));
    for (const type of ["system/message", "subagent/catalog", "tool/ptc-dispatch"]) {
      const v2FutureRequiredPath = path.join(root, `v2-${type.replaceAll("/", "-")}`, "session.v2.jsonl");
      writeJsonl(v2FutureRequiredPath, [{ type: "session", version: 2, id: `v2-${type}`, createdAt: 1, isSeeded: false, delegationDepth: 0 }, { type, seq: 0, time: 2, data: {} }]);
      assert.throws(() => parseDshSession(v2FutureRequiredPath), /Unsupported required/);
    }

    const file = path.join(root, "v2-session", "session.v2.jsonl");
    const records = [
      { type: "session", version: 2, id: "v2-session", createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: "user/message", seq: 0, time: 1, surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "old" }] } },
      { type: "assistant/attempt", seq: 1, time: 2, data: { turn: 1, step: 1, stream: [{ type: "usage", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }] } },
      { type: "assistant/message", seq: 2, time: 3, surfaceOp: "append", data: { turn: 1, step: 1, stream: [{ type: "usage", usage: { inputTokens: 4, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }], message: { id: "a", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "answer" }, { type: "tool-call", id: "call", name: "read", arguments: "{\"path\":\"x\"}" }] } } },
      { type: "user/message", seq: 3, time: 4, surfaceOp: { op: "replace", start: 0, end: 2 }, sourceEventSeqs: [0, 2], data: { id: "replacement", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "final" }] } },
      { type: "tool/result", seq: 4, time: 5, surfaceOp: "append", data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: "call" }, content: [{ type: "tool-result", toolCallId: "call", content: [{ type: "text", text: "ok" }] }] } } },
      { type: "tool/result", seq: 5, time: 6, surfaceOp: { op: "replace", start: 4, end: 4 }, sourceEventSeqs: [4], data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: "call" }, content: [{ type: "tool-result", toolCallId: "call", content: [{ type: "text", text: "rewritten" }] }] } } },
      { type: "assistant/message", seq: 6, time: 7, surfaceOp: "append", data: { turn: 1, step: 2, message: { id: "empty", role: "assistant", source: { kind: "model" }, content: [] }, usage: { inputTokens: 6, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 } } }
    ];
    writeJsonl(file, records);
    const parsed = parseDshSession(file);
    const compressedFile = path.join(root, "v2-session-compressed", "session.v2.jsonl.zstd");
    mkdirSync(path.dirname(compressedFile), { recursive: true });
    writeFileSync(compressedFile, zstdCompressSync(Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`)));
    assert.equal(parseDshSession(compressedFile)[0].version, 2);
    const messages = dshRecordsToMessages(parsed, "v2-session");
    assert.deepEqual(messages.map((message) => message.content), ["old", "answer", "ok"]);
    assert.deepEqual(dshAssistantUsageRecords(parsed).map((event) => dshUsageOf(event).inputTokens), [4, 6]);
    const protocol = buildDshSessionProtocol({ session: extractDshMeta(parsed), records: parsed, messages, children: [] });
    assert.ok(protocol.events.some((event) => event.kind === "assistant.attempt"));
    assert.deepEqual(protocol.events.find((event) => event.kind === "assistant.attempt")?.providerData?.usage, { input: 1, output: 2, reasoning: 0, total: 3, cache: { read: 0, write: 0 } });
    assert.equal(protocol.events.filter((event) => event.kind === "message.assistant").length, 2);
    for (const [label, mutate] of [
      ["call-id", (data) => ({
        ...data,
        message: { ...data.message, source: { ...data.message.source, callId: "mutated-call" } }
      })],
      ["is-error", (data) => ({
        ...data,
        message: {
          ...data.message,
          content: [{ ...data.message.content[0], isError: true }]
        }
      })]
    ]) {
      const invalidReplacementPath = path.join(root, `tool-result-replacement-${label}`, "session.v2.jsonl");
      writeJsonl(invalidReplacementPath, [
        ...records.slice(0, 6),
        { ...records[6], data: mutate(records[6].data) }
      ]);
      assert.throws(() => parseDshSession(invalidReplacementPath), /only message\.content may change/);
    }
    const retryPath = path.join(root, "retry", "session.v2.jsonl");
    writeJsonl(retryPath, [
      { type: "session", version: 2, id: "retry", createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: "assistant/attempt", seq: 0, time: 1, data: { turn: 1, step: 1, stream: [{ type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }] } },
      { type: "assistant/message", seq: 1, time: 2, surfaceOp: "append", data: { turn: 1, step: 1, message: { source: { kind: "model" }, content: [{ type: "text", text: "settled" }] }, usage: { inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
      { type: "llm/retry-started", seq: 2, time: 3, data: { turn: 1, step: 1 } },
      { type: "assistant/attempt", seq: 3, time: 4, data: { turn: 1, step: 1, stream: [{ type: "usage", usage: { inputTokens: 3, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 } }] } }
    ]);
    const retryRecords = parseDshSession(retryPath);
    assert.deepEqual(dshUsageRecords(retryRecords).map((event) => dshUsageOf(event).inputTokens), [2, 3]);

    const seededPath = path.join(root, "seeded", "session.v2.jsonl");
    const seededRecords = [
      { type: "session", version: 2, id: "seeded", createdAt: 1, isSeeded: true, delegationDepth: 1 },
      { type: "session/title", seq: 0, time: 1, data: { title: "inherited" } },
      { type: "session/end-seed", seq: 1, time: 2, data: { inherited: true } },
      { type: "user/message", seq: 2, time: 3, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "text", text: "own" }] } }
    ];
    writeJsonl(seededPath, seededRecords);
    const seededParsed = parseDshSession(seededPath);
    assert.equal(dshInheritedEventCount(seededParsed), 1);
    assert.deepEqual(dshOwnedEvents(seededParsed).map((event) => event.type), ["session/end-seed", "user/message"]);
    const seededProtocol = buildDshSessionProtocol({ session: extractDshMeta(seededParsed), records: seededParsed, messages: dshRecordsToMessages(seededParsed, "seeded"), children: [] });
    assert.equal(seededProtocol.session?.forkSeedBoundary, 1);
    assert.equal(seededProtocol.session?.inheritedEventCount, 1);
    const missingMarkerPath = path.join(root, "seeded-missing", "session.v2.jsonl");
    writeJsonl(missingMarkerPath, [{ ...seededRecords[0], id: "seeded-missing" }, { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }]);
    assert.throws(() => parseDshSession(missingMarkerPath), /lacks inherited end-seed/);
    const unseededMarkerPath = path.join(root, "unseeded-marker", "session.v2.jsonl");
    writeJsonl(unseededMarkerPath, [{ ...seededRecords[0], id: "unseeded-marker", isSeeded: false }, { ...seededRecords[2], seq: 0 }]);
    assert.throws(() => parseDshSession(unseededMarkerPath), /Unseeded/);
    const illegalMarkerPath = path.join(root, "illegal-marker", "session.v2.jsonl");
    writeJsonl(illegalMarkerPath, [{ ...seededRecords[0], id: "illegal-marker", isSeeded: false }, { ...seededRecords[2], seq: 0, data: { inherited: false } }]);
    assert.throws(() => parseDshSession(illegalMarkerPath), /Invalid session\/end-seed\.inherited/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
