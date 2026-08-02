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

import { closeDb, getFilteredSessionCount, getModelDistribution, getModelPairs, getStatsProjects, getTokenCoverage, getTokenStats, getTopTokenSessions, listSessionProjects, listSessions, searchMessages } from "../dist/src/db.js";
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

test("session analysis snapshots artifacts and generates evaluation inputs", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-analysis-"));
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
        fileExtensions: [".md"],
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
    analysisConfig
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
  writeFileSync(run.files.analyzerStdoutPath, "Analyzer started\n");
  writeFileSync(run.files.analyzerStderrPath, "Waiting for input\n");
  const preparedRuns = listSessionAnalysisRuns({
    provider,
    providerId: "opencode",
    sessionId: "session-analysis",
    directory: projectPath,
    analysisConfig
  });
  assert.equal(
    path.dirname(run.runDir),
    path.join(realpathSync(projectPath), ".agentsession", "analysis")
  );
  assert.equal(
    readFileSync(path.join(projectPath, ".agentsession", ".gitignore"), "utf-8"),
    "*\n!.gitignore\n"
  );
  assert.equal(preparedRuns.length, 1);
  assert.equal(preparedRuns[0].state, "prepared");
  assert.equal(preparedRuns[0].active, true);
  assert.equal(preparedRuns[0].diagnostics.stdout.available, true);
  assert.equal(preparedRuns[0].diagnostics.stderr.available, true);
  assert.equal(preparedRuns[0].diagnostics.stdout.relativePath, "diagnostics/analyzer.stdout.log");
  assert.equal(preparedRuns[0].command.stdin, "prompt");
  assert.equal(preparedRuns[0].command.promptPath, run.files.promptPath);
  const activeRun = findActiveSessionAnalysisRun({
    provider,
    providerId: "opencode",
    sessionId: "session-analysis",
    directory: projectPath,
    analysisConfig,
    targetId: "skills"
  });
  assert.equal(activeRun.runId, run.runId);
  assert.equal(findActiveSessionAnalysisRun({
    provider,
    providerId: "opencode",
    sessionId: "session-analysis",
    directory: projectPath,
    analysisConfig,
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
      file.sourcePath.includes(`${path.sep}.agentsession${path.sep}`)
      || file.sourcePath.includes(`${path.sep}.opensessionviewer${path.sep}`)
    )),
    false
  );
  const skillArtifact = artifacts.files.find(
    (file) => file.sourcePath === realpathSync(skillPath)
  );
  const agentsArtifact = artifacts.files.find((file) => file.relativePath === "AGENTS.md");
  const projectRuntimeArtifact = artifacts.files.find(
    (file) => file.sourcePath === realpathSync(projectRuntimeSkillPath)
  );
  const userRuntimeArtifact = artifacts.files.find(
    (file) => file.sourcePath === realpathSync(userHookPath)
  );
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
        artifactRoot: realpathSync(projectPath),
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
    analysisConfig
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
    analysisConfig
  });
  assert.equal(preparedImplementationRuns[0].implementation.state, "prepared");
  assert.equal(preparedImplementationRuns[0].implementation.acceptedProposalCount, 1);
  assert.equal(preparedImplementationRuns[0].implementation.resultAvailable, false);
  assert.equal(preparedImplementationRuns[0].implementationAvailable, true);

  const generatedTargetProposal = JSON.parse(readFileSync(run.files.proposalsPath, "utf-8"));
  generatedTargetProposal.proposals[0].artifactPath = path.relative(
    realpathSync(projectPath),
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
    runtimeExtensionIds: ["runtime:opencode:project:instruction:agents"]
  });
  const filteredArtifacts = JSON.parse(readFileSync(filteredRuntimeRun.files.artifactsPath, "utf-8"));
  assert.deepEqual(filteredArtifacts.runtimeEnvironment.selectedExtensionIds, [
    "runtime:opencode:project:instruction:agents"
  ]);
});
test("analysis layout resolves categorized run files", () => {
  const runDir = mkdtempSync(path.join(os.tmpdir(), "agentsession-analysis-layout-"));
  const manifest = { schemaVersion: 1, runDir };
  writeFileSync(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  mkdirSync(path.join(runDir, "outputs"), { recursive: true });
  mkdirSync(path.join(runDir, "evidence"), { recursive: true });
  writeFileSync(path.join(runDir, "outputs", "report.md"), "# Report\n");
  writeFileSync(path.join(runDir, "evidence", "evidence-index.json"), "{}\n");

  assert.equal(
    resolveAnalysisRunPath(runDir, manifest, "reportPath"),
    path.join(runDir, "outputs", "report.md")
  );
  assert.equal(
    resolveAnalysisRunPath(runDir, manifest, "evidenceIndexPath"),
    path.join(runDir, "evidence", "evidence-index.json")
  );
});

test("analysis run listing ignores retired paths", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-analysis-runs-"));
  const projectPath = path.join(temp, "project");
  const runDir = path.join(projectPath, ".agentsession", "analysis", "current-run");
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    runId: "current-run",
    provider: "codex",
    sessionId: "current-session",
    target: "skills",
    state: "completed",
    createdAt: "2026-06-01T00:00:00.000Z"
  })}\n`);

  assert.equal(
    getAnalysisOutputRoot(projectPath, {}),
    path.join(realpathSync(projectPath), ".agentsession", "analysis")
  );
  const legacyProjectRunDir = path.join(projectPath, ".opensessionviewer", "analysis", "legacy-project-run");
  mkdirSync(legacyProjectRunDir, { recursive: true });
  writeFileSync(path.join(legacyProjectRunDir, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    runId: "legacy-project-run",
    provider: "codex",
    sessionId: "current-session",
    target: "skills",
    state: "completed",
    createdAt: "2026-06-02T00:00:00.000Z"
  })}\n`);
  const runs = listSessionAnalysisRuns({
    providerId: "codex",
    sessionId: "current-session",
    directory: projectPath,
    analysisConfig: {}
  });
  assert.equal(runs.length, 1);
  assert.deepEqual(
    runs.map((run) => run.runId).sort(),
    ["current-run"]
  );
  assert.equal(runs[0].runDir, runDir);
});

test("session analysis requires a provider capability and an enabled target", () => {
  const opencode = { id: "opencode", capabilities: { sessionAnalysis: true } };
  const claude = { id: "claude-code", capabilities: { sessionAnalysis: true } };
  const codex = getAllProviders().find((provider) => provider.id === "codex");
  const gemini = getAllProviders().find((provider) => provider.id === "gemini");
  const pi = getAllProviders().find((provider) => provider.id === "pi");
  assert.equal(codex.capabilities.sessionAnalysis, true);
  assert.equal(gemini.capabilities.sessionAnalysis, false);
  assert.equal(pi.capabilities.sessionAnalysis, true);
  assert.equal(typeof codex.getRuntimeEnvironment, "function");
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
  assert.equal(resolveAnalysisSettings(gemini, {
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
  assert.equal(resolveAnalysisSettings(codex, {
    enabled: true
  }).command.executable, "opencode");
  assert.equal(resolveAnalysisSettings(pi, {
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
  assert.match(script, /AGENTSESSION_ANALYSIS_SPEC/);
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
  assert.match(script, /AGENTSESSION_IMPLEMENTATION_SPEC/);
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
    resumeCommand: {
      display: "opencode --session analysis-session",
      cwd: "C:\\WorkSpace\\OpenSession",
      available: true
    },
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
  assert.doesNotMatch(hidden, /resume-command-preview/);

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
    resumeCommand: {
      display: "opencode --session analysis-session",
      cwd: "C:\\WorkSpace\\OpenSession",
      available: true
    },
    terminalLaunchAllowed: true
  });
  assert.match(visible, /data-action="analyze-session"/);
  assert.match(visible, /data-target="skills"/);
  assert.match(visible, /class="session-actions-shell analysis-launch-control"/);
  assert.match(visible, /data-analysis-selection-id="analysis-materials-panel"/);
  assert.match(visible, /class="more-actions"/);
  assert.match(visible, /Export MD/);
  assert.match(visible, /Export JSON/);
  assert.match(visible, /class="analysis-target-checkbox"/);
  assert.match(visible, /class="analysis-runtime-extension-checkbox"/);
  assert.match(visible, /data-analysis-label="Analyze skills"/);
  assert.match(visible, /data-analysis-label="AGENTS\.md"/);
  assert.match(visible, /aria-label="Launch analysis for Analyze skills, Analyze tests; runtime extensions: 1"/);
  assert.match(visible, /Analyze 2 targets/);
  assert.match(visible, /Analysis materials/);
  assert.match(visible, /<details class="analysis-materials-panel" id="analysis-materials-panel">/);
  assert.doesNotMatch(visible, /<details class="analysis-materials-panel" open>/);
  assert.match(visible, /class="analysis-target-choice analysis-target-choice-compact/);
  assert.match(visible, /class="analysis-runtime-tab is-active"/);
  assert.match(visible, /role="tabpanel"/);
  assert.match(visible, /Instructions/);
  assert.match(visible, /Plugins/);
  assert.match(visible, /Project scope/);
  assert.match(visible, /User scope/);
  assert.match(visible, /data-action="resume-session"/);
  assert.match(visible, /<details class="resume-command-preview">/);
  assert.match(visible, /Terminal command/);
  assert.match(visible, /opencode --session analysis-session/);
  assert.match(visible, /C:\\WorkSpace\\OpenSession/);
  assert.match(visible, /data-action="copy-resume-command"/);
  assert.match(visible, /id="analysis-status-panel"/);
  assert.match(visible, /data-terminal-launch="true"/);
  assert.match(visible, /report\.md is missing/);
});

test("session rendering includes in-conversation search controls", () => {
  const html = renderSessionPage({
    session: { id: "searchable", title: "Searchable session", time_created: 1000 }
  });

  assert.match(html, /<details class="session-search" data-session-search>/);
  assert.match(html, /class="action-btn session-search-toggle"/);
  assert.match(html, /class="session-search-panel"/);
  assert.match(html, /data-session-search-input/);
  assert.match(html, /data-session-search-previous/);
  assert.match(html, /data-session-search-next/);
  assert.match(html, /data-session-search-close/);
  assert.match(html, /id="session-messages"/);
  assert.ok(html.indexOf("data-session-search") < html.indexOf('id="session-messages"'));

  const appJs = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf-8");
  assert.match(appJs, /requestIdleCallback/);
  assert.match(appJs, /data-session-search-highlight/);
  assert.match(appJs, /highlightTranscriptMatches/);
});

test("session detail uses progressive, accessible tabs without duplicating analysis controls", () => {
  const html = renderSessionPage({
    session: { id: "tabbed", title: "Tabbed session", time_created: 1000, time_updated: 2000 },
    analysisAction: {
      target: "skills",
      targets: [{ id: "skills", label: "Skills", available: true }],
      selectedTargets: ["skills"],
      runtimeEnvironment: { selectedExtensionIds: [], extensions: [] },
      available: true
    },
    analysisRuns: [{ runId: "done", state: "completed", active: false }],
    terminalLaunchAllowed: true
  });

  assert.match(html, /class="tab-bar" role="tablist"/);
  assert.ok(html.indexOf("tab-btn-overview") < html.indexOf("tab-btn-conversation"));
  assert.ok(html.indexOf("tab-btn-conversation") < html.indexOf("tab-btn-flow"));
  assert.ok(html.indexOf("tab-btn-flow") < html.indexOf("tab-btn-analysis"));
  assert.ok(html.indexOf("tab-btn-analysis") < html.indexOf("tab-btn-raw"));
  assert.match(html, /id="tab-btn-conversation" tabindex="0"/);
  assert.match(html, /id="tab-conversation" aria-labelledby="tab-btn-conversation"/);
  assert.doesNotMatch(html, /id="tab-overview"[^>]* hidden/);
  assert.equal((html.match(/class="analysis-materials-panel"/g) || []).length, 1);
  assert.match(html, /<details class="analysis-activity-details" id="analysis-activity-details" >/);
  assert.doesNotMatch(html, /session-detail-id/);

  const appJs = readFileSync(path.join(process.cwd(), "dist", "src", "static", "app.js"), "utf-8");
  assert.match(appJs, /session-flow-tab-open/);
  assert.match(appJs, /openFlowMessagePreview/);
  assert.match(appJs, /data-flow-open-conversation/);
  assert.doesNotMatch(appJs, /classList\.add\("flow-panel-open"\)/);
  assert.match(appJs, /ArrowRight/);
  assert.match(appJs, /ArrowLeft/);
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
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-prompt-preview-"));
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
  assert.match(preview.prompt, /# AgentSession session analysis/);
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
