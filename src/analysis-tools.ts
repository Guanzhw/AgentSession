import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  readSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnalysisArtifactAccess,
  AnalysisRuntimeExtensionAccess,
  AnalysisSessionAccess
} from "./analysis-access.js";
import type { AnalysisEvidenceIndexEntry } from "./analysis-evidence.js";
import { resolveAnalysisRunPath } from "./analysis-layout.js";

type Row = Record<string, any>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_CONTENT_CHARS = 4000;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const INLINE_VALUE_CHARS = 180;
const INLINE_LINE_CHARS = 240;

function readJson(filePath: string) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function assertRegularFileInside(root: string, filePath: string) {
  const rootPath = realpathSync(root);
  const candidate = path.resolve(filePath);
  const info = lstatSync(candidate);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Analysis tool rejected a non-regular input file: ${candidate}`);
  }
  const real = realpathSync(candidate);
  if (real === rootPath || !real.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Analysis tool rejected an input path outside the run: ${candidate}`);
  }
  return real;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function compact(value: unknown, limit = DEFAULT_CONTENT_CHARS) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function loadRun(runDir: string) {
  const resolvedRunDir = path.resolve(runDir);
  const manifestPath = path.join(resolvedRunDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json was not found under ${resolvedRunDir}`);
  }
  const manifest = readJson(assertRegularFileInside(resolvedRunDir, manifestPath));
  const evidenceIndexPath = resolveAnalysisRunPath(resolvedRunDir, manifest, "evidenceIndexPath");
  const sessionIndexPath = resolveAnalysisRunPath(resolvedRunDir, manifest, "sessionIndexPath");
  const evidencePath = resolveAnalysisRunPath(resolvedRunDir, manifest, "evidencePath");
  return {
    runDir: resolvedRunDir,
    manifest,
    files: {
      artifactsPath: resolveAnalysisRunPath(resolvedRunDir, manifest, "artifactsPath"),
      artifactSnapshotsDir: resolveAnalysisRunPath(resolvedRunDir, manifest, "artifactSnapshotsDir")
    },
    evidencePath: assertRegularFileInside(resolvedRunDir, evidencePath),
    evidenceIndex: readJson(assertRegularFileInside(resolvedRunDir, evidenceIndexPath)),
    sessionIndex: readJson(assertRegularFileInside(resolvedRunDir, sessionIndexPath))
  };
}

function paginate<T>(items: T[], args: Row) {
  const cursor = boundedInteger(args.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const page = items.slice(cursor, cursor + limit);
  return {
    items: page,
    cursor,
    limit,
    nextCursor: cursor + page.length < items.length ? cursor + page.length : null,
    total: items.length
  };
}

function timelineEntry(entry: AnalysisEvidenceIndexEntry) {
  return {
    evidenceId: entry.evidenceId,
    sequence: entry.sequence,
    kind: entry.kind,
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    partId: entry.partId,
    role: entry.role,
    toolName: entry.toolName,
    status: entry.status,
    timestamp: entry.timestamp,
    preview: entry.preview,
    errorReason: entry.errorReason
  };
}

function readEvidenceRecord(run: ReturnType<typeof loadRun>, entry: AnalysisEvidenceIndexEntry) {
  const handle = openSync(run.evidencePath, "r");
  try {
    const buffer = Buffer.alloc(entry.byteLength);
    readSync(handle, buffer, 0, entry.byteLength, entry.offset);
    return JSON.parse(buffer.toString("utf-8"));
  } finally {
    closeSync(handle);
  }
}

function projectedRecord(run: ReturnType<typeof loadRun>, entry: AnalysisEvidenceIndexEntry, args: Row) {
  const record = readEvidenceRecord(run, entry);
  const raw = record.raw || {};
  const contentLimit = boundedInteger(args.maxContentChars, DEFAULT_CONTENT_CHARS, 200, 20000);
  return {
    ...timelineEntry(entry),
    input: compact(raw.state?.input ?? raw.input, contentLimit),
    output: compact(raw.state?.output ?? raw.output ?? raw.text ?? raw.preview, contentLimit),
    error: compact(raw.state?.error ?? raw.error, contentLimit),
    title: raw.state?.title ?? raw.title ?? null
  };
}

function isConversationEntry(entry: AnalysisEvidenceIndexEntry) {
  if (entry.kind === "message") {
    return ["user", "assistant", "agent"].includes(String(entry.role || "").toLowerCase());
  }
  return entry.kind === "tool";
}

function isInterruptionReason(reason: unknown) {
  if (typeof reason !== "string" || !reason.trim()) {
    return false;
  }
  return /\b(interrupt(?:ed|ion)?|cancel(?:led|ed|ation)?|abort(?:ed|ing)?|user stopped)\b/i.test(reason);
}

function normalizeStatus(value: unknown) {
  const status = String(value || "all").toLowerCase();
  return ["all", "completed", "error", "unknown"].includes(status) ? status : "all";
}

function artifactInventory(run: ReturnType<typeof loadRun>) {
  return readJson(assertRegularFileInside(run.runDir, run.files.artifactsPath));
}

function readArtifactSnapshot(run, inventory, args, toolName) {
  const artifact = (inventory.files || []).find((entry) => (
    (args.artifactId && entry.artifactId === args.artifactId)
    || (args.snapshotPath && entry.snapshotPath === args.snapshotPath)
    || (args.relativePath && entry.relativePath === args.relativePath)
  ));
  if (!artifact) {
    throw new Error(`${toolName} requires a valid artifactId, snapshotPath, or relativePath`);
  }
  const snapshotRoot = path.resolve(
    typeof inventory.snapshotRoot === "string"
      ? inventory.snapshotRoot
      : run.files.artifactSnapshotsDir
  );
  const snapshotPath = path.resolve(String(artifact.snapshotPath || ""));
  if (
    snapshotPath === snapshotRoot
    || !snapshotPath.startsWith(`${snapshotRoot}${path.sep}`)
    || lstatSync(snapshotPath).isSymbolicLink()
    || !lstatSync(snapshotPath).isFile()
  ) {
    throw new Error(`${toolName} rejected an artifact path outside the run snapshot`);
  }
  const realSnapshotRoot = realpathSync(snapshotRoot);
  const realSnapshotPath = realpathSync(snapshotPath);
  if (!realSnapshotPath.startsWith(`${realSnapshotRoot}${path.sep}`)) {
    throw new Error(`${toolName} rejected an artifact path outside the run snapshot`);
  }
  const content = readFileSync(realSnapshotPath);
  const offset = boundedInteger(args.offset, 0, 0, content.length);
  const maxBytes = boundedInteger(args.maxBytes, 64 * 1024, 1024, MAX_EVIDENCE_BYTES);
  const end = Math.min(content.length, offset + maxBytes);
  return {
    tool: toolName,
    artifact,
    offset,
    returnedBytes: end - offset,
    totalBytes: content.length,
    nextOffset: end < content.length ? end : null,
    content: content.subarray(offset, end).toString("utf-8")
  };
}

function markdownHeading(value: unknown) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .trim();
}

function markdownCode(value: unknown) {
  const text = value == null
    ? "null"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
  const longestTicks = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestTicks + 1);
  const padding = text.startsWith("`") || text.endsWith("`") || text.startsWith(" ") || text.endsWith(" ")
    ? " "
    : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

function markdownFence(value: string) {
  const longestTicks = Math.max(2, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestTicks + 1);
  return `${fence}text\n${value}\n${fence}`;
}

function isInlineValue(value: unknown) {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "string") {
    return !value.includes("\n") && !value.includes("\r") && value.length <= INLINE_VALUE_CHARS;
  }
  return Array.isArray(value) && value.every((item) => (
    item == null || ["string", "number", "boolean"].includes(typeof item)
  )) && JSON.stringify(value).length <= INLINE_VALUE_CHARS;
}

function itemLabel(value: Row, index: number) {
  const kind = value.toolName || value.role || value.kind || value.title || value.relativePath || value.id;
  const identity = value.evidenceId || value.artifactId || value.sessionId;
  if (kind && identity && kind !== identity) {
    return `${index + 1}. ${markdownHeading(kind)} - ${markdownHeading(identity)}`;
  }
  return `${index + 1}. ${markdownHeading(identity || kind || "item")}`;
}

function appendHeading(lines: string[], level: number, label: string) {
  if (level <= 6) {
    lines.push(`${"#".repeat(level)} ${markdownHeading(label)}`);
  } else {
    lines.push(`**${markdownHeading(label)}**`);
  }
}

function appendInlineValues(lines: string[], entries: Array<[string, unknown]>) {
  let current = "";
  for (const [key, value] of entries) {
    const fragment = `**${markdownHeading(key)}:** ${markdownCode(value)}`;
    if (current && current.length + fragment.length + 3 > INLINE_LINE_CHARS) {
      lines.push(`- ${current}`);
      current = fragment;
    } else {
      current = current ? `${current} | ${fragment}` : fragment;
    }
  }
  if (current) {
    lines.push(`- ${current}`);
  }
}

function appendMarkdownValue(lines: string[], label: string, value: unknown, level: number) {
  if (Array.isArray(value)) {
    appendHeading(lines, level, `${label} (${value.length})`);
    if (value.length === 0) {
      lines.push("- None");
      return;
    }
    if (value.every((item) => item == null || typeof item !== "object")) {
      appendInlineValues(lines, value.map((item, index) => [`${index + 1}`, item]));
      return;
    }
    value.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        appendHeading(lines, level + 1, itemLabel(item, index));
        appendMarkdownObject(lines, item, level + 2);
      } else {
        appendHeading(lines, level + 1, `${index + 1}. item`);
        appendMarkdownValue(lines, "value", item, level + 2);
      }
    });
    return;
  }

  if (value && typeof value === "object") {
    appendHeading(lines, level, label);
    appendMarkdownObject(lines, value as Row, level + 1);
    return;
  }

  appendHeading(lines, level, label);
  lines.push(markdownFence(value == null ? "null" : String(value)));
}

function appendMarkdownObject(lines: string[], value: Row, level: number) {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    lines.push("- None");
    return;
  }

  const inline = entries.filter(([, item]) => isInlineValue(item));
  appendInlineValues(lines, inline);

  for (const [key, item] of entries) {
    if (!isInlineValue(item)) {
      appendMarkdownValue(lines, key, item, level);
    }
  }
}

export function formatAnalysisToolOutput(result: Row) {
  const tool = typeof result?.tool === "string" && result.tool
    ? result.tool
    : "analysis_tool";
  const lines = [`# ${markdownHeading(tool)}`];
  const body = Object.fromEntries(Object.entries(result || {}).filter(([key]) => key !== "tool"));
  appendMarkdownObject(lines, body, 2);
  return `${lines.join("\n")}\n`;
}

function createSessionAccess(
  run: ReturnType<typeof loadRun>,
  entries: AnalysisEvidenceIndexEntry[]
): AnalysisSessionAccess {
  return {
    overview(args: Row = {}) {
      const sessionId = typeof args.sessionId === "string"
        ? args.sessionId
        : run.sessionIndex.rootSessionId;
      const timeline = entries
        .filter((entry) => entry.sessionId === sessionId)
        .filter((entry) => (
          entry.kind === "message"
          && ["user", "assistant", "agent"].includes(String(entry.role || "").toLowerCase())
        ) || (
          entry.kind === "tool"
          && ["task", "subtask"].includes(String(entry.toolName || "").toLowerCase())
        ))
        .map(timelineEntry);
      const session = run.sessionIndex.sessions.find((item) => item.sessionId === sessionId) || null;
      const systemPrompts = entries
        .filter((entry) => entry.sessionId === sessionId && entry.kind === "system-prompt")
        .map(timelineEntry);
      return {
        provider: run.evidenceIndex.provider,
        rootSessionId: run.sessionIndex.rootSessionId,
        session,
        sessionTree: run.sessionIndex.tree,
        systemPrompts,
        timeline: paginate(timeline, args)
      };
    },

    listSessions(args: Row = {}) {
      const hasParentFilter = Object.prototype.hasOwnProperty.call(args, "parentSessionId");
      const sessions = (run.sessionIndex.sessions || [])
        .filter((session) => !hasParentFilter || session.parentSessionId === args.parentSessionId);
      return paginate(sessions, args) as any;
    },

    timeline(args: Row = {}) {
      const kinds = Array.isArray(args.kinds)
        ? new Set(args.kinds.map((kind) => String(kind)))
        : null;
      const matches = entries
        .filter((entry) => !args.sessionId || entry.sessionId === args.sessionId)
        .filter((entry) => !kinds || kinds.has(entry.kind))
        .map(timelineEntry);
      return paginate(matches, args);
    },

    querySystemPrompts(args: Row = {}) {
      const prompts = entries
        .filter((entry) => entry.kind === "system-prompt")
        .filter((entry) => !args.sessionId || entry.sessionId === args.sessionId);
      const page = paginate(prompts, args);
      return {
        ...page,
        items: page.items.map((entry) => projectedRecord(run, entry, args))
      };
    },

    queryErrors(args: Row = {}) {
      const errors = entries
        .filter((entry) => entry.kind === "tool" && entry.status === "error")
        .filter((entry) => !args.sessionId || entry.sessionId === args.sessionId);
      const page = paginate(errors, args);
      return {
        ...page,
        items: page.items.map((entry) => projectedRecord(run, entry, args))
      };
    },

    queryTools(args: Row = {}) {
      const status = normalizeStatus(args.status);
      const names = Array.isArray(args.names)
        ? new Set(args.names.map((name) => String(name).toLowerCase()))
        : null;
      const matches = entries
        .filter((entry) => entry.kind === "tool")
        .filter((entry) => !args.sessionId || entry.sessionId === args.sessionId)
        .filter((entry) => !names || names.has(String(entry.toolName || "").toLowerCase()))
        .filter((entry) => {
          const entryStatus = entry.status || "unknown";
          return status === "all" || status === entryStatus;
        });
      const page = paginate(matches, args);
      return {
        status,
        ...page,
        items: page.items.map((entry) => projectedRecord(run, entry, args))
      };
    },

    findAnomalies(args: Row = {}) {
      const threshold = Math.min(1, Math.max(0, Number(args.errorRateThreshold ?? 0.25)));
      const minToolCalls = boundedInteger(args.minToolCalls, 4, 1, 100000);
      const interruptions = entries
        .filter((entry) => entry.kind === "tool" && entry.status === "error")
        .filter((entry) => isInterruptionReason(entry.errorReason))
        .map((entry) => ({
          ...timelineEntry(entry),
          detector: "explicit-error-reason"
        }));
      const rankedSessions = run.sessionIndex.sessions
        .map((session) => ({
          sessionId: session.sessionId,
          evidenceId: session.evidenceId,
          title: session.title,
          parentSessionId: session.parentSessionId,
          toolCalls: Number(session.direct?.toolCalls) || 0,
          errors: Number(session.direct?.errors) || 0,
          errorRate: Number(session.direct?.errorRate) || 0
        }))
        .filter((session) => args.includeRoot === true || session.parentSessionId)
        .filter((session) => session.toolCalls >= minToolCalls)
        .sort((left, right) => right.errorRate - left.errorRate || right.errors - left.errors);
      return {
        interruptions,
        highErrorRate: {
          heuristic: true,
          threshold,
          minToolCalls,
          flagged: rankedSessions.filter((session) => session.errorRate >= threshold),
          rankedSessions
        }
      };
    },

    getContext(args: Row) {
      if (typeof args.evidenceId !== "string" || !args.evidenceId) {
        throw new Error("session_query_context requires args.evidenceId");
      }
      const conversation = entries.filter(isConversationEntry);
      const target = entries.find((entry) => entry.evidenceId === args.evidenceId);
      if (!target) {
        throw new Error(`Unknown evidence ID: ${args.evidenceId}`);
      }
      let index = conversation.findIndex((entry) => entry.evidenceId === target.evidenceId);
      if (index < 0) {
        index = conversation.findIndex((entry) => entry.sequence >= target.sequence);
        if (index < 0) index = conversation.length - 1;
      }
      const before = boundedInteger(args.before, 5, 0, 50);
      const after = boundedInteger(args.after, 5, 0, 50);
      return {
        target: timelineEntry(target),
        before,
        after,
        items: conversation
          .slice(Math.max(0, index - before), Math.min(conversation.length, index + after + 1))
          .map((entry) => projectedRecord(run, entry, args))
      };
    },

    getEvidence(args: Row) {
      if (typeof args.evidenceId !== "string" || !args.evidenceId) {
        throw new Error("session_get_evidence requires args.evidenceId");
      }
      const entry = entries.find((candidate) => candidate.evidenceId === args.evidenceId);
      if (!entry) {
        throw new Error(`Unknown evidence ID: ${args.evidenceId}`);
      }
      const offset = boundedInteger(args.offset, 0, 0, entry.byteLength);
      const maxBytes = boundedInteger(args.maxBytes, 64 * 1024, 1024, MAX_EVIDENCE_BYTES);
      const remaining = entry.byteLength - offset;
      const length = Math.min(maxBytes, remaining);
      const handle = openSync(run.evidencePath, "r");
      try {
        const buffer = Buffer.alloc(length);
        readSync(handle, buffer, 0, length, entry.offset + offset);
        const complete = offset === 0 && length === entry.byteLength;
        return {
          evidence: timelineEntry(entry),
          offset,
          returnedBytes: length,
          totalBytes: entry.byteLength,
          nextOffset: offset + length < entry.byteLength ? offset + length : null,
          complete,
          record: complete ? JSON.parse(buffer.toString("utf-8")) : null,
          content: complete ? null : buffer.toString("utf-8")
        };
      } finally {
        closeSync(handle);
      }
    }
  };
}

function createArtifactAccess(run: ReturnType<typeof loadRun>): AnalysisArtifactAccess {
  return {
    list(args: Row = {}) {
      const inventory = artifactInventory(run);
      const page = paginate(inventory.files || [], args);
      return {
        roots: inventory.roots || [],
        limits: inventory.limits || null,
        totalCapturedBytes: inventory.totalCapturedBytes || 0,
        ...page
      };
    },

    get(args: Row) {
      const inventory = artifactInventory(run);
      return readArtifactSnapshot(run, inventory, args, "artifact_get");
    }
  };
}

function createRuntimeExtensionAccess(run: ReturnType<typeof loadRun>): AnalysisRuntimeExtensionAccess {
  return {
    list(args: Row = {}) {
      const inventory = artifactInventory(run);
      if (!inventory.runtimeEnvironment) {
        return {
          legacyArtifactInventory: true,
          roots: inventory.roots || [],
          ...paginate(inventory.files || [], args)
        };
      }
      return {
        resolution: inventory.runtimeEnvironment.resolution,
        note: inventory.runtimeEnvironment.note,
        ...paginate(inventory.runtimeEnvironment.extensions || [], args)
      };
    },

    get(args: Row) {
      const inventory = artifactInventory(run);
      if (!inventory.runtimeEnvironment || !args.extensionId) {
        return readArtifactSnapshot(run, inventory, args, "extension_get");
      }
      const extension = (inventory.runtimeEnvironment.extensions || [])
        .find((entry) => entry.id === args.extensionId);
      if (!extension) {
        throw new Error("extension_get requires a selected extensionId");
      }
      return {
        extension,
        artifacts: (inventory.files || [])
          .filter((artifact) => (artifact.runtimeExtensionIds || []).includes(extension.id))
      };
    }
  };
}

function withTool(toolName: string, result: unknown) {
  const { tool: _tool, ...body } = (result && typeof result === "object" ? result : {}) as Row;
  return {
    tool: toolName,
    ...body
  };
}

export function runAnalysisTool(runDir: string, toolName: string, args: Row = {}) {
  const run = loadRun(runDir);
  const entries = run.evidenceIndex.entries as AnalysisEvidenceIndexEntry[];
  const sessionAccess = createSessionAccess(run, entries);
  const artifactAccess = createArtifactAccess(run);
  const runtimeExtensionAccess = createRuntimeExtensionAccess(run);

  if (toolName === "session_main_info" || toolName === "session_overview") {
    return withTool(toolName, sessionAccess.overview(args));
  }
  if (toolName === "session_list") {
    return withTool(toolName, sessionAccess.listSessions(args));
  }
  if (toolName === "session_timeline") {
    return withTool(toolName, sessionAccess.timeline(args));
  }
  if (toolName === "session_query_system_prompts") {
    return withTool(toolName, sessionAccess.querySystemPrompts(args));
  }
  if (toolName === "session_query_context") {
    return withTool(toolName, sessionAccess.getContext(args as any));
  }
  if (toolName === "session_query_errors") {
    return withTool(toolName, sessionAccess.queryErrors(args));
  }
  if (toolName === "session_query_tools") {
    return withTool(toolName, sessionAccess.queryTools(args));
  }
  if (toolName === "session_find_anomalies") {
    return withTool(toolName, sessionAccess.findAnomalies(args));
  }
  if (toolName === "session_get_evidence") {
    return withTool(toolName, sessionAccess.getEvidence(args as any));
  }
  if (toolName === "artifact_list") {
    return withTool(toolName, artifactAccess.list(args));
  }
  if (toolName === "artifact_get") {
    return withTool(toolName, artifactAccess.get(args));
  }
  if (toolName === "extension_list") {
    return withTool(toolName, runtimeExtensionAccess.list(args));
  }
  if (toolName === "extension_get") {
    return withTool(toolName, runtimeExtensionAccess.get(args as any));
  }

  throw new Error(`Unknown analysis tool: ${toolName}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  const runDir = process.argv[2];
  const toolName = process.argv[3];
  if (!runDir || !toolName) {
    console.error("Usage: node analysis-tools.js <runDir> <toolName> [argsJson]");
    process.exitCode = 2;
  } else {
    try {
      const args = process.argv[4] ? JSON.parse(process.argv[4]) : {};
      process.stdout.write(formatAnalysisToolOutput(runAnalysisTool(runDir, toolName, args)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
