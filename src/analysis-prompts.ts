import { existsSync } from "node:fs";
import { makeEvidenceId } from "./analysis-evidence.js";
import type { ProviderAdapter } from "./providers/interface.js";

export interface AnalysisPromptParams {
  provider: ProviderAdapter;
  session: { id: string };
  targetId: string;
  runDir: string;
  projectPath: string;
  customPrompt?: string;
  files: Record<string, string>;
  rawSnapshotsIncluded: boolean;
}

export interface ImplementationPromptParams {
  provider: ProviderAdapter;
  manifest: {
    sessionId: string;
    target?: string;
    runId: string;
    runDir?: string;
  };
  projectPath: string;
  files: Record<string, string>;
}

export function buildAnalysisPrompt({
  provider,
  session,
  targetId,
  runDir,
  projectPath,
  customPrompt,
  files,
  rawSnapshotsIncluded
}: AnalysisPromptParams) {
  const rootEvidenceId = makeEvidenceId(provider.id, session.id, "session", session.id);
  return `# AgentSession session analysis

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

Each evidence-index entry has a literal \`evidenceId\` field. Copy that field
exactly. The index lists \`evidenceId\` before \`sequence\`; \`sequence\` is only
display order, not a citation key. Do not reconstruct evidence IDs from
\`sequence\`, \`kind\`, \`sourceKey\`, titles, labels, decoded system-prompt
parts, or visible file paths. For example, an entry with \`sequence: 7\` and title
\`session.permission\` does not make \`...:system-prompt:7...session.permission\`
valid unless that exact string appears as the entry's \`evidenceId\`.

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
24. When a proposal updates skills, runtime instructions, or harness guidance to improve future agent behavior, set \`kind\` to \`skill-evolution\`. Use \`artifact-change\` or omit \`kind\` for ordinary artifact changes.

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
      "kind": "artifact-change|skill-evolution",
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
- Every copied evidence ID matches a literal \`evidenceId\` field from \`${files.evidenceIndexPath}\` or a literal \`artifactId\` field from \`${files.artifactsPath}\`; pattern-shaped IDs are not enough.
- No ID was reconstructed from \`sequence\`, \`kind\`, \`sourceKey\`, title, label, or decoded system-prompt fields instead of copied literally.
- No \`sourceEvidence\` or \`evidence\` item is a shortened \`ev:...\` prefix or raw \`ses_...\` ID.
- No evidence array contains a filesystem path or free-form observation.
- Every evaluation case has at least one valid evidence ID.
- Evaluation cases include exactly supported kinds and collectively cover replay, held-out, and regression.
- Every evaluation case has \`metrics.taskSuccess\` set to \`true\`.
- Every artifact proposal action is one of \`create\`, \`edit\`, \`replace\`, or \`delete\`.
- Every artifact proposal \`kind\`, when present, is either \`artifact-change\` or \`skill-evolution\`.
- No two artifact proposals use the same \`artifactRoot\` plus \`artifactPath\`.
- Every proposal references declared evaluation case IDs and an exact captured artifact root.

${customPrompt ? `## Additional configured instructions\n\n${customPrompt}\n` : ""}`;
}

export function buildImplementationPrompt({
  provider,
  manifest,
  projectPath,
  files
}: ImplementationPromptParams) {
  const accessManifestLine = existsSync(files.accessManifestPath)
    ? `- Analysis access interface: ${files.accessManifestPath}`
    : `- Analysis access interface: ${files.accessManifestPath} (not available for this legacy run)`;
  return `# AgentSession accepted-proposal implementation

The user has reviewed and accepted the validated proposal set from an
AgentSession analysis run. Implement only that accepted set, then verify
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
- Accepted proposals: ${files.acceptedProposalsPath}
- Validated proposal source: ${files.proposalsPath}
- Captured artifact inventory: ${files.artifactsPath}
- Original analysis request: ${files.promptPath}
- Implementation result file: ${files.implementationResultPath}
${accessManifestLine}

## Required behavior

1. Treat the accepted-proposals file as the user's approval record, but still
   implement it narrowly and preserve unrelated local changes.
2. Inspect \`git status --short\` before editing. Do not revert or overwrite
   changes that are unrelated to the accepted proposals.
3. Implement only proposals listed in \`${files.acceptedProposalsPath}\`.
4. When proposal context or evidence is needed, start with
   \`${files.accessManifestPath}\` if it is available. Follow its bounded
   backing-store interface and prefer direct reads of the session index,
   evidence index, artifact inventory, and selected evidence records over
   broad reads of the complete evidence JSONL or raw diagnostics.
5. Do not edit provider-owned databases, transcripts, or files inside
   \`${manifest.runDir || ""}\`.
6. For \`skill-evolution\` proposals, edit only the named skill, instruction,
   or harness artifacts. Do not broaden them into unrelated redesigns.
7. Prefer focused source, test, documentation, or instruction changes that map
   directly to the proposal descriptions.
8. Use \`${files.evaluationPath}\` as the verification guide. Run the relevant
   tests, type checks, or review checks available in the project.
9. Write \`${files.implementationResultPath}\` with the JSON result shape below.
10. Do not merge automatically. If a PR or MR can be opened after verification,
   open it for human review; otherwise leave the worktree ready for review and
   summarize the changes and verification.
11. If a proposal is unsafe, stale, impossible, or contradicted by current code,
   stop and explain that instead of forcing an edit.

## Implementation result JSON

\`\`\`json
{
  "schemaVersion": 1,
  "status": "completed|partial|blocked",
  "implementedProposalIds": ["accepted proposal IDs implemented"],
  "skippedProposals": [
    { "id": "accepted proposal ID", "reason": "Why it was skipped" }
  ],
  "changedFiles": ["Project-relative paths changed"],
  "verification": [
    { "command": "Command or check", "result": "Exact outcome" }
  ],
  "notes": ["Any human-review notes"]
}
\`\`\`

## Completion report

Before finishing, report:

- Which proposal IDs were implemented.
- Which files changed.
- Which verification commands ran and their exact result.
- Any proposal IDs skipped and why.
- The path to \`${files.implementationResultPath}\`.
`;
}
