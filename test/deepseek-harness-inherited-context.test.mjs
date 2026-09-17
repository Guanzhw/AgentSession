import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initConfig } from "../dist/src/config.js";
import {
  dshRecordsToInheritedMessages,
  dshRecordsToMessages,
  parseDshSession
} from "../dist/src/providers/deepseek-harness/parser.js";
import { renderInheritedContextPage } from "../dist/src/views/session.js";

function seededRecords(version, id, backgroundCount) {
  const now = Date.now();
  const prefix = [];
  const push = (target, type, data, surfaceOp) => {
    const seq = target.length;
    target.push({ type, seq, time: now + seq, data, ...(surfaceOp ? { surfaceOp } : {}) });
  };
  for (let index = 0; index < backgroundCount; index += 1) {
    push(prefix, "user/message", {
      id: `background-${index}`, role: "user", source: { kind: "user" },
      content: [{ type: "text", text: index === backgroundCount - 1 ? `BACKGROUND_LAST ${"long background ".repeat(800)}` : `BACKGROUND_ONLY ${index}` }]
    }, "append");
  }
  push(prefix, "assistant/message", {
    turn: 0, step: 0,
    message: {
      id: "background-assistant", role: "assistant", source: { kind: "model", provider: "deepseek", model: "fixture" },
      content: [
        { type: "reasoning", text: "background reasoning" },
        { type: "text", text: "background answer" },
        { type: "tool-call", id: "background-call", name: "read", arguments: '{"path":"background.md"}' }
      ]
    },
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }, "append");
  push(prefix, "tool/result", {
    turn: 0, step: 0,
    message: {
      id: "background-result", role: "tool", source: { kind: "tool", callId: "background-call" },
      content: [{ type: "tool-result", toolCallId: "background-call", content: [{ type: "text", text: "background tool output" }], isError: false }]
    }
  }, "append");
  const boundary = prefix.length;
  const rows = [...prefix];
  push(rows, "session/end-seed", version >= 2 ? { inherited: true } : {});
  push(rows, "user/message", {
    id: "owned-user", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "OWNED_REQUEST" }]
  }, "append");
  push(rows, "assistant/message", {
    turn: 1, step: 1,
    message: { id: "owned-assistant", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "OWNED_ANSWER" }] },
    usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }, "append");
  const header = {
    type: "session", version, id, parentSession: "recorded-missing-parent", createdAt: now, delegationDepth: 1,
    ...(version >= 2 ? { isSeeded: true } : { seedLength: boundary })
  };
  return {
    records: [header, ...rows],
    originalPrefix: [{ ...header, ...(version >= 2 ? { isSeeded: false } : { seedLength: 0 }) }, ...prefix]
  };
}

function writeFixture(root, version, id, records) {
  const file = path.join(root, "sessions", "fixture", id, version ? `session.v${version}.jsonl` : "session.jsonl");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

for (const version of [0, 1, 2, 3]) {
  test(`DSH v${version} discloses the complete inherited prefix without changing owned history or usage`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-dsh-inherited-"));
    try {
      const id = `inherited-v${version}`;
      const backgroundCount = version % 2 ? 43 : 2;
      const { records, originalPrefix } = seededRecords(version, id, backgroundCount);
      const file = writeFixture(root, version, id, records);
      const beforeHash = createHash("sha256").update(readFileSync(file)).digest("hex");
      const parsed = parseDshSession(file);
      initConfig(["--dsh-dir", root]);
      const { default: dsh } = await import(`../dist/src/providers/deepseek-harness/adapter.js?inherited-v${version}`);

      const owned = structuredClone(dsh.getMessages(id));
      const metrics = structuredClone(dsh.getSessionMetrics(id));
      const protocol = structuredClone(dsh.getSessionProtocol(id));
      const usage = structuredClone(dsh.getTokenStats(30));
      const context = dsh.getInheritedContext(id);
      assert.deepEqual(context.sourceSession, { provider: "deepseek-harness", sessionId: "recorded-missing-parent" });
      assert.equal(dsh.getSession("recorded-missing-parent"), null, "the recorded source need not remain locally readable");
      assert.equal(context.total, backgroundCount + 2);
      assert.equal(context.messages.length, context.total);
      assert.equal(context.truncated, false, "the accessor retains every message for reader pagination");

      const expected = dshRecordsToMessages(originalPrefix, id).map((message) => ({
        ...message, tokens: null, metadata: { ...message.metadata, provenance: "inherited-parent-context" }
      }));
      assert.deepEqual(context.messages, expected, "all normalized source fields and canonical IDs survive the prefix split");
      assert.deepEqual(dshRecordsToInheritedMessages(parsed, id), expected);
      assert.deepEqual(context.messages.map((message) => message.id), [
        ...Array.from({ length: backgroundCount }, (_, index) => `background-${index}`), "background-assistant", "background-call"
      ]);
      assert.equal(context.messages.find((message) => message.id === "background-assistant").thinking, "background reasoning");
      const tool = context.messages.find((message) => message.id === "background-call");
      assert.deepEqual(tool.toolInput, { path: "background.md" });
      assert.equal(tool.toolOutput, "background tool output");
      assert.equal(context.messages[backgroundCount - 1].content, `BACKGROUND_LAST ${"long background ".repeat(800)}`);
      assert.ok(context.messages.every((message) => message.sessionId === id && message.tokens === null));

      const first = renderInheritedContextPage(context, "deepseek-harness");
      assert.equal(first.shown, Math.min(40, context.total));
      if (context.total > 40) {
        assert.equal(first.nextOffset, 40);
        const last = renderInheritedContextPage(context, "deepseek-harness", first.nextOffset);
        assert.equal(last.shown, context.total);
        assert.equal(last.nextOffset, null);
        assert.match(last.html, /BACKGROUND_LAST/);
        assert.match(last.html, /data-content-scope="inherited-context"/);
        assert.match(last.html, /background-call/);
      } else {
        assert.equal(first.nextOffset, null);
      }

      assert.deepEqual(dsh.getMessages(id), owned);
      assert.deepEqual(owned.map((message) => message.id), ["owned-user", "owned-assistant"]);
      assert.deepEqual(dsh.getSessionMetrics(id), metrics);
      assert.deepEqual(dsh.getSessionProtocol(id), protocol);
      assert.deepEqual(dsh.getTokenStats(30), usage);
      assert.equal(usage.reduce((sum, day) => sum + day.totalTokens, 0), 7);
      assert.deepEqual(dsh.searchMessages("BACKGROUND_ONLY"), []);
      assert.deepEqual(dsh.searchMessages("OWNED_REQUEST").map((match) => match.sessionId), [id]);
      assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), beforeHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("DSH inherited disclosure needs recorded lineage and a readable prefix", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentsession-dsh-inherited-missing-"));
  try {
    const noParent = seededRecords(3, "without-parent", 2).records;
    delete noParent[0].parentSession;
    writeFixture(root, 3, "without-parent", noParent);
    const unseeded = seededRecords(0, "without-prefix", 2).records;
    unseeded[0].seedLength = 0;
    writeFixture(root, 0, "without-prefix", unseeded);
    initConfig(["--dsh-dir", root]);
    const { default: dsh } = await import("../dist/src/providers/deepseek-harness/adapter.js?inherited-missing");
    assert.ok(dsh.getSession("without-parent"));
    assert.ok(dsh.getSession("without-prefix"));
    assert.equal(dsh.getInheritedContext("without-parent"), null, "seed markers cannot invent a source session");
    assert.equal(dsh.getInheritedContext("without-prefix"), null, "parent lineage alone does not prove copied content");
    assert.equal(dsh.getInheritedContext("absent"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
