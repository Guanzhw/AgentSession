import type { ProviderId, RuntimeExtensionReference } from "./providers/interface.js";
import { analysisRunRelativePath } from "./analysis-layout.js";

export const ANALYSIS_ACCESS_INTERFACE_VERSION = 1;

export interface AnalysisPageArgs {
  cursor?: number;
  limit?: number;
}

export interface AnalysisPage<T> {
  items: T[];
  cursor: number;
  limit: number;
  nextCursor: number | null;
  total: number;
}

export interface AnalysisEvidenceRef {
  evidenceId: string;
  sequence?: number;
  kind?: string;
  sessionId?: string;
  parentSessionId?: string | null;
  messageId?: string | null;
  partId?: string | null;
  role?: string | null;
  toolName?: string | null;
  status?: string | null;
  timestamp?: number;
  preview?: string;
  errorReason?: string | null;
}

export interface AnalysisSessionNode {
  sessionId: string;
  evidenceId: string;
  parentSessionId: string | null;
  attachedByEvidenceId?: string | null;
  attachMode?: string;
  depth?: number;
  title?: string;
  metrics?: unknown;
  direct?: {
    messages?: number;
    toolCalls?: number;
    errors?: number;
    completedToolCalls?: number;
    errorRate?: number;
  };
  children?: AnalysisSessionNode[];
}

export interface AnalysisSessionAccess {
  overview(args?: AnalysisPageArgs & { sessionId?: string }): unknown;
  listSessions(args?: AnalysisPageArgs & { parentSessionId?: string | null }): AnalysisPage<AnalysisSessionNode>;
  timeline(args?: AnalysisPageArgs & { sessionId?: string; kinds?: string[] }): AnalysisPage<AnalysisEvidenceRef>;
  querySystemPrompts(args?: AnalysisPageArgs & { sessionId?: string }): AnalysisPage<AnalysisEvidenceRef>;
  queryErrors(args?: AnalysisPageArgs & { sessionId?: string }): AnalysisPage<unknown>;
  queryTools(args?: AnalysisPageArgs & {
    sessionId?: string;
    status?: "all" | "completed" | "error" | "unknown";
    names?: string[];
  }): AnalysisPage<unknown>;
  findAnomalies(args?: {
    includeRoot?: boolean;
    minToolCalls?: number;
    errorRateThreshold?: number;
  }): unknown;
  getContext(args: AnalysisPageArgs & {
    evidenceId: string;
    before?: number;
    after?: number;
    maxContentChars?: number;
  }): unknown;
  getEvidence(args: {
    evidenceId: string;
    offset?: number;
    maxBytes?: number;
  }): unknown;
}

export interface AnalysisArtifactAccess {
  list(args?: AnalysisPageArgs): unknown;
  get(args: {
    artifactId?: string;
    snapshotPath?: string;
    relativePath?: string;
    offset?: number;
    maxBytes?: number;
  }): unknown;
}

export interface AnalysisRuntimeExtensionAccess {
  list(args?: AnalysisPageArgs): unknown;
  get(args: { extensionId: string }): {
    extension: RuntimeExtensionReference;
    artifacts: unknown[];
  } | unknown;
}

export interface AnalysisAccessToolSpec {
  method: string;
  command: string;
  purpose: string;
  exampleArgs?: Record<string, unknown>;
}

export const ANALYSIS_ACCESS_TOOLS = {
  session: [
    {
      method: "overview",
      command: "session_main_info",
      purpose: "Start here for root session metadata, hierarchy, system prompt refs, and a bounded timeline."
    },
    {
      method: "listSessions",
      command: "session_list",
      purpose: "Page through root and child sessions without expanding all raw records."
    },
    {
      method: "timeline",
      command: "session_timeline",
      purpose: "Page chronological evidence refs by session or kind."
    },
    {
      method: "querySystemPrompts",
      command: "session_query_system_prompts",
      purpose: "List locally resolvable system prompt and runtime instruction evidence."
    },
    {
      method: "queryErrors",
      command: "session_query_errors",
      purpose: "Find failed or interrupted tool evidence."
    },
    {
      method: "queryTools",
      command: "session_query_tools",
      purpose: "Filter tool calls by status, name, or session.",
      exampleArgs: { status: "completed" }
    },
    {
      method: "findAnomalies",
      command: "session_find_anomalies",
      purpose: "Use interruption reasons and visible high-error-rate thresholds as retrieval signals."
    },
    {
      method: "getContext",
      command: "session_query_context",
      purpose: "Expand nearby conversation context around a specific evidenceId.",
      exampleArgs: { evidenceId: "ev:..." }
    },
    {
      method: "getEvidence",
      command: "session_get_evidence",
      purpose: "Read one exact evidence record, with byte paging for large records.",
      exampleArgs: { evidenceId: "ev:..." }
    }
  ],
  artifacts: [
    {
      method: "list",
      command: "artifact_list",
      purpose: "List configured target artifact snapshots and exact artifact IDs."
    },
    {
      method: "get",
      command: "artifact_get",
      purpose: "Read one captured artifact snapshot by artifactId, relativePath, or snapshotPath.",
      exampleArgs: { artifactId: "artifact:..." }
    }
  ],
  runtimeExtensions: [
    {
      method: "list",
      command: "extension_list",
      purpose: "List provider-resolved runtime extensions selected for this run."
    },
    {
      method: "get",
      command: "extension_get",
      purpose: "Inspect one selected runtime extension and the artifacts captured for it.",
      exampleArgs: { extensionId: "runtime:..." }
    }
  ]
} satisfies Record<string, AnalysisAccessToolSpec[]>;

export function buildAnalysisAccessManifest({
  providerId,
  providerName,
  rootSessionId,
  runDir,
  files,
  nodeExecutable = process.execPath,
  executableArgs = []
}: {
  providerId: ProviderId;
  providerName: string;
  rootSessionId: string;
  runDir: string;
  files: Record<string, string>;
  nodeExecutable?: string;
  executableArgs?: string[];
}) {
  const relative = (filePath: string) => analysisRunRelativePath(runDir, filePath);
  const quotedArgs = executableArgs.map((arg) => `"${arg}"`).join(" ");
  const commandPrefix = [`"${nodeExecutable}"`, quotedArgs].filter(Boolean).join(" ");
  return {
    schemaVersion: 1,
    interfaceVersion: ANALYSIS_ACCESS_INTERFACE_VERSION,
    provider: {
      id: providerId,
      name: providerName
    },
    rootSessionId,
    generatedAt: new Date().toISOString(),
    accessTool: {
      executable: nodeExecutable,
      executableArgs,
      path: files.analysisToolPath,
      relativePath: relative(files.analysisToolPath),
      invocation: executableArgs.length
        ? `${commandPrefix} "${runDir}" <command> [argsJson]`
        : `${commandPrefix} "${files.analysisToolPath}" "${runDir}" <command> [argsJson]`
    },
    interfaces: ANALYSIS_ACCESS_TOOLS,
    backingStores: {
      sessionIndex: relative(files.sessionIndexPath),
      evidenceIndex: relative(files.evidenceIndexPath),
      evidenceRecords: relative(files.evidencePath),
      artifacts: relative(files.artifactsPath)
    },
    rules: [
      "Start with the bounded backing store files listed here: session index, evidence index, artifacts, and selected evidence records.",
      "The access tool is optional convenience. If command execution or node resolution is unavailable, use direct file reads instead.",
      "Use exact ev:... and artifact:... IDs from the backing stores for citations.",
      "Expand raw evidence records only when a specific evidenceId is needed.",
      "Use artifact and runtime-extension backing data before proposing artifact changes."
    ]
  };
}
