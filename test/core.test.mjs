import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { closeDb, getTokenStats } from "../dist/src/db.js";
import { buildCodeAgentSessionTree } from "../dist/src/providers/codeagent/session-tree.js";
import { enrichCodeAgentSession } from "../dist/src/providers/codeagent/schema.js";
import { buildOpenCodeSessionTree } from "../dist/src/providers/opencode/session-tree.js";
import { buildFlowTreeFromContainer } from "../dist/src/providers/shared/flow-tree.js";
import { renderSessionPage } from "../dist/src/views/session.js";
import {
  extractSessionMeta,
  parseTranscript,
  recordsToMessages
} from "../dist/src/providers/claude-code/parser.js";
import {
  extractMeta as extractCodexMeta,
  recordsToMessages as codexRecordsToMessages
} from "../dist/src/providers/codex/parser.js";
import { buildMessageSessionViews } from "../dist/src/providers/shared/message-session.js";
import { getAllProviders } from "../dist/src/providers/index.js";
import {
  buildPowerShellResumeArgs,
  getResumeCommand,
  resolveProjectDirectory
} from "../dist/src/resume.js";
import { parseArgs } from "../dist/src/config.js";

const fixture = (name) => path.join(process.cwd(), "test", "fixtures", name);

test("Claude current transcripts preserve tools, thinking, titles, and cache tokens", () => {
  const records = parseTranscript(fixture("claude-current.jsonl"));
  const meta = extractSessionMeta(records, "session-current");
  const messages = recordsToMessages(records, "session-current");

  assert.equal(meta.title, "Inspect the current Claude transcript");
  assert.equal(meta.directory, "D:\\WorkSpace\\OpenSession");
  assert.equal(meta.tokenCount, 44);
  assert.equal(messages.find((message) => message.toolName === "Read")?.thinking, "I should inspect the files.");
  assert.equal(messages.find((message) => message.metadata?.toolUseId === "tool-1")?.content, "OpenSessionViewer");
  assert.deepEqual(messages.find((message) => message.toolName === "Read")?.tokens, {
    input: 10,
    output: 5,
    reasoning: 0,
    cache: { read: 20, write: 3 },
    total: 38
  });
});

test("Claude legacy transcripts derive a useful title", () => {
  const records = parseTranscript(fixture("claude-legacy.jsonl"));
  const meta = extractSessionMeta(records, "legacy");
  assert.equal(meta.title, "Legacy first prompt");
  assert.equal(meta.tokenCount, 3);
});

test("Claude fragmented assistant records preserve reasoning and count repeated usage once", () => {
  const records = [
    {
      type: "user",
      uuid: "user",
      timestamp: "2026-06-06T00:00:00.000Z",
      message: { content: [{ type: "text", text: "Inspect package.json" }] }
    },
    {
      type: "assistant",
      uuid: "thinking",
      timestamp: "2026-06-06T00:00:01.000Z",
      message: {
        model: "deepseek-v4-flash",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
        content: [{ type: "thinking", thinking: "I should read the file." }]
      }
    },
    {
      type: "assistant",
      uuid: "tool-record",
      timestamp: "2026-06-06T00:00:01.000Z",
      message: {
        model: "deepseek-v4-flash",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "package.json" } }]
      }
    }
  ];
  const meta = extractSessionMeta(records, "fragmented");
  const messages = recordsToMessages(records, "fragmented");

  assert.equal(meta.tokenCount, 170);
  assert.equal(meta.messageCount, 2);
  assert.equal(messages[1].thinking, "I should read the file.");
  assert.equal(messages[1].toolName, "Read");
  assert.deepEqual(messages[1].tokens, {
    input: 100,
    output: 20,
    reasoning: 0,
    cache: { read: 50, write: 0 },
    total: 170
  });
});

test("normalized message providers build structured tree, metrics, flow, and model-aware cache data", () => {
  const records = parseTranscript(fixture("claude-current.jsonl"));
  const session = extractSessionMeta(records, "session-current");
  const messages = recordsToMessages(records, "session-current");
  const views = buildMessageSessionViews(session, messages);

  assert.equal(views.tree.messages.length, messages.length - 1);
  assert.equal(views.metrics.totals.toolCalls, 1);
  assert.equal(
    views.tree.messages.find((message) => message.id === "tool-1")?.parts[1]?.data.state.output,
    "OpenSessionViewer"
  );
  assert.equal(views.metrics.totals.inputTokens, 14);
  assert.equal(views.metrics.totals.cacheReadTokens, 20);
  assert.equal(views.flow.root.line.filter((node) => node.kind === "user").length, 1);
  assert.equal(
    views.tree.messages.find((message) => message.data.tokens)?.data.model.modelID,
    "claude-sonnet"
  );
});

test("Codex token_count records attach request usage to the preceding assistant output", () => {
  const records = [
    {
      timestamp: "2026-06-06T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-test", cwd: "D:\\WorkSpace", model: "gpt-5" }
    },
    {
      timestamp: "2026-06-06T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }]
      }
    },
    {
      timestamp: "2026-06-06T00:00:01.100Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10000,
            cached_input_tokens: 9000,
            output_tokens: 120,
            reasoning_output_tokens: 20,
            total_tokens: 10120
          }
        }
      }
    }
  ];
  const session = extractCodexMeta(records, "codex-test");
  const messages = codexRecordsToMessages(records, "codex-test");
  const views = buildMessageSessionViews(session, messages);

  assert.equal(session.id, "codex-test");
  assert.equal(session.directory, "D:\\WorkSpace");
  assert.deepEqual(messages[0].tokens, {
    input: 1000,
    output: 120,
    reasoning: 20,
    cache: { read: 9000, write: 0 },
    total: 10120
  });
  assert.equal(messages[0].metadata.model, "gpt-5");
  assert.equal(session.id, "codex-test");
  assert.equal(views.metrics.totals.cacheReadTokens, 9000);
  assert.equal(views.flow.summary.totalTokens, 1140);
});

test("OpenCode token stats include child sessions exactly once", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-token-"));
  const dbPath = path.join(temp, "sessions.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        time_archived INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        data TEXT
      );
    `);
    db.prepare("INSERT INTO session (id, parent_id, time_archived) VALUES (?, ?, NULL)").run("root", null);
    db.prepare("INSERT INTO session (id, parent_id, time_archived) VALUES (?, ?, NULL)").run("child", "root");
    const created = Date.now() - 1000;
    const insert = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
    insert.run("m1", "root", JSON.stringify({
      role: "assistant",
      time: { created },
      tokens: { input: 2, output: 1, reasoning: 1, cache: { read: 3, write: 0 }, total: 7 }
    }));
    insert.run("m2", "child", JSON.stringify({
      role: "assistant",
      time: { created },
      tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 5, write: 1 }, total: 12 }
    }));
    db.close();

    const rows = getTokenStats(30, dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_tokens, 19);
    assert.equal(rows[0].cache_read_tokens, 8);
    assert.equal(rows[0].cache_write_tokens, 1);
  } finally {
    closeDb(dbPath);
  }
});

test("CodeAgent and OpenCode use provider-owned session metric readers", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-provider-metrics-"));
  const dbPath = path.join(temp, "sessions.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        title TEXT,
        slug TEXT,
        directory TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER,
        cost REAL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        data TEXT
      );
    `);
    db.prepare(`
      INSERT INTO session (
        id, parent_id, title, time_created, time_updated, time_archived,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
        tokens_cache_write, cost
      ) VALUES (?, NULL, ?, 1000, 2000, NULL, 100, 50, 25, 10, 5, 9.5)
    `).run("root", "Provider metrics");
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
      "assistant",
      "root",
      JSON.stringify({
        role: "assistant",
        time: { created: 1100 },
        cost: 1.25,
        tokens: {
          input: 7,
          output: 3,
          reasoning: 2,
          cache: { read: 4, write: 1 }
        }
      })
    );
    db.close();

    const codeAgent = buildCodeAgentSessionTree("root", dbPath);
    assert.deepEqual({
      input: codeAgent.metrics.inputTokens,
      output: codeAgent.metrics.outputTokens,
      reasoning: codeAgent.metrics.reasoningTokens,
      cacheRead: codeAgent.metrics.cacheReadTokens,
      cacheWrite: codeAgent.metrics.cacheWriteTokens,
      cost: codeAgent.metrics.cost
    }, {
      input: 7,
      output: 3,
      reasoning: 2,
      cacheRead: 4,
      cacheWrite: 1,
      cost: 1.25
    });

    const openCode = buildOpenCodeSessionTree("root", dbPath);
    assert.equal(openCode.metrics.inputTokens, 100);
    assert.equal(openCode.metrics.outputTokens, 50);
    assert.equal(openCode.metrics.cost, 9.5);
  } finally {
    closeDb(dbPath);
  }
});

test("CodeAgent derives session identity and totals from assistant messages", () => {
  const session = enrichCodeAgentSession(
    { id: "session", agent: null, model: null, cost: 0 },
    [
      {
        id: "assistant",
        data: JSON.stringify({
          role: "assistant",
          agent: "build",
          providerID: "w3",
          modelID: "MiniMax-M2.5",
          cost: 0.75,
          tokens: {
            input: 11,
            output: 4,
            reasoning: 2,
            cache: { read: 6, write: 1 }
          }
        })
      }
    ]
  );

  assert.equal(session.agent, "build");
  assert.equal(session.model, "w3/MiniMax-M2.5");
  assert.equal(session.tokens_input, 11);
  assert.equal(session.tokens_cache_read, 6);
  assert.equal(session.cost, 0.75);
});

test("resume commands use structured placeholders and validated directories", () => {
  const cwd = resolveProjectDirectory(process.cwd());
  assert.ok(cwd);
  const provider = {
    id: "codeagent",
    resumeCommand: {
      executable: process.execPath,
      args: ["--version", "{sessionId}"]
    }
  };
  const command = getResumeCommand(provider, "session id", cwd, {
    codeagent: {
      executable: process.execPath,
      args: ["--version", "{sessionId}", "{projectPath}"]
    }
  });

  assert.equal(command.available, true);
  assert.deepEqual(command.args, ["--version", "session id", cwd]);
  assert.match(command.display, /"session id"/);
  assert.equal(resolveProjectDirectory("relative/path"), null);
  assert.equal(getResumeCommand(provider, "id", "relative/path", {}), null);

  const fixedExecutable = getResumeCommand(provider, "node", cwd, {
    codeagent: { executable: "{sessionId}", args: [] }
  });
  assert.equal(fixedExecutable.executable, "{sessionId}");
  assert.equal(fixedExecutable.available, false);

  const providerDefault = getResumeCommand(provider, "default id", cwd, {});
  assert.equal(providerDefault.executable, process.execPath);
  assert.deepEqual(providerDefault.args, ["--version", "default id"]);
  assert.equal(getResumeCommand(provider, "disabled", cwd, { codeagent: false }), null);
});

test("every provider declares a configurable resume command", () => {
  const providers = getAllProviders();
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["opencode", "codeagent", "claude-code", "codex", "gemini"]
  );
  for (const provider of providers) {
    assert.equal(typeof provider.resumeCommand?.executable, "string", provider.id);
    assert.ok(provider.resumeCommand.executable, provider.id);
    assert.ok(Array.isArray(provider.resumeCommand.args), provider.id);
    assert.ok(provider.resumeCommand.args.includes("{sessionId}"), provider.id);
  }
});

test("terminal launch requires the explicit startup flag", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-config-"));
  const configPath = path.join(temp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    allowTerminalLaunch: true,
    resumeShell: {
      executable: "powershell.exe",
      args: ["-NoExit", "-NoLogo", "-NoProfile"]
    }
  }));

  const disabled = parseArgs(["--config", configPath]);
  assert.equal(disabled.allowTerminalLaunch, false);
  assert.deepEqual(disabled.resumeShell, {
    executable: "powershell.exe",
    args: ["-NoExit", "-NoLogo", "-NoProfile"]
  });
  assert.equal(parseArgs(["--config", configPath, "--allow-terminal-launch"]).allowTerminalLaunch, true);
});

test("terminal launch encodes the complete PowerShell resume script", () => {
  const powershell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const args = buildPowerShellResumeArgs(powershell, ["-NoProfile"]);

  assert.deepEqual(args.slice(0, 3), [
    powershell,
    "-NoProfile",
    "-EncodedCommand"
  ]);
  const script = Buffer.from(args[3], "base64").toString("utf16le");
  assert.match(script, /ConvertFrom-Json/);
  assert.match(script, /Set-Location -LiteralPath \$spec\.cwd/);
  assert.match(script, /& \$spec\.executable @\(\$spec\.args\)$/);
});

function flowMetrics(overrides = {}) {
  return {
    messageCount: 0,
    partCount: 0,
    toolCallCount: 0,
    directChildCount: 0,
    descendantCount: 0,
    totalMessages: 0,
    totalToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    timeStart: 1000,
    timeEnd: 2000,
    runtimeMs: 1000,
    ...overrides
  };
}

function flowMessage(id, role, timeCreated, parts = [], { text = role !== "user" } = {}) {
  const textParts = text
    ? [{
        kind: "part",
        id: `${id}-text`,
        messageId: id,
        sessionId: "root",
        partType: "text",
        tool: null,
        title: `${role} ${id}`,
        timeStart: 0,
        timeEnd: 0,
        childSessions: [],
        data: { type: "text", text: `${role} ${id}` }
      }]
    : [];
  return {
    kind: "message",
    id,
    sessionId: "root",
    role,
    title: `${role} ${id}`,
    timeCreated,
    parts: [...textParts, ...parts],
    data: { role }
  };
}

function flowSession(id, messages, overrides = {}) {
  return {
    kind: "session",
    id,
    title: overrides.title || id,
    depth: overrides.depth || 0,
    attachMode: overrides.attachMode || "root",
    session: { id },
    messages,
    detachedChildren: overrides.detachedChildren || [],
    metrics: flowMetrics({
      messageCount: messages.length,
      totalMessages: messages.length,
      ...overrides.metrics
    })
  };
}

function flowTool(id, options = {}) {
  return {
    kind: "part",
    id,
    messageId: options.messageId || "assistant",
    sessionId: options.sessionId || "root",
    partType: "tool",
    tool: options.tool || "read",
    title: options.title || options.tool || "read",
    timeStart: options.timeStart || 0,
    timeEnd: options.timeEnd || 0,
    childSessions: options.childSessions || [],
    data: {
      type: "tool",
      tool: options.tool || "read",
      state: {
        status: options.status || "completed",
        time: { start: options.timeStart || 0, end: options.timeEnd || 0 }
      }
    }
  };
}

test("conversation flow includes all messages and hides ordinary tool nodes", () => {
  const ordinaryTool = flowTool("read-1", { tool: "read", messageId: "a1" });
  const container = flowSession("root", [
    flowMessage("u1", "user", 1000),
    flowMessage("a1", "assistant", 1100, [ordinaryTool], { text: false })
  ], {
    metrics: {
      partCount: 1,
      toolCallCount: 1,
      totalToolCalls: 1,
      inputTokens: 10,
      outputTokens: 4
    }
  });

  const flow = buildFlowTreeFromContainer(container);
  assert.deepEqual(flow.root.line.map((node) => node.kind), ["user"]);
  assert.equal(flow.summary.messages, 1);
  assert.equal(flow.summary.toolCalls, 1);
  assert.equal(flow.root.line.some((node) => node.id.includes("read-1")), false);
});

test("conversation flow renders recursive subagents as fork-and-join pairs", () => {
  const grandchild = flowSession("grandchild", [
    flowMessage("gu1", "user", 1250),
    flowMessage("ga1", "assistant", 1300)
  ], {
    depth: 2,
    attachMode: "task",
    metrics: { timeStart: 1250, timeEnd: 1350, runtimeMs: 100 }
  });
  const nestedTask = flowTool("nested-task", {
    tool: "task",
    messageId: "ca1",
    sessionId: "child-1",
    timeStart: 1200,
    timeEnd: 1400,
    childSessions: [grandchild]
  });
  const childOne = flowSession("child-1", [
    flowMessage("cu1", "user", 1150),
    flowMessage("ca1", "assistant", 1200, [nestedTask])
  ], {
    depth: 1,
    attachMode: "task",
    metrics: {
      partCount: 1,
      toolCallCount: 1,
      totalToolCalls: 1,
      descendantCount: 1,
      timeStart: 1150,
      timeEnd: 1450,
      runtimeMs: 300
    }
  });
  const childTwo = flowSession("child-2", [
    flowMessage("c2u1", "user", 1160),
    flowMessage("c2a1", "assistant", 1250)
  ], {
    depth: 1,
    attachMode: "task",
    metrics: { timeStart: 1160, timeEnd: 1300, runtimeMs: 140 }
  });
  const task = flowTool("task-1", {
    tool: "task",
    messageId: "a1",
    timeStart: 1100,
    timeEnd: 1500,
    childSessions: [childOne, childTwo]
  });
  const container = flowSession("root", [
    flowMessage("u1", "user", 1000),
    flowMessage("a1", "assistant", 1080, [task]),
    flowMessage("a2", "assistant", 1600)
  ], {
    metrics: {
      partCount: 1,
      toolCallCount: 1,
      totalToolCalls: 2,
      descendantCount: 3,
      timeStart: 1000,
      timeEnd: 1700,
      runtimeMs: 700
    }
  });

  const flow = buildFlowTreeFromContainer(container);
  assert.deepEqual(flow.root.line.map((node) => node.kind), [
    "user", "agent", "invocation", "return", "agent"
  ]);
  const invocation = flow.root.line[2];
  const returned = flow.root.line[3];
  assert.equal(invocation.branches.length, 2);
  assert.equal(invocation.returnId, returned.id);
  assert.equal(returned.invocationId, invocation.id);
  assert.deepEqual(invocation.branches[0].line.map((node) => node.kind), [
    "user", "agent", "invocation", "return"
  ]);
  assert.equal(invocation.branches[0].line[2].branches[0].id, "session:grandchild");
  assert.equal(flow.summary.subagents, 3);
  assert.equal(flow.root.line[4].emphasis, "final");
});

test("conversation flow inserts detached sessions as inferred branches", () => {
  const detached = flowSession("detached", [
    flowMessage("du1", "user", 1400),
    flowMessage("da1", "assistant", 1450)
  ], {
    depth: 1,
    attachMode: "detached",
    metrics: { timeStart: 1400, timeEnd: 1500, runtimeMs: 100 }
  });
  const container = flowSession("root", [
    flowMessage("u1", "user", 1000),
    flowMessage("a1", "assistant", 1300),
    flowMessage("u2", "user", 1600)
  ], {
    detachedChildren: [detached],
    metrics: {
      descendantCount: 1,
      timeStart: 1000,
      timeEnd: 1700,
      runtimeMs: 700
    }
  });

  const flow = buildFlowTreeFromContainer(container);
  assert.deepEqual(flow.root.line.map((node) => node.kind), [
    "user", "agent", "invocation", "return", "user"
  ]);
  assert.equal(flow.root.line[2].inferred, true);
  assert.equal(flow.root.line[3].inferred, true);
  assert.equal(flow.root.line[2].branches[0].inferred, true);
});

test("session rendering merges reasoning tokens into output and nests tools in assistant turns", () => {
  const sessionTree = {
    session: { id: "root", title: "Render test" },
    detachedChildren: [],
    metrics: flowMetrics(),
    messages: [{
      id: "assistant-1",
      sessionId: "root",
      role: "assistant",
      timeCreated: 1000,
      data: {
        role: "assistant",
        modelID: "deepseek-v4-flash",
        providerID: "deepseek",
        time: { created: 1000 },
        tokens: {
          input: 100,
          output: 121,
          reasoning: 31,
          cache: { read: 43, write: 0 },
          total: 295
        }
      },
      parts: [{
        id: "reasoning-1",
        messageId: "assistant-1",
        sessionId: "root",
        type: "reasoning",
        tool: null,
        timeStart: 1050,
        timeEnd: 1090,
        childSessions: [],
        data: {
          type: "reasoning",
          text: "I should inspect the file.",
          time: { start: 1050, end: 1090 }
        }
      }, {
        id: "text-1",
        messageId: "assistant-1",
        sessionId: "root",
        type: "text",
        tool: null,
        timeStart: 0,
        timeEnd: 0,
        childSessions: [],
        data: { type: "text", text: "Let me inspect it." }
      }, {
        id: "tool-1",
        messageId: "assistant-1",
        sessionId: "root",
        type: "tool",
        tool: "read",
        timeStart: 1100,
        timeEnd: 1200,
        childSessions: [],
        data: {
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "README.md" },
            output: "contents",
            time: { start: 1100, end: 1200 }
          }
        }
      }]
    }]
  };

  const html = renderSessionPage({
    session: {
      id: "root",
      title: "Render test",
      directory: "",
      time_created: 1000
    },
    sessionTree,
    provider: "opencode"
  });

  assert.match(html, /message-turn-assistant/);
  assert.match(html, /message-turn-assistant[\s\S]*tool-call/);
  assert.match(html, /message-reasoning[\s\S]*I should inspect the file/);
  assert.doesNotMatch(html, /tool-reasoning/);
  assert.match(html, /token-chip-label">↑<\/span>100/);
  assert.match(html, /token-chip-label">↓<\/span>152/);
  assert.doesNotMatch(html, /token-chip-label">R<\/span>/);
});

test("session rendering does not double-count reasoning already included in output", () => {
  const messages = [{
    id: "assistant",
    data: {
      role: "assistant",
      tokens: {
        input: 100,
        output: 50,
        reasoning: 20,
        cache: { read: 40, write: 0 },
        total: 150
      }
    }
  }];
  const partsByMessage = new Map([[
    "assistant",
    [{ id: "text", data: { type: "text", text: "Done." } }]
  ]]);
  const html = renderSessionPage({
    session: { id: "root", title: "Inclusive output", time_created: 1000 },
    messages,
    partsByMessage,
    provider: "codex"
  });

  assert.match(html, /token-chip-label">↑<\/span>100/);
  assert.match(html, /token-chip-label">↓<\/span>50/);
  assert.doesNotMatch(html, /token-chip-label">R<\/span>/);
});

test("session rendering shows uncached upload input and cache as prompt context", () => {
  const messages = [{
    id: "assistant",
    data: {
      role: "assistant",
      tokens: {
        total: 95274,
        input: 24,
        output: 114,
        reasoning: 0,
        cache: { read: 95136, write: 0 }
      }
    }
  }];
  const partsByMessage = new Map([[
    "assistant",
    [{ id: "tool", data: {
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "git diff --stat" }, output: "" }
    } }]
  ]]);
  const html = renderSessionPage({
    session: { id: "root", title: "Cached prompt", time_created: 1000 },
    messages,
    partsByMessage,
    provider: "opencode"
  });

  assert.match(html, /token-chip-label">↑<\/span>24/);
  assert.match(html, /token-chip-label">↓<\/span>114/);
  assert.match(html, /token-chip-label">C<\/span>95k/);
  assert.match(html, /Uncached prompt input uploaded for this request: 24\. Total prompt input: 95k/);
  assert.match(html, /99\.97% cache hit/);
});

test("session rendering marks a same-model cache collapse after a strong hit", () => {
  const messages = [{
    id: "cached",
    data: {
      role: "assistant",
      modelID: "glm-5.1",
      providerID: "opencode-go",
      tokens: {
        total: 95614,
        input: 324,
        output: 90,
        reasoning: 0,
        cache: { read: 95200, write: 0 }
      }
    }
  }, {
    id: "miss",
    data: {
      role: "assistant",
      modelID: "glm-5.1",
      providerID: "opencode-go",
      tokens: {
        total: 96737,
        input: 96660,
        output: 45,
        reasoning: 0,
        cache: { read: 32, write: 0 }
      }
    }
  }];
  const partsByMessage = new Map(messages.map((message) => [message.id, [{
    id: `${message.id}-tool`,
    data: {
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: `echo ${message.id}` }, output: "" }
    }
  }]]));
  const html = renderSessionPage({
    session: { id: "root", title: "Cache warning", time_created: 1000 },
    messages,
    partsByMessage,
    provider: "opencode"
  });

  assert.equal((html.match(/cache-warning-badge/g) || []).length, 1);
  assert.match(html, /token-chip-cache-warning[^>]*title="Possible cache miss/);
  assert.match(html, /! cache miss/);
  assert.match(html, /previous same-model request was 99\.7%/);
});


test("tool-only assistant turns still render assistant metadata", () => {
  const messages = [{
    id: "tool-only",
    data: {
      role: "tool",
      time: { created: 1000 },
      model: { providerID: "openai", modelID: "gpt-5" }
    }
  }];
  const partsByMessage = new Map([[
    "tool-only",
    [{
      id: "tool",
      data: {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: {}, output: "ok" }
      }
    }]
  ]]);
  const html = renderSessionPage({
    session: { id: "root", title: "Tool only", time_created: 1000 },
    messages,
    partsByMessage,
    provider: "codex"
  });

  assert.match(html, /message-turn-assistant/);
  assert.match(html, /message-role">assistant<\/span>/);
  assert.match(html, /openai\/gpt-5/);
});

test("reasoning before a tool renders at assistant-turn level", () => {
  const messages = [{
    id: "tool-turn",
    data: {
      role: "assistant",
      time: { created: 1000 },
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" }
    }
  }];
  const partsByMessage = new Map([[
    "tool-turn",
    [{
      id: "reasoning",
      data: { type: "reasoning", text: "Search the source first." }
    }, {
      id: "tool",
      data: {
        type: "tool",
        tool: "grep",
        state: { status: "completed", input: { pattern: "notify" }, output: "match" }
      }
    }]
  ]]);
  const html = renderSessionPage({
    session: { id: "root", title: "Reasoning tool", time_created: 1000 },
    messages,
    partsByMessage,
    provider: "opencode"
  });

  assert.match(html, /message-turn-assistant[\s\S]*turn-reasoning[\s\S]*tool-call/);
  assert.doesNotMatch(html, /tool-panels[\s\S]*tool-reasoning/);
});

test("non-thinking models render assistant tools without an empty reasoning block", () => {
  const messages = [{
    id: "plain-tool",
    data: {
      role: "assistant",
      time: { created: 1000 },
      model: { providerID: "openai", modelID: "gpt-4.1" }
    }
  }];
  const partsByMessage = new Map([[
    "plain-tool",
    [{
      id: "tool",
      data: {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "README.md" }, output: "ok" }
      }
    }]
  ]]);
  const html = renderSessionPage({
    session: { id: "root", title: "Plain tool", time_created: 1000 },
    messages,
    partsByMessage,
    provider: "opencode"
  });

  assert.match(html, /message-turn-assistant[\s\S]*tool-call/);
  assert.doesNotMatch(html, /reasoning-block|turn-reasoning|tool-reasoning/);
});

test("reasoning does not cross assistant message boundaries", () => {
  const makePart = (id, type, data) => ({
    id,
    messageId: id.startsWith("first") ? "first" : "second",
    sessionId: "root",
    type,
    tool: data.tool || null,
    timeStart: 0,
    timeEnd: 0,
    childSessions: [],
    data: { type, ...data }
  });
  const sessionTree = {
    session: { id: "root", title: "Separate reasoning turns" },
    detachedChildren: [],
    metrics: flowMetrics(),
    messages: [{
      id: "first",
      sessionId: "root",
      role: "assistant",
      timeCreated: 1000,
      data: { role: "assistant", time: { created: 1000 } },
      parts: [
        makePart("first-reasoning", "reasoning", { text: "Plan the work." }),
        makePart("first-todo", "tool", {
          tool: "todowrite",
          state: { status: "completed", input: {}, output: "" }
        })
      ]
    }, {
      id: "second",
      sessionId: "root",
      role: "assistant",
      timeCreated: 2000,
      data: { role: "assistant", time: { created: 2000 } },
      parts: [
        makePart("second-reasoning", "reasoning", { text: "Start the search." }),
        makePart("second-tool", "tool", {
          tool: "grep",
          state: { status: "completed", input: { pattern: "ctx" }, output: "match" }
        })
      ]
    }]
  };
  const html = renderSessionPage({
    session: { id: "root", title: "Separate reasoning turns", time_created: 1000 },
    sessionTree,
    provider: "opencode"
  });
  const firstStart = html.indexOf('id="msg-first"');
  const secondStart = html.indexOf('id="msg-second"');
  const firstMarkup = html.slice(firstStart, secondStart);
  const secondMarkup = html.slice(secondStart);

  assert.equal((firstMarkup.match(/reasoning-block/g) || []).length, 1);
  assert.match(firstMarkup, /Plan the work/);
  assert.match(firstMarkup, /tool-call[\s\S]*todowrite/);
  assert.doesNotMatch(firstMarkup, /Start the search/);
  assert.equal((secondMarkup.match(/reasoning-block/g) || []).length, 1);
  assert.match(secondMarkup, /Start the search/);
  assert.doesNotMatch(secondMarkup, /Plan the work/);
});

test("subagent invocation headers show child-session token usage", () => {
  const child = flowSession("child", [
    flowMessage("child-user", "user", 1100),
    flowMessage("child-assistant", "assistant", 1200)
  ], {
    depth: 1,
    attachMode: "task",
    metrics: {
      inputTokens: 76953,
      outputTokens: 7966,
      reasoningTokens: 1969,
      cacheReadTokens: 794752,
      cacheWriteTokens: 0
    }
  });
  const task = flowTool("task", {
    tool: "task",
    messageId: "assistant",
    childSessions: [child]
  });
  task.data.state.title = "Explore code";
  const sessionTree = {
    session: { id: "root", title: "Subagent tokens" },
    detachedChildren: [],
    metrics: flowMetrics(),
    messages: [{
      id: "assistant",
      sessionId: "root",
      role: "assistant",
      timeCreated: 1000,
      data: { role: "assistant", time: { created: 1000 } },
      parts: [{
        id: task.id,
        messageId: task.messageId,
        sessionId: task.sessionId,
        type: task.partType,
        tool: task.tool,
        timeStart: task.timeStart,
        timeEnd: task.timeEnd,
        childSessions: task.childSessions,
        data: task.data
      }]
    }]
  };
  const html = renderSessionPage({
    session: { id: "root", title: "Subagent tokens", time_created: 1000 },
    sessionTree,
    provider: "opencode"
  });

  assert.match(html, /subagent-tokens/);
  assert.match(html, /token-chip-label">↑<\/span>77k/);
  assert.match(html, /token-chip-label">↓<\/span>9\.9k/);
  assert.match(html, /token-chip-label">C<\/span>795k/);
  const parentStart = html.indexOf('id="msg-assistant"');
  const parentHeader = html.indexOf('<header class="message-meta">', parentStart);
  const subagentStart = html.indexOf('class="subagent-branch"', parentStart);
  assert.ok(parentHeader > parentStart && parentHeader < subagentStart);
  assert.match(
    html.slice(parentHeader, subagentStart),
    /message-role">assistant<\/span>/
  );
});
