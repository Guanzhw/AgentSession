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
import { buildAnalysisAccessManifest } from "./analysis-access.js";
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
const PROJECT_ANALYSIS_DIR_NAME = ".codeagentsession";
const LEGACY_PROJECT_ANALYSIS_DIR_NAME = ".opensessionviewer";
const PROJECT_ANALYSIS_GITIGNORE = "*\n!.gitignore\n";
export const SESSION_ANALYSIS_PROVIDER_ID = "opencode";
export const OPENCODE_ANALYSIS_COMMAND = {
  executable: "opencode",
  args: [
    "run",
    "Read the attached analysis request and write the requested proposal files.",
    "--model", "deepseek/deepseek-v4-flash",
    "--dir", "{projectPath}",
    "--file", "{promptPath}"
  ]
};
export const OPENCODE_IMPLEMENTATION_COMMAND = {
  executable: "opencode",
  args: [
    "run",
    "Read the attached implementation request and implement the accepted proposals.",
    "--model", "deepseek/deepseek-v4-flash",
    "--dir", "{projectPath}",
    "--file", "{implementationPromptPath}"
  ]
};

function supportsSessionAnalysis(provider: ProviderAdapter) {
  return provider?.id === SESSION_ANALYSIS_PROVIDER_ID;
}

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
  if (!supportsSessionAnalysis(provider) || !analysisConfig || analysisConfig.enabled !== true || providerConfig === false) {
    return [];
  }
  const providerSettings = providerConfig && typeof providerConfig === "object" ? providerConfig : {};
  return [...new Set([
    ...Object.keys(BUILTIN_ANALYSIS_TARGETS),
    ...Object.keys(analysisConfig.targets || {}),
    ...Object.keys(providerSettings.targets || {}),
    ...configuredDefaultTargetIds(provider, analysisConfig)
  ])].filter((targetId) => resolveAnalysisSettings(provider, analysisConfig, targetId));
}

export function getDefaultAnalysisTargetIds(provider: ProviderAdapter, analysisConfig): string[] {
  const configured = configuredDefaultTargetIds(provider, analysisConfig)
    .filter((targetId) => resolveAnalysisSettings(provider, analysisConfig, targetId));
  if (configured.length) {
    return configured.slice(0, 1);
  }
  return getAnalysisTargetIds(provider, analysisConfig).slice(0, 1);
}

export function resolveAnalysisSettings(provider: ProviderAdapter, analysisConfig, targetId = "") {
  if (!supportsSessionAnalysis(provider) || !analysisConfig || analysisConfig.enabled !== true) {
    return null;
  }

  const providerConfig = analysisConfig.providers?.[provider.id];
  if (providerConfig === false) {
    return null;
  }
  const providerSettings = providerConfig && typeof providerConfig === "object" ? providerConfig : {};

  const selectedTarget = targetId || configuredDefaultTargetIds(provider, analysisConfig)[0] || "skills";
  const configuredTarget = analysisConfig.targets?.[selectedTarget];
  const providerTarget = providerSettings.targets?.[selectedTarget];
  if (configuredTarget === false || providerTarget === false) {
    return null;
  }
  const target = getProviderAnalysisTarget(analysisConfig, provider.id, selectedTarget);
  const command = providerTarget?.command || providerSettings.command || target.command || OPENCODE_ANALYSIS_COMMAND;
  if (!isCommandSpec(command)) {
    return null;
  }

  const shell = providerTarget?.shell
    || providerSettings.shell
    || analysisConfig.shell
    || null;
  return {
    targetId: selectedTarget,
    target,
    command,
    shell: isShellSpec(shell) ? shell : null
  };
}

function objectOrNull(value) {
  return value && typeof value === "object" ? value : null;
}

export function resolveAnalysisImplementationSettings(providerOrId, analysisConfig) {
  const providerId = typeof providerOrId === "string" ? providerOrId : providerOrId?.id;
  if (providerId !== SESSION_ANALYSIS_PROVIDER_ID || !analysisConfig || analysisConfig.enabled !== true) {
    return null;
  }
  const providerConfig = analysisConfig.providers?.[providerId];
  if (providerConfig === false) {
    return null;
  }
  const providerSettings = objectOrNull(providerConfig) || {};
  const sharedImplementation = objectOrNull(analysisConfig.implementation);
  const providerImplementation = objectOrNull(providerSettings.implementation);
  const command = providerImplementation?.command
    || sharedImplementation?.command
    || OPENCODE_IMPLEMENTATION_COMMAND;
  if (!isCommandSpec(command)) {
    return null;
  }
  const shell = providerImplementation?.shell
    || sharedImplementation?.shell
    || providerSettings.shell
    || analysisConfig.shell
    || null;
  return {
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
  const selectedTarget = targetId || getDefaultAnalysisTargetIds(provider, analysisConfig)[0] || "skills";
  const effectiveTarget = targets.find((target) => target.id === selectedTarget && target.available)
    || targets.find((target) => target.available);
  if (!targets.length || !effectiveTarget) {
    return null;
  }
  const runtimeEnvironment = resolveRuntimeEnvironment(provider, sessionId);
  const runtimeExtensions = (runtimeEnvironment?.extensions || []).map((extension) => ({
    id: extension.id,
    provider: extension.provider,
    scope: extension.scope,
    kind: extension.kind,
    name: extension.name,
    source: extension.source,
    sourcePath: extension.sourcePath,
    sourceType: extension.sourceType,
    available: extension.available,
    capturable: extension.capturable,
    defaultSelected: extension.defaultSelected,
    note: extension.note
  }));
  return {
    target: effectiveTarget.id,
    targets,
    selectedTargets: [effectiveTarget.id],
    label: effectiveTarget.label,
    available: true,
    sessionId,
    projectPath,
    runtimeEnvironment: runtimeEnvironment
      ? {
        resolution: runtimeEnvironment.resolution,
        note: runtimeEnvironment.note,
        selectedExtensionIds: runtimeExtensions
          .filter((extension) => extension.defaultSelected && extension.available)
          .map((extension) => extension.id),
        extensions: runtimeExtensions
      }
      : null
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
  excludedRoots = [],
  selectedRuntimeExtensionIds = null
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
  const selectedRuntimeExtensionSet = Array.isArray(selectedRuntimeExtensionIds)
    ? new Set(selectedRuntimeExtensionIds.filter((id) => typeof id === "string" && id.trim()))
    : null;
  const selectedRuntimeExtensions = (runtimeEnvironment?.extensions || [])
    .filter((extension) => (
      extension.available
      && (selectedRuntimeExtensionSet
        ? selectedRuntimeExtensionSet.has(extension.id)
        : extension.defaultSelected)
    ));
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
- Analysis access manifest: ${files.accessManifestPath}
- Selected runtime extensions and artifact snapshots: ${files.artifactsPath}
- Evaluation seed: ${files.evaluationSeedPath}
- Optional read-only analysis access tool: ${files.analysisToolPath}
${rawSnapshotsIncluded ? `- Optional raw diagnostic snapshots: ${files.messagesPath}, ${files.treePath}, ${files.containerPath}, ${files.metricsPath}, ${files.flowPath}, ${files.tracePath}` : ""}

## Analysis access interfaces

Do not begin by reading the complete session or JSONL evidence files. Start
with \`${files.accessManifestPath}\`, then read the bounded backing store files
it names. The manifest describes three provider-neutral interfaces: session
data access, artifact snapshot access, and runtime extension access. Prefer
direct file reads of \`${files.sessionIndexPath}\`, \`${files.evidenceIndexPath}\`,
\`${files.artifactsPath}\`, and selected records from \`${files.evidencePath}\`.

The bundled access tool is optional convenience only. Do not spend the run
debugging shell command execution, Node.js PATH issues, PowerShell encoding, or
stdout capture. If command execution is unavailable or produces no output, keep
going with direct file reads. The backing stores preserve the exact evidence
and artifact IDs required for citations.

Use \`${files.evidenceIndexPath}\` to find specific \`ev:...\` IDs before
opening \`${files.evidencePath}\`. Read raw evidence records only when a
specific evidence ID needs detail beyond the index preview.

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
20. The validator treats \`metrics.taskSuccess\` as a required acceptance threshold. Set it to the literal JSON value \`true\` for every evaluation case, not \`null\` or \`false\`.
21. Use only supported artifact proposal actions: \`create\`, \`edit\`, \`replace\`, or \`delete\`. Use \`edit\` or \`replace\` for bounded changes to existing artifacts.
22. Do not cite raw session IDs or shortened evidence prefixes. If a related session is relevant, first retrieve an exact full \`ev:...\` ID from an access tool result or \`evidence-index.json\`. If you only know a prefix, cite \`${rootEvidenceId}\` instead.
23. The validator rejects duplicate proposal targets. If several ideas target the same \`artifactRoot\` plus \`artifactPath\`, merge them into one proposal with a combined description, evidence list, risk list, and validation case list.

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
      "action": "create|edit|replace|delete",
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
- No \`sourceEvidence\` or \`evidence\` item is a shortened \`ev:...\` prefix or raw \`ses_...\` ID.
- No evidence array contains a filesystem path or free-form observation.
- Every evaluation case has at least one valid evidence ID.
- Evaluation cases include exactly supported kinds and collectively cover replay, held-out, and regression.
- Every evaluation case has \`metrics.taskSuccess\` set to \`true\`.
- Every artifact proposal action is one of \`create\`, \`edit\`, \`replace\`, or \`delete\`.
- No two artifact proposals use the same \`artifactRoot\` plus \`artifactPath\`.
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

function getProjectAnalysisOutputRoot(projectPath) {
  return path.join(projectPath, PROJECT_ANALYSIS_DIR_NAME, "analysis");
}

function getLegacyProjectAnalysisOutputRoot(projectPath) {
  return path.join(projectPath, LEGACY_PROJECT_ANALYSIS_DIR_NAME, "analysis");
}

function ensureProjectAnalysisGitignore(outputRoot, projectPath) {
  const projectRoot = path.resolve(projectPath);
  const resolvedOutputRoot = path.resolve(outputRoot);
  for (const directoryName of [PROJECT_ANALYSIS_DIR_NAME, LEGACY_PROJECT_ANALYSIS_DIR_NAME]) {
    const directory = path.join(projectRoot, directoryName);
    const analysisRoot = path.join(directory, "analysis");
    if (resolvedOutputRoot !== path.resolve(analysisRoot)) {
      continue;
    }
    mkdirSync(directory, { recursive: true });
    const gitignorePath = path.join(directory, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, PROJECT_ANALYSIS_GITIGNORE, "utf-8");
    }
    return;
  }
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
    : getProjectAnalysisOutputRoot(projectPath);
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
  if (!analysisConfig?.outputDir) {
    const projectPath = resolveProjectDirectory(directory);
    if (projectPath) {
      const legacyProjectOutputRoot = getLegacyProjectAnalysisOutputRoot(projectPath);
      if (path.resolve(legacyProjectOutputRoot) !== path.resolve(outputRoot)) {
        outputRoots.push(legacyProjectOutputRoot);
      }
    }
    if (metaDir) {
      const legacyMetaOutputRoot = path.join(metaDir, "analysis");
      if (!outputRoots.some((root) => path.resolve(root) === path.resolve(legacyMetaOutputRoot))) {
        outputRoots.push(legacyMetaOutputRoot);
      }
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
        const launchedAtMs = manifest.launchedAt ? Date.parse(manifest.launchedAt) : NaN;
        const waitingForOutput = manifest.state === "launched"
          && !outputs.report.available
          && !outputs.evaluation.available
          && !outputs.proposals.available;
        const waitingSeconds = waitingForOutput && Number.isFinite(launchedAtMs)
          ? Math.max(0, Math.floor((Date.now() - launchedAtMs) / 1000))
          : null;
        const implementation = manifest.implementation && typeof manifest.implementation === "object"
          ? manifest.implementation
          : null;
        const implementationSettings = resolveAnalysisImplementationSettings(providerId, analysisConfig);
        const implementationState = implementation?.state ? String(implementation.state) : "";
        const implementationAvailable = Boolean(
          manifest.state === "completed"
          && validation?.ok === true
          && outputs.proposals.available
          && Number(validation.artifactProposalCount) > 0
          && implementationState !== "launched"
          && implementationSettings
          && resolveExecutable(implementationSettings.command.executable)
        );
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
          waitingForOutput,
          waitingSeconds,
          stalled: waitingForOutput && Number(waitingSeconds) >= 30,
          implementation: implementation
            ? {
              state: implementationState || "unknown",
              acceptedAt: implementation.acceptedAt || null,
              launchedAt: implementation.launchedAt || null,
              promptPath: typeof implementation.promptPath === "string"
                ? implementation.promptPath
                : null
            }
            : null,
          implementationAvailable,
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
  ensureProjectAnalysisGitignore(outputRoot, projectPath);
  const runId = `${timestampSegment()}-${safeSegment(provider.id)}-${safeSegment(sessionId)}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(outputRoot, runId);
  mkdirSync(runDir, { recursive: false });

  const messages = provider.getMessages(sessionId);
  const includeRawSnapshots = analysisConfig.includeRawSnapshots === true
    || settings.target.includeRawSnapshots === true;
  const files = getAnalysisRunPaths(runDir);
  ensureAnalysisRunDirectories(files, includeRawSnapshots);
  const runtimeEnvironment = resolveRuntimeEnvironment(provider, sessionId);
  const artifacts = snapshotArtifacts(
    projectPath,
    files.artifactSnapshotsDir,
    settings.target,
    runtimeEnvironment,
    [...new Set([
      outputRoot,
      getProjectAnalysisOutputRoot(projectPath),
      getLegacyProjectAnalysisOutputRoot(projectPath)
    ].map((root) => path.resolve(root)))],
    runtimeExtensionIds
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
  writeJson(files.accessManifestPath, buildAnalysisAccessManifest({
    providerId: provider.id,
    providerName: provider.name,
    rootSessionId: sessionId,
    runDir,
    files
  }));
  const prompt = buildAnalysisPrompt({
    provider,
    session,
    targetId: settings.targetId,
    runDir,
    projectPath,
    customPrompt: configuredPrompt,
    files,
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
        files.accessManifestPath,
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
    accessManifestPath: files.accessManifestPath,
    messagesPath: files.messagesPath,
    promptPath: files.promptPath,
    prompt,
    analysisToolPath: files.analysisToolPath,
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

function buildImplementationPrompt({
  provider,
  manifest,
  projectPath,
  files
}) {
  return `# OpenSessionViewer accepted-proposal implementation

The user has reviewed and accepted the validated artifact proposals from an
OpenSessionViewer analysis run. Implement the accepted proposal set, then verify
the result.

## Run context

- Project: ${projectPath}
- Provider: ${provider.id}
- Session: ${manifest.sessionId}
- Target: ${manifest.target || ""}
- Analysis run: ${manifest.runId}
- Analysis run directory: ${manifest.runDir || ""}

## Inputs

- Human report: ${files.reportPath}
- Evaluation plan: ${files.evaluationPath}
- Accepted artifact proposals: ${files.proposalsPath}
- Captured artifact inventory: ${files.artifactsPath}
- Original analysis request: ${files.promptPath}

## Required behavior

1. Treat the proposal file as accepted by the user, but still implement it
   narrowly and preserve unrelated local changes.
2. Inspect \`git status --short\` before editing. Do not revert or overwrite
   changes that are unrelated to the accepted proposals.
3. Implement only proposals listed in \`${files.proposalsPath}\`.
4. Do not edit provider-owned databases, transcripts, or files inside
   \`${manifest.runDir || ""}\`.
5. Prefer focused source, test, documentation, or instruction changes that map
   directly to the proposal descriptions.
6. Use \`${files.evaluationPath}\` as the verification guide. Run the relevant
   tests, type checks, or review checks available in the project.
7. Do not merge automatically. If a PR or MR can be opened after verification,
   open it for human review; otherwise leave the worktree ready for review and
   summarize the changes and verification.
8. If a proposal is unsafe, stale, impossible, or contradicted by current code,
   stop and explain that instead of forcing an edit.

## Completion report

Before finishing, report:

- Which proposal IDs were implemented.
- Which files changed.
- Which verification commands ran and their exact result.
- Any proposal IDs skipped and why.
`;
}

function readAnalysisManifest(runDir) {
  const manifestPath = path.join(runDir, "manifest.json");
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("Analysis manifest is unavailable");
  }
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

export function prepareAnalysisImplementation({
  provider,
  sessionId,
  analysisConfig,
  metaDir,
  runId
}) {
  const settings = resolveAnalysisImplementationSettings(provider, analysisConfig);
  if (!settings) {
    throw new Error("Analysis implementation is not configured");
  }
  const session = provider.getSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  const projectPath = resolveProjectDirectory(session.directory);
  if (!projectPath) {
    throw new Error("Session has no valid project directory");
  }
  const runs = listSessionAnalysisRuns({
    providerId: provider.id,
    sessionId,
    directory: session.directory,
    analysisConfig,
    metaDir,
    limit: 50
  });
  const run = runs.find((item) => item.runId === runId);
  if (!run) {
    throw new Error("Analysis run not found");
  }
  if (run.state !== "completed" || run.validation?.ok !== true) {
    throw new Error("Only completed, validated analysis runs can be implemented");
  }
  if (!run.outputs?.proposals?.available || Number(run.validation.artifactProposalCount) <= 0) {
    throw new Error("The analysis run has no validated artifact proposals to implement");
  }
  if (run.implementation?.state === "launched") {
    throw new Error("Implementation has already been launched for this analysis run");
  }

  const manifest = readAnalysisManifest(run.runDir);
  const files = {
    ...getAnalysisRunPaths(run.runDir),
    reportPath: resolveAnalysisRunPath(run.runDir, manifest, "reportPath"),
    evaluationPath: resolveAnalysisRunPath(run.runDir, manifest, "evaluationPath"),
    proposalsPath: resolveAnalysisRunPath(run.runDir, manifest, "proposalsPath"),
    artifactsPath: resolveAnalysisRunPath(run.runDir, manifest, "artifactsPath"),
    promptPath: resolveAnalysisRunPath(run.runDir, manifest, "promptPath")
  };
  mkdirSync(path.dirname(files.implementationPromptPath), { recursive: true });
  const prompt = buildImplementationPrompt({
    provider,
    manifest,
    projectPath,
    files
  });
  writeFileSync(files.implementationPromptPath, prompt, "utf-8");

  const replacements = {
    sessionId,
    projectPath,
    target: manifest.target || "",
    runId: manifest.runId || runId,
    runDir: run.runDir,
    reportPath: files.reportPath,
    evaluationPath: files.evaluationPath,
    proposalsPath: files.proposalsPath,
    artifactsPath: files.artifactsPath,
    analysisPromptPath: files.promptPath,
    implementationPromptPath: files.implementationPromptPath,
    promptPath: files.implementationPromptPath,
    prompt
  };
  const cwd = resolveProjectDirectory(settings.command.cwd
    ? replaceCommandValue(settings.command.cwd, replacements)
    : projectPath);
  if (!cwd) {
    throw new Error("Configured implementation working directory is invalid");
  }
  const resolvedExecutable = resolveExecutable(settings.command.executable);
  if (!resolvedExecutable) {
    throw new Error("Configured implementation executable was not found");
  }
  const command = {
    executable: settings.command.executable,
    resolvedExecutable,
    args: settings.command.args.map((arg) => replaceCommandValue(arg, replacements)),
    cwd,
    stdinPath: settings.command.stdin === "prompt" ? files.implementationPromptPath : null
  };
  const nextManifest = {
    ...manifest,
    files: {
      ...(manifest.files || {}),
      implementationPromptPath: files.implementationPromptPath
    },
    implementation: {
      schemaVersion: 1,
      state: "prepared",
      acceptedAt: new Date().toISOString(),
      acceptedBy: "user-action",
      promptPath: analysisRunRelativePath(run.runDir, files.implementationPromptPath),
      proposalsPath: analysisRunRelativePath(run.runDir, files.proposalsPath),
      command: {
        executable: command.executable,
        args: command.args,
        cwd: command.cwd,
        stdin: command.stdinPath ? "prompt" : null
      }
    }
  };
  writeJson(files.manifestPath, nextManifest);

  return {
    runId: String(manifest.runId || runId),
    runDir: run.runDir,
    shell: settings.shell,
    command,
    files,
    manifest: nextManifest
  };
}

export function buildPowerShellAnalysisArgs(powershell, shellArgs = ["-NoExit", "-NoLogo"]) {
  const script = [
    "$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENSESSIONVIEWER_ANALYSIS_SPEC))",
    "$spec=$json|ConvertFrom-Json",
    "Set-Location -LiteralPath $spec.cwd",
    "$diagnosticsDir=Split-Path -LiteralPath $spec.stdoutPath -Parent",
    "if($diagnosticsDir){New-Item -ItemType Directory -Force -LiteralPath $diagnosticsDir|Out-Null}",
    "$agentExitCode=0;$timedOut=$false",
    "$timeoutSeconds=1800;if($null -ne $spec.agentTimeoutSeconds){$timeoutSeconds=[int]$spec.agentTimeoutSeconds};if($timeoutSeconds -le 0){$timeoutSeconds=1800}",
    "try{$startInfo=@{FilePath=$spec.executable;ArgumentList=@($spec.args);WorkingDirectory=$spec.cwd;PassThru=$true;RedirectStandardOutput=$spec.stdoutPath;RedirectStandardError=$spec.stderrPath};if($spec.stdinPath){$startInfo['RedirectStandardInput']=$spec.stdinPath};$agentProcess=Start-Process @startInfo;$waitMs=$timeoutSeconds*1000;if(-not $agentProcess.WaitForExit($waitMs)){try{$agentProcess.Kill($true)}catch{try{$agentProcess.Kill()}catch{}};$timedOut=$true;$agentExitCode=124}else{$agentExitCode=[int]$agentProcess.ExitCode}}catch{Add-Content -LiteralPath $spec.stderrPath -Value ([string]$_);$agentExitCode=1}",
    "if($timedOut){Add-Content -LiteralPath $spec.stderrPath -Value \"Analysis command timed out after $timeoutSeconds seconds\"}",
    "$waitSeconds=600;if($null -ne $spec.outputWaitSeconds){$waitSeconds=[int]$spec.outputWaitSeconds}",
    "$expectedOutputs=@($spec.reportPath,$spec.evaluationPath,$spec.proposalsPath)",
    "$processNeedles=@($spec.runDir,$spec.promptPath)|Where-Object{![string]::IsNullOrWhiteSpace([string]$_)}",
    "if($agentExitCode -eq 0 -and $processNeedles.Count -gt 0){$deadline=(Get-Date).AddSeconds($waitSeconds);do{$active=@(Get-CimInstance Win32_Process|Where-Object{$processInfo=$_;$processInfo.ProcessId -ne $PID -and $processInfo.CommandLine -and @(($processNeedles|Where-Object{$processInfo.CommandLine.Contains([string]$_)})).Count -gt 0});if($active.Count -eq 0){break};Start-Sleep -Milliseconds 1000}while((Get-Date) -lt $deadline)}",
    "$stderrHasContent=(Test-Path -LiteralPath $spec.stderrPath) -and ((Get-Item -LiteralPath $spec.stderrPath).Length -gt 0)",
    "$missingOutputCount=@($expectedOutputs|Where-Object{[string]::IsNullOrWhiteSpace([string]$_)-or -not [IO.File]::Exists([string]$_)}).Count",
    "if($agentExitCode -eq 0 -and $stderrHasContent -and $missingOutputCount -eq $expectedOutputs.Count){$waitSeconds=[Math]::Min($waitSeconds,15)}",
    "if($agentExitCode -eq 0){$deadline=(Get-Date).AddSeconds($waitSeconds);$lastSignature='';$stableCount=0;do{$ready=$true;$parts=@();foreach($outputPath in $expectedOutputs){if([string]::IsNullOrWhiteSpace([string]$outputPath)-or -not [IO.File]::Exists([string]$outputPath)){$ready=$false;break};$item=Get-Item -LiteralPath ([string]$outputPath) -ErrorAction SilentlyContinue;if($null -eq $item -or $item.Length -le 0){$ready=$false;break};$parts+=\"$($item.FullName)|$($item.Length)|$($item.LastWriteTimeUtc.Ticks)\"};if($ready){$signature=($parts -join '|');if($signature -eq $lastSignature){$stableCount++}else{$lastSignature=$signature;$stableCount=1};if($stableCount -ge 2){break}}else{$lastSignature='';$stableCount=0};Start-Sleep -Milliseconds 1000}while((Get-Date) -lt $deadline)}",
    "$missingOutputCount=@($expectedOutputs|Where-Object{[string]::IsNullOrWhiteSpace([string]$_)-or -not [IO.File]::Exists([string]$_)}).Count",
    "if($agentExitCode -eq 0 -and $stderrHasContent -and $missingOutputCount -gt 0){$agentExitCode=1}",
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

export function buildPowerShellImplementationArgs(powershell, shellArgs = ["-NoExit", "-NoLogo"]) {
  const script = [
    "$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENSESSIONVIEWER_IMPLEMENTATION_SPEC))",
    "$spec=$json|ConvertFrom-Json",
    "Set-Location -LiteralPath $spec.cwd",
    "$agentExitCode=0",
    "try{if($spec.stdinPath){$inputText=[IO.File]::ReadAllText($spec.stdinPath);$inputText|& $spec.executable @($spec.args)}else{& $spec.executable @($spec.args)};$lastExitCode=$LASTEXITCODE;if($null -eq $lastExitCode){$agentExitCode=0}else{$agentExitCode=[int]$lastExitCode}}catch{Write-Error $_;$agentExitCode=1}",
    "if($agentExitCode -ne 0){Write-Host \"Implementation command exited with code $agentExitCode\" -ForegroundColor Red}else{Write-Host \"Implementation command completed\" -ForegroundColor Green}"
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
    promptPath: run.files.promptPath,
    runDir: run.runDir,
    integrityBase64: Buffer.from(JSON.stringify(run.integrity), "utf-8").toString("base64"),
    reportPath: run.files.reportPath,
    evaluationPath: run.files.evaluationPath,
    proposalsPath: run.files.proposalsPath,
    stdoutPath: run.files.analyzerStdoutPath,
    stderrPath: run.files.analyzerStderrPath,
    agentTimeoutSeconds: 1800,
    outputWaitSeconds: 600,
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

export function launchAnalysisImplementation(run, fallbackShell = null) {
  if (process.platform !== "win32") {
    throw new Error("Terminal launching is currently supported on Windows only");
  }
  if (!run?.command?.resolvedExecutable || !run?.command?.cwd) {
    throw new Error("Implementation command is not available");
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
    runDir: run.runDir
  }), "utf-8").toString("base64");
  const child = spawn(terminal, [
    "-d", run.command.cwd,
    ...buildPowerShellImplementationArgs(powershell, shellArgs)
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OPENSESSIONVIEWER_IMPLEMENTATION_SPEC: payload }
  });
  child.unref();

  const launched = {
    ...run.manifest,
    implementation: {
      ...run.manifest.implementation,
      state: "launched",
      launchedAt: new Date().toISOString()
    }
  };
  writeJson(run.files.manifestPath, launched);
}
