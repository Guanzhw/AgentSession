import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  resolveAnalysisRunPath,
  resolveIntegrityPath
} from "./analysis-layout.js";

function readJson(filePath, errors, label) {
  if (!existsSync(filePath)) {
    errors.push(`${label} is missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function requireFields(value, fields, errors, label) {
  for (const field of fields) {
    if (value?.[field] === undefined) {
      errors.push(`${label} is missing ${field}`);
    }
  }
}

function isInsideRoot(root, relativePath) {
  if (!root || !relativePath || path.isAbsolute(relativePath)) {
    return false;
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  return resolved !== resolvedRoot && resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(temporary, filePath);
}

function hashFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const ALLOWED_PROPOSAL_KINDS = new Set(["artifact-change", "skill-evolution"]);

function normalizeEvidenceRef(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function evidenceTokens(value) {
  return normalizeEvidenceRef(value)
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .filter((token) => token.length > 2);
}

function suggestEvidenceRefs(ref, allowedRefs, limit = 3) {
  const normalizedRef = normalizeEvidenceRef(ref).toLowerCase();
  const refTail = normalizedRef.split(":").pop() || "";
  const refTokens = new Set(evidenceTokens(ref));
  return [...allowedRefs]
    .filter((candidate) => candidate !== ref)
    .map((candidate) => {
      const normalizedCandidate = normalizeEvidenceRef(candidate).toLowerCase();
      const candidateTokens = new Set(evidenceTokens(candidate));
      let score = 0;
      if (refTail && normalizedCandidate.endsWith(`:${refTail}`)) score += 8;
      if (normalizedRef.includes(":system-prompt:") && normalizedCandidate.includes(":system-prompt:")) score += 4;
      if (normalizedRef.includes(":session:") && normalizedCandidate.includes(":session:")) score += 4;
      for (const token of refTokens) {
        if (candidateTokens.has(token)) score += 1;
      }
      return { candidate, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

export function validateAnalysisOutputs(runDir, processExitCode = 0, expectedIntegrity = null) {
  const resolvedRunDir = path.resolve(runDir);
  const manifestPath = path.join(resolvedRunDir, "manifest.json");
  const errors = [];
  const manifest = readJson(manifestPath, errors, "manifest.json") || {
    schemaVersion: 1,
    runDir: resolvedRunDir
  };
  const reportPath = resolveAnalysisRunPath(resolvedRunDir, manifest, "reportPath");
  const evaluationPath = resolveAnalysisRunPath(resolvedRunDir, manifest, "evaluationPath");
  const proposalsPath = resolveAnalysisRunPath(resolvedRunDir, manifest, "proposalsPath");
  const artifactsPath = resolveAnalysisRunPath(resolvedRunDir, manifest, "artifactsPath");
  const evidenceIndexPath = resolveAnalysisRunPath(resolvedRunDir, manifest, "evidenceIndexPath");
  const analyzerStderrPath = resolveAnalysisRunPath(resolvedRunDir, manifest, "analyzerStderrPath");

  if (!existsSync(reportPath)) {
    errors.push("report.md is missing");
  } else if (!statSync(reportPath).isFile() || statSync(reportPath).size < 100) {
    errors.push("report.md is empty or too short");
  }

  const evaluation = readJson(evaluationPath, errors, "evaluation-proposals.json");
  const artifacts = readJson(artifactsPath, errors, "artifacts.json");
  const evidenceIndex = readJson(evidenceIndexPath, errors, "evidence-index.json");
  const proposals = readJson(proposalsPath, errors, "artifact-proposals.json");
  const caseIds = new Set();
  const kinds = new Set();
  const allowedEvidenceRefs = new Set(
    Array.isArray(evidenceIndex?.entries)
      ? evidenceIndex.entries.map((entry) => entry.evidenceId).filter(Boolean)
      : []
  );
  const allowedArtifactRefs = new Set(
    Array.isArray(artifacts?.files)
      ? artifacts.files.map((entry) => entry.artifactId).filter(Boolean)
      : []
  );
  const validateEvidenceRefs = (refs, label) => {
    if (!Array.isArray(refs) || refs.length === 0) {
      errors.push(`${label} must contain at least one evidence reference`);
      return;
    }
    for (const ref of refs) {
      if (!allowedEvidenceRefs.has(ref) && !allowedArtifactRefs.has(ref)) {
        const suggestions = suggestEvidenceRefs(ref, new Set([...allowedEvidenceRefs, ...allowedArtifactRefs]));
        errors.push(`${label} references unknown evidence ${ref}${suggestions.length ? `; closest valid IDs: ${suggestions.join(", ")}` : ""}`);
      }
    }
  };

  if (expectedIntegrity?.algorithm !== "sha256" || !expectedIntegrity.files) {
    errors.push("trusted input integrity metadata is missing");
  } else {
    for (const field of ["runId", "provider", "sessionId", "target", "runDir"]) {
      if (expectedIntegrity.context?.[field] !== manifest[field]) {
        errors.push(`manifest ${field} does not match trusted launch metadata`);
      }
    }
    for (const [fileName, expectedHash] of Object.entries(expectedIntegrity.files)) {
      const filePath = resolveIntegrityPath(resolvedRunDir, fileName);
      if (!filePath || !existsSync(filePath)) {
        errors.push(`captured input ${fileName} is missing`);
      } else if (hashFile(filePath) !== expectedHash) {
        errors.push(`captured input ${fileName} failed its sha256 integrity check`);
      }
    }
  }

  for (const artifact of artifacts?.files || []) {
    const configuredSnapshotRoot = typeof artifacts?.snapshotRoot === "string"
      ? path.resolve(artifacts.snapshotRoot)
      : resolveAnalysisRunPath(resolvedRunDir, manifest, "artifactSnapshotsDir");
    const fallbackSnapshotRoot = path.resolve(resolvedRunDir, "artifacts");
    const snapshotRoots = [configuredSnapshotRoot, fallbackSnapshotRoot]
      .filter((root) => resolveIntegrityPath(
        resolvedRunDir,
        path.relative(resolvedRunDir, root)
      ));
    const snapshotPath = path.resolve(String(artifact.snapshotPath || ""));
    if (
      !snapshotRoots.some((snapshotRoot) => (
        snapshotPath !== snapshotRoot
        && snapshotPath.startsWith(`${snapshotRoot}${path.sep}`)
      ))
      || !existsSync(snapshotPath)
    ) {
      errors.push(`artifact snapshot ${artifact.artifactId || artifact.relativePath || "unknown"} is unavailable`);
    } else if (artifact.sha256 && hashFile(snapshotPath) !== artifact.sha256) {
      errors.push(`artifact snapshot ${artifact.artifactId || artifact.relativePath || "unknown"} failed its sha256 integrity check`);
    }
  }

  if (evaluation) {
    requireFields(
      evaluation,
      ["schemaVersion", "status", "target", "sourceSessionId", "cases"],
      errors,
      "evaluation-proposals.json"
    );
    if (evaluation.schemaVersion !== 1 || evaluation.status !== "proposed") {
      errors.push("evaluation-proposals.json must use schemaVersion 1 and status proposed");
    }
    if (manifest.target && evaluation.target !== manifest.target) {
      errors.push("evaluation-proposals.json target does not match the manifest");
    }
    if (manifest.sessionId && evaluation.sourceSessionId !== manifest.sessionId) {
      errors.push("evaluation-proposals.json sourceSessionId does not match the manifest");
    }
    if (!Array.isArray(evaluation.cases)) {
      errors.push("evaluation-proposals.json cases must be an array");
    } else {
      for (const [index, entry] of evaluation.cases.entries()) {
        const label = `evaluation case ${index + 1}`;
        requireFields(
          entry,
          ["id", "title", "kind", "status", "task", "setup", "sourceEvidence", "expectedOutcome", "comparison", "verifier", "metrics"],
          errors,
          label
        );
        if (caseIds.has(entry.id)) {
          errors.push(`${label} repeats id ${entry.id}`);
        }
        caseIds.add(entry.id);
        if (!["replay", "held-out", "regression"].includes(entry.kind)) {
          errors.push(`${label} has invalid kind ${entry.kind}`);
        }
        kinds.add(entry.kind);
        if (entry.status !== "proposed") {
          errors.push(`${label} must have status proposed`);
        }
        validateEvidenceRefs(entry.sourceEvidence, `${label} sourceEvidence`);
        requireFields(entry.comparison, ["baseline", "candidate", "acceptance"], errors, `${label} comparison`);
        if (!entry.verifier?.kind) {
          errors.push(`${label} is missing verifier.kind`);
        }
        if (entry.metrics?.taskSuccess !== true) {
          errors.push(`${label} must require metrics.taskSuccess`);
        }
        requireFields(
          entry.metrics,
          ["taskSuccess", "maxTokenIncreasePercent", "maxRuntimeIncreasePercent"],
          errors,
          `${label} metrics`
        );
      }
      for (const requiredKind of ["replay", "held-out", "regression"]) {
        if (!kinds.has(requiredKind)) {
          errors.push(`evaluation-proposals.json is missing a ${requiredKind} case`);
        }
      }
    }
  }

  const allowedRoots = new Set(
    Array.isArray(artifacts?.roots)
      ? artifacts.roots.map((root) => path.resolve(String(root)))
      : []
  );
  const analysisOutputRoot = path.dirname(resolvedRunDir);
  const allowedExplicitTargets = new Set(
    Array.isArray(artifacts?.files)
      ? artifacts.files
        .filter((file) => file.explicit === true)
        .map((file) => `${path.resolve(String(file.root || ""))}\0${file.relativePath}`)
      : []
  );
  const proposalTargets = new Set();
  if (proposals) {
    requireFields(
      proposals,
      ["schemaVersion", "status", "target", "sourceSessionId", "proposals"],
      errors,
      "artifact-proposals.json"
    );
    if (proposals.schemaVersion !== 1 || proposals.status !== "proposed") {
      errors.push("artifact-proposals.json must use schemaVersion 1 and status proposed");
    }
    if (manifest.target && proposals.target !== manifest.target) {
      errors.push("artifact-proposals.json target does not match the manifest");
    }
    if (manifest.sessionId && proposals.sourceSessionId !== manifest.sessionId) {
      errors.push("artifact-proposals.json sourceSessionId does not match the manifest");
    }
    if (!Array.isArray(proposals.proposals)) {
      errors.push("artifact-proposals.json proposals must be an array");
    } else {
      for (const [index, proposal] of proposals.proposals.entries()) {
        const label = `artifact proposal ${index + 1}`;
        requireFields(
          proposal,
          ["id", "action", "artifactRoot", "artifactPath", "description", "evidence", "expectedBenefit", "risks", "validationCaseIds"],
          errors,
          label
        );
        if (!["create", "edit", "replace", "delete"].includes(proposal.action)) {
          errors.push(`${label} has invalid action ${proposal.action}`);
        }
        if (proposal.kind !== undefined && !ALLOWED_PROPOSAL_KINDS.has(String(proposal.kind))) {
          errors.push(`${label} has invalid kind ${proposal.kind}`);
        }
        validateEvidenceRefs(proposal.evidence, `${label} evidence`);
        const artifactRoot = path.resolve(String(proposal.artifactRoot || ""));
        const target = `${artifactRoot}\0${proposal.artifactPath}`;
        const proposedPath = path.resolve(artifactRoot, String(proposal.artifactPath || ""));
        const targetsExplicitFile = allowedExplicitTargets.has(target);
        if (!allowedRoots.has(artifactRoot) && !targetsExplicitFile) {
          errors.push(`${label} uses an artifact root outside artifacts.json`);
        }
        if (!targetsExplicitFile && !isInsideRoot(artifactRoot, proposal.artifactPath)) {
          errors.push(`${label} artifactPath escapes its artifact root`);
        }
        if (
          proposedPath === analysisOutputRoot
          || proposedPath.startsWith(`${analysisOutputRoot}${path.sep}`)
        ) {
          errors.push(`${label} targets generated analysis output`);
        }
        if (proposalTargets.has(target)) {
          errors.push(`${label} duplicates another proposal target`);
        }
        proposalTargets.add(target);
        if (!Array.isArray(proposal.validationCaseIds)) {
          errors.push(`${label} validationCaseIds must be an array`);
        } else {
          for (const caseId of proposal.validationCaseIds) {
            if (!caseIds.has(caseId)) {
              errors.push(`${label} references unknown evaluation case ${caseId}`);
            }
          }
        }
      }
    }
  }

  const numericExitCode = Number(processExitCode) || 0;
  if (numericExitCode !== 0) {
    errors.unshift(`analysis command exited with code ${numericExitCode}`);
    try {
      if (existsSync(analyzerStderrPath) && statSync(analyzerStderrPath).isFile()) {
        const stderr = readFileSync(analyzerStderrPath, "utf-8").trim();
        if (stderr) {
          errors.unshift(`analysis stderr: ${stderr.slice(-2000)}`);
        }
      }
    } catch {
      // Best-effort diagnostic only; schema validation errors above are enough.
    }
  }
  const state = numericExitCode !== 0
    ? "failed"
    : errors.length
      ? "invalid"
      : "completed";
  const validation = {
    ok: state === "completed",
    checkedAt: new Date().toISOString(),
    processExitCode: numericExitCode,
    errors,
    evaluationCaseCount: evaluation?.cases?.length || 0,
    artifactProposalCount: proposals?.proposals?.length || 0
  };
  const updatedManifest = {
    ...manifest,
    state,
    completedAt: validation.checkedAt,
    validation
  };
  writeJsonAtomic(manifestPath, updatedManifest);
  return updatedManifest;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("Usage: node analysis-validator.js <runDir> [processExitCode]");
    process.exitCode = 2;
  } else {
    let expectedIntegrity = null;
    if (process.argv[4]) {
      try {
        expectedIntegrity = JSON.parse(Buffer.from(process.argv[4], "base64").toString("utf-8"));
      } catch (error) {
        console.error(`Invalid integrity metadata: ${error.message}`);
        process.exitCode = 2;
      }
    }
    const result = validateAnalysisOutputs(runDir, Number(process.argv[3]) || 0, expectedIntegrity);
    console.log(JSON.stringify({
      state: result.state,
      validation: result.validation
    }, null, 2));
    if (result.state !== "completed") {
      process.exitCode = 1;
    }
  }
}
