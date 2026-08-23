import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";

import { initConfig } from "../dist/src/config.js";
import { getAllProviders } from "../dist/src/providers/index.js";
import dsh, { getDshStorageDiagnostic } from "../dist/src/providers/deepseek-harness/adapter.js";
import { DSH_COMPATIBILITY_SNAPSHOT } from "../dist/src/providers/deepseek-harness/compatibility.js";
import {
  DshSessionParseError,
  DSH_KNOWN_EVENT_TYPES,
  decodeDshStorageRecord,
  dshAssistantUsageRecords,
  dshOwnedEvents,
  dshRecordsToMessages,
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
          usage: { inputTokens: 10, outputTokens: 8, reasoningTokens: 3, cacheReadTokens: 2 }
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
      { type: "assistant/message", surfaceOp: "append", sourceEventSeqs: [], data: { turn: 1, step: 1, message: { id: "child-assistant", role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-pro" }, content: [{ type: "text", text: "DSH child result" }] }, usage: { inputTokens: 3, outputTokens: 4 } } },
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
    assert.equal(dsh.resumeCommand, undefined);
    assert.equal(dsh.capabilities.localManagement, true);
    assert.ok(getAllProviders().some((provider) => provider.id === "deepseek-harness"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DeepSeek Harness compatibility snapshot and SQLite diagnostic are explicit", () => {
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.commit, "141eb6fef83422698aef7a981029e843e8161534");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.tag, "dsh-v0.1.0-rc.8");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.npm.stable, "0.1.0-rc.7");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.npm.next, "0.1.0-rc.8");
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.sessionFormatVersion, 0);
  assert.equal(DSH_COMPATIBILITY_SNAPSHOT.sqliteSchemaVersion, 17);
  assert.ok(DSH_COMPATIBILITY_SNAPSHOT.requiredEventTypes.includes("agent/inbox/spliced"));
  assert.ok(DSH_COMPATIBILITY_SNAPSHOT.requiredEventTypes.includes("team/message/delivered"));
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
          usage: { inputTokens: 100, outputTokens: 100 }
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
          usage: { inputTokens: 2, outputTokens: 3 }
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
