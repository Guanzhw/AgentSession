import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { closeDb, getTokenStats } from "../dist/src/db.js";
import { buildCodeAgentSessionTree } from "../dist/src/providers/codeagent/session-tree.js";
import { enrichCodeAgentSession } from "../dist/src/providers/codeagent/schema.js";
import { buildOpenCodeSessionTree } from "../dist/src/providers/opencode/session-tree.js";
import { buildFlowTreeFromContainer } from "../dist/src/providers/shared/flow-tree.js";
import { renderSessionPage } from "../dist/src/views/session.js";
import { renderSettingsPage } from "../dist/src/views/settings.js";
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
import {
  buildAnalysisPromptPreview,
  buildPowerShellAnalysisArgs,
  getAnalysisTargetIds,
  getDefaultAnalysisTargetIds,
  getAnalysisOutputRoot,
  getSessionAnalysisAction,
  listSessionAnalysisRuns,
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

  const disabled = parseArgs(["--config", configPath]);
  assert.equal(disabled.allowTerminalLaunch, false);
  assert.deepEqual(disabled.resumeShell, {
    executable: "powershell.exe",
    args: ["-NoExit", "-NoLogo", "-NoProfile"]
  });
  assert.equal(disabled.analysis.enabled, true);
  assert.equal(disabled.analysis.providers.codex.command.executable, "codex");
  assert.equal(parseArgs(["--config", configPath, "--allow-terminal-launch"]).allowTerminalLaunch, true);
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
            command: { executable: "", args: "run" }
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
      "analysis.providers.opencode.command.args must be an array of strings."
    ]
  );
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
    resumeDefault: {
      executable: "opencode",
      args: ["--session", "{sessionId}"]
    },
    providers: [{
      id: "opencode",
      name: "OpenCode",
      icon: "OC",
      available: true
    }]
  });

  assert.match(html, /data-page="settings"/);
  assert.match(html, /id="settings-form"/);
  assert.match(html, /class="settings-section-nav"/);
  assert.match(html, /href="#settings-target"/);
  assert.match(html, /id="settings-analysis"/);
  assert.match(html, /id="settings-target"/);
  assert.match(html, /id="settings-analyzer"/);
  assert.match(html, /id="settings-resume"/);
  assert.match(html, /id="settings-advanced"/);
  assert.match(html, /id="settings-json"/);
  assert.match(html, /id="settings-analysis-enabled"/);
  assert.match(html, /id="settings-default-targets"/);
  assert.match(html, /name="settings-default-target" value="skills" checked/);
  assert.match(html, /id="settings-target-id"/);
  assert.match(html, /id="settings-target-context-label"/);
  assert.match(html, /Target display name/);
  assert.match(html, /<option value="skills" selected>/);
  assert.match(html, /Analyze skills \(built-in\)/);
  assert.match(html, /id="settings-target-prompt"/);
  assert.match(html, /OpenSessionViewer does not create it/);
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
  assert.match(html, /--allow-terminal-launch/);
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
  assert.match(customTargetHtml, /name="settings-default-target" value="skills" checked/);
  assert.match(customTargetHtml, /name="settings-default-target" value="memories" checked/);
  assert.match(customTargetHtml, /Analyze memories \(memories\)/);
  assert.match(customTargetHtml, /Look for stale operational knowledge\./);
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

test("session analysis snapshots artifacts and generates evaluation inputs", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-analysis-"));
  const projectPath = path.join(temp, "project");
  const skillPath = path.join(projectPath, "skills", "review-session", "SKILL.md");
  const agentsPath = path.join(projectPath, "AGENTS.md");
  mkdirSync(path.dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, "# Review session\n\nUse execution evidence.\n");
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
    id: "codex",
    name: "Codex CLI",
    icon: "",
    detect: () => true,
    getDataPath: () => null,
    scan: async function* () {},
    getSession: () => ({
      id: "session-analysis",
      provider: "codex",
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
    targets: {
      skills: {
        artifactRoots: ["."],
        artifactFiles: ["AGENTS.md"],
        extensions: [".md"],
        prompt: "Focus on deterministic validation."
      }
    },
    providers: {
      codex: {
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
  assert.deepEqual(action.selectedTargets, ["skills", "tests"]);
  assert.deepEqual(
    action.targets.map((target) => target.id),
    Object.keys(BUILTIN_ANALYSIS_TARGETS)
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
  assert.ok(existsSync(run.files.analysisToolPath));
  assert.ok(existsSync(run.files.analysisLayoutPath));
  assert.ok(existsSync(run.files.analysisToolPackagePath));
  assert.equal(existsSync(run.files.messagesPath), false);
  assert.equal(path.relative(run.runDir, run.files.reportPath), path.join("outputs", "report.md"));
  assert.equal(path.relative(run.runDir, run.files.promptPath), path.join("inputs", "analysis-request.md"));
  assert.equal(path.relative(run.runDir, run.files.evidencePath), path.join("evidence", "evidence.jsonl"));
  assert.equal(path.relative(run.runDir, run.files.messagesPath), path.join("diagnostics", "messages.json"));
  assert.deepEqual(
    readdirSync(run.runDir).sort(),
    ["evidence", "inputs", "manifest.json", "outputs", "tools"].sort()
  );
  const manifest = JSON.parse(readFileSync(run.files.manifestPath, "utf-8"));
  assert.equal(manifest.layoutVersion, 1);
  assert.equal(typeof manifest.integrity.files["inputs/session.json"], "string");
  assert.equal(typeof manifest.integrity.files["tools/analysis-tools.js"], "string");
  assert.equal(typeof manifest.integrity.files["tools/analysis-layout.js"], "string");
  assert.equal(typeof manifest.integrity.files["tools/package.json"], "string");
  assert.equal(
    JSON.parse(readFileSync(run.files.analysisToolPackagePath, "utf-8")).type,
    "module"
  );
  const preparedRuns = listSessionAnalysisRuns({
    providerId: "codex",
    sessionId: "session-analysis",
    directory: projectPath,
    analysisConfig,
    metaDir: path.join(temp, "meta")
  });
  assert.equal(
    path.dirname(run.runDir),
    path.join(projectPath, ".opensessionviewer", "analysis")
  );
  assert.equal(preparedRuns.length, 1);
  assert.equal(preparedRuns[0].state, "prepared");
  assert.equal(preparedRuns[0].active, true);
  const analysisPrompt = readFileSync(run.files.promptPath, "utf-8");
  assert.match(analysisPrompt, /Focus on deterministic validation/);
  assert.match(analysisPrompt, /Never propose changes to those generated files/);
  assert.match(analysisPrompt, /artifactRoot/);
  assert.match(analysisPrompt, /session_query_tools/);
  assert.match(analysisPrompt, /return compact Markdown/);
  assert.match(analysisPrompt, new RegExp(
    run.files.analysisToolPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ));
  assert.match(analysisPrompt, /Contrast successful and failed tool outcomes/);
  assert.match(analysisPrompt, /use only exact, unmodified `ev:\.\.\.` IDs/);
  assert.match(analysisPrompt, /Never append descriptions, parentheses, quotes, line numbers, or filesystem paths/);
  assert.match(
    analysisPrompt,
    /"sourceEvidence": \["ev:codex:session-analysis:session:session-analysis"\]/
  );

  const artifacts = JSON.parse(readFileSync(run.files.artifactsPath, "utf-8"));
  assert.equal(artifacts.files.length, 2);
  assert.equal(
    artifacts.files.some((file) => file.sourcePath.includes(`${path.sep}.opensessionviewer${path.sep}`)),
    false
  );
  const skillArtifact = artifacts.files.find(
    (file) => file.relativePath === path.join("skills", "review-session", "SKILL.md")
  );
  const agentsArtifact = artifacts.files.find((file) => file.relativePath === "AGENTS.md");
  assert.match(skillArtifact.artifactId, /^artifact:/);
  assert.ok(existsSync(skillArtifact.snapshotPath));
  assert.equal(agentsArtifact.explicit, false);

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
    /ev:codex:session-analysis:session:session-analysis/
  );
  assert.ok(
    bundledTool.stdout.length < JSON.stringify(mainInfo, null, 2).length,
    "compact Markdown should be shorter than pretty-printed JSON"
  );
  assert.equal(
    bundledTool.stdout,
    formatAnalysisToolOutput(mainInfo)
  );
  const formattedArtifact = formatAnalysisToolOutput({
    tool: "extension_get",
    artifact: {
      artifactId: "artifact:example",
      relativePath: "skills/example/SKILL.md"
    },
    content: "# Example\n\n```text\nUse compact output.\n```"
  });
  assert.match(formattedArtifact, /^# extension_get/m);
  assert.match(formattedArtifact, /artifact:example/);
  assert.match(formattedArtifact, /````text\n# Example/);
  assert.match(formattedArtifact, /Use compact output\./);
  assert.equal(mainInfo.session.direct.errors, 1);
  assert.equal(mainInfo.systemPrompts.length, 1);
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
  assert.equal(extensions.total, 2);
  const extension = runAnalysisTool(run.runDir, "extension_get", {
    artifactId: skillArtifact.artifactId
  });
  assert.match(extension.content, /Use execution evidence/);

  const rootEvidenceId = seed.cases[0].sourceEvidence[0];
  const artifactId = skillArtifact.artifactId;
  const rulesArtifactId = agentsArtifact.artifactId;

  writeFileSync(
    run.files.reportPath,
    "# Session Analysis\n\nA sufficiently detailed analysis report with evidence, risks, proposed updates, and a concrete validation strategy for replay, held-out, and regression tasks.\n"
  );
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
        action: "replace",
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
    providerId: "codex",
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
  writeFileSync(run.files.proposalsPath, JSON.stringify(generatedTargetProposal));

  writeFileSync(run.files.evidencePath, `${readFileSync(run.files.evidencePath, "utf-8")}\n`);
  const tampered = validateAnalysisOutputs(run.runDir, 0, run.integrity);
  assert.equal(tampered.state, "invalid");
  assert.ok(tampered.validation.errors.some((error) => /integrity check/.test(error)));
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
    path.join(projectPath, ".opensessionviewer", "analysis")
  );
  const runs = listSessionAnalysisRuns({
    providerId: "codex",
    sessionId: "legacy-session",
    directory: projectPath,
    analysisConfig: {},
    metaDir
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, "legacy-run");
  assert.equal(runs[0].runDir, runDir);
});

test("session analysis requires enabled provider and target configuration", () => {
  const provider = { id: "codex" };
  assert.equal(resolveAnalysisSettings(provider, { enabled: false }), null);
  assert.equal(resolveAnalysisSettings(provider, {
    enabled: true,
    providers: { codex: false }
  }), null);
  assert.equal(resolveAnalysisSettings(provider, {
    enabled: true,
    targets: { skills: false },
    providers: {
      codex: {
        command: { executable: "codex", args: ["exec"] }
      }
    }
  }), null);
  assert.equal(resolveAnalysisSettings(provider, {
    enabled: true,
    providers: { codex: {} }
  }), null);
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
  assert.match(script, /\[IO\.File\]::ReadAllText\(\$spec\.stdinPath\)/);
  assert.match(script, /& \$spec\.executable @\(\$spec\.args\)/);
  assert.match(script, /\$spec\.validatorPath/);
  assert.match(script, /\$spec\.integrityBase64/);
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
    analysisAction: {
      target: "skills",
      targets: [
        { id: "skills", label: "Analyze skills", available: true },
        { id: "tests", label: "Analyze tests", available: true }
      ],
      selectedTargets: ["skills", "tests"],
      label: null,
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
  assert.match(visible, /class="analysis-target-checkbox"/);
  assert.match(visible, /value="skills"\s+checked/);
  assert.match(visible, /value="tests"\s+checked/);
  assert.match(visible, /data-action="resume-session"/);
  assert.doesNotMatch(visible, /data-action="copy-resume-command"/);
  assert.match(visible, /id="analysis-status-panel"/);
  assert.match(visible, /report\.md is missing/);
});

test("built-in analysis targets resolve without target-specific config", () => {
  const provider = { id: "opencode" };
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
    ["skills", "tests"]
  );
  for (const [targetId, expected] of Object.entries(BUILTIN_ANALYSIS_TARGETS)) {
    const settings = resolveAnalysisSettings(provider, analysisConfig, targetId);
    assert.equal(settings.targetId, targetId);
    assert.equal(settings.target.label, expected.label);
    assert.deepEqual(settings.target.artifactRoots, expected.artifactRoots);
    assert.deepEqual(settings.target.extensions, expected.extensions);
    assert.match(settings.target.prompt, /\S/);
  }
});

test("analysis prompt preview uses the real builder and reports configured sources", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensessionviewer-prompt-preview-"));
  const configPath = path.join(temp, "config.json");
  const promptPath = path.join(temp, "prompts", "analyze-skills.md");
  mkdirSync(path.dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, "Inspect successful and failed executions contrastively.\n");
  const provider = { id: "opencode", name: "OpenCode" };
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
    /Focus proposals on reusable agent skills and their supporting files/
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
