import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  AnalysisCommandSpec,
  ProviderAdapter,
  RuntimeEnvironmentView,
  ResumeShellSpec
} from "./providers/interface.js";
import { makeEvidenceId, writeAnalysisEvidence } from "./analysis-evidence.js";
import {
  BUILTIN_ANALYSIS_TARGETS,
  DEFAULT_ANALYSIS_TARGET,
  DEFAULT_ANALYSIS_EXTENSIONS,
  getBuiltinAnalysisTarget,
  getProviderAnalysisTarget
} from "./analysis-targets.js";
import {
  analysisRunRelativePath,
  ensureAnalysisRunDirectories,
  getAnalysisRunPaths,
  resolveAnalysisRunPath
} from "./analysis-layout.js";
import { resolveExecutable, resolveProjectDirectory } from "./resume.js";

const MAX_ARTIFACT_FILES = 200;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 5 * 1024 * 1024;

function isCommandSpec(value): value is AnalysisCommandSpec {
  return Boolean(
    value
    && typeof value === "object"
    && typeof value.executable === "string"
    && value.executable.trim()
    && Array.isArray(value.args)
    && value.args.every((arg) => typeof arg === "string")
    && (value.stdin === undefined || value.stdin === "prompt")
  );
}

function isShellSpec(value): value is ResumeShellSpec {
  return Boolean(
    value
    && typeof value === "object"
    && typeof value.executable === "string"
    && value.executable.trim()
    && (value.args === undefined || (
      Array.isArray(value.args)
      && value.args.every((arg) => typeof arg === "string")
    ))
  );
}

function safeSegment(value) {
  const segment = String(value || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return segment.slice(0, 80) || "session";
}

function timestampSegment(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function inspectPromptFile(promptFile, configPath) {
  if (!promptFile || typeof promptFile !== "string") {
    return {
      configuredPath: "",
      resolvedPath: "",
      available: false,
      content: "",
      error: ""
    };
  }
  const base = configPath ? path.dirname(configPath) : process.cwd();
  const resolved = path.isAbsolute(promptFile) ? promptFile : path.resolve(base, promptFile);
  try {
    return {
      configuredPath: promptFile,
      resolvedPath: resolved,
      available: true,
      content: readFileSync(resolved, "utf-8"),
      error: ""
    };
  } catch (error) {
    return {
      configuredPath: promptFile,
      resolvedPath: resolved,
      available: false,
      content: "",
      error: error.message
    };
  }
}

function readPromptFile(promptFile, configPath) {
  const inspected = inspectPromptFile(promptFile, configPath);
  if (inspected.error) {
    console.warn(`Ignoring unavailable analysis prompt file at ${inspected.resolvedPath}: ${inspected.error}`);
  }
  return inspected.content;
}

function resolveRuntimeEnvironment(provider: ProviderAdapter, sessionId: string) {
  try {
    return provider.getRuntimeEnvironment?.(sessionId) || null;
  } catch (error) {
    console.warn(`Unable to resolve ${provider.id} runtime environment: ${error?.message || error}`);
    return null;
  }
}

function normalizeTargetIds(value): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(
    values
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

function configuredDefaultTargetIds(provider: ProviderAdapter, analysisConfig): string[] {
  const providerConfig = analysisConfig?.providers?.[provider.id];
  return normalizeTargetIds(
    providerConfig?.defaultTargets?.length
      ? providerConfig.defaultTargets
      : providerConfig?.defaultTarget
        ? providerConfig.defaultTarget
        : analysisConfig?.defaultTargets?.length
          ? analysisConfig.defaultTargets
          : analysisConfig?.defaultTarget || "skills"
  );
}

export function getAnalysisTargetIds(provider: ProviderAdapter, analysisConfig): string[] {
  const providerConfig = analysisConfig?.providers?.[provider.id];
  if (!analysisConfig || analysisConfig.enabled !== true || !providerConfig || providerConfig === false) {
    return [];
  }
  return [...new Set([
    ...Object.keys(BUILTIN_ANALYSIS_TARGETS),
    ...Object.keys(analysisConfig.targets || {}),
    ...Object.keys(providerConfig.targets || {}),
    ...configuredDefaultTargetIds(provider, analysisConfig)
  ])].filter((targetId) => resolveAnalysisSettings(provider, analysisConfig, targetId));
}

export function getDefaultAnalysisTargetIds(provider: ProviderAdapter, analysisConfig): string[] {
  const configured = configuredDefaultTargetIds(provider, analysisConfig)
    .filter((targetId) => resolveAnalysisSettings(provider, analysisConfig, targetId));
  if (configured.length) {
    return configured;
  }
  return getAnalysisTargetIds(provider, analysisConfig).slice(0, 1);
}

export function resolveAnalysisSettings(provider: ProviderAdapter, analysisConfig, targetId = "") {
  if (!analysisConfig || analysisConfig.enabled !== true) {
    return null;
  }

  const providerConfig = analysisConfig.providers?.[provider.id];
  if (!providerConfig || providerConfig === false) {
    return null;
  }

  const selectedTarget = targetId || configuredDefaultTargetIds(provider, analysisConfig)[0] || "skills";
  const configuredTarget = analysisConfig.targets?.[selectedTarget];
  const providerTarget = providerConfig.targets?.[selectedTarget];
  if (configuredTarget === false || providerTarget === false) {
    return null;
  }
  const target = getProviderAnalysisTarget(analysisConfig, provider.id, selectedTarget);
  const command = providerTarget?.command || providerConfig.command || target.command;
  if (!isCommandSpec(command)) {
    return null;
  }

  const shell = providerTarget?.shell
    || providerConfig.shell
    || analysisConfig.shell
    || null;
  return {
    targetId: selectedTarget,
    target,
    command,
    shell: isShellSpec(shell) ? shell : null
  };
}

export function getSessionAnalysisAction(
  provider: ProviderAdapter,
  sessionId,
  directory,
  analysisConfig,
  targetId = ""
) {
  const projectPath = resolveProjectDirectory(directory);
  if (!projectPath) {
    return null;
  }

  const targetIds = targetId ? [targetId] : getAnalysisTargetIds(provider, analysisConfig);
  const targets = targetIds
    .map((id) => resolveAnalysisSettings(provider, analysisConfig, id))
    .filter(Boolean)
    .map((settings) => ({
      id: settings.targetId,
      label: settings.target.label ? String(settings.target.label) : settings.targetId,
      artifacts: {
        roots: Array.isArray(settings.target.artifactRoots) ? settings.target.artifactRoots : [],
        files: Array.isArray(settings.target.artifactFiles) ? settings.target.artifactFiles : [],
        fileExtensions: Array.isArray(settings.target.fileExtensions)
          ? settings.target.fileExtensions
          : DEFAULT_ANALYSIS_EXTENSIONS
      },
      available: Boolean(resolveExecutable(settings.command.executable))
    }));
  const selectedTargets = targetId
    ? [targetId]
    : getDefaultAnalysisTargetIds(provider, analysisConfig);
  const selected = targets.filter(
    (target) => selectedTargets.includes(target.id) && target.available
  );
  const effectiveSelection = selected.length
    ? selected
    : targets.filter((target) => target.available).slice(0, 1);
  if (!targets.length || !effectiveSelection.length) {
    return null;
  }
  const runtimeEnvironment = resolveRuntimeEnvironment(provider, sessionId);
  const selectedRuntimeExtensionIds = (runtimeEnvironment?.extensions || [])
    .filter((extension) => extension.defaultSelected && extension.available)
    .map((extension) => extension.id);

  return {
    target: effectiveSelection[0].id,
    targets,
    selectedTargets: effectiveSelection.map((target) => target.id),
    label: effectiveSelection.length === 1 ? effectiveSelection[0].label : null,
    available: true,
    sessionId,
    projectPath,
    runtimeEnvironment,
    selectedRuntimeExtensionIds
  };
}

function resolveArtifactRoot(projectPath, root) {
  if (typeof root !== "string" || !root.trim()) {
    return null;
  }
  const candidate = path.isAbsolute(root) ? root : path.resolve(projectPath, root);
  try {
    const resolved = realpathSync(candidate);
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function resolveArtifactFile(projectPath, filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return null;
  }
  const candidate = path.isAbsolute(filePath) ? filePath : path.resolve(projectPath, filePath);
  try {
    const info = lstatSync(candidate);
    if (info.isSymbolicLink() || !info.isFile()) {
      return null;
    }
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function addArtifactFile(
  sourcePath,
  root,
  extensions,
  output,
  state,
  explicit = false,
  runtimeExtensionIds = []
) {
  const existing = output.find((file) => file.sourcePath === sourcePath);
  if (existing) {
    existing.runtimeExtensionIds = [...new Set([
      ...(existing.runtimeExtensionIds || []),
      ...runtimeExtensionIds
    ])];
    existing.explicit = existing.explicit || explicit;
    return;
  }
  if (output.length >= MAX_ARTIFACT_FILES || state.totalBytes >= MAX_TOTAL_ARTIFACT_BYTES) {
    return;
  }
  try {
    const info = lstatSync(sourcePath);
    if (
      info.isSymbolicLink()
      || !info.isFile()
      || (!explicit && !extensions.has(path.extname(sourcePath).toLowerCase()))
    ) {
      return;
    }
    const capturedBytes = Math.min(info.size, MAX_ARTIFACT_BYTES);
    if (state.totalBytes + capturedBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      return;
    }
    output.push({
      sourcePath,
      root,
      explicit,
      runtimeExtensionIds: [...runtimeExtensionIds],
      size: info.size,
      capturedBytes,
      truncated: info.size > capturedBytes,
      modifiedAt: info.mtime.toISOString()
    });
    state.totalBytes += capturedBytes;
  } catch {
    // Files may disappear while the inventory is being generated.
  }
}

function isInsideExcludedRoot(candidate, excludedRoots) {
  const resolved = path.resolve(candidate);
  return excludedRoots.some((root) => (
    resolved === root || resolved.startsWith(`${root}${path.sep}`)
  ));
}

function walkArtifactFiles(
  root,
  extensions,
  output,
  state,
  artifactRoot = root,
  excludedRoots = [],
  runtimeExtensionIds = []
) {
  if (output.length >= MAX_ARTIFACT_FILES || state.totalBytes >= MAX_TOTAL_ARTIFACT_BYTES) {
    return;
  }

  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (output.length >= MAX_ARTIFACT_FILES || state.totalBytes >= MAX_TOTAL_ARTIFACT_BYTES) {
      break;
    }
    const fullPath = path.join(root, entry.name);
    try {
      if (isInsideExcludedRoot(fullPath, excludedRoots)) {
        continue;
      }
      const info = lstatSync(fullPath);
      if (info.isSymbolicLink()) {
        continue;
      }
      if (info.isDirectory()) {
        walkArtifactFiles(
          fullPath,
          extensions,
          output,
          state,
          artifactRoot,
          excludedRoots,
          runtimeExtensionIds
        );
        continue;
      }
      addArtifactFile(
        fullPath,
        artifactRoot,
        extensions,
        output,
        state,
        false,
        runtimeExtensionIds
      );
    } catch {
      // Files may disappear while the inventory is being generated.
    }
  }
}

function truncateTextBuffer(buffer, maxBytes) {
  if (buffer.length <= maxBytes) {
    return buffer;
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end);
}

function snapshotArtifacts(
  projectPath,
  snapshotDir,
  target,
  runtimeEnvironment: RuntimeEnvironmentView | null,
  selectedRuntimeExtensionIds: string[],
  excludedRoots = []
) {
  const resolvedExcludedRoots = excludedRoots.map((root) => path.resolve(root));
  const roots = [];
  const seenRoots = new Set();
  for (const configuredRoot of target.artifactRoots || []) {
    const resolved = resolveArtifactRoot(projectPath, configuredRoot);
    if (resolved && !seenRoots.has(resolved)) {
      seenRoots.add(resolved);
      roots.push(resolved);
    }
  }

  const fileExtensions = new Set(
    (target.fileExtensions || target.extensions || DEFAULT_ANALYSIS_TARGET.fileExtensions)
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.startsWith(".") ? entry.toLowerCase() : `.${entry.toLowerCase()}`)
  );
  const runtimeFileExtensions = new Set([
    ...fileExtensions,
    ...DEFAULT_ANALYSIS_EXTENSIONS,
    ".toml",
    ".txt",
    ".mdx"
  ]);
  const requestedRuntimeIds = new Set(selectedRuntimeExtensionIds);
  const selectedRuntimeExtensions = (runtimeEnvironment?.extensions || [])
    .filter((extension) => requestedRuntimeIds.has(extension.id));
  const runtimeDirectoryExtensions = [];
  const runtimeFileExtensionsToCapture = [];
  for (const extension of selectedRuntimeExtensions) {
    if (!extension.sourcePath || !extension.capturable) continue;
    try {
      const info = lstatSync(extension.sourcePath);
      if (info.isDirectory()) {
        const root = realpathSync(extension.sourcePath);
        if (!seenRoots.has(root)) {
          seenRoots.add(root);
          roots.push(root);
        }
        runtimeDirectoryExtensions.push({ root, extensionId: extension.id });
      } else if (info.isFile()) {
        runtimeFileExtensionsToCapture.push({
          sourcePath: realpathSync(extension.sourcePath),
          extensionId: extension.id
        });
      }
    } catch {
      // Runtime entries may disappear after the page was rendered.
    }
  }
  const files = [];
  const state = { totalBytes: 0 };
  const targetRoots = roots.filter(
    (root) => !runtimeDirectoryExtensions.some((entry) => entry.root === root)
  );
  for (const root of targetRoots) {
    walkArtifactFiles(root, fileExtensions, files, state, root, resolvedExcludedRoots);
  }
  for (const runtimeRoot of runtimeDirectoryExtensions) {
    walkArtifactFiles(
      runtimeRoot.root,
      runtimeFileExtensions,
      files,
      state,
      runtimeRoot.root,
      resolvedExcludedRoots,
      [runtimeRoot.extensionId]
    );
  }
  const seenFiles = new Set(files.map((file) => file.sourcePath));
  for (const configuredFile of target.artifactFiles || []) {
    const resolved = resolveArtifactFile(projectPath, configuredFile);
    if (
      !resolved
      || seenFiles.has(resolved)
      || isInsideExcludedRoot(resolved, resolvedExcludedRoots)
    ) {
      continue;
    }
    seenFiles.add(resolved);
    addArtifactFile(resolved, path.dirname(resolved), fileExtensions, files, state, true);
  }
  for (const runtimeFile of runtimeFileExtensionsToCapture) {
    if (isInsideExcludedRoot(runtimeFile.sourcePath, resolvedExcludedRoots)) {
      continue;
    }
    addArtifactFile(
      runtimeFile.sourcePath,
      path.dirname(runtimeFile.sourcePath),
      runtimeFileExtensions,
      files,
      state,
      true,
      [runtimeFile.extensionId]
    );
  }

  mkdirSync(snapshotDir, { recursive: true });
  const inventory = files.map((file, index) => {
    const root = file.root;
    const rootIndex = root ? roots.indexOf(root) : -1;
    const relative = root ? path.relative(root, file.sourcePath) : path.basename(file.sourcePath);
    const snapshotRelative = path.join(`${String(index + 1).padStart(3, "0")}-${safeSegment(path.basename(root || "root"))}`, relative);
    const snapshotPath = path.join(snapshotDir, snapshotRelative);
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    const content = truncateTextBuffer(readFileSync(file.sourcePath), file.capturedBytes);
    writeFileSync(snapshotPath, content);
    return {
      artifactId: file.explicit
        ? `artifact:file:${safeSegment(path.relative(projectPath, file.sourcePath))}:${createHash("sha256").update(file.sourcePath).digest("hex").slice(0, 12)}`
        : `artifact:${rootIndex >= 0 ? rootIndex : "unknown"}:${relative.split(path.sep).join("/")}`,
      sourcePath: file.sourcePath,
      root,
      relativePath: relative,
      explicit: file.explicit,
      runtimeExtensionIds: file.runtimeExtensionIds,
      snapshotPath,
      size: file.size,
      capturedBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      truncated: file.truncated,
      modifiedAt: file.modifiedAt
    };
  });

  return {
    roots,
    snapshotRoot: snapshotDir,
    explicitFiles: inventory.filter((file) => file.explicit).map((file) => file.sourcePath),
    fileExtensions: [...fileExtensions],
    runtimeEnvironment: runtimeEnvironment
      ? {
        resolution: runtimeEnvironment.resolution,
        note: runtimeEnvironment.note,
        selectedExtensionIds: selectedRuntimeExtensions.map((extension) => extension.id),
        extensions: selectedRuntimeExtensions
      }
      : null,
    limits: {
      maxFiles: MAX_ARTIFACT_FILES,
      maxBytesPerFile: MAX_ARTIFACT_BYTES,
      maxTotalBytes: MAX_TOTAL_ARTIFACT_BYTES
    },
    totalCapturedBytes: inventory.reduce((sum, file) => sum + file.capturedBytes, 0),
    files: inventory
  };
}

function firstMessage(messages, role) {
  return messages.find((message) => String(message.role || "").toLowerCase() === role);
}

function lastMessage(messages, role) {
  return [...messages].reverse().find((message) => String(message.role || "").toLowerCase() === role);
}

function messageSummary(message) {
  if (!message) {
    return "";
  }
  const text = String(message.content || message.toolOutput || "");
  return text.length > 2000 ? `${text.slice(0, 2000)}\n[truncated]` : text;
}

function buildEvaluationSeed(provider, session, messages, targetId, rootEvidenceId) {
  const user = firstMessage(messages, "user");
  const assistant = lastMessage(messages, "assistant");
  return {
    schemaVersion: 1,
    status: "proposed",
    target: targetId,
    source: {
      provider: provider.id,
      sessionId: session.id,
      projectPath: session.directory || ""
    },
    observedTask: messageSummary(user) || session.title || session.id,
    observedOutcome: messageSummary(assistant),
    cases: [
      {
        id: "observed-session-replay",
        title: "Replay the observed session task",
        kind: "replay",
        status: "proposed",
        sourceEvidence: [rootEvidenceId || makeEvidenceId(provider.id, session.id, "session", session.id)],
        verifier: {
          status: "missing",
          note: "The analyzer should propose an executable verifier or explicit review criteria."
        }
      }
    ]
  };
}

function buildAnalysisPrompt({
  provider,
  session,
  targetId,
  runDir,
  projectPath,
  customPrompt,
  files,
  analysisToolPath,
  rawSnapshotsIncluded
}) {
  const rootEvidenceId = makeEvidenceId(provider.id, session.id, "session", session.id);
  return `# OpenSessionViewer session analysis

You are analyzing an existing ${provider.name} session as evidence for improving external agent guidance.

## Inputs

- Project: ${projectPath}
- Provider: ${provider.id}
- Session: ${session.id}
- Target: ${targetId}
- Session metadata: ${files.sessionPath}
- Session hierarchy: ${files.sessionIndexPath}
- Evidence metadata index: ${files.evidenceIndexPath}
- Immutable evidence records: ${files.evidencePath}
- Selected runtime extensions and artifact snapshots: ${files.artifactsPath}
- Evaluation seed: ${files.evaluationSeedPath}
- Read-only analysis tool: ${analysisToolPath}
${rawSnapshotsIncluded ? `- Optional raw diagnostic snapshots: ${files.messagesPath}, ${files.treePath}, ${files.containerPath}, ${files.metricsPath}, ${files.flowPath}, ${files.tracePath}` : ""}

## Evidence tools

Do not begin by reading the complete JSONL evidence file. Use the read-only
analysis tool and expand only the records needed for a conclusion. Commands
return compact Markdown with exact evidence and artifact IDs preserved:

\`\`\`text
node "${analysisToolPath}" "${runDir}" session_main_info
node "${analysisToolPath}" "${runDir}" session_query_system_prompts
node "${analysisToolPath}" "${runDir}" session_query_errors
node "${analysisToolPath}" "${runDir}" session_query_tools '{"status":"completed"}'
node "${analysisToolPath}" "${runDir}" session_find_anomalies
node "${analysisToolPath}" "${runDir}" session_query_context '{"evidenceId":"..."}'
node "${analysisToolPath}" "${runDir}" session_get_evidence '{"evidenceId":"..."}'
node "${analysisToolPath}" "${runDir}" extension_list
node "${analysisToolPath}" "${runDir}" extension_get '{"extensionId":"..."}'
node "${analysisToolPath}" "${runDir}" artifact_list
node "${analysisToolPath}" "${runDir}" artifact_get '{"artifactId":"..."}'
\`\`\`

\`session_find_anomalies\` reports explicit interruption reasons separately
from the configurable high-error-rate heuristic. Its output includes the raw
counts, minimum sample size, threshold, and ranked sessions.

## Required behavior

The analysis inputs have three distinct roles:

- Session evidence is the normalized conversation, tool results, system-prompt records, and related session data.
- Target artifacts are provider-neutral raw materials configured for this analysis target, such as docs, tests, prompts, scripts, or explicit external reference files.
- Runtime extensions are provider-resolved instructions and behavior selected for this run, such as AGENTS.md, CLAUDE.md, skills, agents, commands, plugins, hooks, and rules.

1. Treat the session as evidence, not proof that a proposed change is generally useful.
2. Inspect both the configured target artifacts and selected runtime extensions before proposing updates or new artifacts.
3. Cite concrete session messages, tool results, captured target artifacts, or captured runtime extensions for every proposal.
4. Do not modify project files or the original artifacts.
5. Generate proposals only. A proposal is not validated until executable evaluation compares a baseline with the candidate.
6. Prefer small, focused edits over comprehensive documentation.
7. Include regression and held-out cases, not only replay of the observed session.
8. Propose deterministic or execution-based verifiers whenever feasible.
9. Record token, runtime, and tool-call criteria when they matter.
10. Treat every file under ${runDir} as generated evidence or output. Never propose changes to those generated files.
11. Artifact proposals must target an existing captured artifact root, or a focused new artifact inside one of those roots.
12. Do not propose generic project documentation, scripts, or guidance unless that artifact type is explicitly included by the selected target.
13. Combine overlapping proposals for the same artifact into one bounded proposal.
14. Contrast successful and failed tool outcomes before diagnosing missing guidance.
15. In every \`sourceEvidence\` or \`evidence\` array, use only exact, unmodified \`ev:...\` IDs from \`evidence-index.json\` or exact \`artifact:...\` IDs from \`artifacts.json\`.
16. Treat anomaly flags as retrieval signals. Re-check their underlying evidence before drawing a conclusion.
17. Include baseline-versus-candidate expectations and track task success, token cost, and runtime where measurable.
18. Never append descriptions, parentheses, quotes, line numbers, or filesystem paths to an evidence ID. Never invent an ID. A valid array item is the ID string by itself.
19. Held-out and regression cases may describe new tasks, but their \`sourceEvidence\` must still contain exact IDs captured in this run. Use \`${rootEvidenceId}\` when only session-level evidence applies.

## Required outputs

Write these files inside the categorized output directory:

### ${files.reportPath}

Include:

- Session outcome and evidence
- What worked
- Friction, failures, and missing guidance
- Existing artifacts reviewed
- Proposed updates
- Proposed new artifacts
- Risks, staleness, and possible overfitting
- Validation strategy

### ${files.evaluationPath}

Write valid JSON with this shape:

\`\`\`json
{
  "schemaVersion": 1,
  "status": "proposed",
  "target": "${targetId}",
  "sourceSessionId": "${session.id}",
  "cases": [
    {
      "id": "stable-id",
      "title": "Short title",
      "kind": "replay|held-out|regression",
      "status": "proposed",
      "task": "Task presented to the agent",
      "setup": ["Reproducible setup steps"],
      "sourceEvidence": ["${rootEvidenceId}"],
      "expectedOutcome": ["Observable acceptance criteria"],
      "comparison": {
        "baseline": "Expected behavior with the captured artifact",
        "candidate": "Expected behavior with the proposed artifact",
        "acceptance": ["Candidate passes without regressing the baseline"]
      },
      "verifier": {
        "kind": "command|assertions|human-review",
        "command": "Optional deterministic verification command",
        "assertions": ["Optional assertions"]
      },
      "metrics": {
        "taskSuccess": true,
        "maxTokenIncreasePercent": null,
        "maxRuntimeIncreasePercent": null
      }
    }
  ]
}
\`\`\`

### ${files.proposalsPath}

Write valid JSON with this shape:

\`\`\`json
{
  "schemaVersion": 1,
  "status": "proposed",
  "target": "${targetId}",
  "sourceSessionId": "${session.id}",
  "proposals": [
    {
      "id": "stable-id",
      "action": "create|replace|delete",
      "artifactRoot": "An exact root path from artifacts.json",
      "artifactPath": "A path relative to artifactRoot",
      "description": "The bounded proposed change",
      "evidence": ["${rootEvidenceId}"],
      "expectedBenefit": "Observable benefit",
      "risks": ["Overfitting, staleness, or regression risks"],
      "validationCaseIds": ["IDs from evaluation-proposals.json"]
    }
  ]
}
\`\`\`

For the \`${targetId}\` target, do not use paths under ${runDir} as
\`artifactRoot\` or \`artifactPath\`. If no captured artifact should change,
return an empty \`proposals\` array and explain why in \`report.md\`.

Before finishing, verify all of the following:

- Every \`sourceEvidence\` and \`evidence\` item is an exact ID copied from this run's indexes, with no annotation.
- No evidence array contains a filesystem path or free-form observation.
- Every evaluation case has at least one valid evidence ID.
- Evaluation cases include exactly supported kinds and collectively cover replay, held-out, and regression.
- Every proposal references declared evaluation case IDs and an exact captured artifact root.

${customPrompt ? `## Additional configured instructions\n\n${customPrompt}\n` : ""}`;
}

export function buildAnalysisPromptPreview({
  provider,
  analysisConfig,
  configPath = "",
  targetId = ""
}) {
  const settings = resolveAnalysisSettings(provider, analysisConfig, targetId);
  if (!settings) {
    throw new Error("Session analysis is not configured for this provider and target");
  }

  const providerConfig = analysisConfig.providers?.[provider.id] || {};
  const configuredTarget = analysisConfig.targets?.[settings.targetId];
  const providerTarget = providerConfig.targets?.[settings.targetId];
  const hasPrompt = (value) => Boolean(
    value
    && typeof value === "object"
    && Object.prototype.hasOwnProperty.call(value, "prompt")
  );
  const targetInstructionSource = hasPrompt(providerTarget)
    ? "provider"
    : hasPrompt(configuredTarget)
      ? "configured"
      : getBuiltinAnalysisTarget(settings.targetId)
        ? "built-in"
        : "default";
  const promptFile = inspectPromptFile(settings.target.promptFile, configPath);
  const configuredPrompt = [
    settings.target.prompt,
    promptFile.content
  ].filter(Boolean).join("\n\n");
  const runDir = "<analysis-run-directory>";
  const previewFiles = getAnalysisRunPaths(runDir);
  const prompt = buildAnalysisPrompt({
    provider,
    session: { id: "session-preview" },
    targetId: settings.targetId,
    runDir,
    projectPath: "<session-project-directory>",
    customPrompt: configuredPrompt,
    files: previewFiles,
    analysisToolPath: previewFiles.analysisToolPath,
    rawSnapshotsIncluded: analysisConfig.includeRawSnapshots === true
      || settings.target.includeRawSnapshots === true
  });

  return {
    target: settings.targetId,
    targetLabel: String(settings.target.label || settings.targetId),
    targetInstructions: String(settings.target.prompt || ""),
    targetInstructionSource,
    promptFile: {
      configuredPath: promptFile.configuredPath,
      resolvedPath: promptFile.resolvedPath,
      available: promptFile.available,
      error: promptFile.error
    },
    usesPlaceholders: true,
    prompt
  };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function getAnalysisOutputRoot(directory, analysisConfig, metaDir) {
  const projectPath = resolveProjectDirectory(directory);
  if (!projectPath) {
    return null;
  }
  const configuredOutput = analysisConfig?.outputDir;
  return configuredOutput
    ? path.isAbsolute(configuredOutput)
      ? path.resolve(configuredOutput)
      : path.resolve(projectPath, configuredOutput)
    : path.join(projectPath, ".opensessionviewer", "analysis");
}

export function listSessionAnalysisRuns({
  providerId,
  sessionId,
  directory,
  analysisConfig,
  metaDir,
  limit = 10
}) {
  const outputRoot = getAnalysisOutputRoot(directory, analysisConfig, metaDir);
  if (!outputRoot) {
    return [];
  }

  const runs = [];
  const outputRoots = [outputRoot];
  if (!analysisConfig?.outputDir && metaDir) {
    const legacyOutputRoot = path.join(metaDir, "analysis");
    if (path.resolve(legacyOutputRoot) !== path.resolve(outputRoot)) {
      outputRoots.push(legacyOutputRoot);
    }
  }

  for (const currentOutputRoot of outputRoots) {
    if (!existsSync(currentOutputRoot)) {
      continue;
    }
    let entries = [];
    try {
      entries = readdirSync(currentOutputRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const runDir = path.join(currentOutputRoot, entry.name);
      const manifestPath = path.join(runDir, "manifest.json");
      try {
        const manifestStat = lstatSync(manifestPath);
        if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1024 * 1024) {
          continue;
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (manifest?.provider !== providerId || manifest?.sessionId !== sessionId) {
          continue;
        }
        const validation = manifest.validation && typeof manifest.validation === "object"
          ? manifest.validation
          : null;
        const outputAvailable = (filePath) => {
          try {
            const info = lstatSync(filePath);
            return info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024;
          } catch {
            return false;
          }
        };
        const reportPath = resolveAnalysisRunPath(runDir, manifest, "reportPath");
        const evaluationPath = resolveAnalysisRunPath(runDir, manifest, "evaluationPath");
        const proposalsPath = resolveAnalysisRunPath(runDir, manifest, "proposalsPath");
        const outputs = {
          report: {
            fileName: "report.md",
            relativePath: analysisRunRelativePath(runDir, reportPath),
            available: outputAvailable(reportPath)
          },
          evaluation: {
            fileName: "evaluation-proposals.json",
            relativePath: analysisRunRelativePath(runDir, evaluationPath),
            available: outputAvailable(evaluationPath)
          },
          proposals: {
            fileName: "artifact-proposals.json",
            relativePath: analysisRunRelativePath(runDir, proposalsPath),
            available: outputAvailable(proposalsPath)
          }
        };
        runs.push({
          runId: String(manifest.runId || entry.name),
          state: String(manifest.state || "unknown"),
          active: manifest.state === "prepared" || manifest.state === "launched",
          target: String(manifest.target || ""),
          createdAt: manifest.createdAt || null,
          launchedAt: manifest.launchedAt || null,
          completedAt: manifest.completedAt || null,
          runDir,
          hasReport: outputs.report.available,
          outputs,
          validation: validation
            ? {
              ok: Boolean(validation.ok),
              checkedAt: validation.checkedAt || null,
              processExitCode: Number(validation.processExitCode) || 0,
              errors: Array.isArray(validation.errors)
                ? validation.errors.slice(0, 20).map((error) => String(error))
                : [],
              evaluationCaseCount: Number(validation.evaluationCaseCount) || 0,
              artifactProposalCount: Number(validation.artifactProposalCount) || 0
            }
            : null
        });
      } catch {
        // Ignore incomplete or malformed run directories.
      }
    }
  }

  return runs
    .sort((a, b) => String(b.createdAt || b.runId).localeCompare(String(a.createdAt || a.runId)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
}

function hashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function replaceCommandValue(value, replacements) {
  let result = value;
  for (const [name, replacement] of Object.entries(replacements)) {
    result = result.replaceAll(`{${name}}`, String(replacement));
  }
  return result;
}

export function prepareSessionAnalysis({
  provider,
  sessionId,
  analysisConfig,
  metaDir,
  configPath = "",
  targetId = "",
  runtimeExtensionIds = null
}) {
  const settings = resolveAnalysisSettings(provider, analysisConfig, targetId);
  if (!settings) {
    throw new Error("Session analysis is not configured for this provider and target");
  }
  const session = provider.getSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  const projectPath = resolveProjectDirectory(session.directory);
  if (!projectPath) {
    throw new Error("Session has no valid project directory");
  }

  const outputRoot = getAnalysisOutputRoot(session.directory, analysisConfig, metaDir);
  mkdirSync(outputRoot, { recursive: true });
  const runId = `${timestampSegment()}-${safeSegment(provider.id)}-${safeSegment(sessionId)}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(outputRoot, runId);
  mkdirSync(runDir, { recursive: false });

  const messages = provider.getMessages(sessionId);
  const includeRawSnapshots = analysisConfig.includeRawSnapshots === true
    || settings.target.includeRawSnapshots === true;
  const files = getAnalysisRunPaths(runDir);
  ensureAnalysisRunDirectories(files, includeRawSnapshots);
  const runtimeEnvironment = resolveRuntimeEnvironment(provider, sessionId);
  const availableRuntimeIds = new Set(
    (runtimeEnvironment?.extensions || [])
      .filter((extension) => extension.available)
      .map((extension) => extension.id)
  );
  const selectedRuntimeIds = runtimeExtensionIds === null
    ? (runtimeEnvironment?.extensions || [])
      .filter((extension) => extension.defaultSelected && extension.available)
      .map((extension) => extension.id)
    : [...new Set(
      (Array.isArray(runtimeExtensionIds) ? runtimeExtensionIds : [])
        .filter((extensionId) => typeof extensionId === "string" && availableRuntimeIds.has(extensionId))
    )];
  const artifacts = snapshotArtifacts(
    projectPath,
    files.artifactSnapshotsDir,
    settings.target,
    runtimeEnvironment,
    selectedRuntimeIds,
    [outputRoot]
  );

  const evidence = writeAnalysisEvidence({
    provider,
    session,
    sessionId,
    messages,
    runDir,
    files
  });
  const evaluationSeed = buildEvaluationSeed(
    provider,
    session,
    messages,
    settings.targetId,
    evidence.rootEvidenceId
  );
  const configuredPrompt = [
    settings.target.prompt,
    readPromptFile(settings.target.promptFile, configPath)
  ].filter(Boolean).join("\n\n");
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  copyFileSync(path.join(runtimeDir, "analysis-tools.js"), files.analysisToolPath);
  copyFileSync(path.join(runtimeDir, "analysis-layout.js"), files.analysisLayoutPath);
  writeJson(files.analysisToolPackagePath, {
    private: true,
    type: "module"
  });
  const analysisToolPath = files.analysisToolPath;
  const prompt = buildAnalysisPrompt({
    provider,
    session,
    targetId: settings.targetId,
    runDir,
    projectPath,
    customPrompt: configuredPrompt,
    files,
    analysisToolPath,
    rawSnapshotsIncluded: includeRawSnapshots
  });

  writeJson(files.sessionPath, session);
  if (includeRawSnapshots) {
    writeJson(files.messagesPath, messages);
    writeJson(files.treePath, provider.getSessionTree?.(sessionId) || null);
    writeJson(files.containerPath, provider.getSessionContainer?.(sessionId) || null);
    writeJson(files.metricsPath, provider.getSessionMetrics?.(sessionId) || null);
    writeJson(files.flowPath, provider.getSessionFlow?.(sessionId) || null);
    writeJson(files.tracePath, provider.getTrace?.(sessionId) || null);
  }
  writeJson(files.artifactsPath, artifacts);
  writeJson(files.evaluationSeedPath, evaluationSeed);
  writeFileSync(files.promptPath, prompt, "utf-8");
  const integrity = {
    algorithm: "sha256",
    context: {
      runId,
      provider: provider.id,
      sessionId,
      target: settings.targetId,
      runDir
    },
    files: Object.fromEntries(
      [
        files.sessionPath,
        files.sessionIndexPath,
        files.evidenceIndexPath,
        files.evidencePath,
        files.artifactsPath,
        files.analysisToolPath,
        files.analysisLayoutPath,
        files.analysisToolPackagePath,
        files.evaluationSeedPath,
        files.promptPath,
        ...(includeRawSnapshots
          ? [
            files.messagesPath,
            files.treePath,
            files.containerPath,
            files.metricsPath,
            files.flowPath,
            files.tracePath
          ]
          : [])
      ]
        .filter((filePath) => existsSync(filePath))
        .map((filePath) => [analysisRunRelativePath(runDir, filePath), hashFile(filePath)])
    )
  };

  const replacements = {
    sessionId,
    projectPath,
    target: settings.targetId,
    runId,
    runDir,
    bundlePath: files.sessionPath,
    sessionPath: files.sessionPath,
    sessionIndexPath: files.sessionIndexPath,
    evidenceIndexPath: files.evidenceIndexPath,
    evidencePath: files.evidencePath,
    messagesPath: files.messagesPath,
    promptPath: files.promptPath,
    prompt,
    analysisToolPath,
    reportPath: files.reportPath,
    evaluationSeedPath: files.evaluationSeedPath,
    evaluationPath: files.evaluationPath,
    proposalsPath: files.proposalsPath,
    artifactsPath: files.artifactsPath
  };
  const cwd = resolveProjectDirectory(settings.command.cwd
    ? replaceCommandValue(settings.command.cwd, replacements)
    : projectPath);
  if (!cwd) {
    throw new Error("Configured analysis working directory is invalid");
  }
  const resolvedExecutable = resolveExecutable(settings.command.executable);
  const command = {
    executable: settings.command.executable,
    resolvedExecutable,
    args: settings.command.args.map((arg) => replaceCommandValue(arg, replacements)),
    cwd,
    stdinPath: settings.command.stdin === "prompt" ? files.promptPath : null
  };
  const manifest = {
    schemaVersion: 1,
    runId,
    state: "prepared",
    createdAt: new Date().toISOString(),
    provider: provider.id,
    sessionId,
    target: settings.targetId,
    projectPath,
    runDir,
    layoutVersion: 1,
    rawSnapshotsIncluded: includeRawSnapshots,
    integrity,
    command: {
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      stdin: command.stdinPath ? "prompt" : null
    },
    files
  };
  writeJson(files.manifestPath, manifest);

  return {
    runId,
    runDir,
    session,
    target: settings.targetId,
    label: settings.target.label ? String(settings.target.label) : null,
    shell: settings.shell,
    command,
    files,
    manifest,
    integrity
  };
}

export function buildPowerShellAnalysisArgs(powershell, shellArgs = ["-NoExit", "-NoLogo"]) {
  const script = [
    "$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENSESSIONVIEWER_ANALYSIS_SPEC))",
    "$spec=$json|ConvertFrom-Json",
    "Set-Location -LiteralPath $spec.cwd",
    "$agentExitCode=0",
    "try{if($spec.stdinPath){$inputText=[IO.File]::ReadAllText($spec.stdinPath);$inputText|& $spec.executable @($spec.args)}else{& $spec.executable @($spec.args)};$agentExitCode=$LASTEXITCODE}catch{Write-Error $_;$agentExitCode=1}",
    "& $spec.nodeExecutable $spec.validatorPath $spec.runDir ([string]$agentExitCode) $spec.integrityBase64",
    "if($agentExitCode -ne 0){Write-Host \"Analysis command exited with code $agentExitCode\" -ForegroundColor Red}"
  ].join(";");
  return [
    powershell,
    ...shellArgs,
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ];
}

export function launchSessionAnalysis(run, fallbackShell = null) {
  if (process.platform !== "win32") {
    throw new Error("Terminal launching is currently supported on Windows only");
  }
  if (!run?.command?.resolvedExecutable || !run?.command?.cwd) {
    throw new Error("Analysis command is not available");
  }

  const terminal = resolveExecutable("wt.exe");
  const configuredShell = run.shell || fallbackShell;
  const shellSpec = isShellSpec(configuredShell) ? configuredShell : null;
  const powershell = shellSpec
    ? resolveExecutable(shellSpec.executable)
    : resolveExecutable("pwsh.exe") || resolveExecutable("powershell.exe");
  if (!terminal || !powershell) {
    throw new Error("Windows Terminal and PowerShell are required");
  }
  const shellArgs = shellSpec?.args || ["-NoExit", "-NoLogo"];
  const payload = Buffer.from(JSON.stringify({
    executable: run.command.resolvedExecutable,
    args: run.command.args,
    cwd: run.command.cwd,
    stdinPath: run.command.stdinPath,
    runDir: run.runDir,
    integrityBase64: Buffer.from(JSON.stringify(run.integrity), "utf-8").toString("base64"),
    nodeExecutable: process.execPath,
    validatorPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "analysis-validator.js")
  }), "utf-8").toString("base64");
  const child = spawn(terminal, [
    "-d", run.command.cwd,
    ...buildPowerShellAnalysisArgs(powershell, shellArgs)
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OPENSESSIONVIEWER_ANALYSIS_SPEC: payload }
  });
  child.unref();

  const launched = {
    ...run.manifest,
    state: "launched",
    launchedAt: new Date().toISOString()
  };
  writeJson(run.files.manifestPath, launched);
}
