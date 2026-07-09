import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { closeDb, getTokenStats, listSessionProjects, listSessions, searchMessages } from "../dist/src/db.js";
import { buildCodeAgentSessionTree } from "../dist/src/providers/codeagent/session-tree.js";
import { enrichCodeAgentSession } from "../dist/src/providers/codeagent/schema.js";
import { buildOpenCodeSessionTree } from "../dist/src/providers/opencode/session-tree.js";
import { buildOpenCodeRuntimeEnvironment } from "../dist/src/providers/opencode/runtime-environment.js";
import { buildClaudeCodeRuntimeEnvironment } from "../dist/src/providers/claude-code/runtime-environment.js";
import {
  buildClaudeCodeSessionViews,
  buildClaudeCodeSystemPrompts
} from "../dist/src/providers/claude-code/views.js";
import { buildCodexRuntimeEnvironment } from "../dist/src/providers/codex/runtime-environment.js";
import { buildGeminiRuntimeEnvironment } from "../dist/src/providers/gemini/runtime-environment.js";
import { buildFlowTreeFromContainer } from "../dist/src/providers/shared/flow-tree.js";
import { renderCanonicalFlowPanelContent, renderSessionPage } from "../dist/src/views/session.js";
import { renderSettingsPage } from "../dist/src/views/settings.js";
import { sessionCard } from "../dist/src/views/components.js";
import { renderSessionsPage } from "../dist/src/views/sessions.js";
import { getSearchResults, resolveSessionSearchMode } from "../dist/src/server.js";
import { t } from "../dist/src/i18n.js";
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
  buildPowerShellLaunchSpec,
  buildPowerShellResumeArgs,
  getResumeCommand,
  resolvePowerShellLaunch,
  resolveProjectDirectory,
  resolveWindowsExecutableCandidate
} from "../dist/src/resume.js";
import {
  buildAnalysisPromptPreview,
  buildPowerShellAnalysisArgs,
  buildPowerShellImplementationArgs,
  findActiveSessionAnalysisRun,
  getAnalysisTargetIds,
  getDefaultAnalysisTargetIds,
  getAnalysisOutputRoot,
  getSessionAnalysisAction,
  listSessionAnalysisRuns,
  OPENCODE_ANALYSIS_COMMAND,
  prepareAnalysisImplementation,
  prepareSessionAnalysis,
  resolveAnalysisSettings
} from "../dist/src/analysis.js";
import {
  formatAnalysisToolOutput,
  runAnalysisTool
} from "../dist/src/analysis-tools.js";
import { validateAnalysisOutputs } from "../dist/src/analysis-validator.js";
import { BUILTIN_ANALYSIS_TARGETS } from "../dist/src/analysis-targets.js";
import { resolveAnalysisRunPath } from "../dist/src/analysis-layout.js";
import {
  applyRuntimeUserConfig,
  parseArgs,
  readUserConfigDocument,
  validateUserConfig,
  writeUserConfig
} from "../dist/src/config.js";
import {
  buildRuntimeEvent,
  getRuntimeRouteContext,
  getRuntimeLogPath,
  recordRuntimeEvent,
  runtimeErrorMessage,
  runtimeExecutableName,
  runtimeLevelForStatus
} from "../dist/src/runtime-log.js";

const fixture = (name) => path.join(process.cwd(), "test", "fixtures", name);
const regexEscape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

test("Claude Code views reconstruct trace and metrics steps from transcript tools", () => {
  const records = parseTranscript(fixture("claude-current.jsonl"));
  const session = extractSessionMeta(records, "session-current");
  const messages = recordsToMessages(records, "session-current");
  const views = buildClaudeCodeSessionViews(session, messages);
  const trace = views.trace;

  assert.equal(trace.summary.totalSteps, 1);
  assert.equal(trace.summary.totalSpans, 3);
  assert.equal(trace.summary.totalTokens, 44);
  assert.equal(views.metrics.totals.steps, 1);
  assert.equal(views.metrics.steps[0].reason, "tool-calls");
  assert.equal(views.metrics.steps[0].inputTokens, 14);
  assert.equal(views.metrics.steps[0].cacheReadTokens, 20);
  assert.deepEqual(
    trace.steps[0].spans.map((span) => [span.name, span.category, span.status]),
    [
      ["reasoning", "reasoning", null],
      ["Read", "tool", "completed"],
      ["text", "text", null]
    ]
  );
  assert.equal(trace.steps[0].spans.find((span) => span.name === "Read")?.output, "OpenSessionViewer");
});

test("Claude Code trace splits independent turns and classifies MCP tools", () => {
  const records = [
    {
      type: "user",
      uuid: "user-1",
      timestamp: "2026-06-06T00:00:00.000Z",
      message: { content: [{ type: "text", text: "First prompt" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-1",
      timestamp: "2026-06-06T00:00:01.000Z",
      message: {
        model: "claude-sonnet",
        usage: { input_tokens: 3, output_tokens: 2 },
        content: [{ type: "text", text: "First answer" }]
      }
    },
    {
      type: "user",
      uuid: "user-2",
      timestamp: "2026-06-06T00:00:02.000Z",
      message: { content: [{ type: "text", text: "Search the issue tracker" }] }
    },
    {
      type: "assistant",
      uuid: "assistant-2",
      timestamp: "2026-06-06T00:00:03.000Z",
      message: {
        model: "claude-sonnet",
        usage: { input_tokens: 5, output_tokens: 1 },
        content: [{
          type: "tool_use",
          id: "mcp-tool-1",
          name: "mcp__github__search_issues",
          input: { query: "cache miss" }
        }]
      }
    },
    {
      type: "user",
      uuid: "tool-result",
      timestamp: "2026-06-06T00:00:04.000Z",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "mcp-tool-1",
          content: "issue #123",
          is_error: false
        }]
      }
    }
  ];
  const session = extractSessionMeta(records, "claude-multiturn");
  const views = buildClaudeCodeSessionViews(session, recordsToMessages(records, "claude-multiturn"));
  const mcpSpan = views.trace.steps[1].spans.find((span) => span.name === "mcp__github__search_issues");

  assert.equal(views.trace.summary.totalSteps, 2);
  assert.equal(views.metrics.steps.length, 2);
  assert.equal(views.metrics.steps[0].reason, "message");
  assert.equal(views.metrics.steps[1].reason, "tool-calls");
  assert.equal(mcpSpan?.category, "mcp");
  assert.equal(mcpSpan?.mcpServer, "github");
  assert.equal(mcpSpan?.output, "issue #123");
});

test("Claude Code system prompt evidence resolves local runtime sources without hidden prompt claims", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-claude-prompts-"));
  try {
    const projectPath = path.join(temp, "project");
    const claudeDir = path.join(temp, "claude");
    mkdirSync(path.join(projectPath, ".git"), { recursive: true });
    mkdirSync(path.join(projectPath, ".claude", "rules"), { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path.join(claudeDir, "CLAUDE.md"), "# User Claude instructions\n");
    writeFileSync(path.join(projectPath, "CLAUDE.md"), "# Project Claude instructions\n");
    writeFileSync(path.join(projectPath, ".claude", "rules", "review.md"), "# Review rules\n");

    const runtime = buildClaudeCodeRuntimeEnvironment("claude-session", projectPath, claudeDir);
    const prompts = buildClaudeCodeSystemPrompts(
      {
        id: "claude-session",
        provider: "claude-code",
        parentId: null,
        title: "Claude session",
        directory: projectPath,
        timeCreated: 1780000000000,
        timeUpdated: 1780000001000,
        messageCount: 2,
        tokenCount: null
      },
      [
        {
          type: "system",
          uuid: "system-1",
          timestamp: "2026-06-01T00:00:00.000Z",
          cwd: projectPath,
          version: "1.0.0",
          tools: ["Read", "Bash"]
        },
        {
          type: "user",
          uuid: "user-1",
          timestamp: "2026-06-01T00:00:01.000Z",
          message: { content: [{ type: "text", text: "Review this repository" }] }
        }
      ],
      runtime
    );

    const instructionItems = prompts.sections.find((section) => section.title === "Claude Instruction Files")?.items || [];
    assert.equal(prompts.hiddenPromptStored, false);
    assert.match(prompts.note, /do not store the hidden provider prompt/);
    assert.ok(instructionItems.some((entry) => entry.source.endsWith("CLAUDE.md") && /Project Claude instructions/.test(entry.preview)));
    assert.ok(instructionItems.some((entry) => entry.source.endsWith(path.join(".claude", "rules", "review.md")) && /Review rules/.test(entry.preview)));
    assert.equal(prompts.firstUserMessage.preview, "Review this repository");
    assert.ok(
      prompts.sections
        .find((section) => section.title === "Stored Transcript Envelope")
        ?.items.some((entry) => entry.title === "System record 1" && /Read/.test(entry.preview))
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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

test("windows executable resolution prefers runnable command shims", () => {
  assert.equal(
    resolveWindowsExecutableCandidate(
      ["D:\\npm\\node_global\\opencode"],
      (candidate) => candidate === "D:\\npm\\node_global\\opencode.cmd"
    ),
    "D:\\npm\\node_global\\opencode.cmd"
  );
  assert.equal(
    resolveWindowsExecutableCandidate([
      "D:\\npm\\node_global\\opencode",
      "D:\\npm\\node_global\\opencode.cmd"
    ]),
    "D:\\npm\\node_global\\opencode.cmd"
  );
  assert.equal(
    resolveWindowsExecutableCandidate(["D:\\npm\\node_global\\opencode"], () => false),
    "D:\\npm\\node_global\\opencode"
  );
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

test("terminal launch is enabled by default and supports an explicit startup opt-out", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-config-"));
  const configPath = path.join(temp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    allowTerminalLaunch: false,
    resumeShell: {
      executable: "powershell.exe",
      args: ["-NoExit", "-NoLogo", "-NoProfile"]
    },
    analysis: {
      enabled: true,
      defaultTarget: "skills",
      providers: {
        codex: {
          command: {
            executable: "codex",
            args: ["exec", "{promptPath}"]
          }
        }
      }
    }
  }));

  const enabled = parseArgs(["--config", configPath]);
  assert.equal(enabled.allowTerminalLaunch, true);
  assert.deepEqual(enabled.resumeShell, {
    executable: "powershell.exe",
    args: ["-NoExit", "-NoLogo", "-NoProfile"]
  });
  assert.equal(enabled.analysis.enabled, true);
  assert.equal(enabled.analysis.providers.codex.command.executable, "codex");
  assert.equal(
    parseArgs(["--config", configPath, "--disable-terminal-launch"]).allowTerminalLaunch,
    false
  );
});

test("runtime events write JSONL under meta logs with redaction", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-runtime-log-"));
  const now = new Date("2026-07-01T02:40:00.000Z");
  const longValue = "x".repeat(700);

  const record = recordRuntimeEvent(temp, {
    event: "analysis.launch",
    level: "info",
    provider: "opencode",
    sessionId: "ses_test",
    runId: "run_test",
    prompt: "do not persist",
    details: {
      route: "/api/:provider/session/:sessionId/analyze",
      authorization: "Bearer secret"
    },
    note: longValue
  }, { now });

  assert.equal(record.event, "analysis.launch");
  assert.equal(record.provider, "opencode");
  assert.equal(record.prompt, "[redacted]");
  assert.equal(record.details.authorization, "[redacted]");
  assert.equal(record.note.endsWith("..."), true);

  const logPath = getRuntimeLogPath(temp, now);
  const lines = readFileSync(logPath, "utf-8").trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), record);
});

test("runtime event normalization keeps logs small and predictable", () => {
  const event = buildRuntimeEvent({
    event: "bad event name!",
    level: "verbose",
    command: {
      executable: "opencode",
      args: ["secret prompt"]
    },
    nested: {
      output: "raw provider output",
      safe: "kept"
    }
  }, new Date("2026-07-01T02:41:00.000Z"));

  assert.equal(event.event, "bad_event_name_");
  assert.equal(event.level, "info");
  assert.equal(event.command, "[redacted]");
  assert.deepEqual(event.nested, {
    output: "[redacted]",
    safe: "kept"
  });
});

test("runtime route context logs patterns instead of raw session paths", () => {
  assert.deepEqual(
    getRuntimeRouteContext("GET", "/api/providers"),
    {
      method: "GET",
      route: "/api/:resource",
      provider: undefined,
      sessionId: undefined,
      runId: undefined,
      action: "providers"
    }
  );
  assert.deepEqual(
    getRuntimeRouteContext("GET", "/api/opencode/sessions"),
    {
      method: "GET",
      route: "/api/:provider/:resource",
      provider: "opencode",
      sessionId: undefined,
      runId: undefined,
      action: "sessions"
    }
  );
  assert.deepEqual(
    getRuntimeRouteContext("POST", "/api/opencode/session/ses_123/analyze"),
    {
      method: "POST",
      route: "/api/:provider/session/:sessionId/:action",
      provider: "opencode",
      sessionId: "ses_123",
      runId: undefined,
      action: "analyze"
    }
  );
  assert.deepEqual(
    getRuntimeRouteContext("GET", "/api/opencode/session/ses_123/metrics"),
    {
      method: "GET",
      route: "/api/:provider/session/:sessionId/:action",
      provider: "opencode",
      sessionId: "ses_123",
      runId: undefined,
      action: "metrics"
    }
  );
  assert.deepEqual(
    getRuntimeRouteContext("GET", "/api/opencode/session/ses_123/analyses/run_456/outputs/report"),
    {
      method: "GET",
      route: "/api/:provider/session/:sessionId/analyses/:runId/outputs/:output",
      provider: "opencode",
      sessionId: "ses_123",
      runId: "run_456",
      action: "report"
    }
  );
  assert.equal(getRuntimeRouteContext("GET", "/static/app.js"), null);
  assert.deepEqual(
    getRuntimeRouteContext("GET", "/unexpected/ses_secret"),
    { method: "GET", route: "/unmatched" }
  );
});

test("runtime helper utilities classify status, errors, and executables", () => {
  assert.equal(runtimeLevelForStatus(200), "info");
  assert.equal(runtimeLevelForStatus(404), "warn");
  assert.equal(runtimeLevelForStatus(500), "error");
  assert.equal(runtimeErrorMessage(new Error("boom")), "boom");
  assert.equal(runtimeErrorMessage(null), "Unknown error");
  assert.equal(
    runtimeExecutableName({ resolvedExecutable: "C:\\Tools\\opencode.cmd", executable: "opencode" }),
    "opencode.cmd"
  );
  assert.equal(runtimeExecutableName({ executable: "/usr/bin/node" }), "node");
  assert.equal(runtimeExecutableName(null), "");
  assert.equal(recordRuntimeEvent(null, { event: "ignored" }), null);
});

test("sessions search page preserves query and exposes content pagination", () => {
  const html = renderSessionsPage({
    sessions: Array.from({ length: 30 }, (_, index) => ({
      id: `ses_${index}`,
      title: `Session ${index}`,
      directory: "D:\\WorkSpace\\OpenSession",
      time_updated: 1_700_000_000_000 + index,
      summary_files: 0,
      summary_additions: 0,
      summary_deletions: 0
    })),
    total: 40,
    limit: 30,
    offset: 0,
    query: "analysis",
    searchMode: "content",
    provider: "opencode",
    providerAvailable: true,
    manageable: true,
    providers: []
  });

  assert.match(html, /<input type="text" name="q" value="analysis"/);
  assert.match(html, /id="scroll-sentinel"/);
  assert.match(html, /data-offset="30"/);
  assert.match(html, /data-total="40"/);
  assert.match(html, /data-query="analysis"/);
  assert.match(html, /data-mode="content"/);
  assert.match(html, />Load more sessions<\/button>/);
});

test("session API search mode accepts explicit and compatible parameter names", () => {
  assert.equal(resolveSessionSearchMode(new URLSearchParams()), "list");
  assert.equal(resolveSessionSearchMode(new URLSearchParams("mode=content")), "content");
  assert.equal(resolveSessionSearchMode(new URLSearchParams("searchMode=content")), "content");
  assert.equal(resolveSessionSearchMode(new URLSearchParams("searchMode=list")), "list");
  assert.equal(resolveSessionSearchMode(new URLSearchParams("mode=list&searchMode=content")), "list");
  assert.equal(resolveSessionSearchMode(new URLSearchParams("mode=unexpected")), "list");
});

test("mobile topbar keeps settings reachable when utility links collapse", () => {
  const html = renderSessionsPage({
    sessions: [],
    total: 0,
    limit: 30,
    offset: 0,
    provider: "opencode",
    providerAvailable: true,
    manageable: true,
    providers: []
  });
  const style = readFileSync(path.join(process.cwd(), "dist", "src", "static", "style.css"), "utf8");

  assert.match(html, /href="\/opencode\/stats" class="nav-link nav-link-stats /);
  assert.match(html, /href="\/opencode\/trash" class="nav-link nav-link-trash /);
  assert.match(html, /href="\/opencode\/settings" class="nav-link nav-link-settings [^"]*" title="Settings" aria-label="Settings"/);
  assert.match(style, /@media \(max-width: 480px\)[\s\S]*\.topbar-actions \.nav-link \{\s*display: none;[\s\S]*\.topbar-actions \.nav-link-settings \{\s*display: inline-flex;/);
});

test("sqlite session queries exclude viewer-deleted sessions from paging, projects, and search", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-visible-sessions-"));
  const dbPath = path.join(temp, "sessions.db");
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        name TEXT,
        worktree TEXT
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        parent_id TEXT,
        slug TEXT,
        title TEXT,
        directory TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        time_archived INTEGER
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

    db.prepare("INSERT INTO project (id, name, worktree) VALUES (?, ?, ?)").run("p1", "Project One", "/p1");
    db.prepare("INSERT INTO project (id, name, worktree) VALUES (?, ?, ?)").run("p2", "Project Two", "/p2");

    const insertSession = db.prepare(`
      INSERT INTO session (
        id, project_id, parent_id, slug, title, directory, time_created, time_updated,
        summary_additions, summary_deletions, summary_files, time_archived
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 0, NULL)
    `);
    insertSession.run("a", "p1", "a", "needle title", "/p1", 100, 300);
    insertSession.run("b", "p1", "b", "deleted content", "/p1", 100, 200);
    insertSession.run("c", "p2", "c", "active content", "/p2", 100, 100);

    const insertMessage = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)");
    for (const id of ["b", "c"]) {
      insertMessage.run(`m-${id}`, id, JSON.stringify({ role: "assistant", time: { created: 100 } }));
      insertPart.run(`p-${id}`, `m-${id}`, id, JSON.stringify({ text: "needle in content" }));
    }
  } finally {
    db.close();
  }

  try {
    const excluded = new Set(["b"]);
    const firstPage = listSessions(1, 0, "", "", dbPath, "", excluded);
    const secondPage = listSessions(1, 1, "", "", dbPath, "", excluded);

    assert.equal(firstPage.total, 2);
    assert.deepEqual(firstPage.sessions.map((session) => session.id), ["a"]);
    assert.deepEqual(secondPage.sessions.map((session) => session.id), ["c"]);
    assert.deepEqual(
      listSessionProjects("", "", dbPath, excluded).map((project) => ({
        id: project.id,
        label: project.label,
        count: project.count
      })),
      [
        { id: "p1", label: "Project One", count: 1 },
        { id: "p2", label: "Project Two", count: 1 }
      ]
    );
    assert.deepEqual(
      searchMessages("needle", 1, dbPath, excluded).map((match) => match.sessionId),
      ["c"]
    );

    const search = getSearchResults("needle", 10, 0, dbPath, excluded);
    assert.equal(search.total, 2);
    assert.deepEqual(search.sessions.map((session) => session.id), ["a", "c"]);
  } finally {
    closeDb(dbPath);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("session cards expose accessible action buttons", () => {
  const html = sessionCard({
    id: "ses_accessible",
    title: "Accessible session",
    directory: "D:\\WorkSpace\\OpenSession",
    time_updated: 1_700_000_000_000,
    summary_files: 1,
    summary_additions: 2,
    summary_deletions: 0,
    starred: false
  }, false, { showCheckbox: true, provider: "opencode", manageable: true });

  assert.match(html, /class="star-btn "/);
  assert.match(html, /type="button" data-star-format="icon"/);
  assert.match(html, /aria-label="☆ Star"/);
  assert.match(html, /class="card-menu-trigger" type="button"/);
  assert.match(html, /aria-label="More actions"/);
  assert.match(html, /class="copy-btn" type="button" data-action="copy-session-id"/);
  assert.match(html, /aria-label="Copy session ID"/);
});

test("session management uses in-page dialogs", () => {
  const appJs = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf-8");

  assert.doesNotMatch(appJs, /\b(prompt|confirm|alert)\s*\(/);
  assert.match(appJs, /openRenameDialog/);
  assert.match(appJs, /openConfirmDialog/);
  assert.match(appJs, /rename-dialog/);
  assert.match(appJs, /confirm-dialog/);
  assert.match(appJs, /aria-describedby/);
});

test("OpenCode runtime environment resolves project and user agent extensions", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-runtime-"));
  const projectPath = path.join(temp, "project");
  const configHome = path.join(temp, "config");
  const userOpenCode = path.join(configHome, "opencode");
  mkdirSync(path.join(projectPath, ".git"), { recursive: true });
  mkdirSync(path.join(projectPath, ".opencode", "agents"), { recursive: true });
  mkdirSync(path.join(projectPath, ".opencode", "skills", "project-skill"), { recursive: true });
  mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  mkdirSync(path.join(userOpenCode, "skills", "user-skill"), { recursive: true });
  writeFileSync(path.join(projectPath, "AGENTS.md"), "# Project instructions\n");
  writeFileSync(path.join(projectPath, "docs", "runtime.md"), "# Configured instructions\n");
  writeFileSync(path.join(userOpenCode, "AGENTS.md"), "# User instructions\n");
  writeFileSync(path.join(projectPath, ".opencode", "agents", "review.md"), "# Review agent\n");
  writeFileSync(
    path.join(projectPath, ".opencode", "skills", "project-skill", "SKILL.md"),
    "# Project skill\n"
  );
  writeFileSync(
    path.join(userOpenCode, "skills", "user-skill", "SKILL.md"),
    "# User skill\n"
  );
  writeFileSync(
    path.join(userOpenCode, "opencode.json"),
    '{"plugin":["example-plugin"],"instructions":["docs/runtime.md"]}\n'
  );
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    const runtime = buildOpenCodeRuntimeEnvironment("runtime-session", projectPath);
    assert.equal(runtime.resolution, "current-local");
    assert.ok(runtime.extensions.some((entry) => (
      entry.scope === "project" && entry.kind === "agent" && entry.name === "review"
    )));
    assert.ok(runtime.extensions.some((entry) => (
      entry.scope === "project" && entry.kind === "skill" && entry.name === "project-skill"
    )));
    assert.ok(runtime.extensions.some((entry) => (
      entry.scope === "user" && entry.kind === "skill" && entry.name === "user-skill"
    )));
    assert.ok(runtime.extensions.some((entry) => (
      entry.scope === "user"
      && entry.kind === "plugin"
      && entry.name === "example-plugin"
      && entry.capturable === false
    )));
    assert.ok(runtime.extensions.some((entry) => (
      entry.scope === "project"
      && entry.kind === "instruction"
      && entry.sourcePath === path.join(projectPath, "AGENTS.md")
    )));
    assert.ok(runtime.extensions.some((entry) => (
      entry.scope === "project"
      && entry.kind === "instruction"
      && entry.sourcePath === path.join(projectPath, "docs", "runtime.md")
    )));
    assert.ok(runtime.extensions.some((entry) => (
      entry.scope === "user"
      && entry.kind === "instruction"
      && entry.sourcePath === path.join(userOpenCode, "AGENTS.md")
    )));
  } finally {
    if (previousConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
  }
});

test("provider runtime environments classify instruction files as runtime extensions", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-instructions-"));
  const projectPath = path.join(temp, "project");
  const codexDir = path.join(temp, "codex");
  const claudeDir = path.join(temp, "claude");
  const geminiDir = path.join(temp, "gemini");
  mkdirSync(path.join(projectPath, ".git"), { recursive: true });
  mkdirSync(path.join(projectPath, ".claude", "rules"), { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(geminiDir, { recursive: true });
  writeFileSync(path.join(codexDir, "AGENTS.md"), "# Global Codex instructions\n");
  writeFileSync(path.join(projectPath, "AGENTS.override.md"), "# Project Codex instructions\n");
  writeFileSync(path.join(claudeDir, "CLAUDE.md"), "# User Claude instructions\n");
  writeFileSync(path.join(projectPath, "CLAUDE.md"), "# Project Claude instructions\n");
  writeFileSync(path.join(projectPath, ".claude", "rules", "review.md"), "# Review rules\n");
  writeFileSync(path.join(geminiDir, "GEMINI.md"), "# User Gemini context\n");
  writeFileSync(path.join(projectPath, "GEMINI.md"), "# Project Gemini context\n");

  const codex = buildCodexRuntimeEnvironment("codex-session", projectPath, codexDir);
  assert.ok(codex.extensions.some((entry) => (
    entry.scope === "user"
    && entry.kind === "instruction"
    && entry.sourcePath === path.join(codexDir, "AGENTS.md")
  )));
  assert.ok(codex.extensions.some((entry) => (
    entry.scope === "project"
    && entry.kind === "instruction"
    && entry.sourcePath === path.join(projectPath, "AGENTS.override.md")
  )));

  const claude = buildClaudeCodeRuntimeEnvironment("claude-session", projectPath, claudeDir);
  assert.ok(claude.extensions.some((entry) => (
    entry.scope === "user"
    && entry.kind === "instruction"
    && entry.sourcePath === path.join(claudeDir, "CLAUDE.md")
  )));
  assert.ok(claude.extensions.some((entry) => (
    entry.scope === "project"
    && entry.kind === "instruction"
    && entry.sourcePath === path.join(projectPath, "CLAUDE.md")
  )));
  assert.ok(claude.extensions.some((entry) => (
    entry.scope === "project"
    && entry.kind === "rule"
    && entry.sourcePath === path.join(projectPath, ".claude", "rules", "review.md")
  )));

  const gemini = buildGeminiRuntimeEnvironment("gemini-session", projectPath, geminiDir);
  assert.ok(gemini.extensions.some((entry) => (
    entry.scope === "user"
    && entry.kind === "instruction"
    && entry.sourcePath === path.join(geminiDir, "GEMINI.md")
  )));
  assert.ok(gemini.extensions.some((entry) => (
    entry.scope === "project"
    && entry.kind === "instruction"
    && entry.sourcePath === path.join(projectPath, "GEMINI.md")
  )));
});

test("settings configuration validates, persists, and applies runtime fields", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-settings-"));
  const configPath = path.join(temp, "nested", "config.json");
  const fileConfig = {
    port: 4567,
    resumeCommands: {
      opencode: {
        executable: "opencode",
        args: ["--session", "{sessionId}"]
      }
    },
    resumeShell: {
      executable: "powershell.exe",
      args: ["-NoExit", "-NoLogo"]
    },
    analysis: {
      enabled: true,
      defaultTargets: ["skills", "tests"],
      defaultTarget: "skills",
      targets: {
        skills: {
          artifactRoots: ["skills"],
          extensions: [".md"],
          prompt: "Focus on deterministic validation."
        }
      },
      providers: {
        opencode: {
          targets: {
            skills: {
              artifactRoots: ["provider-materials"],
              artifactFiles: ["REFERENCE.md"],
              fileExtensions: [".md"]
            }
          },
          command: {
            executable: "opencode",
            args: ["run", "--file", "{promptPath}"]
          }
        }
      }
    }
  };

  assert.deepEqual(validateUserConfig(fileConfig), []);
  writeUserConfig(configPath, fileConfig);
  const document = readUserConfigDocument(configPath);
  assert.equal(document.exists, true);
  assert.equal(document.error, "");
  assert.deepEqual(document.config, fileConfig);
  assert.equal(
    document.config.analysis.targets.skills.prompt,
    "Focus on deterministic validation."
  );

  const runtimeConfig = {
    allowTerminalLaunch: true,
    resumeCommands: {},
    resumeShell: null,
    analysis: { enabled: false }
  };
  applyRuntimeUserConfig(runtimeConfig, fileConfig);
  assert.equal(runtimeConfig.allowTerminalLaunch, true);
  assert.deepEqual(runtimeConfig.analysis, fileConfig.analysis);
  assert.deepEqual(runtimeConfig.resumeCommands, fileConfig.resumeCommands);
  assert.deepEqual(runtimeConfig.resumeShell, fileConfig.resumeShell);

  assert.deepEqual(
    validateUserConfig({
      analysis: {
        enabled: "yes",
        defaultTargets: [],
        targets: {
          skills: {
            prompt: 42
          }
        },
        providers: {
          opencode: {
            defaultTargets: [],
            command: { executable: "", args: "run" },
            targets: {
              skills: {
                artifactRoots: "skills"
              }
            }
          }
        }
      }
    }),
    [
      "analysis.enabled must be a boolean.",
      "analysis.defaultTargets must contain at least one target.",
      "analysis.targets.skills.prompt must be a string.",
      "analysis.providers.opencode.defaultTargets must contain at least one target.",
      "analysis.providers.opencode.command.executable must be a non-empty string.",
      "analysis.providers.opencode.command.args must be an array of strings.",
      "analysis.providers.opencode.targets.skills.artifactRoots must be an array of strings."
    ]
  );
  assert.deepEqual(
    validateUserConfig({
      analysis: {
        implementation: {
          command: { executable: "", args: "run" }
        },
        providers: {
          opencode: {
            implementation: {
              command: { executable: "", args: "run" }
            }
          }
        }
      }
    }),
    [
      "analysis.implementation.command.executable must be a non-empty string.",
      "analysis.implementation.command.args must be an array of strings.",
      "analysis.providers.opencode.implementation.command.executable must be a non-empty string.",
      "analysis.providers.opencode.implementation.command.args must be an array of strings."
    ]
  );
});

test("legacy analysis material defaults migrate without removing custom paths", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-config-migration-"));
  const configPath = path.join(temp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    analysis: {
      outputDir: ".opensessionviewer/analysis",
      targets: {
        skills: {
          artifactRoots: ["skills", ".agents/skills", ".codex/skills"]
        },
        prompts: {
          artifactRoots: ["custom-prompts"]
        }
      },
      providers: {
        opencode: {
          targets: {
            skills: {
              artifactRoots: [".opencode/skills", ".agents/skills", ".codex/skills"],
              artifactFiles: ["AGENTS.md"]
            }
          }
        },
        codex: {
          targets: {
            skills: {
              artifactFiles: ["AGENTS.md"]
            }
          }
        }
      }
    }
  }));

  const document = readUserConfigDocument(configPath);
  assert.equal(document.config.analysis.outputDir, undefined);
  assert.equal(document.config.analysis.targets.skills.artifactRoots, undefined);
  assert.deepEqual(document.config.analysis.targets.prompts.artifactRoots, ["custom-prompts"]);
  assert.equal(
    document.config.analysis.providers.opencode.targets.skills.artifactRoots,
    undefined
  );
  assert.equal(
    document.config.analysis.providers.opencode.targets.skills.artifactFiles,
    undefined
  );
  assert.deepEqual(
    document.config.analysis.providers.codex.targets.skills.artifactFiles,
    ["AGENTS.md"]
  );
  assert.match(document.raw, /\.agents\/skills/);

  const savedPath = path.join(temp, "saved.json");
  writeUserConfig(savedPath, JSON.parse(document.raw));
  const saved = JSON.parse(readFileSync(savedPath, "utf-8"));
  assert.equal(saved.analysis.outputDir, undefined);
  assert.equal(saved.analysis.targets.skills.artifactRoots, undefined);
  assert.equal(saved.analysis.providers.opencode.targets.skills.artifactRoots, undefined);
  assert.equal(saved.analysis.providers.opencode.targets.skills.artifactFiles, undefined);
});

test("settings page exposes config location and startup-only launch status", () => {
  const html = renderSettingsPage({
    configPath: "C:\\Users\\tester\\config.json",
    configDocument: {
      exists: false,
      raw: "{}\n",
      config: {},
      error: ""
    },
    terminalLaunchAllowed: true,
    provider: "opencode",
    providerName: "OpenCode",
    analysisDefaultCommand: OPENCODE_ANALYSIS_COMMAND,
    resumeDefault: {
      executable: "opencode",
      args: ["--session", "{sessionId}"]
    },
    providers: [{
      id: "opencode",
      name: "OpenCode",
      icon: "OC",
      available: true
    }, {
      id: "codeagent",
      name: "CodeAgent",
      icon: "CA",
      available: false
    }]
  });

  assert.match(html, /data-page="settings"/);
  assert.match(html, /class="logo"[^>]+title="OpenSessionViewer"[^>]+aria-label="OpenSessionViewer"/);
  assert.match(html, /class="provider-tab active"[^>]+title="OpenCode"[^>]+aria-label="OpenCode"[^>]+aria-current="page"/);
  assert.match(html, new RegExp(`class="provider-tab disabled"[^>]+aria-label="CodeAgent - ${regexEscape(t("provider.not_detected"))}"[^>]+aria-disabled="true"`));
  assert.match(html, /id="theme-toggle"[^>]+aria-label="Toggle theme"/);
  assert.match(html, /id="settings-form"/);
  assert.match(html, /class="settings-section-nav"/);
  assert.match(html, /href="#settings-target"/);
  assert.match(html, /href="#settings-advanced" data-open-settings-advanced/);
  assert.match(html, /id="settings-analysis"/);
  assert.match(html, /id="settings-target"/);
  assert.match(html, /id="settings-analyzer"/);
  assert.match(html, /id="settings-resume"/);
  assert.match(html, /id="settings-advanced"/);
  assert.match(html, /id="settings-json"[^>]+aria-describedby="settings-json-feedback"/);
  assert.match(html, /id="settings-json-feedback"[^>]+class="settings-json-feedback"/);
  assert.match(html, /id="settings-analysis-enabled"/);
  assert.match(html, /id="settings-default-target"/);
  assert.match(html, /id="settings-target-id"/);
  assert.match(html, /id="settings-target-context-label"/);
  assert.match(html, /Target display name/);
  assert.match(html, /<option value="skills" selected>/);
  assert.match(html, /Analyze skills \(built-in\)/);
  assert.match(html, /id="settings-target-prompt"/);
  assert.match(html, /data-reset-setting="target-prompt"/);
  assert.match(html, /OpenSessionViewer does not create it/);
  assert.match(html, /id="settings-artifact-summary-roots"/);
  assert.match(html, /Analysis materials used by default/);
  assert.match(html, /data-reset-setting="artifact-roots"/);
  assert.match(html, /data-reset-setting="resume-executable"/);
  assert.match(html, /id="settings-prompt-preview-button"/);
  assert.match(html, /Preview current prompt/);
  for (const [targetId, target] of Object.entries(BUILTIN_ANALYSIS_TARGETS)) {
    assert.match(html, new RegExp(`<option value="${targetId}"`));
    assert.match(html, new RegExp(`${target.label} \\(built-in\\)`));
  }
  assert.match(html, /id="settings-analyzer-model"/);
  assert.match(html, /id="settings-resume-enabled"/);
  assert.match(html, /id="settings-shell-mode"/);
  assert.match(html, /C:\\Users\\tester\\config\.json/);
  assert.match(html, /Enabled for this server process/);
  assert.match(html, /--disable-terminal-launch/);
  assert.match(html, /id="settings-initial-data"/);
  assert.match(html, /id="settings-dirty-state"[^>]+data-dirty="false"/);
  assert.match(html, /class="btn settings-save" disabled/);
  assert.match(html, /deepseek\/deepseek-v4-flash/);
  const settingsInitialData = JSON.parse(
    html.match(/<script type="application\/json" id="settings-initial-data">([\s\S]*?)<\/script>/)[1]
  );
  assert.deepEqual(
    Object.keys(settingsInitialData.targetDefaults),
    Object.keys(BUILTIN_ANALYSIS_TARGETS)
  );
  const presetArgs = settingsInitialData.analysisDefaultCommand.args;
  assert.equal(presetArgs[0], "run");
  assert.ok(
    presetArgs.indexOf("Read the attached analysis request and write the requested proposal files.")
      < presetArgs.indexOf("--file")
  );

  const customTargetHtml = renderSettingsPage({
    configPath: "C:\\Users\\tester\\config.json",
    configDocument: {
      exists: true,
      raw: "{}\n",
      config: {
        analysis: {
          enabled: true,
          defaultTargets: ["memories", "skills"],
          defaultTarget: "memories",
          targets: {
            memories: {
              label: "Analyze memories",
              artifactRoots: ["memories"],
              extensions: [".md"],
              prompt: "Look for stale operational knowledge."
            }
          },
          providers: {
            opencode: {
              defaultTargets: ["memories", "skills"],
              targets: {
                memories: {
                  artifactRoots: ["provider-memories"],
                  artifactFiles: ["MEMORY.md"]
                }
              }
            }
          }
        }
      },
      error: ""
    },
    provider: "opencode",
    providerName: "OpenCode"
  });
  assert.match(customTargetHtml, /<option value="skills"\s*>/);
  assert.match(customTargetHtml, /<option value="memories" selected>/);
  assert.doesNotMatch(customTargetHtml, /name="settings-default-target"/);
  assert.match(customTargetHtml, /Analyze memories \(memories\)/);
  assert.match(customTargetHtml, /Look for stale operational knowledge\./);
  assert.match(customTargetHtml, /provider-memories/);
  assert.match(customTargetHtml, /MEMORY\.md/);

  const codeAgentHtml = renderSettingsPage({
    configPath: "C:\\Users\\tester\\config.json",
    configDocument: {
      exists: false,
      raw: "{}\n",
      config: {},
      error: ""
    },
    terminalLaunchAllowed: true,
    provider: "codeagent",
    providerName: "CodeAgent",
    analysisDefaultCommand: OPENCODE_ANALYSIS_COMMAND,
    resumeDefault: {
      executable: "codeagent",
      args: ["--session", "{sessionId}"]
    },
    providers: [{
      id: "codeagent",
      name: "CodeAgent",
      icon: "CA",
      available: true
    }]
  });
  assert.match(codeAgentHtml, /id="settings-analyzer-enabled"[^>]+checked/);
  assert.match(codeAgentHtml, /id="settings-analyzer-model"/);
  assert.match(codeAgentHtml, /id="settings-analysis-preset"/);
  assert.match(codeAgentHtml, /deepseek\/deepseek-v4-flash/);
  const codeAgentInitialData = JSON.parse(
    codeAgentHtml.match(/<script type="application\/json" id="settings-initial-data">([\s\S]*?)<\/script>/)[1]
  );
  assert.equal(codeAgentInitialData.analysisDefaultCommand.executable, "opencode");
});

test("settings browser script blocks save while advanced JSON is invalid", () => {
  const appScript = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf8");

  assert.match(appScript, /let settingsJsonValid = true;/);
  assert.match(appScript, /submitButton\.disabled = !settingsDirty \|\| !settingsJsonValid;/);
  assert.match(appScript, /const invalidJsonMessage = \(error\) => `\$\{ft\("settings_invalid_json"\)\}: \$\{error\.message\}`;/);
  assert.match(appScript, /if \(event\.target === editor\) \{\s*updateEditorJsonState\(\{ showMessage: true \}\);/);
});

test("built-in analysis materials do not claim provider runtime paths", () => {
  const providerRuntimePath = /(^|[\\/])\.(agents|codex|claude|opencode|gemini)([\\/]|$)/;
  const instructionFile = /^(AGENTS(?:\.override)?|CLAUDE(?:\.local)?|GEMINI)\.md$/i;
  for (const target of Object.values(BUILTIN_ANALYSIS_TARGETS)) {
    assert.equal(target.artifactRoots.some((root) => providerRuntimePath.test(root)), false);
    assert.equal(Boolean(target.artifactFiles?.some((file) => instructionFile.test(file))), false);
  }
  assert.deepEqual(BUILTIN_ANALYSIS_TARGETS.skills.artifactRoots, []);
  assert.deepEqual(BUILTIN_ANALYSIS_TARGETS.agents.artifactRoots, []);
  assert.deepEqual(BUILTIN_ANALYSIS_TARGETS.rules.artifactRoots, []);
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

test("terminal launch prefers Windows Terminal when available", () => {
  const cwd = "C:\\project";
  const powershell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const terminal = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
  const host = resolvePowerShellLaunch(null, (executable) => {
    if (executable === "wt.exe") return terminal;
    if (executable === "pwsh.exe") return powershell;
    return null;
  });

  assert.deepEqual(host, {
    terminal,
    powershell,
    shellArgs: ["-NoExit", "-NoLogo"]
  });
  const args = buildPowerShellResumeArgs(host.powershell, host.shellArgs);
  const launch = buildPowerShellLaunchSpec({ cwd, terminal: host.terminal, powershellArgs: args });
  assert.equal(launch.executable, terminal);
  assert.deepEqual(launch.args.slice(0, 3), ["-d", cwd, powershell]);
  assert.equal(launch.cwd, undefined);
  assert.equal(launch.detached, true);
  assert.equal(launch.windowsHide, true);
  assert.deepEqual(launch.env, {});
});

test("terminal launch falls back to direct PowerShell without Windows Terminal", () => {
  const cwd = "C:\\project";
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const host = resolvePowerShellLaunch(null, (executable) => {
    if (executable === "powershell.exe") return powershell;
    return null;
  });

  assert.deepEqual(host, {
    terminal: null,
    powershell,
    shellArgs: ["-NoExit", "-NoLogo"]
  });
  const args = buildPowerShellResumeArgs(host.powershell, host.shellArgs);
  const launch = buildPowerShellLaunchSpec({ cwd, terminal: host.terminal, powershellArgs: args });
  assert.equal(launch.executable, powershell);
  assert.deepEqual(launch.args.slice(0, 3), ["-NoLogo", "-NoProfile", "-EncodedCommand"]);
  assert.equal(launch.cwd, undefined);
  assert.equal(launch.detached, false);
  assert.equal(launch.windowsHide, true);
  const directSpec = JSON.parse(
    Buffer.from(launch.env.OPENSESSIONVIEWER_DIRECT_POWERSHELL_LAUNCH_SPEC, "base64").toString("utf-8")
  );
  assert.deepEqual(directSpec, {
    executable: powershell,
    args: args.slice(1),
    cwd
  });
  const wrapperScript = Buffer.from(launch.args[3], "base64").toString("utf16le");
  assert.match(wrapperScript, /Start-Process @startInfo/);
});

test("session analysis snapshots artifacts and generates evaluation inputs", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-analysis-"));
  const projectPath = path.join(temp, "project");
  const skillPath = path.join(projectPath, "skills", "review-session", "SKILL.md");
  const projectRuntimeSkillPath = path.join(
    projectPath,
    ".agents",
    "skills",
    "project-runtime",
    "SKILL.md"
  );
  const userHookPath = path.join(temp, "user-runtime", "hooks.json");
  const agentsPath = path.join(projectPath, "AGENTS.md");
  mkdirSync(path.dirname(skillPath), { recursive: true });
  mkdirSync(path.dirname(projectRuntimeSkillPath), { recursive: true });
  mkdirSync(path.dirname(userHookPath), { recursive: true });
  writeFileSync(skillPath, "# Review session\n\nUse execution evidence.\n");
  writeFileSync(projectRuntimeSkillPath, "# Project runtime\n\nUse project context.\n");
  writeFileSync(userHookPath, '{"hooks":{"afterTool":"verify"}}\n');
  writeFileSync(agentsPath, "# Agent rules\n\nRun deterministic validation.\n");
  writeFileSync(path.join(projectPath, "package.json"), '{"type":"commonjs"}\n');
  const staleAnalysisReport = path.join(
    projectPath,
    ".opensessionviewer",
    "analysis",
    "old-run",
    "outputs",
    "report.md"
  );
  mkdirSync(path.dirname(staleAnalysisReport), { recursive: true });
  writeFileSync(staleAnalysisReport, "# Generated analysis output\n");

  const provider = {
    id: "opencode",
    name: "OpenCode",
    icon: "",
    capabilities: {
      sessionAnalysis: true
    },
    detect: () => true,
    getDataPath: () => null,
    scan: async function* () {},
    getSession: () => ({
      id: "session-analysis",
      provider: "opencode",
      parentId: null,
      title: "Improve the review skill",
      directory: projectPath,
      timeCreated: 1,
      timeUpdated: 4,
      messageCount: 4,
      tokenCount: 10
    }),
    getMessages: () => [
      {
        id: "user",
        sessionId: "session-analysis",
        role: "user",
        content: "Review the current skill",
        thinking: null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp: 1,
        tokens: null,
        metadata: null
      },
      {
        id: "assistant",
        sessionId: "session-analysis",
        role: "assistant",
        content: "The verifier is missing.",
        thinking: null,
        toolName: null,
        toolInput: null,
        toolOutput: null,
        timestamp: 2,
        tokens: null,
        metadata: null
      },
      {
        id: "tool-success",
        sessionId: "session-analysis",
        role: "tool",
        content: "All tests passed.",
        thinking: null,
        toolName: "test",
        toolInput: { command: "npm test" },
        toolOutput: "All tests passed.",
        timestamp: 3,
        tokens: null,
        metadata: { isError: false }
      },
      {
        id: "tool-interrupted",
        sessionId: "session-analysis",
        role: "tool",
        content: "User interrupted the command.",
        thinking: null,
        toolName: "shell",
        toolInput: { command: "long-running-command" },
        toolOutput: "User interrupted the command.",
        timestamp: 4,
        tokens: null,
        metadata: { isError: true }
      }
    ],
    getTokenStats: () => [],
    searchMessages: () => [],
    exportSession: () => null,
    getRuntimeEnvironment: () => ({
      sessionId: "session-analysis",
      resolution: "current-local",
      note: "Resolved current test runtime.",
      extensions: [
        {
          id: "runtime:opencode:project:skill:project",
          provider: "opencode",
          scope: "project",
          kind: "skill",
          name: "project-runtime",
          source: projectRuntimeSkillPath,
          sourcePath: path.dirname(projectRuntimeSkillPath),
          sourceType: "directory",
          available: true,
          capturable: true,
          defaultSelected: true,
          note: "Project skill"
        },
        {
          id: "runtime:opencode:project:instruction:agents",
          provider: "opencode",
          scope: "project",
          kind: "instruction",
          name: "AGENTS.md",
          source: agentsPath,
          sourcePath: agentsPath,
          sourceType: "file",
          available: true,
          capturable: true,
          defaultSelected: true,
          note: "Project instructions"
        },
        {
          id: "runtime:opencode:user:hook:user",
          provider: "opencode",
          scope: "user",
          kind: "hook",
          name: "user hooks",
          source: userHookPath,
          sourcePath: userHookPath,
          sourceType: "config",
          available: true,
          capturable: true,
          defaultSelected: true,
          note: "User hooks"
        },
        {
          id: "runtime:opencode:user:plugin:metadata",
          provider: "opencode",
          scope: "user",
          kind: "plugin",
          name: "metadata-only",
          source: "config.toml#plugins.metadata-only",
          sourcePath: null,
          sourceType: "package",
          available: true,
          capturable: false,
          defaultSelected: true,
          note: "Configured package"
        }
      ]
    }),
    getSystemPrompts: () => ({
      sessionId: "session-analysis",
      sections: [
        {
          title: "Instructions",
          note: "Resolved at session start",
          items: [
            {
              kind: "instruction",
              title: "AGENTS.md",
              preview: "Run deterministic validation.",
              source: path.join(projectPath, "AGENTS.md"),
              time: 0
            }
          ]
        }
      ]
    })
  };
  const analysisConfig = {
    enabled: true,
    defaultTargets: ["skills", "tests"],
    implementation: {
      command: {
        executable: process.execPath,
        args: ["--version", "{implementationPromptPath}", "{acceptedProposalsPath}", "{implementationResultPath}", "{accessManifestPath}"],
        stdin: "prompt"
      }
    },
    targets: {
      skills: {
        artifactRoots: ["skills"],
        artifactFiles: [],
        extensions: [".md"],
        prompt: "Focus on deterministic validation."
      }
    },
    providers: {
      opencode: {
        command: {
          executable: process.execPath,
          args: ["--version", "{promptPath}", "{evaluationPath}"],
          stdin: "prompt"
        }
      }
    }
  };

  const action = getSessionAnalysisAction(
    provider,
    "session-analysis",
    projectPath,
    analysisConfig
  );
  assert.equal(action.target, "skills");
  assert.equal(action.available, true);
  assert.deepEqual(action.selectedTargets, ["skills"]);
  assert.deepEqual(action.runtimeEnvironment.selectedExtensionIds, [
    "runtime:opencode:project:skill:project",
    "runtime:opencode:project:instruction:agents",
    "runtime:opencode:user:hook:user",
    "runtime:opencode:user:plugin:metadata"
  ]);
  assert.deepEqual(
    action.targets.map((target) => target.id),
    Object.keys(BUILTIN_ANALYSIS_TARGETS)
  );
  assert.deepEqual(
    action.targets.find((target) => target.id === "skills").artifacts,
    {
      roots: ["skills"],
      files: [],
      fileExtensions: [".md"]
    }
  );

  const run = prepareSessionAnalysis({
    provider,
    sessionId: "session-analysis",
    analysisConfig,
    metaDir: path.join(temp, "meta")
  });
  assert.equal(run.command.stdinPath, run.files.promptPath);
  assert.equal(run.command.args[1], run.files.promptPath);
  assert.equal(run.command.args[2], run.files.evaluationPath);
  assert.ok(existsSync(run.files.manifestPath));
  assert.ok(existsSync(run.files.evaluationSeedPath));
  assert.ok(existsSync(run.files.sessionIndexPath));
  assert.ok(existsSync(run.files.evidenceIndexPath));
  assert.ok(existsSync(run.files.evidencePath));
  assert.ok(existsSync(run.files.accessManifestPath));
  assert.ok(existsSync(run.files.analysisToolPath));
  assert.ok(existsSync(run.files.analysisLayoutPath));
  assert.ok(existsSync(run.files.analysisToolPackagePath));
  assert.equal(existsSync(run.files.messagesPath), false);
  assert.equal(path.relative(run.runDir, run.files.reportPath), path.join("outputs", "report.md"));
  assert.equal(path.relative(run.runDir, run.files.promptPath), path.join("inputs", "analysis-request.md"));
  assert.equal(path.relative(run.runDir, run.files.evidencePath), path.join("evidence", "evidence.jsonl"));
  assert.equal(path.relative(run.runDir, run.files.analyzerStdoutPath), path.join("diagnostics", "analyzer.stdout.log"));
  assert.equal(path.relative(run.runDir, run.files.analyzerStderrPath), path.join("diagnostics", "analyzer.stderr.log"));
  assert.equal(
    path.relative(run.runDir, run.files.accessManifestPath),
    path.join("inputs", "analysis-access.json")
  );
  assert.equal(path.relative(run.runDir, run.files.messagesPath), path.join("diagnostics", "messages.json"));
  assert.deepEqual(
    readdirSync(run.runDir).sort(),
    ["diagnostics", "evidence", "inputs", "manifest.json", "outputs", "tools"].sort()
  );
  const manifest = JSON.parse(readFileSync(run.files.manifestPath, "utf-8"));
  assert.equal(manifest.layoutVersion, 1);
  assert.equal(typeof manifest.integrity.files["inputs/session.json"], "string");
  assert.equal(typeof manifest.integrity.files["inputs/analysis-access.json"], "string");
  assert.equal(typeof manifest.integrity.files["tools/analysis-tools.js"], "string");
  assert.equal(typeof manifest.integrity.files["tools/analysis-layout.js"], "string");
  assert.equal(typeof manifest.integrity.files["tools/package.json"], "string");
  assert.equal(
    JSON.parse(readFileSync(run.files.analysisToolPackagePath, "utf-8")).type,
    "module"
  );
  const evidenceIndexText = readFileSync(run.files.evidenceIndexPath, "utf-8");
  assert.ok(evidenceIndexText.indexOf('"evidenceId"') < evidenceIndexText.indexOf('"sequence"'));
  const preparedRuns = listSessionAnalysisRuns({
    provider,
    providerId: "opencode",
    sessionId: "session-analysis",
    directory: projectPath,
    analysisConfig,
    metaDir: path.join(temp, "meta")
  });
  assert.equal(
    path.dirname(run.runDir),
    path.join(projectPath, ".codeagentsession", "analysis")
  );
  assert.equal(
    readFileSync(path.join(projectPath, ".codeagentsession", ".gitignore"), "utf-8"),
    "*\n!.gitignore\n"
  );
  assert.equal(preparedRuns.length, 1);
  assert.equal(preparedRuns[0].state, "prepared");
  assert.equal(preparedRuns[0].active, true);
  const activeRun = findActiveSessionAnalysisRun({
    provider,
    providerId: "opencode",
    sessionId: "session-analysis",
    directory: projectPath,
    analysisConfig,
    metaDir: path.join(temp, "meta"),
    targetId: "skills"
  });
  assert.equal(activeRun.runId, run.runId);
  assert.equal(findActiveSessionAnalysisRun({
    provider,
    providerId: "opencode",
    sessionId: "session-analysis",
    directory: projectPath,
    analysisConfig,
    metaDir: path.join(temp, "meta"),
    targetId: "prompts"
  }), null);
  const analysisPrompt = readFileSync(run.files.promptPath, "utf-8");
  assert.match(analysisPrompt, /Focus on deterministic validation/);
  assert.match(analysisPrompt, /Never propose changes to those generated files/);
  assert.match(analysisPrompt, /artifactRoot/);
  assert.match(analysisPrompt, /Analysis access manifest/);
  assert.match(analysisPrompt, /Analysis access interfaces/);
  assert.match(analysisPrompt, /provider-neutral interfaces/);
  assert.match(analysisPrompt, /direct file reads/);
  assert.match(analysisPrompt, /Do not spend the run\s+debugging shell command execution/);
  assert.match(analysisPrompt, /If command execution is unavailable or produces no output/);
  assert.match(analysisPrompt, new RegExp(
    run.files.accessManifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ));
  assert.match(analysisPrompt, new RegExp(
    run.files.sessionIndexPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ));
  assert.match(analysisPrompt, new RegExp(
    run.files.evidenceIndexPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ));
  assert.match(analysisPrompt, new RegExp(
    run.files.evidencePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ));
  assert.doesNotMatch(analysisPrompt, /node ".+analysis-tools\.js"/);
  assert.doesNotMatch(analysisPrompt, /analysis-tool\.ps1/);
  assert.match(analysisPrompt, /Contrast successful and failed tool outcomes/);
  assert.match(analysisPrompt, /use only exact, unmodified `ev:\.\.\.` IDs/);
  assert.match(analysisPrompt, /Never append descriptions, parentheses, quotes, line numbers, or filesystem paths/);
  assert.match(analysisPrompt, /Do not reconstruct evidence IDs from\s+`sequence`, `kind`/);
  assert.match(analysisPrompt, /`sequence` is only\s+display order, not a citation key/);
  assert.match(analysisPrompt, /matches a literal `evidenceId` field/);
  assert.match(analysisPrompt, /No ID was reconstructed from `sequence`, `kind`, `sourceKey`/);
  assert.match(analysisPrompt, /metrics\.taskSuccess/);
  assert.match(analysisPrompt, /create\|edit\|replace\|delete/);
  assert.match(
    analysisPrompt,
    /"sourceEvidence": \["ev:opencode:session-analysis:session:session-analysis"\]/
  );

  const artifacts = JSON.parse(readFileSync(run.files.artifactsPath, "utf-8"));
  assert.equal(artifacts.files.length, 4);
  assert.equal(artifacts.runtimeEnvironment.extensions.length, 4);
  assert.deepEqual(
    artifacts.runtimeEnvironment.selectedExtensionIds,
    [
      "runtime:opencode:project:skill:project",
      "runtime:opencode:project:instruction:agents",
      "runtime:opencode:user:hook:user",
      "runtime:opencode:user:plugin:metadata"
    ]
  );
  assert.equal(
    artifacts.files.some((file) => (
      file.sourcePath.includes(`${path.sep}.codeagentsession${path.sep}`)
      || file.sourcePath.includes(`${path.sep}.opensessionviewer${path.sep}`)
    )),
    false
  );
  const skillArtifact = artifacts.files.find(
    (file) => file.sourcePath === skillPath
  );
  const agentsArtifact = artifacts.files.find((file) => file.relativePath === "AGENTS.md");
  const projectRuntimeArtifact = artifacts.files.find(
    (file) => file.sourcePath === projectRuntimeSkillPath
  );
  const userRuntimeArtifact = artifacts.files.find((file) => file.sourcePath === userHookPath);
  assert.match(skillArtifact.artifactId, /^artifact:/);
  assert.ok(existsSync(skillArtifact.snapshotPath));
  assert.equal(agentsArtifact.explicit, true);
  assert.deepEqual(
    agentsArtifact.runtimeExtensionIds,
    ["runtime:opencode:project:instruction:agents"]
  );
  assert.deepEqual(
    projectRuntimeArtifact.runtimeExtensionIds,
    ["runtime:opencode:project:skill:project"]
  );
  assert.deepEqual(
    userRuntimeArtifact.runtimeExtensionIds,
    ["runtime:opencode:user:hook:user"]
  );

  const seed = JSON.parse(readFileSync(run.files.evaluationSeedPath, "utf-8"));
  assert.equal(seed.status, "proposed");
  assert.equal(seed.observedTask, "Review the current skill");
  assert.equal(seed.cases[0].verifier.status, "missing");
  assert.match(seed.cases[0].sourceEvidence[0], /^ev:/);

  const mainInfo = runAnalysisTool(run.runDir, "session_main_info");
  assert.equal(mainInfo.session.direct.toolCalls, 2);
  const bundledTool = spawnSync(
    process.execPath,
    [run.files.analysisToolPath, run.runDir, "session_main_info"],
    { encoding: "utf-8" }
  );
  assert.equal(bundledTool.status, 0, bundledTool.stderr);
  assert.match(bundledTool.stdout, /^# session_main_info/m);
  assert.match(bundledTool.stdout, /## session/);
  assert.match(bundledTool.stdout, /\*\*toolCalls:\*\* `2`/);
  assert.match(
    bundledTool.stdout,
    /ev:opencode:session-analysis:session:session-analysis/
  );
  assert.equal(
    bundledTool.stdout,
    formatAnalysisToolOutput(mainInfo)
  );
  const formattedArtifact = formatAnalysisToolOutput({
    tool: "artifact_get",
    artifact: {
      artifactId: "artifact:example",
      relativePath: "skills/example/SKILL.md"
    },
    content: "# Example\n\n```text\nUse compact output.\n```"
  });
  assert.match(formattedArtifact, /^# artifact_get/m);
  assert.match(formattedArtifact, /artifact:example/);
  assert.match(formattedArtifact, /````text\n# Example/);
  assert.match(formattedArtifact, /Use compact output\./);
  assert.equal(mainInfo.session.direct.errors, 1);
  const accessManifest = JSON.parse(readFileSync(run.files.accessManifestPath, "utf-8"));
  assert.equal(accessManifest.provider.id, "opencode");
  assert.equal(accessManifest.rootSessionId, "session-analysis");
  assert.equal(accessManifest.interfaceVersion, 1);
  assert.equal(accessManifest.backingStores.evidenceRecords, "evidence/evidence.jsonl");
  assert.equal(accessManifest.accessTool.executable, process.execPath);
  assert.equal(accessManifest.accessTool.relativePath, "tools/analysis-tools.js");
  assert.match(accessManifest.rules.join("\n"), /direct file reads/);
  assert.equal(
    accessManifest.interfaces.session.some((entry) => entry.method === "queryTools"
      && entry.command === "session_query_tools"),
    true
  );
  assert.equal(
    accessManifest.interfaces.artifacts.some((entry) => entry.command === "artifact_get"),
    true
  );
  assert.equal(
    accessManifest.interfaces.runtimeExtensions.some((entry) => entry.command === "extension_get"),
    true
  );
  assert.equal(mainInfo.systemPrompts.length, 1);
  const sessionList = runAnalysisTool(run.runDir, "session_list");
  assert.equal(sessionList.total, 1);
  assert.equal(sessionList.items[0].sessionId, "session-analysis");
  const timeline = runAnalysisTool(run.runDir, "session_timeline", {
    kinds: ["tool"]
  });
  assert.equal(timeline.total, 2);
  assert.equal(timeline.items[0].kind, "tool");
  const systemPrompts = runAnalysisTool(run.runDir, "session_query_system_prompts");
  assert.equal(systemPrompts.total, 1);
  assert.match(systemPrompts.items[0].output, /Run deterministic validation/);
  const errors = runAnalysisTool(run.runDir, "session_query_errors");
  assert.equal(errors.total, 1);
  assert.match(errors.items[0].errorReason, /interrupted/i);
  const successes = runAnalysisTool(run.runDir, "session_query_tools", { status: "completed" });
  assert.equal(successes.total, 1);
  assert.equal(successes.items[0].toolName, "test");
  const anomalies = runAnalysisTool(run.runDir, "session_find_anomalies");
  assert.equal(anomalies.interruptions.length, 1);
  assert.equal(anomalies.highErrorRate.heuristic, true);
  assert.equal(anomalies.highErrorRate.flagged.length, 0);
  const rootAnomalies = runAnalysisTool(run.runDir, "session_find_anomalies", {
    includeRoot: true,
    minToolCalls: 2,
    errorRateThreshold: 0.4
  });
  assert.equal(rootAnomalies.highErrorRate.threshold, 0.4);
  assert.equal(rootAnomalies.highErrorRate.flagged[0].toolCalls, 2);
  assert.equal(rootAnomalies.highErrorRate.flagged[0].errors, 1);
  const exactEvidence = runAnalysisTool(run.runDir, "session_get_evidence", {
    evidenceId: errors.items[0].evidenceId
  });
  assert.equal(exactEvidence.complete, true);
  assert.equal(exactEvidence.record.status, "error");
  const extensions = runAnalysisTool(run.runDir, "extension_list");
  assert.equal(extensions.total, 4);
  const extension = runAnalysisTool(run.runDir, "extension_get", {
    extensionId: "runtime:opencode:project:skill:project"
  });
  assert.equal(extension.extension.scope, "project");
  assert.equal(extension.artifacts[0].artifactId, projectRuntimeArtifact.artifactId);
  const instructionExtension = runAnalysisTool(run.runDir, "extension_get", {
    extensionId: "runtime:opencode:project:instruction:agents"
  });
  assert.equal(instructionExtension.extension.kind, "instruction");
  assert.equal(instructionExtension.artifacts[0].artifactId, agentsArtifact.artifactId);
  const artifactList = runAnalysisTool(run.runDir, "artifact_list");
  assert.equal(artifactList.total, 4);
  const artifact = runAnalysisTool(run.runDir, "artifact_get", {
    artifactId: skillArtifact.artifactId
  });
  assert.match(artifact.content, /Use execution evidence/);

  const rootEvidenceId = seed.cases[0].sourceEvidence[0];
  const artifactId = skillArtifact.artifactId;
  const rulesArtifactId = agentsArtifact.artifactId;

  writeFileSync(
    run.files.reportPath,
    "# Session Analysis\n\nA sufficiently detailed analysis report with evidence, risks, proposed updates, and a concrete validation strategy for replay, held-out, and regression tasks.\n"
  );
  const unknownEvidenceId = `${rootEvidenceId}:extra`;
  writeFileSync(run.files.evaluationPath, JSON.stringify({
    schemaVersion: 1,
    status: "proposed",
    target: "skills",
    sourceSessionId: "session-analysis",
    cases: ["replay", "held-out", "regression"].map((kind) => ({
      id: `${kind}-invalid-evidence`,
      title: `${kind} invalid evidence`,
      kind,
      status: "proposed",
      task: "Exercise validator evidence suggestions",
      setup: [],
      sourceEvidence: [unknownEvidenceId],
      expectedOutcome: ["Validator reports the nearest valid evidence ID"],
      comparison: {
        baseline: "Unknown evidence ID",
        candidate: "Exact evidence ID",
        acceptance: ["Validator suggests a copied ID"]
      },
      verifier: { kind: "assertions", assertions: ["error includes closest valid IDs"] },
      metrics: {
        taskSuccess: true,
        maxTokenIncreasePercent: null,
        maxRuntimeIncreasePercent: null
      }
    }))
  }));
  writeFileSync(run.files.proposalsPath, JSON.stringify({
    schemaVersion: 1,
    status: "proposed",
    target: "skills",
    sourceSessionId: "session-analysis",
    proposals: []
  }));
  const invalidEvidenceResult = validateAnalysisOutputs(run.runDir, 0, run.integrity);
  assert.equal(invalidEvidenceResult.state, "invalid");
  assert.ok(invalidEvidenceResult.validation.errors.some((error) => (
    error.includes(`references unknown evidence ${unknownEvidenceId}`)
    && error.includes(`closest valid IDs: ${rootEvidenceId}`)
  )));

  writeFileSync(run.files.evaluationPath, JSON.stringify({
    schemaVersion: 1,
    status: "proposed",
    target: "skills",
    sourceSessionId: "session-analysis",
    cases: [
      {
        id: "replay",
        title: "Replay",
        kind: "replay",
        status: "proposed",
        task: "Replay the task",
        setup: [],
        sourceEvidence: [rootEvidenceId],
        expectedOutcome: ["Task succeeds"],
        comparison: {
          baseline: "Captured skill",
          candidate: "Proposed skill",
          acceptance: ["Candidate succeeds"]
        },
        verifier: { kind: "assertions", assertions: ["success"] },
        metrics: {
          taskSuccess: true,
          maxTokenIncreasePercent: null,
          maxRuntimeIncreasePercent: null
        }
      },
      {
        id: "held-out",
        title: "Held out",
        kind: "held-out",
        status: "proposed",
        task: "Run a related task",
        setup: [],
        sourceEvidence: [artifactId],
        expectedOutcome: ["Task succeeds"],
        comparison: {
          baseline: "Captured skill",
          candidate: "Proposed skill",
          acceptance: ["Candidate succeeds"]
        },
        verifier: { kind: "assertions", assertions: ["success"] },
        metrics: {
          taskSuccess: true,
          maxTokenIncreasePercent: null,
          maxRuntimeIncreasePercent: null
        }
      },
      {
        id: "regression",
        title: "Regression",
        kind: "regression",
        status: "proposed",
        task: "Run an existing passing task",
        setup: [],
        sourceEvidence: [artifactId],
        expectedOutcome: ["Still passes"],
        comparison: {
          baseline: "Captured skill",
          candidate: "Proposed skill",
          acceptance: ["Candidate preserves the passing behavior"]
        },
        verifier: { kind: "command", command: "npm test" },
        metrics: {
          taskSuccess: true,
          maxTokenIncreasePercent: null,
          maxRuntimeIncreasePercent: null
        }
      }
    ]
  }));
  writeFileSync(run.files.proposalsPath, JSON.stringify({
    schemaVersion: 1,
    status: "proposed",
    target: "skills",
    sourceSessionId: "session-analysis",
    proposals: [
      {
        id: "update-agent-rules",
        kind: "skill-evolution",
        action: "edit",
        artifactRoot: projectPath,
        artifactPath: "AGENTS.md",
        description: "Require executable verification.",
        evidence: [rulesArtifactId],
        expectedBenefit: "Fewer unverified recommendations.",
        risks: ["May be too strict for exploratory work."],
        validationCaseIds: ["replay", "held-out", "regression"]
      }
    ]
  }));
  const validated = validateAnalysisOutputs(run.runDir, 0, run.integrity);
  assert.equal(validated.state, "completed");
  assert.equal(validated.validation.evaluationCaseCount, 3);
  assert.equal(validated.validation.artifactProposalCount, 1);
  const completedRuns = listSessionAnalysisRuns({
    provider,
    providerId: "opencode",
    sessionId: "session-analysis",
    directory: projectPath,
    analysisConfig,
    metaDir: path.join(temp, "meta")
  });
  assert.equal(completedRuns[0].state, "completed");
  assert.equal(completedRuns[0].active, false);
  assert.equal(completedRuns[0].hasReport, true);
  assert.equal(completedRuns[0].outputs.report.available, true);
  assert.equal(completedRuns[0].outputs.evaluation.available, true);
  assert.equal(completedRuns[0].outputs.proposals.available, true);
  assert.equal(completedRuns[0].validation.evaluationCaseCount, 3);
  assert.equal(completedRuns[0].implementationAvailable, true);

  const implementationRun = prepareAnalysisImplementation({
    provider,
    sessionId: "session-analysis",
    analysisConfig,
    metaDir: path.join(temp, "meta"),
    runId: run.runId
  });
  assert.equal(implementationRun.command.stdinPath, implementationRun.files.implementationPromptPath);
  assert.equal(implementationRun.command.args[1], implementationRun.files.implementationPromptPath);
  assert.equal(implementationRun.command.args[2], implementationRun.files.acceptedProposalsPath);
  assert.equal(implementationRun.command.args[3], implementationRun.files.implementationResultPath);
  assert.equal(implementationRun.command.args[4], implementationRun.files.accessManifestPath);
  assert.ok(existsSync(implementationRun.files.implementationPromptPath));
  assert.ok(existsSync(implementationRun.files.acceptedProposalsPath));
  const acceptedProposals = JSON.parse(readFileSync(implementationRun.files.acceptedProposalsPath, "utf-8"));
  assert.equal(acceptedProposals.status, "accepted");
  assert.equal(acceptedProposals.selection, "all-validated-proposals");
  assert.deepEqual(acceptedProposals.acceptedProposalIds, ["update-agent-rules"]);
  assert.equal(acceptedProposals.proposals[0].kind, "skill-evolution");
  const implementationPrompt = readFileSync(implementationRun.files.implementationPromptPath, "utf-8");
  assert.match(implementationPrompt, /accepted the validated proposal set/);
  assert.match(implementationPrompt, /git status --short/);
  assert.match(implementationPrompt, /skill-evolution/);
  assert.match(implementationPrompt, /Analysis access interface/);
  assert.match(implementationPrompt, /bounded\s+backing-store interface/);
  assert.match(implementationPrompt, /complete evidence JSONL/);
  assert.match(implementationPrompt, /implementation-result\.json/);
  assert.match(implementationPrompt, /Do not merge automatically/);
  assert.match(implementationPrompt, new RegExp(
    implementationRun.files.acceptedProposalsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ));
  assert.match(implementationPrompt, new RegExp(
    implementationRun.files.proposalsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ));
  assert.match(implementationPrompt, new RegExp(
    implementationRun.files.accessManifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ));
  const implementationManifest = JSON.parse(readFileSync(run.files.manifestPath, "utf-8"));
  assert.equal(implementationManifest.implementation.state, "prepared");
  assert.equal(implementationManifest.implementation.acceptedBy, "user-action");
  assert.equal(
    implementationManifest.implementation.promptPath,
    path.join("inputs", "implementation-request.md").split(path.sep).join("/")
  );
  assert.equal(
    implementationManifest.implementation.acceptedProposalsPath,
    path.join("inputs", "accepted-proposals.json").split(path.sep).join("/")
  );
  assert.equal(
    implementationManifest.implementation.resultPath,
    path.join("outputs", "implementation-result.json").split(path.sep).join("/")
  );
  assert.equal(implementationManifest.implementation.acceptedProposalCount, 1);
  const preparedImplementationRuns = listSessionAnalysisRuns({
    provider,
    providerId: "opencode",
    sessionId: "session-analysis",
    directory: projectPath,
    analysisConfig,
    metaDir: path.join(temp, "meta")
  });
  assert.equal(preparedImplementationRuns[0].implementation.state, "prepared");
  assert.equal(preparedImplementationRuns[0].implementation.acceptedProposalCount, 1);
  assert.equal(preparedImplementationRuns[0].implementation.resultAvailable, false);
  assert.equal(preparedImplementationRuns[0].implementationAvailable, true);

  const generatedTargetProposal = JSON.parse(readFileSync(run.files.proposalsPath, "utf-8"));
  generatedTargetProposal.proposals[0].artifactPath = path.relative(
    projectPath,
    run.files.reportPath
  );
  writeFileSync(run.files.proposalsPath, JSON.stringify(generatedTargetProposal));
  const generatedTarget = validateAnalysisOutputs(run.runDir, 0, run.integrity);
  assert.equal(generatedTarget.state, "invalid");
  assert.ok(
    generatedTarget.validation.errors.some((error) => /generated analysis output/.test(error))
  );
  generatedTargetProposal.proposals[0].artifactPath = "AGENTS.md";
  generatedTargetProposal.proposals[0].kind = "self-evolving-magic";
  writeFileSync(run.files.proposalsPath, JSON.stringify(generatedTargetProposal));
  const invalidKind = validateAnalysisOutputs(run.runDir, 0, run.integrity);
  assert.equal(invalidKind.state, "invalid");
  assert.ok(
    invalidKind.validation.errors.some((error) => /invalid kind self-evolving-magic/.test(error))
  );
  generatedTargetProposal.proposals[0].kind = "skill-evolution";
  writeFileSync(run.files.proposalsPath, JSON.stringify(generatedTargetProposal));

  writeFileSync(run.files.evidencePath, `${readFileSync(run.files.evidencePath, "utf-8")}\n`);
  const tampered = validateAnalysisOutputs(run.runDir, 0, run.integrity);
  assert.equal(tampered.state, "invalid");
  assert.ok(tampered.validation.errors.some((error) => /integrity check/.test(error)));
  mkdirSync(path.dirname(run.files.analyzerStderrPath), { recursive: true });
  writeFileSync(
    run.files.analyzerStderrPath,
    "Codex could not read the local image: No such file or directory\n"
  );
  const failedWithStderr = validateAnalysisOutputs(run.runDir, 1, run.integrity);
  assert.equal(failedWithStderr.state, "failed");
  assert.ok(
    failedWithStderr.validation.errors.some((error) => /Codex could not read the local image/.test(error))
  );

  const filteredRuntimeRun = prepareSessionAnalysis({
    provider,
    sessionId: "session-analysis",
    analysisConfig,
    metaDir: path.join(temp, "meta"),
    runtimeExtensionIds: ["runtime:opencode:project:instruction:agents"]
  });
  const filteredArtifacts = JSON.parse(readFileSync(filteredRuntimeRun.files.artifactsPath, "utf-8"));
  assert.deepEqual(filteredArtifacts.runtimeEnvironment.selectedExtensionIds, [
    "runtime:opencode:project:instruction:agents"
  ]);
});

test("analysis layout resolves legacy flat run files", () => {
  const runDir = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-legacy-analysis-"));
  const manifest = { schemaVersion: 1, runDir };
  writeFileSync(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(path.join(runDir, "report.md"), "# Legacy report\n");
  writeFileSync(path.join(runDir, "evidence-index.json"), "{}\n");

  assert.equal(
    resolveAnalysisRunPath(runDir, manifest, "reportPath"),
    path.join(runDir, "report.md")
  );
  assert.equal(
    resolveAnalysisRunPath(runDir, manifest, "evidenceIndexPath"),
    path.join(runDir, "evidence-index.json")
  );
});

test("analysis run listing preserves legacy metadata-directory runs", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-legacy-runs-"));
  const projectPath = path.join(temp, "project");
  const metaDir = path.join(temp, "meta");
  const runDir = path.join(metaDir, "analysis", "legacy-run");
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    runId: "legacy-run",
    provider: "codex",
    sessionId: "legacy-session",
    target: "skills",
    state: "failed",
    createdAt: "2026-06-01T00:00:00.000Z"
  })}\n`);

  assert.equal(
    getAnalysisOutputRoot(projectPath, {}, metaDir),
    path.join(projectPath, ".codeagentsession", "analysis")
  );
  const legacyProjectRunDir = path.join(projectPath, ".opensessionviewer", "analysis", "legacy-project-run");
  mkdirSync(legacyProjectRunDir, { recursive: true });
  writeFileSync(path.join(legacyProjectRunDir, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    runId: "legacy-project-run",
    provider: "codex",
    sessionId: "legacy-session",
    target: "skills",
    state: "completed",
    createdAt: "2026-06-02T00:00:00.000Z"
  })}\n`);
  const runs = listSessionAnalysisRuns({
    providerId: "codex",
    sessionId: "legacy-session",
    directory: projectPath,
    analysisConfig: {},
    metaDir
  });
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map((run) => run.runId).sort(),
    ["legacy-project-run", "legacy-run"]
  );
  assert.equal(runs.find((run) => run.runId === "legacy-run")?.runDir, runDir);
  assert.equal(
    runs.find((run) => run.runId === "legacy-project-run")?.runDir,
    legacyProjectRunDir
  );
});

test("session analysis requires a provider capability and an enabled target", () => {
  const opencode = { id: "opencode", capabilities: { sessionAnalysis: true } };
  const claude = { id: "claude-code", capabilities: { sessionAnalysis: true } };
  const codex = { id: "codex", capabilities: { structuredSessionViews: true } };
  assert.equal(resolveAnalysisSettings(opencode, { enabled: false }), null);
  assert.equal(resolveAnalysisSettings(opencode, {
    enabled: true,
    providers: { opencode: false }
  }), null);
  assert.equal(resolveAnalysisSettings(opencode, {
    enabled: true,
    targets: { skills: false },
    providers: {
      opencode: {
        command: { executable: "opencode", args: ["run"] }
      }
    }
  }), null);
  assert.equal(resolveAnalysisSettings(codex, {
    enabled: true,
    providers: {
      opencode: {
        command: { executable: "codex", args: ["exec"] }
      }
    }
  }), null);
  assert.equal(resolveAnalysisSettings(opencode, {
    enabled: true
  }).command.executable, "opencode");
  assert.equal(resolveAnalysisSettings(claude, {
    enabled: true
  }).command.executable, "opencode");
});

test("terminal analysis passes the prompt through structured PowerShell input", () => {
  const powershell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const args = buildPowerShellAnalysisArgs(powershell, ["-NoProfile"]);

  assert.deepEqual(args.slice(0, 3), [
    powershell,
    "-NoProfile",
    "-EncodedCommand"
  ]);
  const script = Buffer.from(args[3], "base64").toString("utf16le");
  assert.match(script, /OPENSESSIONVIEWER_ANALYSIS_SPEC/);
  assert.match(script, /Start-Process @startInfo/);
  assert.match(script, /\$startInfo\['RedirectStandardInput'\]=\$spec\.stdinPath/);
  assert.match(script, /RedirectStandardOutput=\$spec\.stdoutPath/);
  assert.match(script, /RedirectStandardError=\$spec\.stderrPath/);
  assert.match(script, /\$agentProcess\.WaitForExit\(\$waitMs\)/);
  assert.match(script, /\$agentProcess\.Kill\(\$true\)/);
  assert.match(script, /Analysis command timed out after/);
  assert.match(script, /\$spec\.reportPath/);
  assert.match(script, /\$spec\.evaluationPath/);
  assert.match(script, /\$spec\.proposalsPath/);
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /\$processInfo\.CommandLine\.Contains/);
  assert.match(script, /\$stderrHasContent/);
  assert.match(script, /Start-Sleep -Milliseconds 1000/);
  assert.match(script, /\$spec\.validatorPath/);
  assert.match(script, /\$spec\.integrityBase64/);
});

test("terminal implementation passes the accepted proposal prompt through structured PowerShell input", () => {
  const powershell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const args = buildPowerShellImplementationArgs(powershell, ["-NoProfile"]);

  assert.deepEqual(args.slice(0, 3), [
    powershell,
    "-NoProfile",
    "-EncodedCommand"
  ]);
  const script = Buffer.from(args[3], "base64").toString("utf16le");
  assert.match(script, /OPENSESSIONVIEWER_IMPLEMENTATION_SPEC/);
  assert.match(script, /\[IO\.File\]::ReadAllText\(\$spec\.stdinPath\)/);
  assert.match(script, /& \$spec\.executable @\(\$spec\.args\)/);
  assert.match(script, /\$lastExitCode=\$LASTEXITCODE/);
  assert.match(script, /\$null -eq \$lastExitCode/);
  assert.doesNotMatch(script, /\$spec\.validatorPath/);
});

test("session rendering shows configured analysis actions only when launch is allowed", () => {
  const session = {
    id: "analysis-session",
    title: "Analyze me",
    directory: process.cwd(),
    time_created: Date.now()
  };
  const hidden = renderSessionPage({
    session,
    analysisAction: {
      target: "skills",
      targets: [{ id: "skills", label: "Analyze skills", available: true }],
      selectedTargets: ["skills"],
      label: "Analyze skills",
      available: true
    },
    terminalLaunchAllowed: false
  });
  assert.doesNotMatch(hidden, /data-action="analyze-session"/);

  const visible = renderSessionPage({
    session,
    manageable: true,
    analysisAction: {
      target: "skills",
      targets: [
        { id: "skills", label: "Analyze skills", available: true },
        { id: "tests", label: "Analyze tests", available: true }
      ],
      selectedTargets: ["skills", "tests"],
      label: null,
      runtimeEnvironment: {
        resolution: "current-local",
        note: "Resolved current runtime.",
        selectedExtensionIds: ["runtime:opencode:project:instruction:agents"],
        extensions: [{
          id: "runtime:opencode:project:instruction:agents",
          provider: "opencode",
          scope: "project",
          kind: "instruction",
          name: "AGENTS.md",
          source: "AGENTS.md",
          sourcePath: "AGENTS.md",
          sourceType: "file",
          available: true,
          capturable: true,
          defaultSelected: true,
          note: "Project instructions"
        }, {
          id: "runtime:opencode:user:plugin:notifier",
          provider: "opencode",
          scope: "user",
          kind: "plugin",
          name: "opencode-notifier",
          source: "opencode.json#plugin:opencode-notifier",
          sourcePath: "opencode.json",
          sourceType: "package",
          available: true,
          capturable: true,
          defaultSelected: false,
          note: "User plugin"
        }]
      },
      available: true
    },
    analysisRuns: [{
      runId: "run-1",
      state: "failed",
      active: false,
      target: "skills",
      runDir: "C:\\analysis\\run-1",
      validation: {
        ok: false,
        processExitCode: 1,
        errors: ["report.md is missing"],
        evaluationCaseCount: 0,
        artifactProposalCount: 0
      }
    }],
    resumeCommand: { display: "opencode --session analysis-session", available: true },
    terminalLaunchAllowed: true
  });
  assert.match(visible, /data-action="analyze-session"/);
  assert.match(visible, /data-target="skills"/);
  assert.match(visible, /class="session-actions-shell analysis-launch-control"/);
  assert.match(visible, /class="action-menu"/);
  assert.match(visible, /Export MD/);
  assert.match(visible, /Export JSON/);
  assert.match(visible, /class="analysis-target-checkbox"/);
  assert.match(visible, /class="analysis-runtime-extension-checkbox"/);
  assert.match(visible, /Analyze 2 targets/);
  assert.match(visible, /Analysis materials/);
  assert.match(visible, /<details class="analysis-materials-panel">/);
  assert.doesNotMatch(visible, /<details class="analysis-materials-panel" open>/);
  assert.match(visible, /class="analysis-target-choice analysis-target-choice-compact/);
  assert.match(visible, /class="analysis-runtime-tab is-active"/);
  assert.match(visible, /role="tabpanel"/);
  assert.match(visible, /Instructions/);
  assert.match(visible, /Plugins/);
  assert.match(visible, /Project scope/);
  assert.match(visible, /User scope/);
  assert.match(visible, /data-action="resume-session"/);
  assert.doesNotMatch(visible, /data-action="copy-resume-command"/);
  assert.match(visible, /id="analysis-status-panel"/);
  assert.match(visible, /data-terminal-launch="true"/);
  assert.match(visible, /report\.md is missing/);
});

test("built-in analysis targets resolve without target-specific config", () => {
  const provider = { id: "opencode", capabilities: { sessionAnalysis: true } };
  const analysisConfig = {
    enabled: true,
    defaultTargets: ["skills", "tests"],
    providers: {
      opencode: {
        command: {
          executable: "opencode",
          args: ["run"]
        }
      }
    }
  };
  assert.deepEqual(
    getAnalysisTargetIds(provider, analysisConfig),
    Object.keys(BUILTIN_ANALYSIS_TARGETS)
  );
  assert.deepEqual(
    getDefaultAnalysisTargetIds(provider, analysisConfig),
    ["skills"]
  );
  for (const [targetId, expected] of Object.entries(BUILTIN_ANALYSIS_TARGETS)) {
    const settings = resolveAnalysisSettings(provider, analysisConfig, targetId);
    assert.equal(settings.targetId, targetId);
    assert.equal(settings.target.label, expected.label);
    assert.deepEqual(settings.target.artifactRoots, expected.artifactRoots);
    assert.deepEqual(settings.target.fileExtensions, expected.fileExtensions);
    assert.match(settings.target.prompt, /\S/);
  }
});

test("CodeAgent opts into session analysis with the shared analyzer default", () => {
  const codeAgent = getAllProviders().find((provider) => provider.id === "codeagent");
  assert.equal(codeAgent?.capabilities?.sessionAnalysis, true);
  const analysisConfig = { enabled: true };

  assert.deepEqual(
    getAnalysisTargetIds(codeAgent, analysisConfig),
    Object.keys(BUILTIN_ANALYSIS_TARGETS)
  );
  assert.equal(
    resolveAnalysisSettings(codeAgent, analysisConfig, "skills").command.executable,
    "opencode"
  );
});

test("provider analysis targets override shared artifacts without changing other providers", () => {
  const analysisConfig = {
    enabled: true,
    targets: {
      skills: {
        artifactRoots: ["shared-skills"],
        artifactFiles: ["REFERENCE.md"],
        fileExtensions: [".md"]
      }
    },
    providers: {
      opencode: {
        command: { executable: "opencode", args: ["run"] },
        targets: {
          skills: {
            artifactRoots: ["provider-materials"],
            artifactFiles: ["OPENCODE.md"]
          }
        }
      },
      codex: {
        command: { executable: "codex", args: ["exec"] }
      }
    }
  };

  const openCode = resolveAnalysisSettings({ id: "opencode", capabilities: { sessionAnalysis: true } }, analysisConfig, "skills");
  const codex = resolveAnalysisSettings({ id: "codex", capabilities: { structuredSessionViews: true } }, analysisConfig, "skills");
  assert.deepEqual(openCode.target.artifactRoots, ["provider-materials"]);
  assert.deepEqual(openCode.target.artifactFiles, ["OPENCODE.md"]);
  assert.deepEqual(openCode.target.fileExtensions, [".md"]);
  assert.equal(codex, null);
});

test("analysis prompt preview uses the real builder and reports configured sources", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-prompt-preview-"));
  const configPath = path.join(temp, "config.json");
  const promptPath = path.join(temp, "prompts", "analyze-skills.md");
  mkdirSync(path.dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, "Inspect successful and failed executions contrastively.\n");
  const provider = { id: "opencode", name: "OpenCode", capabilities: { sessionAnalysis: true } };
  const analysisConfig = {
    enabled: true,
    defaultTarget: "skills",
    includeRawSnapshots: true,
    targets: {
      skills: {
        prompt: "Propose only minimal evidence-backed changes.",
        promptFile: "prompts/analyze-skills.md"
      }
    },
    providers: {
      opencode: {
        command: {
          executable: "opencode",
          args: ["run"]
        }
      }
    }
  };

  const preview = buildAnalysisPromptPreview({
    provider,
    analysisConfig,
    configPath,
    targetId: "skills"
  });
  assert.equal(preview.target, "skills");
  assert.equal(preview.targetInstructionSource, "configured");
  assert.equal(preview.promptFile.available, true);
  assert.equal(preview.promptFile.resolvedPath, promptPath);
  assert.match(preview.prompt, /# OpenSessionViewer session analysis/);
  assert.match(preview.prompt, /<analysis-run-directory>/);
  assert.match(preview.prompt, /Propose only minimal evidence-backed changes/);
  assert.match(preview.prompt, /Inspect successful and failed executions contrastively/);
  assert.match(preview.prompt, /Optional raw diagnostic snapshots/);

  const builtInPreview = buildAnalysisPromptPreview({
    provider,
    analysisConfig: {
      ...analysisConfig,
      includeRawSnapshots: false,
      targets: {}
    },
    configPath,
    targetId: "skills"
  });
  assert.equal(builtInPreview.targetInstructionSource, "built-in");
  assert.equal(builtInPreview.promptFile.configuredPath, "");
  assert.match(
    builtInPreview.prompt,
    /Mark recurring harness or skill improvements as skill-evolution proposals/
  );
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

test("session page can defer flow markup until the panel is opened", () => {
  const container = flowSession("root", [
    flowMessage("u1", "user", 1000),
    flowMessage("a1", "assistant", 1100)
  ]);
  const flow = buildFlowTreeFromContainer(container);
  const sessionTree = {
    session: { id: "root", title: "Lazy flow" },
    detachedChildren: [],
    metrics: flowMetrics(),
    messages: container.messages
  };

  const html = renderSessionPage({
    session: { id: "root", title: "Lazy flow", time_created: 1000 },
    sessionTree,
    provider: "opencode",
    flowLazyUrl: "/api/opencode/session/root/flow-panel"
  });
  const flowFragment = renderCanonicalFlowPanelContent(flow);

  assert.match(html, /data-flow-lazy-url="\/api\/opencode\/session\/root\/flow-panel"/);
  assert.match(html, /Flow loads when opened/);
  assert.doesNotMatch(html, /flow-map-root-session/);
  assert.match(flowFragment, /flow-map-root-session/);
  assert.match(flowFragment, /flow-map-node-user/);
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
