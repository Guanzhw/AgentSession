import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";

import { closeDb, getFilteredSessionCount, getModelDistribution, getModelPairs, getSession, getStatsProjects, getTokenCoverage, getTokenStats, getTopTokenSessions, listSessionProjects, listSessions, searchMessages } from "../dist/src/db.js";
import { buildOpenCodeRuntimeEnvironment } from "../dist/src/providers/opencode/runtime-environment.js";
import { buildOpenCodeSessionTree } from "../dist/src/providers/opencode/session-tree.js";
import { buildClaudeCodeRuntimeEnvironment } from "../dist/src/providers/claude-code/runtime-environment.js";
import {
  buildClaudeCodeSessionViews,
  buildLinkedClaudeCodeSessionViews,
  buildClaudeCodeSystemPrompts
} from "../dist/src/providers/claude-code/views.js";
import { buildCodexRuntimeEnvironment } from "../dist/src/providers/codex/runtime-environment.js";
import { codexDailyTokenComponents } from "../dist/src/providers/codex/adapter.js";
import { buildGeminiRuntimeEnvironment } from "../dist/src/providers/gemini/runtime-environment.js";
import { buildPiRuntimeEnvironment } from "../dist/src/providers/pi/runtime-environment.js";
import { buildFlowTreeFromContainer } from "../dist/src/providers/shared/flow-tree.js";
import { renderCanonicalFlowPanelContent, renderSessionPage } from "../dist/src/views/session.js";
import { renderSettingsPage } from "../dist/src/views/settings.js";
import { renderStatsDeferredSection, renderStatsPage } from "../dist/src/views/stats.js";
import { sessionCard } from "../dist/src/views/components.js";
import { renderSessionsPage } from "../dist/src/views/sessions.js";
import { EMPTY_PROJECT_FILTER, normalizeCrossProviderProjectPath } from "../dist/src/project-filter.js";
import { parseSessionNavigationContext } from "../dist/src/navigation-context.js";
import {
  getSearchResults,
  resolveSessionKindFilter,
  resolveSessionSearchMode,
  resolveSessionSort,
  resolveStarredFilter
} from "../dist/src/server.js";
import { isAnalysisTitledSession, matchesSessionKind } from "../dist/src/session-kind.js";
import { t } from "../dist/src/i18n.js";
import {
  claudeUsageToTokens,
  extractSessionMeta,
  parseTranscript,
  recordsToMessages,
  uniqueClaudeAssistantUsageRecords
} from "../dist/src/providers/claude-code/parser.js";
import {
  extractMeta as extractCodexMeta,
  recordsToMessages as codexRecordsToMessages,
  classifyCodexRecordProvenance,
  codexOwnedTokenUsageRecords,
  resolveCodexInheritedContext
} from "../dist/src/providers/codex/parser.js";
import { buildMessageSessionViews } from "../dist/src/providers/shared/message-session.js";
import { buildSessionMetrics } from "../dist/src/providers/shared/session-metrics.js";
import { buildLinkedMessageSessionViews } from "../dist/src/providers/shared/linked-message-session.js";
import { buildAgentLoop, buildAgentLoopTrace } from "../dist/src/providers/shared/agent-loop.js";
import {
  classifySharedTool,
  isSubagentTool,
  mergeToolMetadata
} from "../dist/src/providers/shared/subagent-tools.js";
import { createOpenCodeSqliteAdapter } from "../dist/src/providers/opencode/sqlite-adapter.js";
import { createIncrementalTokenStats, createSessionFileStore } from "../dist/src/providers/shared/file-adapter-helpers.js";
import { providerFeatureMatrix } from "../dist/src/providers/kinds.js";
import { createStatsCache } from "../dist/src/stats-cache.js";
import {
  getIndexedModelDistribution,
  getIndexedTokenSessionCount,
  getIndexedTokenStats,
  refreshSqliteTokenStatsIndex,
} from "../dist/src/stats-index.js";
import { dataToMessages as geminiDataToMessages } from "../dist/src/providers/gemini/parser.js";
import {
  activePiEntries,
  extractPiMeta,
  parsePiSession,
  piAssistantUsageRecords,
  piUsageToTokens,
  piRecordsToMessages
} from "../dist/src/providers/pi/parser.js";
import { getAllProviders } from "../dist/src/providers/index.js";
import {
  buildPowerShellLaunchSpec,
  buildPowerShellResumeArgs,
  getResumeCommand,
  launchPowerShellWithFallback,
  resolvePowerShellLaunch,
  resolveProjectDirectory,
  resolveWindowsExecutableCandidate,
  spawnPowerShellLaunch
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
import { buildAnalysisAccessManifest } from "../dist/src/analysis-access.js";
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

test("binary analysis access invokes the embedded helper mode", () => {
  const runDir = path.join(os.tmpdir(), "analysis-run");
  const files = {
    analysisToolPath: path.join(runDir, "tools", "analysis-tools.js"),
    sessionIndexPath: path.join(runDir, "evidence", "session-index.json"),
    evidenceIndexPath: path.join(runDir, "evidence", "evidence-index.json"),
    evidencePath: path.join(runDir, "evidence", "evidence.jsonl"),
    artifactsPath: path.join(runDir, "artifacts.json")
  };
  const manifest = buildAnalysisAccessManifest({
    providerId: "codex",
    providerName: "Codex CLI",
    rootSessionId: "session-1",
    runDir,
    files,
    nodeExecutable: "agentsession.exe",
    executableArgs: ["--internal-analysis-tool"]
  });
  assert.deepEqual(manifest.accessTool.executableArgs, ["--internal-analysis-tool"]);
  assert.match(manifest.accessTool.invocation, /agentsession\.exe" "--internal-analysis-tool"/);
  assert.doesNotMatch(manifest.accessTool.invocation, /analysis-tools\.js" "C:/);
});

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

test("Claude task notifications bind Agent calls without becoming user messages", () => {
  const parentRecords = [
    {
      type: "user",
      uuid: "parent-user",
      timestamp: "2026-07-25T00:00:00.000Z",
      message: { content: "Delegate a review." }
    },
    {
      type: "assistant",
      uuid: "agent-call-record",
      timestamp: "2026-07-25T00:00:01.000Z",
      message: {
        id: "response-1",
        content: [{ type: "tool_use", id: "agent-call", name: "Agent", input: { description: "Review" } }]
      }
    },
    {
      type: "user",
      uuid: "task-notification",
      timestamp: "2026-07-25T00:00:02.000Z",
      message: {
        content: "<task-notification><task-id>claude-agent-1</task-id><tool-use-id>agent-call</tool-use-id><status>completed</status><summary>Review complete</summary></task-notification>"
      }
    }
  ];
  const childRecords = [{
    type: "assistant",
    uuid: "child-answer",
    isSidechain: true,
    agentId: "claude-agent-1",
    sessionId: "claude-parent",
    timestamp: "2026-07-25T00:00:03.000Z",
    message: { content: [{ type: "text", text: "Review complete" }] }
  }];
  const parent = extractSessionMeta(parentRecords, "claude-parent");
  const child = extractSessionMeta(childRecords, "agent-claude-agent-1");
  const parentMessages = recordsToMessages(parentRecords, parent.id);
  const views = buildLinkedClaudeCodeSessionViews(parent.id, [
    { session: parent, messages: parentMessages },
    { session: child, messages: recordsToMessages(childRecords, child.id) }
  ]);

  assert.deepEqual(parentMessages.map((message) => message.role), ["user", "tool", "tool"]);
  assert.equal(parentMessages[2].metadata?.source, "task_notification");
  assert.equal(parentMessages[2].metadata?.taskId, "claude-agent-1");
  assert.equal(views?.tree.messages.filter((message) => message.role === "user").length, 1);
  assert.doesNotMatch(JSON.stringify(views?.tree), /task-notification/);
  assert.equal(views?.tree.messages[1].parts[0].childSessions[0].session.id, "claude-agent-1");
  assert.equal(views?.tree.detachedChildren.length, 0);
  assert.equal(views?.flow.root.line.some((node) => node.inferred), false);
});

test("Claude token usage keeps optional fields numeric and deduplicates response fragments", () => {
  const records = [
    {
      type: "assistant",
      message: {
        id: "response-1",
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7 }
      }
    },
    {
      type: "assistant",
      message: {
        id: "response-1",
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7 }
      }
    }
  ];

  assert.deepEqual(claudeUsageToTokens(records[0].message.usage), {
    input: 10,
    output: 4,
    reasoning: 0,
    cache: { read: 7, write: 0 },
    total: 21
  });
  assert.equal(uniqueClaudeAssistantUsageRecords(records).length, 1);
  assert.equal(extractSessionMeta(records, "fragmented-response").tokenCount, 21);
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
  assert.equal(views.trace.summary.totalSteps, 2);
  assert.equal(views.metrics.steps[0]?.reason, "tool-calls");
});

test("Agent Loop folds common coding-agent turns into provider-neutral trace steps", () => {
  const messages = [
    {
      id: "user-1", sessionId: "loop-session", role: "user", content: "Inspect the repository.",
      thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: 1000, tokens: null, metadata: null
    },
    {
      id: "assistant-1", sessionId: "loop-session", role: "assistant", content: "", thinking: "I will inspect the files.",
      toolName: "read", toolInput: { path: "README.md" }, toolOutput: null, timestamp: 2000,
      tokens: { input: 5, output: 3, total: 8, cache: { read: 0, write: 0 } },
      metadata: { turnId: "response-1", callId: "read-1", model: "fixture-model" }
    },
    {
      id: "tool-result-1", sessionId: "loop-session", role: "tool", content: "AgentSession", thinking: null,
      toolName: "read", toolInput: null, toolOutput: "AgentSession", timestamp: 3000, tokens: null,
      metadata: { toolUseId: "read-1" }
    },
    {
      id: "assistant-2", sessionId: "loop-session", role: "assistant", content: "The repository is ready.", thinking: null,
      toolName: null, toolInput: null, toolOutput: null, timestamp: 4000,
      tokens: { input: 2, output: 4, total: 6, cache: { read: 0, write: 0 } },
      metadata: { turnId: "response-2", model: "fixture-model" }
    }
  ];
  const loop = buildAgentLoop(messages);
  const trace = buildAgentLoopTrace("loop-session", loop);

  assert.deepEqual(loop.turns.map((turn) => [turn.role, turn.events.map((event) => event.kind)]), [
    ["user", ["text"]],
    ["assistant", ["reasoning", "tool"]],
    ["assistant", ["text"]]
  ]);
  assert.equal(loop.turns[1].events[1].output, "AgentSession");
  assert.equal(trace.summary.totalSteps, 2);
  assert.equal(trace.steps[0].reason, "tool-calls");
  assert.equal(trace.steps[0].spans[1].output, "AgentSession");
  assert.equal(trace.steps[1].tokens.total, 6);
});

test("Agent Loop classifies every supported subagent launcher as an agent", () => {
  for (const toolName of ["agent", "task", "subtask", "spawn_agent", "delegate_task"]) {
    const loop = buildAgentLoop([{
      id: `${toolName}-assistant`, sessionId: "launcher-loop", role: "assistant", content: "", thinking: null,
      toolName, toolInput: { description: `Run ${toolName}` }, toolOutput: "done", timestamp: 1000, tokens: null,
      metadata: { callId: `${toolName}-call` }
    }]);
    const trace = buildAgentLoopTrace("launcher-loop", loop);

    assert.equal(trace.steps[0].spans[0].name, toolName);
    assert.equal(trace.steps[0].spans[0].category, "agent");
  }
});

test("shared tool classification preserves semantic metadata and generic tool categories", () => {
  const metadata = mergeToolMetadata({ subagent: true }, { turnId: "response-1" });

  assert.equal(isSubagentTool("custom-reviewer", metadata), true);
  assert.equal(isSubagentTool("custom-reviewer", mergeToolMetadata({ subagent: true }, { subagent: false })), true);
  assert.deepEqual(classifySharedTool("custom-reviewer", metadata), { category: "agent", mcpServer: null });
  assert.deepEqual(classifySharedTool("skill"), { category: "skill", mcpServer: null });
  assert.deepEqual(classifySharedTool("lsp_definition"), { category: "lsp", mcpServer: null });
  assert.deepEqual(classifySharedTool("mcp__github__search_issues"), { category: "mcp", mcpServer: "github" });
});

test("Agent Loop only folds tool-role results into a matching tool call", () => {
  const loop = buildAgentLoop([
    {
      id: "assistant-tool", sessionId: "loop-role-guard", role: "assistant", content: "", thinking: null,
      toolName: "read", toolInput: { path: "README.md" }, toolOutput: null, timestamp: 1000, tokens: null,
      metadata: { callId: "read-call" }
    },
    {
      id: "user-with-coincidental-id", sessionId: "loop-role-guard", role: "user", content: "This is a new prompt.", thinking: null,
      toolName: null, toolInput: null, toolOutput: null, timestamp: 2000, tokens: null,
      metadata: { toolUseId: "read-call" }
    }
  ]);

  assert.deepEqual(loop.turns.map((turn) => turn.role), ["assistant", "user"]);
  assert.equal(loop.turns[1].events[0].text, "This is a new prompt.");
});

test("Agent Loop clears implicit tool continuation at a system boundary", () => {
  const messages = [
    {
      id: "assistant", sessionId: "loop-boundary", role: "assistant", content: "Running tools.",
      thinking: null, toolName: null, toolInput: null, toolOutput: null, timestamp: 1000, tokens: null, metadata: null
    },
    {
      id: "tool-before", sessionId: "loop-boundary", role: "tool", content: "before", thinking: null,
      toolName: "read", toolInput: null, toolOutput: "before", timestamp: 2000, tokens: null, metadata: null
    },
    {
      id: "compaction", sessionId: "loop-boundary", role: "system", content: "Compacted context.", thinking: null,
      toolName: null, toolInput: null, toolOutput: null, timestamp: 3000, tokens: null, metadata: null
    },
    {
      id: "tool-after", sessionId: "loop-boundary", role: "tool", content: "after", thinking: null,
      toolName: "write", toolInput: null, toolOutput: "after", timestamp: 4000, tokens: null, metadata: null
    }
  ];
  const loop = buildAgentLoop(messages);

  assert.deepEqual(loop.turns.map((turn) => [turn.role, turn.events.map((event) => event.tool || event.kind)]), [
    ["assistant", ["text", "read"]],
    ["system", ["text"]],
    ["tool", ["write"]]
  ]);
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

test("Claude Code trace classifies every supported subagent launcher as an agent", () => {
  for (const toolName of ["Agent", "task", "subtask", "spawn_agent", "delegate_task"]) {
    const records = [
      {
        type: "assistant",
        uuid: `${toolName}-assistant`,
        timestamp: "2026-06-06T00:00:01.000Z",
        message: {
          model: "claude-sonnet",
          usage: { input_tokens: 3, output_tokens: 2 },
          content: [{ type: "tool_use", id: `${toolName}-call`, name: toolName, input: { description: "Run child" } }]
        }
      },
      {
        type: "user",
        uuid: `${toolName}-result`,
        timestamp: "2026-06-06T00:00:02.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: `${toolName}-call`, content: "done", is_error: false }] }
      }
    ];
    const session = extractSessionMeta(records, `claude-${toolName}`);
    const views = buildClaudeCodeSessionViews(session, recordsToMessages(records, `claude-${toolName}`));
    const span = views.trace.steps[0].spans.find((candidate) => candidate.name === toolName);

    assert.equal(span?.category, "agent", toolName);
  }
});

test("Claude Code system prompt evidence resolves local runtime sources without hidden prompt claims", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-claude-prompts-"));
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
    output: 100,
    reasoning: 20,
    cache: { read: 9000, write: 0 },
    total: 10120
  });
  assert.equal(messages[0].metadata.model, "gpt-5");
  assert.equal(session.id, "codex-test");
  assert.equal(views.metrics.totals.cacheReadTokens, 9000);
  assert.equal(views.flow.summary.totalTokens, 10120);
});

test("Codex assigns interrupted request usage to the initiating user message", () => {
  const records = [
    {
      timestamp: "2026-07-21T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "codex-interrupted" }
    },
    {
      timestamp: "2026-07-21T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Please begin the task." }
    },
    {
      timestamp: "2026-07-21T00:00:02.000Z",
      type: "event_msg",
      payload: { type: "turn_aborted" }
    },
    {
      timestamp: "2026-07-21T00:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 40, output_tokens: 2, total_tokens: 42 } }
      }
    }
  ];
  const session = extractCodexMeta(records, "codex-interrupted");
  const messages = codexRecordsToMessages(records, "codex-interrupted");
  const views = buildMessageSessionViews(session, messages);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].tokens.total, 42);
  assert.equal(messages[0].metadata.tokenAttribution, "request-start");
  assert.equal(views.metrics.totals.totalTokens, 42);
  assert.equal(views.flow.summary.totalTokens, 42);
});

test("shared session metrics preserve a provider-reported total with partial components", () => {
  const metrics = buildSessionMetrics(
    "source-total",
    undefined,
    () => ({
      messages: [{
        id: "message",
        parts: [],
        data: { tokens: { input: 10, output: 5, total: 42 } }
      }],
      detachedChildren: [],
      metrics: {
        totalMessages: 1,
        totalToolCalls: 0,
        descendantCount: 0,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
        runtimeMs: 0
      }
    }),
    () => ({ steps: [] })
  );

  assert.equal(metrics?.totals.totalTokens, 42);
  assert.equal(metrics?.totals.inputTokens, 10);
  assert.equal(metrics?.totals.outputTokens, 5);
});

test("OpenCode token stats include child sessions exactly once", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-token-"));
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

test("resume commands use structured placeholders and validated directories", () => {
  const cwd = resolveProjectDirectory(process.cwd());
  assert.ok(cwd);
  const provider = {
    id: "opencode",
    resumeCommand: {
      executable: process.execPath,
      args: ["--version", "{sessionId}"]
    }
  };
  const command = getResumeCommand(provider, "session id", cwd, {
    opencode: {
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
    opencode: { executable: "{sessionId}", args: [] }
  });
  assert.equal(fixedExecutable.executable, "{sessionId}");
  assert.equal(fixedExecutable.available, false);

  const providerDefault = getResumeCommand(provider, "default id", cwd, {});
  assert.equal(providerDefault.executable, process.execPath);
  assert.deepEqual(providerDefault.args, ["--version", "default id"]);
  assert.equal(getResumeCommand(provider, "disabled", cwd, { opencode: false }), null);
});

test("Token Explorer database queries share the usable assistant-token dataset", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-token-explorer-"));
  const dbPath = path.join(temp, "sessions.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, title TEXT, slug TEXT,
        directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    `);
    db.prepare("INSERT INTO project (id, name, worktree) VALUES (?, ?, ?)").run("p1", "Readable Project", "/projects/readable");
    const created = Date.now() - 1000;
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("s1", null, "p1", "Mixed model session", "mixed", "/projects/readable", created, created);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("s2", null, "p1", "No token session", "no-token", "/projects/readable", created, created);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("s3", null, null, "Global usage", "global", "/global", created, created);
    const insert = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
    insert.run("a1", "s1", JSON.stringify({
      role: "assistant", providerID: "provider-a", modelID: "model-a", time: { created },
      tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 2, write: 0 } }
    }));
    insert.run("a2", "s1", JSON.stringify({
      role: "assistant", providerID: "provider-b", modelID: "model-b", time: { created },
      tokens: { input: 1, output: 3, reasoning: 2, cache: { read: 9, write: 0 }, total: 13 }
    }));
    insert.run("u1", "s1", JSON.stringify({
      role: "user", providerID: "provider-a", modelID: "model-a", time: { created }, tokens: { total: 999 }
    }));
    insert.run("a3", "s1", JSON.stringify({ role: "assistant", time: { created }, content: "no usage" }));
    insert.run("a4", "s2", JSON.stringify({ role: "assistant", time: { created }, content: "no usage" }));
    insert.run("a5", "s3", JSON.stringify({ role: "assistant", time: { created }, tokens: { total: 5 } }));
    db.close();

    assert.equal(getTokenStats(30, dbPath)[0].total_tokens, 28);
    assert.equal(getTokenStats(30, dbPath, { project: EMPTY_PROJECT_FILTER })[0].total_tokens, 5);
    assert.equal(getFilteredSessionCount(dbPath, { days: 30 }), 2);
    assert.deepEqual(getModelPairs(dbPath, { days: 30 }).map((row) => row.key).sort(), ["provider-a/model-a", "provider-b/model-b"]);
    assert.equal(getStatsProjects(dbPath, { days: 30 }).find((row) => row.projectId === "p1").label, "Readable Project");

    const top = getTopTokenSessions(dbPath, { days: 30 });
    assert.equal(top[0].total_tokens, 23);
    assert.equal(top[0].message_count, 2);
    assert.equal(top[0].provider_model, "__multiple__");
    assert.equal(top[0].model_count, 2);

    const coverage = getTokenCoverage(dbPath, { days: 30 });
    assert.equal(coverage.messagesWithTokens, 3);
    assert.equal(coverage.totalAssistantMessages, 5);
    assert.equal(coverage.totalSessions, 3);
    assert.deepEqual(coverage.dimensions, {
      input: true, output: true, reasoning: true, cacheRead: true, cacheWrite: true
    });
  } finally {
    closeDb(dbPath);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Codex preserves canonical subagent identity and groups each response as a ReACT turn", () => {
  const records = [
    {
      timestamp: "2026-07-11T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-child",
        session_id: "codex-parent",
        parent_thread_id: "codex-parent",
        thread_source: "subagent",
        agent_path: "/root/reviewer",
        cwd: "D:\\WorkSpace"
      }
    },
    {
      timestamp: "2026-07-11T00:00:00.100Z",
      type: "session_meta",
      payload: { id: "codex-parent", session_id: "codex-parent", thread_source: "user" }
    },
    {
      timestamp: "2026-07-11T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inherited parent prompt" }] }
    },
    {
      timestamp: "2026-07-11T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Inherited parent prompt" }
    },
    {
      timestamp: "2026-07-11T00:00:01.000Z",
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Inspect first" }] }
    },
    {
      timestamp: "2026-07-11T00:00:02.000Z",
      type: "response_item",
      payload: { type: "function_call", name: "read_file", call_id: "call-1", arguments: "{\"path\":\"README.md\"}" }
    },
    {
      timestamp: "2026-07-11T00:00:03.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "ok" }
    },
    {
      timestamp: "2026-07-11T00:00:04.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }
    },
    {
      timestamp: "2026-07-11T00:00:05.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: "call-2", input: "npm test" }
    },
    {
      timestamp: "2026-07-11T00:00:06.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call-2", output: "passed" }
    },
    {
      timestamp: "2026-07-11T00:00:07.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 } } }
    },
    {
      timestamp: "2026-07-11T00:00:08.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Reviewer follow-up" }
    }
  ];
  const session = extractCodexMeta(records, "fallback");
  const candidateMessages = codexRecordsToMessages(records, session.id);
  const parentMessages = [{ role: "user", content: "Inherited parent prompt" }];
  const resolved = resolveCodexInheritedContext(candidateMessages, parentMessages);
  const views = buildMessageSessionViews({ ...session, messageCount: 2 }, resolved.messages);

  assert.equal(session.id, "codex-child");
  assert.equal(session.parentId, "codex-parent");
  assert.equal(session.metadata.agentPath, "/root/reviewer");
  assert.equal(session.messageCount, 3);
  assert.deepEqual(session.metadata.inheritedContext, {
    parentSessionId: "codex-parent",
    candidateUserRecords: 2
  });
  assert.equal(candidateMessages.find((message) => message.content === "Inherited parent prompt")?.metadata.provenance, "inherited-parent-context-candidate");
  assert.equal(resolved.excludedUserMessages, 1);
  assert.equal(resolved.messages.some((message) => message.content === "Inherited parent prompt"), false);
  assert.equal(resolved.messages.at(-1).content, "Reviewer follow-up");
  assert.equal(resolved.messages.at(-1).metadata.provenance, "session");
  const genuineChildPrompt = resolveCodexInheritedContext(candidateMessages, [{ role: "user", content: "Different parent prompt" }]);
  assert.equal(genuineChildPrompt.excludedUserMessages, 0);
  assert.equal(genuineChildPrompt.messages[0].content, "Inherited parent prompt");
  assert.equal(genuineChildPrompt.messages[0].metadata.provenance, "session");
  assert.equal(views.tree.messages.length, 2);
  assert.deepEqual(views.tree.messages[0].parts.map((part) => part.type), ["reasoning", "tool", "tool"]);
  assert.equal(views.tree.messages[0].parts[1].data.state.output, "ok");
  assert.equal(views.tree.messages[0].parts[2].tool, "exec");
  assert.equal(views.tree.messages[0].parts[2].data.state.output, "passed");
});

test("file session store reuses parsed transcripts, refreshes changed files, and bounds descendants", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "opensession-file-store-"));
  try {
    const write = (id, parentId, content) => writeFileSync(
      path.join(temp, `${id}.json`),
      JSON.stringify({ id, parentId, content })
    );
    write("root-alias", null, "root message");
    write("child", "root-alias", "child message");
    write("unrelated", null, "other message");
    let reads = 0;
    const store = createSessionFileStore({
      refreshIntervalMs: 0,
      discoverFiles: () => readdirSync(temp).map((name) => ({
        sessionId: name.replace(/\.json$/, ""),
        filePath: path.join(temp, name)
      })),
      readEntry: ({ filePath }) => {
        reads++;
        const record = JSON.parse(readFileSync(filePath, "utf8"));
        return {
          session: {
            id: record.id === "root-alias" ? "root-canonical" : record.id,
            parentId: record.parentId
          },
          records: [record],
          messages: [record.content]
        };
      }
    });

    assert.equal(store.list().length, 3);
    assert.equal(reads, 3);
    assert.equal(store.get("root-alias").messages[0], "root message");
    assert.equal(store.get("root-canonical").messages[0], "root message");
    assert.deepEqual(store.getFamily("root-alias").map((entry) => entry.session.id), ["root-canonical", "child"]);
    assert.deepEqual(store.getFamily("root-canonical").map((entry) => entry.session.id), ["root-canonical", "child"]);
    assert.equal(reads, 3);

    write("child", "root-alias", "updated child message with a different size");
    assert.equal(store.get("child").messages[0], "updated child message with a different size");
    assert.equal(reads, 4);
    assert.deepEqual(store.getFamily("unrelated").map((entry) => entry.session.id), ["unrelated"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("OpenCode attaches every supported launcher to its child session and trace", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-subagent-launchers-"));
  const dbPath = path.join(temp, "sessions.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
    `);
    const insertSession = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, NULL)");
    const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)");

    for (const [index, toolName] of ["task", "subtask", "spawn_agent", "delegate_task"].entries()) {
      const rootId = `root-${toolName}`;
      const childId = `ses${index}child`;
      const messageId = `message-${toolName}`;
      insertSession.run(rootId, null, 1000 + index * 100, 1090 + index * 100);
      insertSession.run(childId, rootId, 1020 + index * 100, 1080 + index * 100);
      insertMessage.run(messageId, rootId, JSON.stringify({ role: "assistant", time: { created: 1000 + index * 100 } }));
      insertMessage.run(`child-message-${toolName}`, childId, JSON.stringify({ role: "assistant", time: { created: 1020 + index * 100 } }));
      insertPart.run(`part-${toolName}`, messageId, rootId, JSON.stringify({
        type: "tool",
        tool: toolName,
        state: {
          status: "completed",
          metadata: { sessionId: childId },
          time: { start: 1001 + index * 100, end: 1080 + index * 100 }
        }
      }));
    }
    db.close();

    const adapter = createOpenCodeSqliteAdapter({
      id: "opencode",
      name: "OpenCode launcher fixture",
      defaultDataPath: () => dbPath
    });
    for (const toolName of ["task", "subtask", "spawn_agent", "delegate_task"]) {
      const rootId = `root-${toolName}`;
      const tree = buildOpenCodeSessionTree(rootId, dbPath);
      const trace = adapter.getTrace(rootId);

      assert.equal(tree?.messages[0].parts[0].childSessions[0].session.id, `ses${["task", "subtask", "spawn_agent", "delegate_task"].indexOf(toolName)}child`);
      assert.equal(trace?.steps[0].spans[0].category, "agent", toolName);
    }
  } finally {
    closeDb(dbPath);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Codex keeps source-owned token requests when legacy events lack response items", () => {
  const records = [
    {
      timestamp: "2026-07-20T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "child",
        parent_thread_id: "parent",
        agent_path: "/root/worker"
      }
    },
    {
      timestamp: "2026-07-20T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 90, cached_input_tokens: 70, output_tokens: 10, total_tokens: 100 } }
      }
    },
    {
      timestamp: "2026-07-20T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "agent_message",
        content: [{ type: "output_text", text: "Message Type: NEW_TASK\nTask name: worker\n/root/worker" }]
      }
    },
    {
      timestamp: "2026-07-20T00:00:03.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Child work is running." }
    },
    {
      timestamp: "2026-07-20T00:00:04.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 50 } }
      }
    },
    {
      timestamp: "2026-07-20T00:00:05.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 70 } }
      }
    }
  ];

  assert.deepEqual(
    codexOwnedTokenUsageRecords(records).map((record) => record.payload.info.last_token_usage.total_tokens),
    [50, 70]
  );
  assert.equal(extractCodexMeta(records, "child").tokenCount, 120);

  const messages = codexRecordsToMessages(records, "child");
  const assistant = messages.find((message) => message.content === "Child work is running.");
  assert.deepEqual(assistant.tokens, {
    input: 60,
    output: 23,
    reasoning: 7,
    cache: { read: 30, write: 0 },
    total: 120
  });
  assert.equal(assistant.metadata.tokenRequests.length, 2);

  const views = buildMessageSessionViews(extractCodexMeta(records, "child"), messages);
  assert.equal(views.tree.messages.find((message) => message.data.tokens?.total === 120)?.data.tokenRequestCount, 2);
  assert.equal(views.metrics.totals.totalTokens, 120);
  assert.equal(views.flow.summary.totalTokens, 120);
});

test("Codex recognizes NEW_TASK envelopes stored in payload.message", () => {
  const inherited = {
    timestamp: "2026-07-20T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "Inherited parent prompt" }
  };
  const envelope = {
    timestamp: "2026-07-20T00:00:02.000Z",
    type: "response_item",
    payload: {
      type: "agent_message",
      message: "Message Type: NEW_TASK\nTask name: /root/worker\nPayload:\nwork"
    }
  };
  const childOwned = {
    timestamp: "2026-07-20T00:00:03.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: "Child result" }
  };
  const records = [
    {
      timestamp: "2026-07-20T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "child", parent_thread_id: "parent", agent_path: "/root/worker" }
    },
    inherited,
    envelope,
    childOwned
  ];

  const provenance = classifyCodexRecordProvenance(records);
  assert.equal(provenance.get(inherited), "inherited-parent-context");
  assert.equal(provenance.get(envelope), "session");
  assert.equal(provenance.get(childOwned), "session");
});

test("Codex excludes an exact parent token prefix when an older fork omits NEW_TASK", () => {
  const usage = (total) => ({ input_tokens: total - 10, output_tokens: 10, total_tokens: total });
  const parent = [
    { timestamp: "2026-07-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    { timestamp: "2026-07-20T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(10) } } },
    { timestamp: "2026-07-20T00:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(20) } } },
    { timestamp: "2026-07-20T00:00:03.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(30) } } }
  ];
  const child = [
    { timestamp: "2026-07-20T01:00:00.000Z", type: "session_meta", payload: { id: "child", parent_thread_id: "parent" } },
    // This copied prefix begins later in the parent, so timestamps cannot be
    // used to identify it. The complete request usage snapshots can.
    { timestamp: "2026-07-20T01:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(20) } } },
    { timestamp: "2026-07-20T01:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(30) } } },
    { timestamp: "2026-07-20T01:00:03.000Z", type: "event_msg", payload: { type: "agent_message", message: "Child-owned result" } },
    { timestamp: "2026-07-20T01:00:04.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(40) } } }
  ];

  assert.deepEqual(
    codexOwnedTokenUsageRecords(child, parent).map((record) => record.payload.info.last_token_usage.total_tokens),
    [40]
  );
  assert.equal(extractCodexMeta(child, "child", undefined, parent).tokenCount, 40);
  const childMessages = codexRecordsToMessages(child, "child", parent);
  assert.equal(childMessages.find((message) => message.content === "Child-owned result")?.tokens?.total, 40);

  const singleCoincidence = child.filter((_, index) => index !== 2);
  assert.deepEqual(
    codexOwnedTokenUsageRecords(singleCoincidence, parent).map((record) => record.payload.info.last_token_usage.total_tokens),
    [20, 40]
  );
});

test("Codex ignores a repeated adjacent token snapshot without a cumulative advance", () => {
  const usage = (total) => ({ input_tokens: total - 10, output_tokens: 10, total_tokens: total });
  const records = [
    { timestamp: "2026-07-20T00:00:00.000Z", type: "session_meta", payload: { id: "duplicate-usage" } },
    { timestamp: "2026-07-20T00:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: "Working" } },
    {
      timestamp: "2026-07-20T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { ...usage(40), cache_write_input_tokens: 0 },
          total_token_usage: { ...usage(40), cache_write_input_tokens: 0 }
        }
      }
    },
    {
      timestamp: "2026-07-20T00:00:02.500Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: usage(40), total_token_usage: usage(40) }
      }
    },
    {
      timestamp: "2026-07-20T00:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: usage(50), total_token_usage: usage(90) }
      }
    }
  ];

  assert.deepEqual(
    codexOwnedTokenUsageRecords(records).map((record) => record.payload.info.last_token_usage.total_tokens),
    [40, 50]
  );
  assert.equal(extractCodexMeta(records, "duplicate-usage").tokenCount, 90);
  assert.equal(codexRecordsToMessages(records, "duplicate-usage")[0]?.tokens?.total, 90);
});

test("Codex daily stats make cached input and reasoning mutually exclusive", () => {
  assert.deepEqual(codexDailyTokenComponents({
    input_tokens: 53123,
    cached_input_tokens: 51968,
    output_tokens: 82,
    reasoning_output_tokens: 13,
    total_tokens: 53205,
  }), {
    input: 1155,
    output: 69,
    reasoning: 13,
    cacheRead: 51968,
    cacheWrite: 0,
    total: 53205,
  });
  assert.deepEqual(codexDailyTokenComponents({
    input_tokens: 100,
    cached_input_tokens: 80,
    cache_write_input_tokens: 5,
    output_tokens: 30,
    reasoning_output_tokens: 10,
  }), {
    input: 15,
    output: 20,
    reasoning: 10,
    cacheRead: 80,
    cacheWrite: 5,
    total: 130,
  });
});

test("incremental token stats only re-aggregates transcripts with a new signature", () => {
  const now = Date.now();
  let reads = 0;
  const records = new Map([
    ["first", [{ timestamp: now, tokens: 3 }]],
    ["second", [{ timestamp: now, tokens: 5 }]],
  ]);
  let files = [
    { filePath: "first", signature: "first-v1" },
    { filePath: "second", signature: "second-v1" },
  ];
  const getTokenStats = createIncrementalTokenStats(
    () => files,
    (filePath) => {
      reads++;
      return records.get(filePath);
    },
    {
      filterRecord: () => true,
      getTimestamp: (record) => record.timestamp,
      inputTokens: (record) => record.tokens,
      outputTokens: () => 0,
      totalTokens: (record) => record.tokens,
      reasoningTokens: () => 0,
      cacheReadTokens: () => 0,
      cacheWriteTokens: () => 0,
    }
  );

  assert.equal(getTokenStats(30)[0].totalTokens, 8);
  assert.equal(reads, 2);
  assert.equal(getTokenStats(90)[0].totalTokens, 8);
  assert.equal(reads, 2, "range changes reuse per-file daily aggregates");

  records.set("second", [{ timestamp: now, tokens: 11 }]);
  files = [
    { filePath: "first", signature: "first-v1" },
    { filePath: "second", signature: "second-v2" },
  ];
  assert.equal(getTokenStats(30)[0].totalTokens, 14);
  assert.equal(reads, 3, "only the changed transcript is re-aggregated");
});

test("stats cache reuses a matching source fingerprint and invalidates changed data", () => {
  const cache = createStatsCache(2, 60_000);
  let builds = 0;
  const build = () => ({ build: ++builds });

  assert.deepEqual(cache.getOrBuild("opencode:30", "db-v1", build), { build: 1 });
  assert.deepEqual(cache.getOrBuild("opencode:30", "db-v1", build), { build: 1 });
  assert.equal(builds, 1);
  assert.deepEqual(cache.getOrBuild("opencode:30", "db-v2", build), { build: 2 });
  assert.equal(builds, 2);
});

test("SQLite token stats index persists buckets and refreshes only changed sessions", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-stats-index-"));
  const sourcePath = path.join(temp, "source.db");
  const source = new DatabaseSync(sourcePath);
  const cache = new DatabaseSync(":memory:");
  try {
    source.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, time_updated INTEGER, time_archived INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    `);
    source.prepare("INSERT INTO session VALUES (?, ?, ?, ?, NULL)").run("s1", "project-a", null, 100);
    source.prepare("INSERT INTO message VALUES (?, ?, ?)").run("m1", "s1", JSON.stringify({
      role: "assistant", time: { created: Date.now() }, modelID: "model-a", providerID: "provider-a",
      tokens: { input: 10, output: 4, cache: { read: 6 }, total: 20 }
    }));
    source.prepare("INSERT INTO message VALUES (?, ?, ?)").run("m0", "s1", JSON.stringify({
      role: "assistant", time: { created: Date.now() }, modelID: "model-a", providerID: "provider-a",
      tokens: { input: 0, output: 0, total: 0 }
    }));
    source.close();

    assert.deepEqual(refreshSqliteTokenStatsIndex("opencode", sourcePath, cache), { changed: 1, removed: 0, total: 1 });
    assert.deepEqual(refreshSqliteTokenStatsIndex("opencode", sourcePath, cache), { changed: 0, removed: 0, total: 1 });
    const rows = getIndexedTokenStats("opencode", { days: 30, scope: "all" }, cache);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_tokens, 20);
    assert.equal(rows[0].message_count, 1);
    assert.equal(rows[0].cache_read_tokens, 6);
    assert.equal(getIndexedTokenSessionCount("opencode", { days: 30, scope: "all" }, cache), 1);
    assert.equal(getIndexedModelDistribution("opencode", { days: 30, scope: "all" }, cache)[0].model, "model-a");

    const update = new DatabaseSync(sourcePath);
    update.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(200, "s1");
    update.prepare("INSERT INTO message VALUES (?, ?, ?)").run("m2", "s1", JSON.stringify({
      role: "assistant", time: { created: Date.now() }, modelID: "model-a", providerID: "provider-a",
      tokens: { input: 5, output: 2, total: 7 }
    }));
    update.close();
    assert.deepEqual(refreshSqliteTokenStatsIndex("opencode", sourcePath, cache), { changed: 1, removed: 0, total: 1 });
    assert.equal(getIndexedTokenStats("opencode", { days: 30, scope: "all" }, cache)[0].total_tokens, 27);

    const replace = new DatabaseSync(sourcePath);
    replace.prepare("UPDATE session SET time_archived = ? WHERE id = ?").run(300, "s1");
    replace.prepare("INSERT INTO session VALUES (?, ?, ?, ?, NULL)").run("s2", "project-a", null, 300);
    replace.prepare("INSERT INTO message VALUES (?, ?, ?)").run("m3", "s2", JSON.stringify({
      role: "assistant", time: { created: Date.now() }, modelID: "model-b", providerID: "provider-b",
      tokens: { input: 3, output: 2, total: 5 }
    }));
    replace.close();
    assert.deepEqual(refreshSqliteTokenStatsIndex("opencode", sourcePath, cache), { changed: 1, removed: 1, total: 1 });
    assert.equal(getIndexedTokenStats("opencode", { days: 30, scope: "all" }, cache)[0].total_tokens, 5);

    const remove = new DatabaseSync(sourcePath);
    remove.prepare("DELETE FROM message WHERE session_id = ?").run("s2");
    remove.prepare("DELETE FROM session WHERE id = ?").run("s2");
    remove.close();
    assert.deepEqual(refreshSqliteTokenStatsIndex("opencode", sourcePath, cache), { changed: 0, removed: 1, total: 0 });
    assert.equal(getIndexedTokenStats("opencode", { days: 30, scope: "all" }, cache).length, 0);
  } finally {
    closeDb(sourcePath);
    cache.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("SQLite token stats index rebuilds when a provider data path changes", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-stats-source-"));
  const firstPath = path.join(temp, "first.db");
  const secondPath = path.join(temp, "second.db");
  const cache = new DatabaseSync(":memory:");
  const createSource = (dbPath, total) => {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, time_updated INTEGER, time_archived INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    `);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, NULL)").run("same-id", "project-a", null, 100);
    db.prepare("INSERT INTO message VALUES (?, ?, ?)").run("same-message", "same-id", JSON.stringify({
      role: "assistant", time: { created: Date.now() }, modelID: "model-a", providerID: "provider-a",
      tokens: { input: total, output: 0, total }
    }));
    db.close();
  };
  try {
    createSource(firstPath, 10);
    createSource(secondPath, 99);
    refreshSqliteTokenStatsIndex("opencode", firstPath, cache);
    assert.equal(getIndexedTokenStats("opencode", { days: 30, scope: "all" }, cache)[0].total_tokens, 10);
    refreshSqliteTokenStatsIndex("opencode", secondPath, cache);
    assert.equal(getIndexedTokenStats("opencode", { days: 30, scope: "all" }, cache)[0].total_tokens, 99);
  } finally {
    closeDb(firstPath);
    closeDb(secondPath);
    cache.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("linked message sessions attach Codex-style spawn tools to child conversations", () => {
  const session = (id, parentId, title, timeCreated, metadata = null) => ({
    id,
    provider: "codex",
    parentId,
    title,
    directory: "D:\\WorkSpace",
    timeCreated,
    timeUpdated: timeCreated + 100,
    messageCount: 1,
    tokenCount: null,
    metadata
  });
  const message = (id, sessionId, role, content, toolName = null, toolInput = null, toolOutput = null) => ({
    id,
    sessionId,
    role,
    content,
    thinking: null,
    toolName,
    toolInput,
    toolOutput,
    timestamp: id === "spawn" ? 2000 : 3000,
    tokens: null,
    metadata: toolName ? { turnId: `${sessionId}:turn` } : null
  });
  const views = buildLinkedMessageSessionViews("parent", [
    {
      session: session("parent", null, "Parent", 1000),
      messages: [message("spawn", "parent", "tool", "", "spawn_agent", { task_name: "reviewer" }, '{"task_name":"/root/reviewer"}')]
    },
    {
      session: session("child", "parent", "Reviewer", 2100, { agentPath: "/root/reviewer" }),
      messages: [
        message("child-answer", "child", "assistant", "Review complete"),
        message("child-spawn", "child", "tool", "", "spawn_agent", { task_name: "nested" }, '{"task_name":"/root/nested"}')
      ]
    },
    {
      session: session("grandchild", "child", "Nested reviewer", 3100, { agentPath: "/root/nested" }),
      messages: [message("nested-answer", "grandchild", "assistant", "Nested review complete")]
    }
  ]);

  const taskPart = views.tree.messages[0].parts[0];
  assert.equal(taskPart.childSessions[0].session.id, "child");
  assert.equal(taskPart.childSessions[0].messages[0].parts[0].data.text, "Review complete");
  const nestedTask = taskPart.childSessions[0].messages[0].parts[1];
  assert.equal(nestedTask.childSessions[0].session.id, "grandchild");
  assert.equal(views.metrics.totals.branches, 2);
  assert.equal(views.metrics.totals.messages, 3);
});

test("linked message sessions attach every shared subagent launcher", () => {
  const session = (id, parentId, timeCreated) => ({
    id,
    provider: "fixture",
    parentId,
    title: id,
    directory: "D:\\WorkSpace",
    timeCreated,
    timeUpdated: timeCreated + 10,
    messageCount: 1,
    tokenCount: null
  });
  const message = (id, sessionId, role, toolName = null, toolOutput = null) => ({
    id,
    sessionId,
    role,
    content: role === "assistant" ? "Child result" : "",
    thinking: null,
    toolName,
    toolInput: toolName ? { description: "Run child" } : null,
    toolOutput,
    timestamp: role === "tool" ? 2000 : 2100,
    tokens: null,
    metadata: toolName ? { turnId: `${sessionId}:turn` } : null
  });

  for (const toolName of ["agent", "task", "subtask", "spawn_agent", "delegate_task"]) {
    const views = buildLinkedMessageSessionViews("parent-session", [
      {
        session: session("parent-session", null, 1000),
        messages: [message(
          `${toolName}-call`,
          "parent-session",
          "tool",
          toolName,
          '{"session_id":"child-session"}'
        )]
      },
      {
        session: session("child-session", "parent-session", 2050),
        messages: [message(`${toolName}-answer`, "child-session", "assistant")]
      }
    ]);
    const part = views?.tree.messages[0].parts[0];

    assert.equal(part?.childSessions[0].session.id, "child-session", toolName);
    assert.equal(views?.tree.detachedChildren.length, 0, toolName);
  }
});

test("shared views preserve provider-marked custom subagent tools across Tree, Flow, Trace, and rendering", () => {
  const session = (id, parentId, title, timeCreated) => ({
    id,
    provider: "fixture",
    parentId,
    title,
    directory: "D:\\WorkSpace",
    timeCreated,
    timeUpdated: timeCreated + 100,
    messageCount: 1,
    tokenCount: null
  });
  const message = ({ id, sessionId, role, content = "", toolName = null, toolInput = null, toolOutput = null, timestamp, metadata = null }) => ({
    id,
    sessionId,
    role,
    content,
    thinking: null,
    toolName,
    toolInput,
    toolOutput,
    timestamp,
    tokens: null,
    metadata
  });
  const views = buildLinkedMessageSessionViews("root-custom", [
    {
      session: session("root-custom", null, "Root", 1000),
      messages: [
        message({
          id: "root-assistant", sessionId: "root-custom", role: "assistant", content: "I will delegate both reviews.", timestamp: 1100,
          metadata: { turnId: "root-turn" }
        }),
        message({
          id: "security-call", sessionId: "root-custom", role: "tool", toolName: "security-auditor",
          toolInput: { description: "Security review" }, toolOutput: "complete", timestamp: 1200,
          metadata: { turnId: "root-turn", callId: "security-call", agentId: "child-security", subagent: true }
        }),
        message({
          id: "performance-call", sessionId: "root-custom", role: "tool", toolName: "performance-auditor",
          toolInput: { description: "Performance review" }, toolOutput: "complete", timestamp: 1300,
          metadata: { turnId: "root-turn", callId: "performance-call", agentId: "child-performance", subagent: true }
        })
      ]
    },
    // Deliberately reverse bundle and creation order: explicit agentId links
    // must win over chronological fallback attachment.
    {
      session: session("child-performance", "root-custom", "Performance", 1150),
      messages: [message({ id: "performance-result", sessionId: "child-performance", role: "assistant", content: "Performance audit complete.", timestamp: 1400 })]
    },
    {
      session: session("child-security", "root-custom", "Security", 1350),
      messages: [message({ id: "security-result", sessionId: "child-security", role: "assistant", content: "Security audit complete.", timestamp: 1500 })]
    }
  ]);

  assert.equal(isSubagentTool("security-auditor"), false, "names alone stay provider-owned");
  assert.equal(isSubagentTool("security-auditor", { subagent: true }), true);
  const taskParts = views.tree.messages[0].parts.filter((part) => part.type === "tool");
  assert.deepEqual(taskParts.map((part) => [part.tool, part.childSessions.map((child) => child.session.id)]), [
    ["security-auditor", ["child-security"]],
    ["performance-auditor", ["child-performance"]]
  ]);
  assert.equal(views.tree.detachedChildren.length, 0);
  assert.equal(views.metrics.totals.branches, 2);
  assert.deepEqual(
    views.trace.steps[0].spans.filter((span) => span.category === "agent").map((span) => span.name),
    ["security-auditor", "performance-auditor"]
  );
  const invocations = views.flow.root.line.filter((node) => node.kind === "invocation");
  const returns = views.flow.root.line.filter((node) => node.kind === "return");
  assert.deepEqual(invocations.map((node) => node.branches[0].id), ["session:child-security", "session:child-performance"]);
  assert.deepEqual(invocations.map((node) => node.returnId), returns.map((node) => node.id));
  const html = renderSessionPage({ session: views.tree.session, sessionTree: views.tree, provider: "fixture" });
  assert.match(html, /subagent-branch/);
  assert.match(html, /Security audit complete\./);
  assert.match(html, /Performance audit complete\./);
});

test("chronological child fallback remains visibly inferred across detail and Flow", () => {
  const session = (id, parentId, timeCreated) => ({
    id,
    provider: "fixture",
    parentId,
    title: id,
    directory: "D:\\WorkSpace",
    timeCreated,
    timeUpdated: timeCreated + 100,
    messageCount: 1,
    tokenCount: null
  });
  const rootTool = {
    id: "root-custom-launch", sessionId: "root-fallback", role: "tool", content: "", thinking: null,
    toolName: "custom-reviewer", toolInput: { description: "Review the changes" }, toolOutput: "completed", timestamp: 1100,
    tokens: null, metadata: { subagent: true }
  };
  const childAnswer = {
    id: "fallback-answer", sessionId: "child-fallback", role: "assistant", content: "Review complete.", thinking: null,
    toolName: null, toolInput: null, toolOutput: null, timestamp: 1200, tokens: null, metadata: null
  };
  const views = buildLinkedMessageSessionViews("root-fallback", [
    { session: session("root-fallback", null, 1000), messages: [rootTool] },
    { session: session("child-fallback", "root-fallback", 1150), messages: [childAnswer] }
  ]);
  const part = views.tree.messages[0].parts[0];
  const invocation = views.flow.root.line.find((node) => node.kind === "invocation");
  const html = renderSessionPage({ session: views.tree.session, sessionTree: views.tree, provider: "fixture" });

  assert.equal(part.inferredChildSessionIds?.has("child-fallback"), true);
  assert.equal(invocation?.inferred, true);
  assert.match(invocation?.meta || "", /1 inferred link/);
  assert.match(html, /data-subagent-relationship="inferred"/);
  assert.match(html, /Linked session/);
  assert.match(html, /Inferred relationship/);
});

test("linked message sessions break cyclic parent metadata without duplicating descendants", () => {
  const session = (id, parentId) => ({
    id,
    provider: "fixture",
    parentId,
    title: id,
    directory: "D:\\WorkSpace",
    timeCreated: 1000,
    timeUpdated: 2000,
    messageCount: 1,
    tokenCount: null
  });
  const tool = {
    id: "root-agent-call", sessionId: "root-cycle", role: "tool", content: "", thinking: null,
    toolName: "agent", toolInput: { description: "Child" }, toolOutput: "done", timestamp: 1100, tokens: null,
    metadata: { agentId: "child-cycle", subagent: true }
  };
  const answer = (id, sessionId) => ({
    id, sessionId, role: "assistant", content: "done", thinking: null,
    toolName: null, toolInput: null, toolOutput: null, timestamp: 1200, tokens: null, metadata: null
  });
  const views = buildLinkedMessageSessionViews("root-cycle", [
    { session: session("root-cycle", "child-cycle"), messages: [tool] },
    { session: session("child-cycle", "root-cycle"), messages: [answer("child-answer", "child-cycle")] }
  ]);

  assert.equal(views.tree.metrics.descendantCount, 1);
  assert.deepEqual(views.tree.messages[0].parts[0].childSessions.map((child) => child.session.id), ["child-cycle"]);
  assert.equal(views.tree.messages[0].parts[0].childSessions[0].metrics.descendantCount, 0);
});

test("Codex subagent transcripts exclude copied parent context and expose encrypted task envelopes", () => {
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-07-12T00:00:00.000Z",
      payload: {
        id: "child",
        parent_thread_id: "parent",
        agent_path: "/root/reviewer",
        thread_source: "subagent"
      }
    },
    {
      type: "event_msg",
      timestamp: "2026-07-12T00:00:01.000Z",
      payload: { type: "user_message", message: "Parent prompt" }
    },
    {
      type: "session_meta",
      timestamp: "2026-07-12T00:00:01.001Z",
      payload: { id: "parent", thread_source: "user" }
    },
    {
      type: "response_item",
      timestamp: "2026-07-12T00:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Parent answer" }]
      }
    },
    {
      type: "response_item",
      timestamp: "2026-07-12T00:00:03.000Z",
      payload: {
        type: "agent_message",
        content: [
          {
            type: "input_text",
            text: "Message Type: NEW_TASK\nTask name: /root/reviewer\nSender: /root\nPayload:"
          },
          { type: "encrypted_content", encrypted_content: "opaque" }
        ]
      }
    },
    {
      type: "response_item",
      timestamp: "2026-07-12T00:00:04.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Child review complete" }]
      }
    }
  ];

  const messages = codexRecordsToMessages(records, "child");
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.match(messages[0].content, /Subagent task: \/root\/reviewer/);
  assert.match(messages[0].content, /encrypted in the Codex transcript/);
  assert.equal(messages[0].toolName, null);
  assert.equal(messages[0].metadata?.source, "subagent_task");
  assert.equal(messages[0].metadata?.promptAvailable, false);
  assert.equal(messages[1].content, "Child review complete");
  assert.doesNotMatch(JSON.stringify(messages), /Parent prompt|Parent answer/);

  const resolved = resolveCodexInheritedContext([
    {
      id: "copied-after-output",
      sessionId: "child",
      role: "user",
      content: "Parent prompt",
      thinking: null,
      toolName: null,
      toolInput: null,
      toolOutput: null,
      timestamp: 0,
      tokens: null,
      metadata: { provenance: "session" }
    },
    {
      id: "actual-child-message",
      sessionId: "child",
      role: "user",
      content: "Child-specific follow-up",
      thinking: null,
      toolName: null,
      toolInput: null,
      toolOutput: null,
      timestamp: 0,
      tokens: null,
      metadata: { provenance: "session" }
    }
  ], [{
    id: "parent-message",
    sessionId: "parent",
    role: "user",
    content: "Parent prompt",
    thinking: null,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    timestamp: 0,
    tokens: null,
    metadata: null
  }]);
  assert.equal(resolved.excludedUserMessages, 1);
  assert.deepEqual(resolved.messages.map((message) => message.content), ["Child-specific follow-up"]);
});

test("file-backed providers preserve ReACT response boundaries and fold tool-only continuations", () => {
  const claudeRecords = [
    {
      type: "assistant",
      uuid: "thinking-record",
      timestamp: "2026-07-11T00:00:00.000Z",
      message: { id: "claude-response", model: "claude", content: [{ type: "thinking", thinking: "Inspect" }] }
    },
    {
      type: "assistant",
      uuid: "tool-record",
      timestamp: "2026-07-11T00:00:01.000Z",
      message: { id: "claude-response", model: "claude", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] }
    }
  ];
  const claudeSession = extractSessionMeta(claudeRecords, "claude-session");
  const claudeViews = buildMessageSessionViews(claudeSession, recordsToMessages(claudeRecords, claudeSession.id));
  assert.equal(claudeViews.tree.messages.length, 1);
  assert.deepEqual(claudeViews.tree.messages[0].parts.map((part) => part.type), ["reasoning", "tool"]);

  const geminiMessages = geminiDataToMessages({
    messages: [{
      id: "gemini-response",
      type: "gemini",
      text: "I checked it.",
      timestamp: "2026-07-11T00:00:00.000Z",
      toolCalls: [{ id: "tool-2", name: "read_file", args: { path: "README.md" }, result: "failed", status: "error" }]
    }]
  }, "gemini-session");
  const geminiViews = buildMessageSessionViews({
    id: "gemini-session",
    provider: "gemini",
    parentId: null,
    title: "Gemini",
    directory: null,
    timeCreated: 0,
    timeUpdated: 0,
    messageCount: 1,
    tokenCount: null
  }, geminiMessages);
  assert.equal(geminiViews.tree.messages.length, 1);
  assert.deepEqual(geminiViews.tree.messages[0].parts.map((part) => part.type), ["text", "tool"]);
  assert.equal(geminiViews.tree.messages[0].parts[1].data.state.status, "error");

  const piRecords = [
    {
      type: "message",
      id: "pi-user",
      timestamp: "2026-07-11T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Inspect the repository." }] }
    },
    {
      type: "message",
      id: "pi-assistant",
      timestamp: "2026-07-11T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the status." },
          { type: "toolCall", id: "pi-read", name: "read", arguments: { path: "package.json" } }
        ]
      }
    },
    {
      type: "message",
      id: "pi-read-result",
      timestamp: "2026-07-11T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "pi-read",
        content: [{ type: "text", text: "{\"name\":\"agentsession\"}" }]
      }
    },
    {
      type: "message",
      id: "pi-bash",
      timestamp: "2026-07-11T00:00:03.000Z",
      message: { role: "bashExecution", command: "git status --short", output: "", exitCode: 0 }
    },
    {
      type: "message",
      id: "pi-next",
      timestamp: "2026-07-11T00:00:04.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "The repository is clean." }] }
    }
  ];
  const piViews = buildMessageSessionViews({
    id: "pi-session",
    provider: "pi",
    parentId: null,
    title: "Pi",
    directory: null,
    timeCreated: 0,
    timeUpdated: 0,
    messageCount: 3,
    tokenCount: null
  }, piRecordsToMessages(piRecords, "pi-session"));
  assert.equal(piViews.tree.messages.length, 3);
  assert.deepEqual(piViews.tree.messages[1].parts.map((part) => part.type), ["text", "tool", "tool"]);
  assert.equal(piViews.tree.messages[1].parts[1].data.state.output, "{\"name\":\"agentsession\"}");
  assert.equal(piViews.tree.messages[1].parts[2].tool, "bash");

  const codexRecords = [
    {
      timestamp: "2026-07-11T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking the repository." }] }
    },
    {
      timestamp: "2026-07-11T00:00:01.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: { command: "git status" } }
    },
    {
      timestamp: "2026-07-11T00:00:02.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 110, cached_input_tokens: 90, output_tokens: 20, total_tokens: 130 } } }
    },
    {
      timestamp: "2026-07-11T00:00:03.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call", call_id: "call-continuation", name: "exec", input: { command: "git diff --stat" } }
    },
    {
      timestamp: "2026-07-11T00:00:04.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 210, cached_input_tokens: 190, output_tokens: 30, total_tokens: 240 } } }
    },
    {
      timestamp: "2026-07-11T00:00:05.000Z",
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Inspect" }] }
    },
    {
      timestamp: "2026-07-11T00:00:05.500Z",
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Inspect the changed files." }] }
    },
    {
      timestamp: "2026-07-11T00:00:06.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call", call_id: "call-2", name: "exec", input: { command: "git diff" } }
    },
    {
      timestamp: "2026-07-11T00:00:07.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The changes are ready." }] }
    },
    {
      timestamp: "2026-07-11T00:00:08.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call", call_id: "call-3", name: "exec", input: { command: "npm test" } }
    }
  ];
  const codexViews = buildMessageSessionViews({
    id: "codex-session",
    provider: "codex",
    parentId: null,
    title: "Codex",
    directory: null,
    timeCreated: 0,
    timeUpdated: 0,
    messageCount: 2,
    tokenCount: null
  }, codexRecordsToMessages(codexRecords, "codex-session"));
  assert.equal(codexViews.tree.messages.length, 2);
  assert.deepEqual(codexViews.tree.messages[0].parts.map((part) => part.type), ["text", "tool", "tool"]);
  assert.deepEqual(codexViews.tree.messages[1].parts.map((part) => part.type), ["reasoning", "tool", "text", "tool"]);
  assert.equal(codexViews.tree.messages[1].parts[0].data.text, "Inspect the changed files.");
  assert.deepEqual(codexViews.tree.messages[0].data.tokens, {
    input: 40,
    output: 50,
    reasoning: 0,
    total: 370,
    cache: { read: 280, write: 0 }
  });
  assert.equal(codexViews.tree.messages[0].data.tokenRequestCount, 2);
  assert.equal(codexViews.tree.messages[0].data.tokenRequests.length, 2);
  assert.equal(codexViews.metrics.totals.totalTokens, 370);
  const codexHtml = renderSessionPage({
    session: codexViews.tree.session,
    sessionTree: codexViews.tree,
    provider: "codex"
  });
  assert.match(codexHtml, /message-token-requests" title="Aggregated across 2 model requests">2 requests/);
  assert.match(codexHtml, /Uncached prompt input uploaded across 2 model requests: 40/);
  assert.match(codexHtml, /Total tokens across 2 model requests: 370/);
  assert.equal(extractCodexMeta(codexRecords, "codex-session").messageCount, 2);
});

test("Claude sidechain transcripts preserve canonical agent and parent session IDs", () => {
  const session = extractSessionMeta([{
    type: "assistant",
    isSidechain: true,
    agentId: "claude-agent-1",
    sessionId: "claude-parent",
    timestamp: "2026-07-11T00:00:00.000Z",
    message: { id: "response", content: [{ type: "text", text: "Child result" }] }
  }], "agent-claude-agent-1");

  assert.equal(session.id, "claude-agent-1");
  assert.equal(session.parentId, "claude-parent");
  assert.deepEqual(session.metadata.aliases, ["claude-agent-1", "agent-claude-agent-1"]);
});

test("OpenCode model distribution groups by JSON model and provider values", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-model-distribution-"));
  const dbPath = path.join(temp, "sessions.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        model TEXT,
        time_archived INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        data TEXT
      );
    `);
    const insertSession = db.prepare("INSERT INTO session (id, model, time_archived) VALUES (?, ?, ?)");
    insertSession.run("active-a", "legacy-model-a", null);
    insertSession.run("active-b", "legacy-model-b", null);
    insertSession.run("active-c", "legacy-model-c", null);
    insertSession.run("archived", "legacy-model-d", 1);
    const insertMessage = db.prepare(`
      INSERT INTO message (id, session_id, data)
      VALUES (?, ?, ?)
    `);
    const assistantData = (providerID, total) => JSON.stringify({
      role: "assistant",
      modelID: "shared-model",
      providerID,
      tokens: { total }
    });
    insertMessage.run("m1", "active-a", assistantData("provider-a", 10));
    insertMessage.run("m2", "active-b", assistantData("provider-a", 20));
    insertMessage.run("m3", "active-c", assistantData("provider-b", 5));
    insertMessage.run("m4", "archived", assistantData("provider-a", 100));

    const legacyRows = db.prepare(`
      SELECT json_extract(message.data, '$.modelID') as model,
             json_extract(message.data, '$.providerID') as provider,
             COUNT(*) as count,
             SUM(json_extract(message.data, '$.tokens.total')) as total_tokens
      FROM message
      JOIN session ON session.id = message.session_id
      WHERE json_extract(message.data, '$.role') = 'assistant'
        AND json_extract(message.data, '$.modelID') IS NOT NULL
        AND session.time_archived IS NULL
      GROUP BY model, provider
      ORDER BY count DESC
    `).all();
    const legacyProviderARows = legacyRows.filter((row) => row.provider === "provider-a");
    assert.equal(legacyRows.length, 3);
    assert.equal(legacyProviderARows.length, 2);
    assert.ok(legacyProviderARows.every((row) => row.model === "shared-model" && row.count === 1));
    assert.deepEqual(legacyProviderARows.map((row) => row.total_tokens).sort((a, b) => a - b), [10, 20]);
    db.close();

    assert.deepEqual(getModelDistribution(dbPath).map((row) => ({ ...row })), [
      { model: "shared-model", provider: "provider-a", count: 2, total_tokens: 30 },
      { model: "shared-model", provider: "provider-b", count: 1, total_tokens: 5 }
    ]);
  } finally {
    closeDb(dbPath);
    rmSync(temp, { recursive: true, force: true });
  }
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

test("active providers declare a configurable resume command while legacy providers stay read-only", () => {
  const providers = getAllProviders();
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["opencode", "claude-code", "codex", "openclaw", "hermes", "copilot", "gemini", "pi"]
  );
  for (const provider of providers.filter((provider) => provider.lifecycle !== "legacy")) {
    assert.equal(typeof provider.resumeCommand?.executable, "string", provider.id);
    assert.ok(provider.resumeCommand.executable, provider.id);
    assert.ok(Array.isArray(provider.resumeCommand.args), provider.id);
    assert.ok(provider.resumeCommand.args.includes("{sessionId}"), provider.id);
  }
  assert.equal(providers.find((provider) => provider.id === "gemini")?.resumeCommand, undefined);
  assert.equal(providers.find((provider) => provider.id === "gemini")?.lifecycle, "legacy");
  assert.equal(providers.find((provider) => provider.id === "copilot")?.resumeCommand, undefined);
  assert.equal(providers.find((provider) => provider.id === "copilot")?.lifecycle, "legacy");
  assert.equal(parseArgs(["--pi-dir", "D:\\fixtures\\pi-agent"]).piDir, "D:\\fixtures\\pi-agent");
  assert.equal(parseArgs(["--copilot-dir", "D:\\fixtures\\copilot"]).copilotDir, "D:\\fixtures\\copilot");
  assert.equal(parseArgs(["--openclaw-dir", "D:\\fixtures\\openclaw"]).openclawDir, "D:\\fixtures\\openclaw");
  assert.equal(parseArgs(["--hermes-dir", "D:\\fixtures\\hermes"]).hermesDir, "D:\\fixtures\\hermes");
});

test("every provider exposes the complete shared Agent Loop capability surface", () => {
  for (const provider of getAllProviders()) {
    const features = providerFeatureMatrix(provider);
    assert.equal(features.localManagement, true, provider.id);
    assert.equal(features.sessionAnalysis, provider.lifecycle !== "legacy", provider.id);
    assert.equal(features.agentLoopViews, true, provider.id);
    assert.equal(features.sessionTrace, true, provider.id);
    assert.equal(features.systemPromptEvidence, true, provider.id);
    assert.equal(features.runtimeEnvironment, true, provider.id);
    assert.equal(features.resume, provider.lifecycle !== "legacy", provider.id);
    assert.equal(features.openCodeStatsStore, provider.id === "opencode", provider.id);
  }
});

test("terminal launch is enabled by default and supports an explicit startup opt-out", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-config-"));
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
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-runtime-log-"));
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
  assert.deepEqual(
    getRuntimeRouteContext("GET", "/api/opencode/session/ses_123/analyses/run_456/diagnostics/stderr"),
    {
      method: "GET",
      route: "/api/:provider/session/:sessionId/analyses/:runId/diagnostics/:diagnostic",
      provider: "opencode",
      sessionId: "ses_123",
      runId: "run_456",
      action: "stderr"
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

test("cross-provider project paths normalize Windows and WSL aliases", () => {
  assert.equal(normalizeCrossProviderProjectPath("D:\\WorkSpace\\OpenSession\\"), "d:/workspace/opensession");
  assert.equal(normalizeCrossProviderProjectPath("D:/WorkSpace/OpenSession"), "d:/workspace/opensession");
  assert.equal(normalizeCrossProviderProjectPath("/mnt/d/WorkSpace/OpenSession/"), "d:/workspace/opensession");
  assert.equal(normalizeCrossProviderProjectPath("D:\\"), "d:/");
  assert.equal(normalizeCrossProviderProjectPath("/mnt/d/"), "d:/");
  assert.equal(normalizeCrossProviderProjectPath("/srv/Project/"), "/srv/Project");
});

test("Pi sessions preserve the active branch, tools, reasoning, usage, names, and parent identity", () => {
  const records = parsePiSession(path.join(process.cwd(), "test", "fixtures", "pi-current.jsonl"));
  const active = activePiEntries(records);
  assert.equal(active.some((entry) => entry.id === "olduser1" || entry.id === "oldasst1"), false);
  assert.equal(active.at(-1).id, "asst0003");

  const meta = extractPiMeta(records, "fallback");
  assert.equal(meta.id, "019f7b00-0000-7000-8000-000000000001");
  assert.equal(meta.provider, "pi");
  assert.equal(meta.parentId, "019f7a00-0000-7000-8000-000000000000");
  assert.equal(meta.title, "Pi provider fixture");
  assert.equal(meta.directory, "D:\\WorkSpace\\pi-fixture");
  assert.equal(meta.tokenCount, 30);

  const messages = piRecordsToMessages(records, meta.id);
  assert.equal(messages.some((message) => message.content.includes("abandoned")), false);
  assert.equal(messages.some((message) => message.content.includes("hidden extension")), false);
  const assistant = messages.find((message) => message.id === "asst0001");
  assert.equal(assistant.thinking, "Need to read the source");
  assert.deepEqual(assistant.tokens, {
    input: 6,
    output: 4,
    reasoning: 0,
    total: 15,
    cache: { read: 3, write: 2 }
  });
  const tool = messages.find((message) => message.id === "call_read_1");
  assert.equal(tool.toolName, "read");
  assert.deepEqual(tool.toolInput, { path: "src/provider.ts" });
  assert.equal(tool.toolOutput, "export const provider = 'pi';");
  assert.equal(tool.metadata.status, "completed");
  assert.equal(messages.some((message) => message.metadata?.type === "compaction"), true);
  assert.equal(piAssistantUsageRecords(records).length, 3);

  const views = buildMessageSessionViews(meta, messages);
  assert.equal(views.tree.session.id, meta.id);
  assert.equal(views.tree.metrics.toolCallCount, 1);
  assert.equal(views.tree.metrics.inputTokens, 13);
  assert.equal(views.flow.summary.toolCalls, 1);
});

test("Pi keeps reported reasoning exclusive from output", () => {
  assert.deepEqual(piUsageToTokens({
    input: 100,
    output: 30,
    reasoning: 12,
    cacheRead: 5,
    cacheWrite: 7,
    totalTokens: 142
  }), {
    input: 100,
    output: 18,
    reasoning: 12,
    cache: { read: 5, write: 7 },
    total: 142
  });
});

test("Pi runtime environment discovers user and project-owned configuration", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-pi-runtime-"));
  try {
    const project = path.join(temp, "project");
    const piDir = path.join(temp, "pi-agent");
    mkdirSync(path.join(project, ".git"), { recursive: true });
    mkdirSync(path.join(project, ".pi", "extensions"), { recursive: true });
    mkdirSync(path.join(piDir, "skills", "reviewer"), { recursive: true });
    writeFileSync(path.join(project, "AGENTS.md"), "# Project instructions\n");
    writeFileSync(path.join(project, ".pi", "extensions", "guard.ts"), "export default {};\n");
    writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({
      packages: [{ source: "example-package", prompts: ["review.md"] }]
    }));
    writeFileSync(path.join(piDir, "AGENTS.md"), "# User instructions\n");
    writeFileSync(path.join(piDir, "skills", "reviewer", "SKILL.md"), "# Reviewer\n");

    const runtime = buildPiRuntimeEnvironment("pi-session", project, piDir);
    assert.ok(runtime.extensions.some((entry) => entry.scope === "user" && entry.kind === "skill" && entry.name === "reviewer"));
    assert.ok(runtime.extensions.some((entry) => entry.scope === "project" && entry.kind === "extension" && entry.name === "guard"));
    assert.ok(runtime.extensions.some((entry) => entry.scope === "project" && entry.kind === "plugin" && entry.name === "example-package"));
    assert.equal(runtime.extensions.filter((entry) => entry.kind === "instruction").length, 2);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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

  assert.match(html, /<input type="search" name="q" value="analysis"/);
  assert.match(html, /id="scroll-sentinel"/);
  assert.match(html, /data-offset="30"/);
  assert.match(html, /data-total="40"/);
  assert.match(html, /data-query="analysis"/);
  assert.match(html, /data-mode="content"/);
  assert.match(html, /from=%2Fopencode%2Fsearch%3Fq%3Danalysis/);
  assert.match(html, />Load more sessions<\/button>/);
});

test("session batch actions are disabled until a session is selected", () => {
  const html = renderSessionsPage({
    sessions: [{
      id: "ses_batch",
      title: "Batch session",
      directory: "D:\\WorkSpace\\OpenSession",
      time_updated: 1_700_000_000_000,
      summary_files: 0,
      summary_additions: 0,
      summary_deletions: 0
    }],
    total: 1,
    limit: 30,
    offset: 0,
    provider: "opencode",
    providerAvailable: true,
    manageable: true,
    providers: []
  });

  assert.match(html, /<button class="btn batch-action" data-action="star" disabled>/);
  assert.match(html, /<button class="btn batch-action" data-action="unstar" disabled>/);
  assert.match(html, /<button class="btn batch-action btn-danger" data-action="delete" disabled>/);
});

test("session list exposes sort, title type, and starred filters through pagination", () => {
  const html = renderSessionsPage({
    sessions: Array.from({ length: 30 }, (_, index) => ({
      id: `ses_filter_${index}`,
      title: `Session ${index}`,
      directory: "D:\\WorkSpace\\OpenSession",
      time_updated: 1_700_000_000_000 + index,
      summary_files: 0,
      summary_additions: 0,
      summary_deletions: 0,
      starred: index === 0
    })),
    total: 40,
    limit: 30,
    offset: 0,
    sort: "title-asc",
    starredOnly: true,
    sessionKind: "analysis",
    projectOptions: [{ id: "global", label: "/", worktree: "/", count: 4 }],
    provider: "opencode",
    providerAvailable: true,
    manageable: true,
    providers: []
  });

  assert.match(html, /<select name="sort" data-session-filter-auto>/);
  assert.match(html, /<option value="title-asc" selected>Title A-Z<\/option>/);
  assert.match(html, /<select name="kind" data-session-filter-auto>/);
  assert.match(html, /<option value="analysis" selected>Analysis titles<\/option>/);
  assert.match(html, /<input type="checkbox" name="starred" value="1" data-session-filter-auto checked>/);
  assert.match(html, /<option value="global"\s+title="\/">Global sessions \(4\)<\/option>/);
  assert.match(html, /data-sort="title-asc"/);
  assert.match(html, /data-kind="analysis"/);
  assert.match(html, /data-starred="1"/);
  assert.match(html, /href="\/opencode">Clear<\/a>/);
  const filterMarkup = html.slice(html.indexOf('<form class="session-filter"'));
  assert.ok(filterMarkup.indexOf('<select name="kind"') < filterMarkup.indexOf('<input type="search" name="q"'));
  assert.ok(filterMarkup.indexOf('<input type="search" name="q"') < filterMarkup.indexOf('>Apply</button>'));

  const style = readFileSync(path.join(process.cwd(), "dist", "src", "static", "style.css"), "utf8");
  assert.match(
    style,
    /\.session-filter \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1\.15fr\) minmax\(0, 0\.75fr\) minmax\(0, 0\.95fr\) minmax\(0, 0\.85fr\) minmax\(220px, 1\.5fr\) max-content;/
  );
  assert.match(style, /\.filter-actions \{\s*grid-column: 5 \/ -1;/);
});

test("global search uses the centralized sessions entry while list filters stay scoped", () => {
  const html = renderSessionsPage({
    sessions: [],
    total: 0,
    provider: "opencode",
    providerAvailable: true,
    manageable: true,
    providers: []
  });

  assert.match(html, /action="\/sessions" method="GET" role="search" aria-label="Search session titles and projects"/);
  assert.match(html, /placeholder="Search titles and projects\.\.\. \( \/ \)"/);
  assert.match(html, /<span>Filter current list<\/span>/);
  assert.match(html, /placeholder="Title, slug, or directory"/);
});

test("empty session result pages hide batch management controls", () => {
  const html = renderSessionsPage({
    sessions: [],
    total: 0,
    limit: 30,
    offset: 0,
    query: "missing",
    provider: "opencode",
    providerAvailable: true,
    manageable: true,
    providers: []
  });

  assert.match(html, /No sessions found for keyword: <strong>missing<\/strong>/);
  assert.doesNotMatch(html, /id="toggle-batch"/);
  assert.doesNotMatch(html, /id="batch-bar"/);
});

test("session API search mode accepts explicit and compatible parameter names", () => {
  assert.equal(resolveSessionSearchMode(new URLSearchParams()), "list");
  assert.equal(resolveSessionSearchMode(new URLSearchParams("mode=content")), "content");
  assert.equal(resolveSessionSearchMode(new URLSearchParams("searchMode=content")), "content");
  assert.equal(resolveSessionSearchMode(new URLSearchParams("searchMode=list")), "list");
  assert.equal(resolveSessionSearchMode(new URLSearchParams("mode=list&searchMode=content")), "list");
  assert.equal(resolveSessionSearchMode(new URLSearchParams("mode=unexpected")), "list");
});

test("session list query options accept known sort and starred values only", () => {
  assert.equal(resolveSessionSort(new URLSearchParams()), "updated-desc");
  assert.equal(resolveSessionSort(new URLSearchParams("sort=updated-asc")), "updated-asc");
  assert.equal(resolveSessionSort(new URLSearchParams("sort=title-asc")), "title-asc");
  assert.equal(resolveSessionSort(new URLSearchParams("sort=title-desc")), "title-desc");
  assert.equal(resolveSessionSort(new URLSearchParams("sort=random")), "updated-desc");
  assert.equal(resolveStarredFilter(new URLSearchParams()), false);
  assert.equal(resolveStarredFilter(new URLSearchParams("starred=1")), true);
  assert.equal(resolveStarredFilter(new URLSearchParams("starred=true")), true);
  assert.equal(resolveStarredFilter(new URLSearchParams("starred=false")), false);
  assert.equal(resolveSessionKindFilter(new URLSearchParams()), "all");
  assert.equal(resolveSessionKindFilter(new URLSearchParams("kind=analysis")), "analysis");
  assert.equal(resolveSessionKindFilter(new URLSearchParams("sessionKind=work")), "work");
  assert.equal(resolveSessionKindFilter(new URLSearchParams("kind=unknown")), "all");
});

test("analysis title classification remains an explicit title heuristic", () => {
  assert.equal(isAnalysisTitledSession({ title: "OpenCode session analysis proposals" }), true);
  assert.equal(isAnalysisTitledSession({ title: "Analyze current session" }), true);
  assert.equal(isAnalysisTitledSession({ title: "Implement authentication" }), false);
  assert.equal(matchesSessionKind({ title: "Analyze current session" }, "analysis"), true);
  assert.equal(matchesSessionKind({ title: "Analyze current session" }, "work"), false);
  assert.equal(matchesSessionKind({ title: "Implement authentication" }, "work"), true);
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

  assert.match(html, /href="\/stats" class="nav-link nav-link-stats /);
  assert.match(html, /href="\/opencode\/trash" class="nav-link nav-link-trash /);
  assert.match(html, /href="\/opencode\/settings" class="nav-link nav-link-settings [^"]*" title="Settings" aria-label="Settings"/);
  const mobileTopbarStart = style.indexOf("@media (max-width: 480px)");
  const nextResponsiveBlock = style.indexOf("@media (max-width: 1180px)", mobileTopbarStart);
  assert.notEqual(mobileTopbarStart, -1);
  assert.notEqual(nextResponsiveBlock, -1);
  const mobileTopbarCss = style.slice(mobileTopbarStart, nextResponsiveBlock);

  assert.match(mobileTopbarCss, /\.topbar-actions \.nav-link \{\s*display: none;[\s\S]*\.topbar-actions \.nav-link-settings \{\s*display: inline-flex;/);
  assert.match(mobileTopbarCss, /--topbar-height: 104px;/);
  assert.match(mobileTopbarCss, /--session-anchor-offset: 136px;/);
  assert.match(mobileTopbarCss, /--settings-anchor-offset: 164px;/);
  assert.match(mobileTopbarCss, /\.topbar-actions \{\s*grid-column: 1 \/ -1;[\s\S]*grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(mobileTopbarCss, /\.search-input \{\s*width: 100%;\s*min-width: 0;/);
});

test("flow inspector shrinks to content, is node-positioned, and stays inside the flow panel", () => {
  const style = readFileSync(path.join(process.cwd(), "dist", "src", "static", "style.css"), "utf8");
  const workbench = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf8");

  // Desktop rule: height must follow content instead of being pinned to the
  // panel bottom, and long content must be capped so the body scrolls.
  const desktopInspector = style.match(/\.flow-inspector \{[^}]*\}/)?.[0] ?? "";
  assert.match(desktopInspector, /bottom: auto/);
  assert.doesNotMatch(desktopInspector, /bottom: 16px/);
  assert.match(desktopInspector, /max-height: calc\(100% - 32px\)/);

  // Mobile keeps the full-width inset layout with the desktop cap lifted.
  const mobileBlockStart = style.indexOf("@media (max-width: 820px)");
  const nextResponsiveBlock = style.indexOf("@media (max-width: 768px)", mobileBlockStart);
  assert.notEqual(mobileBlockStart, -1);
  assert.notEqual(nextResponsiveBlock, -1);
  const mobileBlock = style.slice(mobileBlockStart, nextResponsiveBlock);
  assert.match(mobileBlock, /\.flow-inspector \{[\s\S]*?max-height: none;/);

  // The workbench positions the inspector relative to the clicked node,
  // caps it to the flow viewport, and clears inline offsets on mobile.
  assert.match(workbench, /const positionFlowInspector = /);
  assert.match(workbench, /window\.innerWidth <= 820/);
  assert.match(workbench, /document\.querySelector\("\.topbar"\).*getBoundingClientRect\(\)\.bottom/);
  assert.match(workbench, /window\.innerHeight - panelRect\.top - gap/);
  assert.match(workbench, /const visibleHeight = Math\.max\(120, visibleBottom - visibleTop\)/);
  assert.match(workbench, /flowInspector\.style\.removeProperty\("top"\)/);
  assert.match(workbench, /flowInspector\.style\.removeProperty\("max-height"\)/);
  assert.match(workbench, /layoutFlowRows\(\);\s*\n\s*if \(flowInspector\.classList\.contains\("hidden"\)\) return;\s*\n\s*positionFlowInspector\(flowInspector\);/);
  // Closes and resizes must reset or recompute the inline placement.
  assert.match(workbench, /closeFlowInspector[\s\S]{0,600}removeProperty\("top"\)/);
  assert.match(workbench, /resize[\s\S]{0,400}positionFlowInspector\(flowInspector\)/);
});

test("sqlite session queries exclude viewer-deleted sessions from paging, projects, and search", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-visible-sessions-"));
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
    insertSession.run("a", "p1", "a", "needle analysis", "/p1", 100, 300);
    insertSession.run("b", "p1", "b", "deleted content", "/p1", 100, 200);
    insertSession.run("c", "p2", "c", "active content", "/p2", 100, 100);

    const insertMessage = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)");
    insertMessage.run("m-a-user", "a", JSON.stringify({ role: "user", time: { created: 90 } }));
    insertMessage.run("m-a", "a", JSON.stringify({
      role: "assistant",
      time: { created: 100 },
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 3, write: 2 } }
    }));
    for (const id of ["b", "c"]) {
      insertMessage.run(`m-${id}`, id, JSON.stringify({ role: "assistant", time: { created: 100 } }));
      insertPart.run(`p-${id}`, `m-${id}`, id, JSON.stringify({ type: "text", text: "needle in content" }));
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
    assert.equal(firstPage.sessions[0].message_count, 2);
    assert.equal(firstPage.sessions[0].token_count, 40);
    const sessionA = getSession("a", dbPath);
    assert.equal(sessionA.message_count, 2);
    assert.equal(sessionA.token_count, 40);
    assert.deepEqual(secondPage.sessions.map((session) => session.id), ["c"]);
    assert.deepEqual(
      listSessions(10, 0, "", "", dbPath, "", excluded, "updated-asc").sessions.map((session) => session.id),
      ["c", "a"]
    );
    assert.deepEqual(
      listSessions(10, 0, "", "", dbPath, "", excluded, "title-asc").sessions.map((session) => session.id),
      ["c", "a"]
    );
    const starredOnly = listSessions(10, 0, "", "", dbPath, "", excluded, "updated-desc", ["c"]);
    assert.equal(starredOnly.total, 1);
    assert.deepEqual(starredOnly.sessions.map((session) => session.id), ["c"]);
    assert.deepEqual(
      listSessions(10, 0, "", "", dbPath, "", excluded, "updated-desc", undefined, "analysis").sessions.map((session) => session.id),
      ["a"]
    );
    assert.deepEqual(
      listSessions(10, 0, "", "", dbPath, "", excluded, "updated-desc", undefined, "work").sessions.map((session) => session.id),
      ["c"]
    );
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
      listSessionProjects("", "", dbPath, excluded, ["c"]).map((project) => ({
        id: project.id,
        label: project.label,
        count: project.count
      })),
      [
        { id: "p2", label: "Project Two", count: 1 }
      ]
    );
    assert.deepEqual(
      listSessionProjects("", "", dbPath, excluded, undefined, "analysis").map((project) => project.id),
      ["p1"]
    );
    assert.deepEqual(
      searchMessages("needle", 1, dbPath, excluded).map((match) => match.sessionId),
      ["c"]
    );

    const search = getSearchResults("needle", 10, 0, dbPath, excluded);
    assert.equal(search.total, 2);
    assert.deepEqual(search.sessions.map((session) => session.id), ["a", "c"]);
    assert.deepEqual(
      getSearchResults("needle", 10, 0, dbPath, excluded, "analysis").sessions.map((session) => session.id),
      ["a"]
    );
    assert.deepEqual(
      getSearchResults("needle", 10, 0, dbPath, excluded, "work").sessions.map((session) => session.id),
      ["c"]
    );
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
  assert.match(html, /data-action="copy-session-id" data-id="ses_accessible"/);
  assert.match(html, /aria-label="Copy session ID"/);
  assert.match(html, /href="\/api\/opencode\/session\/ses_accessible\/export\?format=md"/);
  assert.match(html, /href="\/api\/opencode\/session\/ses_accessible\/export\?format=json"/);
  assert.match(html, /download="session-ses_acce\.md"/);
  assert.match(html, /download="session-ses_acce\.json"/);
  assert.doesNotMatch(html, /data-action="export-md"/);
  assert.doesNotMatch(html, /data-action="export-json"/);
});

test("session cards omit zero-value change metrics", () => {
  const emptyStats = sessionCard({
    id: "ses_empty_stats",
    title: "No file changes",
    time_updated: 1_700_000_000_000,
    summary_files: 0,
    summary_additions: 0,
    summary_deletions: 0
  });
  assert.doesNotMatch(emptyStats, /session-card-stats/);
  assert.doesNotMatch(emptyStats, /\+0|\-0|0 files/);

  const changed = sessionCard({
    id: "ses_changed",
    title: "Changed files",
    time_updated: 1_700_000_000_000,
    summary_files: 2,
    summary_additions: 3,
    summary_deletions: 0
  });
  assert.match(changed, /session-card-stats/);
  assert.match(changed, /2 files/);
  assert.match(changed, /\+3/);
  assert.doesNotMatch(changed, /\-0/);
});

test("session management uses in-page dialogs", () => {
  const appJs = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf-8");

  assert.doesNotMatch(appJs, /\b(prompt|confirm|alert)\s*\(/);
  assert.match(appJs, /openRenameDialog/);
  assert.match(appJs, /openConfirmDialog/);
  assert.match(appJs, /rename-dialog/);
  assert.match(appJs, /confirm-dialog/);
  assert.match(appJs, /aria-describedby/);
  assert.match(appJs, /selectAllCheckbox\.indeterminate = checked > 0 && checked < checkboxes\.length/);
  assert.match(appJs, /btn\.disabled = checked === 0/);
  assert.match(appJs, /function isEditableShortcutTarget/);
  assert.match(appJs, /tagName === "TEXTAREA"/);
  assert.match(appJs, /!isEditableShortcutTarget\(e\.target\)/);
  assert.match(appJs, /document\.getElementById\("search-input"\)\?\.focus\(\)/);
  assert.match(appJs, /analysis_launch_confirm_title/);
  assert.match(appJs, /const confirmed = await openConfirmDialog\(formatText\(ft\("analysis_launch_confirm"\)/);
  assert.ok(
    appJs.indexOf('openConfirmDialog(formatText(ft("analysis_launch_confirm")')
      < appJs.indexOf('fetch(`/api/${PROVIDER}/session/${encodeURIComponent(id)}/analyze`')
  );
  const style = readFileSync(path.join(process.cwd(), "dist", "src", "static", "style.css"), "utf-8");
  assert.match(style, /\.btn:disabled \{/);
  assert.match(style, /cursor: not-allowed;/);
  assert.match(style, /grid-template-columns: auto minmax\(0, 1fr\) minmax\(0, auto\)/);
  assert.match(style, /@media \(max-width: 1300px\)[\s\S]*?\.logo-text \{\s*display: none;/);
});

test("analysis launch accessible name follows selected target labels and runtime count", () => {
  const bundle = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf-8");
  const appSource = readFileSync(path.join(process.cwd(), "src", "static", "app.js"), "utf-8");
  assert.match(bundle, /function analysisLaunchAccessibleLabel/);
  const helperSource = appSource
    .match(/function analysisLaunchAccessibleLabel\([\s\S]*?\r?\n\}\r?\n\r?\nfunction updateAnalysisLaunchControl/)?.[0]
    ?.replace(/\r?\n\r?\nfunction updateAnalysisLaunchControl$/, "");
  assert.ok(helperSource);
  const analysisLaunchAccessibleLabel = runInNewContext(
    `${helperSource}\nanalysisLaunchAccessibleLabel;`,
    {
      ft: (key) => ({
        analysis_launch_action: "Launch analysis for {targets}; runtime extensions: {runtime}",
        analysis_launch_running_title: "Running analyses: {targets}.",
        analysis_launch_select_target: "Select a target"
      })[key],
      formatText: (template, values) => Object.entries(values).reduce(
        (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
        template
      )
    }
  );

  assert.equal(
    analysisLaunchAccessibleLabel([{ label: "Skills" }], 2, [], "Targets 1 · Runtime 2"),
    "Launch analysis for Skills; runtime extensions: 2"
  );
  assert.equal(
    analysisLaunchAccessibleLabel([{ label: "Skills" }, { label: "Tests" }], 0, [], "Targets 2 · Runtime 0"),
    "Launch analysis for Skills, Tests; runtime extensions: 0"
  );
});

test("model distribution legend distinguishes equal model names by provider", () => {
  const html = renderStatsPage({
    tokenStats: [],
    modelRanking: [
      { modelId: "shared-model", providerId: "provider-a", key: "provider-a/shared-model", totalTokens: 20, sessionCount: 2, messageCount: 2 },
      { modelId: "shared-model", providerId: "provider-b", key: "provider-b/shared-model", totalTokens: 10, sessionCount: 1, messageCount: 1 }
    ],
    topSessions: [],
    coverage: { messagesWithTokens: 0, totalAssistantMessages: 0, availableDimensions: [], missingDimensions: [] },
    overview: { totalSessions: 0, totalMessages: 0, totalTokens: 30, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    provider: "opencode",
    providers: []
  });

  assert.match(html, /shared-model · provider-a/);
  assert.match(html, /shared-model · provider-b/);
  assert.match(html, /Model Ranking/);
});

// ── Token Explorer tests ───────────────────────────────────────────────

test("Token Explorer renders filter bar with preset ranges and scope toggles", () => {
  const html = renderStatsPage({
    tokenStats: [],
    modelRanking: [],
    topSessions: [],
    coverage: { messagesWithTokens: 0, totalAssistantMessages: 0, availableDimensions: [], missingDimensions: [] },
    overview: { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    provider: "opencode",
    providers: [{ id: "opencode", name: "OpenCode", icon: "OC", available: true }]
  });

  // Filter bar present
  assert.match(html, /stats-filter-bar/);
  // Preset ranges
  assert.match(html, /value="7"/);
  assert.match(html, /value="30"/);
  assert.match(html, /value="90"/);
  assert.match(html, /value="custom"/);
  // Scope toggles
  assert.match(html, /value="all"/);
  assert.match(html, /value="root"/);
  // Apply and Clear
  assert.match(html, /stats-filter-apply/);
  assert.match(html, /stats-filter-clear/);
});

test("Token Explorer KPI cards show token breakdown", () => {
  const html = renderStatsPage({
    tokenStats: [
      { day: "2026-07-10", input_tokens: 500, output_tokens: 300, reasoning_tokens: 100, cache_read_tokens: 50, cache_write_tokens: 25, total_tokens: 975, message_count: 5 },
      { day: "2026-07-11", input_tokens: 600, output_tokens: 400, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 1000, message_count: 3 },
    ],
    modelRanking: [],
    topSessions: [],
    coverage: { messagesWithTokens: 2, totalAssistantMessages: 2, availableDimensions: ["reasoning", "cache"], missingDimensions: [] },
    overview: { totalSessions: 10, totalMessages: 8, totalTokens: 1975, inputTokens: 1100, outputTokens: 700, reasoningTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 25, peakDay: "2026-07-11", peakDayTokens: 1000, avgTokensPerSession: 198 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    provider: "opencode",
    providers: []
  });

  assert.match(html, /2\.0K/); // total tokens
  assert.match(html, /10/); // sessions
  assert.match(html, /8/); // messages
  assert.match(html, /2026-07-11/); // peak day
});

test("Token Explorer trend chart includes multi-series SVG bands", () => {
  const html = renderStatsPage({
    tokenStats: [
      { day: "2026-07-10", input_tokens: 500, output_tokens: 300, reasoning_tokens: 100, cache_read_tokens: 50, cache_write_tokens: 25, total_tokens: 975, message_count: 5 },
    ],
    modelRanking: [],
    topSessions: [],
    coverage: { messagesWithTokens: 1, totalAssistantMessages: 1, availableDimensions: ["reasoning", "cache"], missingDimensions: [] },
    overview: { totalSessions: 1, totalMessages: 1, totalTokens: 975, inputTokens: 500, outputTokens: 300, reasoningTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 25, peakDay: "2026-07-10", peakDayTokens: 975, avgTokensPerSession: 975 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    provider: "opencode",
    providers: []
  });

  // Trend bands for each series
  assert.match(html, /trend-band-output/);
  assert.match(html, /trend-band-input/);
  assert.match(html, /trend-band-reasoning/);
  assert.match(html, /trend-band-cacheRead/);
  assert.match(html, /trend-band-cacheWrite/);
  // Legend toggles
  assert.match(html, /trend-legend-toggle/);
  assert.match(html, /data-series="output"/);
  assert.match(html, /data-series="input"/);
});

test("Token Explorer shows missing dimensions with unavailable markers", () => {
  const html = renderStatsPage({
    tokenStats: [
      { day: "2026-07-10", input_tokens: 500, output_tokens: 300, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 800, message_count: 3 },
    ],
    modelRanking: [],
    topSessions: [],
    coverage: { messagesWithTokens: 1, totalAssistantMessages: 1, availableDimensions: [], missingDimensions: ["reasoning", "cache"] },
    overview: { totalSessions: 1, totalMessages: 1, totalTokens: 800, inputTokens: 500, outputTokens: 300, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "2026-07-10", peakDayTokens: 800, avgTokensPerSession: 800 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    provider: "opencode",
    providers: []
  });

  // Missing dimensions shown in legend
  assert.match(html, /unavailable/);
  // Coverage section
  assert.match(html, /Data Coverage/);
});

test("Token Explorer model ranking renders horizontal bars with filter links", () => {
  const html = renderStatsPage({
    tokenStats: [],
    modelRanking: [
      { modelId: "claude-4", providerId: "anthropic", key: "anthropic/claude-4", totalTokens: 50000, sessionCount: 10, messageCount: 100 },
      { modelId: "gpt-5", providerId: "openai", key: "openai/gpt-5", totalTokens: 30000, sessionCount: 5, messageCount: 50 },
    ],
    topSessions: [],
    coverage: { messagesWithTokens: 0, totalAssistantMessages: 0, availableDimensions: [], missingDimensions: [] },
    overview: { totalSessions: 15, totalMessages: 150, totalTokens: 80000, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 5333 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    provider: "opencode",
    providers: []
  });

  assert.match(html, /claude-4 · anthropic/);
  assert.match(html, /gpt-5 · openai/);
  assert.match(html, /tokens/); // metric label
  assert.match(html, /model-rank-row/);
});

test("Token Explorer top sessions table links to canonical session URLs", () => {
  const html = renderStatsPage({
    tokenStats: [],
    modelRanking: [],
    topSessions: [
      { sessionId: "ses_abc123", title: "Fix auth bug", directory: "/home/user/projects/app", providerModel: "anthropic/claude-4", totalTokens: 15000, messageCount: 45, timeUpdated: 1750000000000 },
    ],
    coverage: { messagesWithTokens: 1, totalAssistantMessages: 1, availableDimensions: [], missingDimensions: [] },
    overview: { totalSessions: 1, totalMessages: 45, totalTokens: 15000, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 15000 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    provider: "opencode",
    providers: []
  });

  assert.match(html, /href="\/opencode\/session\/ses_abc123\?from=/);
  assert.match(html, /Fix auth bug/);
  assert.match(html, /anthropic\/claude-4/);
  assert.match(html, /15\.0K/);
});

test("Token Explorer coverage bar shows percentage when data is partial", () => {
  const html = renderStatsPage({
    tokenStats: [],
    modelRanking: [],
    topSessions: [],
    coverage: { messagesWithTokens: 75, totalAssistantMessages: 100, availableDimensions: ["reasoning"], missingDimensions: ["cache"] },
    overview: { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    provider: "opencode",
    providers: []
  });

  assert.match(html, /Data Coverage/);
  assert.match(html, /75%/);
  assert.match(html, /75 \/ 100/);
  assert.match(html, /reasoning/);
  assert.match(html, /cache/);
});

test("Token Explorer day drill-down shows filtered info", () => {
  const html = renderStatsPage({
    tokenStats: [{ day: "2026-07-11", input_tokens: 100, output_tokens: 20, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 120, message_count: 1 }],
    modelRanking: [],
    topSessions: [],
    coverage: { messagesWithTokens: 0, totalAssistantMessages: 0, availableDimensions: [], missingDimensions: [] },
    overview: { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    dayDrill: "2026-07-11",
    provider: "opencode",
    providers: []
  });

  assert.match(html, /Filtered to 2026-07-11/);
  assert.match(html, /Show all days/);
  assert.match(html, /trend-day-hit is-selected/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /#stats-session-results/);
  assert.match(html, /id="stats-session-results"/);
});

test("session navigation context accepts viewer-owned sources and rejects unsafe targets", () => {
  assert.deepEqual(parseSessionNavigationContext("/opencode/stats?days=30&day=2026-07-11#stats-session-results"), {
    href: "/opencode/stats?days=30&day=2026-07-11#stats-session-results",
    section: "stats",
    day: "2026-07-11",
  });
  assert.equal(parseSessionNavigationContext("//example.com/steal"), null);
  assert.equal(parseSessionNavigationContext("/api/opencode/session/x"), null);
  assert.equal(parseSessionNavigationContext("javascript:alert(1)"), null);
});

test("session detail shows a safe source breadcrumb and activates Usage for a stats drill", () => {
  const html = renderSessionPage({
    session: { id: "ses_1", title: "Drilled session", directory: "D:\\work", time_created: 1 },
    provider: "opencode",
    providers: [{ id: "opencode", name: "OpenCode", icon: "", available: true }],
    navigationContext: parseSessionNavigationContext("/opencode/stats?day=2026-07-11#stats-session-results"),
  });
  assert.match(html, /class="session-breadcrumb"/);
  assert.match(html, /Back to Usage/);
  assert.match(html, /2026-07-11/);
  assert.match(html, /nav-link nav-link-stats active/);
});

test("session raw data exposes an opaque project key and configured directory provenance", () => {
  const html = renderSessionPage({
    session: {
      id: "gemini-project-key",
      title: "Mapped Gemini session",
      directory: "D:\\WorkSpace\\project",
      time_created: 1,
      metadata: {
        projectKey: "opaque-project-key",
        projectDirectorySource: "configured"
      }
    },
    provider: "gemini"
  });

  assert.match(html, /Project key/);
  assert.match(html, /opaque-project-key/);
  assert.match(html, /Directory supplied by an AgentSession mapping/);
});

test("Token Explorer renders with no data without crashing", () => {
  const html = renderStatsPage({
    tokenStats: [],
    modelRanking: [],
    topSessions: [],
    coverage: { messagesWithTokens: 0, totalAssistantMessages: 0, availableDimensions: [], missingDimensions: [] },
    overview: { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    provider: "opencode",
    providers: []
  });

  assert.match(html, /Token Explorer/);
  assert.match(html, /No data/);
});

test("Token Explorer defers non-primary sections while retaining server-rendered fragments", () => {
  const base = {
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all", compareA: null, compareB: null, rangePreset: "30", requestedFrom: "", requestedTo: "", validationError: null },
    tokenStats: [], modelRanking: [], overview: { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    topSessions: [], coverage: null, comparison: null, insights: [], costEstimate: null, compareA: null, compareB: null,
    provider: "opencode", providers: [], manageable: false,
    capabilities: { customRange: true, project: true, model: true, scope: true, dayDrill: true, composition: true, modelRanking: true, sessionBreakdown: true, coverage: true },
  };
  const initial = renderStatsPage({ ...base, deferredUrl: "/api/opencode/stats/deferred?days=30" });
  assert.match(initial, /data-stats-deferred-section="secondary"/);
  assert.match(initial, /data-stats-deferred-section="advanced"/);
  assert.doesNotMatch(initial, /top-sessions-table/);

  const fragment = renderStatsDeferredSection({ ...base, dayDrill: null }, "secondary");
  assert.match(fragment, /Top Token Sessions/);
  assert.match(fragment, /Data Coverage/);
});

test("Token Explorer JS interactivity hooks are present", () => {
  const appJs = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf8");

  assert.match(appJs, /initTokenExplorer/);
  assert.match(appJs, /trend-legend-toggle/);
  assert.match(appJs, /trend-hit/);
  assert.match(appJs, /trend-tooltip/);
  assert.match(appJs, /chartBody\.scrollLeft \+ chartBody\.clientWidth - tooltip\.offsetWidth/);
  assert.match(appJs, /stats-preset-radio/);
  assert.match(appJs, /stats-filter-custom-dates/);
});

test("stats filters parse days presets and custom ranges from URL params", async () => {
  const { padTokenStats, parseStatsDay, parseStatsFilters } = await import("../dist/src/stats-data.js");

  const f1 = parseStatsFilters(new URLSearchParams(""));
  assert.equal(f1.days, 30);
  assert.equal(f1.scope, "all");

  const f2 = parseStatsFilters(new URLSearchParams("days=7"));
  assert.equal(f2.days, 7);

  const f3 = parseStatsFilters(new URLSearchParams("days=90&scope=root"));
  assert.equal(f3.days, 90);
  assert.equal(f3.scope, "root");

  const f4 = parseStatsFilters(new URLSearchParams("days=custom&from=2026-01-01&to=2026-01-15"));
  assert.equal(f4.from, "2026-01-01");
  assert.equal(f4.to, "2026-01-15");
  assert.equal(f4.days, 15);

  const f5 = parseStatsFilters(new URLSearchParams("days=custom&from=invalid&to=2026-01-15"));
  assert.equal(f5.days, 30);
  assert.equal(f5.rangePreset, "custom");
  assert.equal(f5.requestedFrom, "invalid");
  assert.equal(f5.validationError, "invalid_custom_range");

  assert.equal(parseStatsDay("2026-02-30"), null);
  assert.equal(parseStatsDay("2026-02-28"), "2026-02-28");
  const tooLong = parseStatsFilters(new URLSearchParams("days=custom&from=2024-01-01&to=2026-01-01"));
  assert.equal(tooLong.days, 30);
  assert.equal(tooLong.validationError, "custom_range_too_long");

  const historical = padTokenStats([], 3, new Date("2030-01-01T00:00:00Z"), "2020-01-01", "2020-01-03");
  assert.deepEqual(historical.map((row) => row.day), ["2020-01-01", "2020-01-02", "2020-01-03"]);
});

test("Token Explorer day drill clear link preserves a custom range", () => {
  const html = renderStatsPage({
    tokenStats: [], modelRanking: [], topSessions: [],
    coverage: { messagesWithTokens: 0, totalAssistantMessages: 0, availableDimensions: [], missingDimensions: [] },
    overview: { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    filters: { days: 15, from: "2026-06-01", to: "2026-06-15", project: "", modelPair: null, scope: "all" },
    dayDrill: "2026-06-05", provider: "opencode", providers: []
  });

  assert.match(html, /href="\/opencode\/stats\?days=custom&amp;from=2026-06-01&amp;to=2026-06-15"/);
});

test("file-backed Token Explorer keeps the shared composition chart while limiting database-only features", () => {
  const html = renderStatsPage({
    tokenStats: [{ day: "2026-07-10", input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 2, message_count: 1 }],
    modelRanking: [], topSessions: [], coverage: null,
    overview: { totalSessions: 1, totalMessages: 1, totalTokens: 2, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "2026-07-10", peakDayTokens: 2, avgTokensPerSession: 2 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    capabilities: { customRange: false, project: false, model: false, scope: false, dayDrill: false, composition: true, modelRanking: false, sessionBreakdown: false, coverage: false },
    projects: null, provider: "codex", providers: []
  });

  assert.match(html, /aggregate token data only/);
  assert.doesNotMatch(html, /name="model"/);
  assert.doesNotMatch(html, /Model Ranking/);
  assert.doesNotMatch(html, /Top Token Sessions/);
  assert.doesNotMatch(html, /Data Coverage/);
  assert.match(html, /trend-band-input/);
  assert.match(html, /trend-band-output/);
  assert.match(html, /data-day-index="0" data-series="output" data-value="1"/);
  assert.match(html, /class="trend-y-label" data-grid-index="0"/);
  assert.match(html, /data-plot-top="22" data-plot-height="238"/);
  assert.doesNotMatch(html, /data-series="total"/);
  assert.doesNotMatch(html, /day=2026-07-10/);
});

test("Token Explorer keeps global-project filtering distinct from all projects", () => {
  const html = renderStatsPage({
    tokenStats: [], modelRanking: [], topSessions: [], coverage: null,
    overview: { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    filters: { days: 30, from: null, to: null, project: EMPTY_PROJECT_FILTER, modelPair: null, scope: "all", rangePreset: "30", requestedFrom: "", requestedTo: "", validationError: null },
    capabilities: { customRange: true, project: true, model: true, scope: true, dayDrill: true, composition: true, modelRanking: true, sessionBreakdown: true, coverage: true },
    projects: [{ projectId: "", label: "/", count: 2 }], provider: "opencode", providers: []
  });

  assert.match(html, new RegExp(`<option value="${EMPTY_PROJECT_FILTER}" selected>Global sessions \\(2\\)</option>`));
  assert.match(html, /<option value="">All projects<\/option>/);
});

test("Token Explorer shows invalid custom ranges instead of silently presenting 30 days", async () => {
  const { parseStatsFilters } = await import("../dist/src/stats-data.js");
  const filters = parseStatsFilters(new URLSearchParams("days=custom&from=2026-02-30&to=2026-03-01"));
  const html = renderStatsPage({
    tokenStats: [], modelRanking: [], topSessions: [], coverage: null,
    overview: { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    filters, provider: "opencode", providers: []
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Enter a valid UTC start and end date/);
  assert.match(html, /value="custom" checked/);
  assert.doesNotMatch(html, /value="30" checked/);
});

test("stats filters to params round-trips basic values", async () => {
  const { parseStatsFilters, statsFiltersToParams } = await import("../dist/src/stats-data.js");

  const filters = parseStatsFilters(new URLSearchParams("days=7&project=myproj&model=openai/gpt-5&scope=root"));
  const p = statsFiltersToParams(filters);
  assert.equal(p.get("days"), "7");
  assert.equal(p.get("project"), "myproj");
  assert.equal(p.get("model"), "openai/gpt-5");
  assert.equal(p.get("scope"), "root");
});

test("padTokenStats fills missing days with zero rows", async () => {
  const { padTokenStats } = await import("../dist/src/stats-data.js");

  const rows = [{ day: "2026-07-10", input_tokens: 10, output_tokens: 5, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 15, message_count: 1 }];
  const padded = padTokenStats(rows, 3, new Date("2026-07-12T00:00:00Z"));
  assert.equal(padded.length, 3);
  assert.equal(padded[0].day, "2026-07-10");
  assert.equal(padded[0].total_tokens, 15);
  assert.equal(padded[1].day, "2026-07-11");
  assert.equal(padded[1].total_tokens, 0);
  assert.equal(padded[2].day, "2026-07-12");
  assert.equal(padded[2].total_tokens, 0);
});

test("detectAvailableDimensions reports each token component independently", async () => {
  const { detectAvailableDimensions } = await import("../dist/src/stats-data.js");

  const rows = [
    { day: "2026-07-10", input_tokens: 10, output_tokens: 5, reasoning_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 18, message_count: 1 },
  ];
  const result = detectAvailableDimensions(rows);
  assert.deepEqual(result.available, ["input", "output", "reasoning"]);
  assert.ok(result.missing.includes("cache-read"));
  assert.ok(result.missing.includes("cache-write"));
});

// ── Stats insights unit tests ──────────────────────────────────────────

test("detectDailySpike returns empty for insufficient data", async () => {
  const { detectDailySpike } = await import("../dist/src/stats-insights.js");
  const result = detectDailySpike({ dailyTotals: [100, 200], topSessions: [], totalTokens: 300, messagesWithTokens: null, totalAssistantMessages: null });
  assert.strictEqual(result.length, 0);
});

test("detectDailySpike returns empty for flat data", async () => {
  const { detectDailySpike } = await import("../dist/src/stats-insights.js");
  const result = detectDailySpike({ dailyTotals: [1000, 1100, 1050, 1020], topSessions: [], totalTokens: 4170, messagesWithTokens: null, totalAssistantMessages: null });
  assert.strictEqual(result.length, 0);
});

test("detectDailySpike detects a significant spike", async () => {
  const { detectDailySpike } = await import("../dist/src/stats-insights.js");
  const result = detectDailySpike({ dailyTotals: [1000, 1100, 1050, 10000], topSessions: [], totalTokens: 13150, messagesWithTokens: null, totalAssistantMessages: null });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].key, "daily_spike");
  assert.strictEqual(result[0].severity, "medium");
});

test("detectDominantSession returns empty for balanced sessions", async () => {
  const { detectDominantSession } = await import("../dist/src/stats-insights.js");
  const result = detectDominantSession({ dailyTotals: [], topSessions: [{ sessionId: "a", title: "A", totalTokens: 3000 }, { sessionId: "b", title: "B", totalTokens: 3000 }], totalTokens: 10000, messagesWithTokens: null, totalAssistantMessages: null });
  assert.strictEqual(result.length, 0);
});

test("detectDominantSession detects a dominant session", async () => {
  const { detectDominantSession } = await import("../dist/src/stats-insights.js");
  const result = detectDominantSession({ dailyTotals: [], topSessions: [{ sessionId: "a", title: "A", totalTokens: 7000 }, { sessionId: "b", title: "B", totalTokens: 3000 }], totalTokens: 10000, messagesWithTokens: null, totalAssistantMessages: null });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].key, "dominant_session");
});

test("detectLowCoverage returns empty when coverage data is null", async () => {
  const { detectLowCoverage } = await import("../dist/src/stats-insights.js");
  const result = detectLowCoverage({ dailyTotals: [], topSessions: [], totalTokens: 0, messagesWithTokens: null, totalAssistantMessages: null });
  assert.strictEqual(result.length, 0);
});

test("detectLowCoverage detects low coverage", async () => {
  const { detectLowCoverage } = await import("../dist/src/stats-insights.js");
  const result = detectLowCoverage({ dailyTotals: [], topSessions: [], totalTokens: 0, messagesWithTokens: 30, totalAssistantMessages: 100 });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].key, "low_coverage");
});

test("detectLowCoverage returns empty for high coverage", async () => {
  const { detectLowCoverage } = await import("../dist/src/stats-insights.js");
  const result = detectLowCoverage({ dailyTotals: [], topSessions: [], totalTokens: 0, messagesWithTokens: 80, totalAssistantMessages: 100 });
  assert.strictEqual(result.length, 0);
});

// ── Stats comparison unit tests ──────────────────────────────────────────

test("computePreviousRange returns correct previous period for 7-day range", async () => {
  const { computePreviousRange } = await import("../dist/src/stats-comparison.js");
  const result = computePreviousRange("2025-03-08", "2025-03-14");
  assert.strictEqual(result.from, "2025-03-01");
  assert.strictEqual(result.to, "2025-03-07");
  assert.strictEqual(result.days, 7);
});

test("computePreviousRange works for 1-day range", async () => {
  const { computePreviousRange } = await import("../dist/src/stats-comparison.js");
  const result = computePreviousRange("2025-03-14", "2025-03-14");
  assert.strictEqual(result.from, "2025-03-13");
  assert.strictEqual(result.to, "2025-03-13");
  assert.strictEqual(result.days, 1);
});

test("buildComparison produces correct deltas", async () => {
  const { buildComparison } = await import("../dist/src/stats-comparison.js");
  const result = buildComparison({ tokens: 15000, sessions: 10, records: 100 }, { tokens: 10000, sessions: 8, records: 80 }, "2025-03-01", "2025-03-07", 7);
  assert.strictEqual(result.totalDelta, 5000);
  assert.strictEqual(result.totalDeltaPercent, 50.0);
});

test("buildComparison handles zero previous", async () => {
  const { buildComparison } = await import("../dist/src/stats-comparison.js");
  const result = buildComparison({ tokens: 5000, sessions: 3, records: 30 }, { tokens: 0, sessions: 0, records: 0 }, "2025-03-01", "2025-03-07", 7);
  assert.strictEqual(result.totalDelta, 5000);
  assert.strictEqual(result.totalDeltaPercent, null);
});

// ── Stats cost unit tests ────────────────────────────────────────────────

test("validateTokenPricing rejects non-object", async () => {
  const { validateTokenPricing } = await import("../dist/src/stats-cost.js");
  const errors = validateTokenPricing("not an object");
  assert.ok(errors.length > 0);
});

test("validateTokenPricing accepts valid entry", async () => {
  const { validateTokenPricing } = await import("../dist/src/stats-cost.js");
  const errors = validateTokenPricing({ "openai/gpt-4": { currency: "USD", inputPerMillion: 30, outputPerMillion: 60 } });
  assert.strictEqual(errors.length, 0);
});

test("validateTokenPricing rejects negative rate", async () => {
  const { validateTokenPricing } = await import("../dist/src/stats-cost.js");
  const errors = validateTokenPricing({ "x/y": { currency: "USD", inputPerMillion: -1, outputPerMillion: 60 } });
  assert.ok(errors.length > 0);
});

test("validateTokenPricing rejects unsafe sources and malformed model keys", async () => {
  const { validateTokenPricing } = await import("../dist/src/stats-cost.js");
  assert.ok(validateTokenPricing({ "missing-separator": { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 } }).length > 0);
  assert.ok(validateTokenPricing({ "x/y": { currency: "US", inputPerMillion: 1, outputPerMillion: 2 } }).length > 0);
  assert.ok(validateTokenPricing({ "x/y": { currency: "USD", inputPerMillion: 1, outputPerMillion: 2, sourceUrl: "javascript:alert(1)" } }).length > 0);
});

test("computeCostEstimate produces correct output", async () => {
  const { computeCostEstimate } = await import("../dist/src/stats-cost.js");
  const result = computeCostEstimate({ currency: "USD", inputPerMillion: 10, outputPerMillion: 30 }, { inputTokens: 1000000, outputTokens: 2000000, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.strictEqual(result.currency, "USD");
  // 1M input @ $10/M = $10, 2M output @ $30/M = $60 → $70
  assert.ok(Math.abs(result.totalCost - 70) < 0.01);
});

test("stats advanced modules are capability-gated and export URLs are canonical", () => {
  const base = {
    tokenStats: [], modelRanking: [], topSessions: [], coverage: null,
    overview: { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    filters: { days: 7, from: null, to: null, project: "", modelPair: null, scope: "all", compareA: null, compareB: null, rangePreset: "7", requestedFrom: "", requestedTo: "", validationError: null },
    provider: "codex", providers: [{ id: "codex", name: "Codex", available: true }, { id: "gemini", name: "Gemini", available: false }], manageable: true,
  };
  const limited = renderStatsPage({ ...base, capabilities: { customRange: false, project: false, model: false, scope: false, dayDrill: false, composition: false, modelRanking: false, sessionBreakdown: false, coverage: false } });
  assert.match(limited, /href="\/api\/codex\/stats\/export\.json\?days=7"/);
  assert.match(limited, /stats-provider-item disabled/);
  assert.doesNotMatch(limited, /stats-advanced-details/);

  const full = renderStatsPage({ ...base, capabilities: { customRange: true, project: true, model: true, scope: true, dayDrill: true, composition: true, modelRanking: true, sessionBreakdown: true, coverage: true } });
  assert.match(full, /stats-advanced-details/);
  assert.match(full, /Advanced insights and estimates/);
});

test("navigate Token to Usage", () => {
  // The nav label should be "Usage" not "Token"
  const html = renderStatsPage({
    tokenStats: [],
    modelRanking: [],
    topSessions: [],
    coverage: { messagesWithTokens: 0, totalAssistantMessages: 0, availableDimensions: [], missingDimensions: [] },
    overview: { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 },
    filters: { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all" },
    provider: "opencode",
    providers: []
  });

  // Nav label should no longer be "Token"
  assert.match(html, />Usage</);
  assert.doesNotMatch(html, />Token</);
});

test("global search shortcut ignores editable targets", () => {
  const bundle = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf-8");
  const appSource = readFileSync(path.join(process.cwd(), "src", "static", "app.js"), "utf-8");
  assert.match(bundle, /function isEditableShortcutTarget/);
  const helperSource = appSource.match(/function isEditableShortcutTarget\(target\) \{[\s\S]*?target\.isContentEditable;\r?\n\}/)?.[0];
  assert.ok(helperSource);

  class FakeHTMLElement {
    constructor(tagName, isContentEditable = false) {
      this.tagName = tagName;
      this.isContentEditable = isContentEditable;
    }
  }
  const isEditableShortcutTarget = runInNewContext(
    `${helperSource}\nisEditableShortcutTarget;`,
    { HTMLElement: FakeHTMLElement }
  );

  assert.equal(isEditableShortcutTarget(new FakeHTMLElement("INPUT")), true);
  assert.equal(isEditableShortcutTarget(new FakeHTMLElement("TEXTAREA")), true);
  assert.equal(isEditableShortcutTarget(new FakeHTMLElement("SELECT")), true);
  assert.equal(isEditableShortcutTarget(new FakeHTMLElement("DIV", true)), true);
  assert.equal(isEditableShortcutTarget(new FakeHTMLElement("DIV")), false);
  assert.equal(isEditableShortcutTarget({ tagName: "TEXTAREA" }), false);
});

test("OpenCode runtime environment resolves project and user agent extensions", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-runtime-"));
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
      && entry.sourcePath === realpathSync(path.join(projectPath, "AGENTS.md"))
    )));
    assert.ok(runtime.extensions.some((entry) => (
      entry.scope === "project"
      && entry.kind === "instruction"
      && entry.sourcePath === realpathSync(path.join(projectPath, "docs", "runtime.md"))
    )));
    assert.ok(runtime.extensions.some((entry) => (
      entry.scope === "user"
      && entry.kind === "instruction"
      && entry.sourcePath === realpathSync(path.join(userOpenCode, "AGENTS.md"))
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
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-instructions-"));
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
    && entry.sourcePath === realpathSync(path.join(codexDir, "AGENTS.md"))
  )));
  assert.ok(codex.extensions.some((entry) => (
    entry.scope === "project"
    && entry.kind === "instruction"
    && entry.sourcePath === realpathSync(path.join(projectPath, "AGENTS.override.md"))
  )));

  const claude = buildClaudeCodeRuntimeEnvironment("claude-session", projectPath, claudeDir);
  assert.ok(claude.extensions.some((entry) => (
    entry.scope === "user"
    && entry.kind === "instruction"
    && entry.sourcePath === realpathSync(path.join(claudeDir, "CLAUDE.md"))
  )));
  assert.ok(claude.extensions.some((entry) => (
    entry.scope === "project"
    && entry.kind === "instruction"
    && entry.sourcePath === realpathSync(path.join(projectPath, "CLAUDE.md"))
  )));
  assert.ok(claude.extensions.some((entry) => (
    entry.scope === "project"
    && entry.kind === "rule"
    && entry.sourcePath === realpathSync(path.join(projectPath, ".claude", "rules", "review.md"))
  )));

  const gemini = buildGeminiRuntimeEnvironment("gemini-session", projectPath, geminiDir);
  assert.ok(gemini.extensions.some((entry) => (
    entry.scope === "user"
    && entry.kind === "instruction"
    && entry.sourcePath === realpathSync(path.join(geminiDir, "GEMINI.md"))
  )));
  assert.ok(gemini.extensions.some((entry) => (
    entry.scope === "project"
    && entry.kind === "instruction"
    && entry.sourcePath === realpathSync(path.join(projectPath, "GEMINI.md"))
  )));
});

test("settings configuration validates, persists, and applies runtime fields", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-settings-"));
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
          fileExtensions: [".md"],
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
          },
          projectPaths: {
            "opaque-project-key": process.cwd()
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
            projectPaths: [],
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
      "analysis.providers.opencode.projectPaths must be an object of string values.",
      "analysis.providers.opencode.targets.skills.artifactRoots must be an array of strings."
    ]
  );
  assert.deepEqual(
    validateUserConfig({
      analysis: {
        providers: {
          gemini: {
            projectPaths: { "opaque-project-key": "relative-project" }
          }
        }
      }
    }),
    ["analysis.providers.gemini.projectPaths.opaque-project-key must be an absolute path."]
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

test("analysis configuration preserves explicit paths without migration", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-config-"));
  const configPath = path.join(temp, "config.json");
  writeFileSync(configPath, JSON.stringify({
    analysis: {
      outputDir: ".agentsession/analysis",
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
  assert.equal(document.config.analysis.outputDir, ".agentsession/analysis");
  assert.deepEqual(document.config.analysis.targets.skills.artifactRoots, ["skills", ".agents/skills", ".codex/skills"]);
  assert.deepEqual(document.config.analysis.targets.prompts.artifactRoots, ["custom-prompts"]);
  assert.deepEqual(
    document.config.analysis.providers.opencode.targets.skills.artifactRoots,
    [".opencode/skills", ".agents/skills", ".codex/skills"]
  );
  assert.deepEqual(
    document.config.analysis.providers.opencode.targets.skills.artifactFiles,
    ["AGENTS.md"]
  );
  assert.deepEqual(
    document.config.analysis.providers.codex.targets.skills.artifactFiles,
    ["AGENTS.md"]
  );
  assert.match(document.raw, /\.agents\/skills/);

  const savedPath = path.join(temp, "saved.json");
  writeUserConfig(savedPath, JSON.parse(document.raw));
  const saved = JSON.parse(readFileSync(savedPath, "utf-8"));
  assert.equal(saved.analysis.outputDir, ".agentsession/analysis");
  assert.deepEqual(saved.analysis.targets.skills.artifactRoots, ["skills", ".agents/skills", ".codex/skills"]);
  assert.deepEqual(saved.analysis.providers.opencode.targets.skills.artifactRoots, [".opencode/skills", ".agents/skills", ".codex/skills"]);
  assert.deepEqual(saved.analysis.providers.opencode.targets.skills.artifactFiles, ["AGENTS.md"]);
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
    }]
  });

  assert.match(html, /data-page="settings"/);
  assert.match(html, /class="logo"[^>]+title="AgentSession"[^>]+aria-label="AgentSession"/);
  assert.match(html, /class="provider-context" title="OpenCode"/);
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
  assert.match(html, /AgentSession does not create it/);
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
              fileExtensions: [".md"],
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

});

test("settings browser script blocks save while advanced JSON is invalid", () => {
  const bundle = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf8");
  const settingsModule = readFileSync(
    path.join(process.cwd(), "src", "static", "app", "settings-form.js"),
    "utf8"
  );

  assert.match(bundle, /initSettingsForm\(\{ ft, formatText, showToast \}\);/);
  assert.match(bundle, /submitButton\.disabled = !settingsDirty \|\| !settingsJsonValid;/);
  assert.match(settingsModule, /let settingsJsonValid = true;/);
  assert.match(settingsModule, /submitButton\.disabled = !settingsDirty \|\| !settingsJsonValid;/);
  assert.match(settingsModule, /const invalidJsonMessage = \(error\) => `\$\{ft\("settings_invalid_json"\)\}: \$\{error\.message\}`;/);
  assert.match(settingsModule, /if \(event\.target === editor\) \{\s*updateEditorJsonState\(\{ showMessage: true \}\);/);
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
    Buffer.from(launch.env.AGENTSESSION_DIRECT_POWERSHELL_LAUNCH_SPEC, "base64").toString("utf-8")
  );
  assert.deepEqual(directSpec, {
    executable: powershell,
    args: args.slice(1),
    cwd
  });
  const wrapperScript = Buffer.from(launch.args[3], "base64").toString("utf16le");
  assert.match(wrapperScript, /Start-Process @startInfo/);
});

function fakeSpawnSequence(sequence) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const next = sequence.shift() || {};
    const child = new EventEmitter();
    child.pid = next.pid ?? (1000 + calls.length);
    child.unrefCalled = false;
    child.unref = () => {
      child.unrefCalled = true;
    };
    calls.push({ executable, args, options, child });
    setTimeout(() => {
      if (next.error) {
        child.emit("error", new Error(next.error));
        return;
      }
      child.emit("spawn");
      if (next.exitCode !== undefined || next.signal !== undefined) {
        setTimeout(() => child.emit("exit", next.exitCode ?? null, next.signal ?? null), next.exitDelay ?? 0);
      }
    }, next.delay ?? 0);
    return child;
  };
  return { spawnImpl, calls };
}

test("terminal launch reports direct PowerShell wrapper failures", async () => {
  const cwd = "C:\\project";
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const { spawnImpl } = fakeSpawnSequence([{ exitCode: 1 }]);

  await assert.rejects(
    spawnPowerShellLaunch({
      cwd,
      terminal: null,
      powershellArgs: buildPowerShellResumeArgs(powershell),
      env: { AGENTSESSION_RESUME_SPEC: "e30=" }
    }, spawnImpl),
    /Terminal launch failed for powershell\.exe: Terminal launch wrapper exited with exit code 1/
  );
});

test("terminal launch reports synchronous spawn failures with context", async () => {
  const cwd = "C:\\project";
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  await assert.rejects(
    spawnPowerShellLaunch({
      cwd,
      terminal: null,
      powershellArgs: buildPowerShellResumeArgs(powershell),
      env: { AGENTSESSION_RESUME_SPEC: "e30=" }
    }, () => {
      throw new Error("spawn EINVAL");
    }),
    /Terminal launch failed for powershell\.exe: spawn EINVAL/
  );
});

test("terminal launch falls back when Windows Terminal fails to start", async () => {
  const cwd = "C:\\project";
  const terminal = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
  const powershell = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const { spawnImpl, calls } = fakeSpawnSequence([
    { error: "wt failed" },
    { exitCode: 0 }
  ]);

  const result = await launchPowerShellWithFallback({
    cwd,
    terminal,
    powershellArgs: buildPowerShellResumeArgs(powershell),
    env: { AGENTSESSION_RESUME_SPEC: "e30=" }
  }, spawnImpl);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].executable, terminal);
  assert.equal(calls[1].executable, powershell);
  assert.equal(result.fallbackFrom, terminal);
  assert.equal(result.usedTerminal, false);
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

test("conversation flow recognizes every shared subagent launcher", () => {
  for (const tool of ["agent", "task", "subtask", "spawn_agent", "delegate_task"]) {
    const child = flowSession(`${tool}-child`, [
      flowMessage(`${tool}-user`, "user", 1100),
      flowMessage(`${tool}-assistant`, "assistant", 1200)
    ], {
      depth: 1,
      attachMode: "task",
      metrics: { timeStart: 1100, timeEnd: 1200, runtimeMs: 100 }
    });
    const launcher = flowTool(`${tool}-launcher`, {
      tool,
      messageId: `${tool}-root-agent`,
      childSessions: [child],
      timeStart: 1050,
      timeEnd: 1250
    });
    const parent = flowSession(`${tool}-root`, [
      flowMessage(`${tool}-root-user`, "user", 1000),
      flowMessage(`${tool}-root-agent`, "assistant", 1040, [launcher])
    ], {
      metrics: {
        partCount: 1,
        toolCallCount: 1,
        totalToolCalls: 1,
        descendantCount: 1,
        timeStart: 1000,
        timeEnd: 1300,
        runtimeMs: 300
      }
    });

    const flow = buildFlowTreeFromContainer(parent);
    const invocation = flow.root.line.find((node) => node.kind === "invocation");
    const returned = flow.root.line.find((node) => node.kind === "return");

    assert.ok(invocation, `${tool} should render a subagent fork`);
    assert.ok(returned, `${tool} should render a matching return`);
    assert.equal(invocation.branches[0].id, `session:${tool}-child`);
    assert.equal(invocation.returnId, returned.id);
    assert.equal(flow.summary.subagents, 1);
  }
});

test("detached child sessions visibly identify inferred source relationships", () => {
  const child = {
    session: { id: "fork", title: "Pi fork", time_created: 1100, time_updated: 1200 },
    detachedChildren: [],
    metrics: flowMetrics({ messageCount: 2, totalMessages: 2, timeStart: 1100, timeEnd: 1200 }),
    messages: [
      flowMessage("fork-user", "user", 1100),
      flowMessage("fork-agent", "assistant", 1200)
    ]
  };
  const sessionTree = {
    session: { id: "root", title: "Root", time_created: 1000, time_updated: 1300 },
    detachedChildren: [child],
    metrics: flowMetrics({ messageCount: 1, totalMessages: 3, descendantCount: 1, timeStart: 1000, timeEnd: 1300 }),
    messages: [flowMessage("root-user", "user", 1000)]
  };

  const html = renderSessionPage({
    session: sessionTree.session,
    sessionTree,
    provider: "pi"
  });

  assert.match(html, /data-session-relationship="inferred"/);
  assert.match(html, /Linked session/);
  assert.match(html, /Inferred relationship/);
  assert.match(html, /Pi fork/);
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
  assert.match(flowFragment, /data-flow-preview-target="#msg-u1"/);
  assert.match(flowFragment, /data-flow-inspector/);
  assert.match(flowFragment, /data-flow-inspector-body/);
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
  assert.match(html, /href="\/opencode\/session\/child"[^>]*>Open<\/a>/);
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
