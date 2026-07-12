import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const CATEGORIZED_FILES = {
  manifestPath: "manifest.json",
  reportPath: "outputs/report.md",
  evaluationPath: "outputs/evaluation-proposals.json",
  proposalsPath: "outputs/artifact-proposals.json",
  sessionPath: "inputs/session.json",
  evaluationSeedPath: "inputs/evaluation-seed.json",
  promptPath: "inputs/analysis-request.md",
  sessionIndexPath: "evidence/session-index.json",
  evidenceIndexPath: "evidence/evidence-index.json",
  evidencePath: "evidence/evidence.jsonl",
  accessManifestPath: "inputs/analysis-access.json",
  artifactsPath: "evidence/artifacts.json",
  acceptedProposalsPath: "inputs/accepted-proposals.json",
  implementationPromptPath: "inputs/implementation-request.md",
  implementationResultPath: "outputs/implementation-result.json",
  analysisToolPath: "tools/analysis-tools.js",
  analysisLayoutPath: "tools/analysis-layout.js",
  analysisToolPackagePath: "tools/package.json",
  messagesPath: "diagnostics/messages.json",
  treePath: "diagnostics/tree.json",
  containerPath: "diagnostics/container.json",
  metricsPath: "diagnostics/metrics.json",
  flowPath: "diagnostics/flow.json",
  tracePath: "diagnostics/trace.json",
  analyzerStdoutPath: "diagnostics/analyzer.stdout.log",
  analyzerStderrPath: "diagnostics/analyzer.stderr.log",
  artifactSnapshotsDir: "evidence/artifact-snapshots"
};

const LEGACY_FILES = {
  reportPath: "report.md",
  evaluationPath: "evaluation-proposals.json",
  proposalsPath: "artifact-proposals.json",
  sessionPath: "session.json",
  evaluationSeedPath: "evaluation-seed.json",
  promptPath: "analysis-request.md",
  sessionIndexPath: "session-index.json",
  evidenceIndexPath: "evidence-index.json",
  evidencePath: "evidence.jsonl",
  artifactsPath: "artifacts.json",
  messagesPath: "messages.json",
  treePath: "tree.json",
  containerPath: "container.json",
  metricsPath: "metrics.json",
  flowPath: "flow.json",
  tracePath: "trace.json",
  analyzerStdoutPath: "diagnostics/analyzer.stdout.log",
  analyzerStderrPath: "diagnostics/analyzer.stderr.log",
  artifactSnapshotsDir: "artifacts"
};

function isInsideRun(runDir: string, candidate: string) {
  const root = path.resolve(runDir);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export function getAnalysisRunPaths(runDir: string) {
  return Object.fromEntries(
    Object.entries(CATEGORIZED_FILES).map(([key, relativePath]) => [
      key,
      path.join(runDir, relativePath)
    ])
  ) as Record<keyof typeof CATEGORIZED_FILES, string>;
}

export function ensureAnalysisRunDirectories(
  files: ReturnType<typeof getAnalysisRunPaths>,
  includeDiagnostics = false
) {
  const targets = [
    files.reportPath,
    files.sessionPath,
    files.sessionIndexPath,
    files.analysisToolPath,
    files.analyzerStdoutPath,
    files.analyzerStderrPath,
    files.artifactSnapshotsDir,
    ...(includeDiagnostics ? [files.messagesPath] : [])
  ];
  for (const target of targets) {
    const directory = target === files.artifactSnapshotsDir ? target : path.dirname(target);
    mkdirSync(directory, { recursive: true });
  }
}

export function resolveAnalysisRunPath(
  runDir: string,
  manifest: any,
  key: keyof typeof CATEGORIZED_FILES
) {
  const candidates = [
    (manifest?.files as Record<string, string> | undefined)?.[key],
    path.join(runDir, (CATEGORIZED_FILES as Record<string, string>)[key]),
    (LEGACY_FILES as Record<string, string>)[key] ? path.join(runDir, (LEGACY_FILES as Record<string, string>)[key]) : null
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) {
      continue;
    }
    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(runDir, candidate);
    if (isInsideRun(runDir, resolved) && existsSync(resolved)) {
      return resolved;
    }
  }
  return path.join(runDir, CATEGORIZED_FILES[key]);
}

export function analysisRunRelativePath(runDir: string, filePath: string) {
  return path.relative(runDir, filePath).split(path.sep).join("/");
}

export function resolveIntegrityPath(runDir: string, relativePath: string) {
  const resolved = path.resolve(runDir, relativePath);
  return isInsideRun(runDir, resolved) && resolved !== path.resolve(runDir)
    ? resolved
    : null;
}
