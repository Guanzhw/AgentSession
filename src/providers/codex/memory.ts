import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ContextArtifactContentResult } from "../interface.js";
import { contextArtifact, type ContextArtifact, type ContextArtifactSourceState } from "../shared/session-protocol.js";

export interface CodexMemoryMetadata {
  artifacts: ContextArtifact[];
  sourceState: ContextArtifactSourceState;
  revision: string;
}

type MemoryField = "raw_memory" | "rollout_summary";
interface MemoryRow {
  thread_id: string;
  source_updated_at: number;
  generated_at: number;
  raw_memory: string;
  rollout_summary: string;
}

const fields: MemoryField[] = ["raw_memory", "rollout_summary"];
const requiredColumns = ["thread_id", "source_updated_at", "generated_at", ...fields];
const metadataCache = new Map<string, CodexMemoryMetadata>();
const maxCachedSessions = 128;
let cachedSignature: string | null = null;

function sourceState(sourcePath: string, state: ContextArtifactSourceState["state"], code: ContextArtifactSourceState["code"]): ContextArtifactSourceState {
  return { state, code, sourcePath, provenance: { fidelity: "recorded", sourceType: "codex.memories_1.sqlite" } };
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fileSignature(file: string): string {
  try {
    const stat = statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function columns(db: DatabaseSync, table: "stage1_outputs" | "jobs"): Set<string> {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
}

function seconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 1000);
}

function validRow(row: Record<string, unknown>, sessionId: string): row is MemoryRow & Record<string, unknown> {
  return row.thread_id === sessionId && seconds(row.source_updated_at) && seconds(row.generated_at)
    && fields.every((field) => typeof row[field] === "string");
}

function artifactPrefix(sessionId: string, field: MemoryField): string {
  return `codex:stage1:${encodeURIComponent(sessionId)}:${field}:`;
}

function artifactId(row: MemoryRow, field: MemoryField, digest: string): string {
  return `${artifactPrefix(row.thread_id, field)}${row.source_updated_at}:${row.generated_at}:${digest}`;
}

function productionEvidence(db: DatabaseSync, row: MemoryRow): ContextArtifact["productionEvidence"] {
  const schema = columns(db, "jobs");
  if (!["kind", "job_key", "status", "input_watermark", "finished_at"].every((column) => schema.has(column))) return null;
  const job = db.prepare(`SELECT kind, job_key, status, input_watermark, finished_at,
    ${schema.has("started_at") ? "started_at" : "NULL AS started_at"}
    FROM jobs WHERE kind = ? AND job_key = ?`).get("memory_stage1", row.thread_id);
  if (!job || job.kind !== "memory_stage1" || job.job_key !== row.thread_id || job.status !== "done"
    || job.input_watermark !== row.source_updated_at || job.finished_at !== row.generated_at) return null;
  return {
    provenance: { fidelity: "recorded", sourceType: "codex.memories.jobs", sourceId: `memory_stage1:${row.thread_id}` },
    startedAt: seconds(job.started_at) ? job.started_at * 1000 : null,
    completedAt: row.generated_at * 1000,
    inputUpdatedAt: row.source_updated_at * 1000
  };
}

function metadata(artifacts: ContextArtifact[], state: ContextArtifactSourceState): CodexMemoryMetadata {
  return { artifacts, sourceState: state, revision: hash(JSON.stringify({ artifacts, sourceState: state })) };
}

/** Reads only the selected PK row. Body strings never enter the bounded cache. */
function readMetadata(databasePath: string, sessionId: string): CodexMemoryMetadata {
  let db: DatabaseSync | undefined;
  try {
    if (fileSignature(databasePath) === "missing") return metadata([], sourceState(databasePath, "unavailable", "not-found"));
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec("BEGIN");
    const schema = columns(db, "stage1_outputs");
    if (!requiredColumns.every((column) => schema.has(column))) return metadata([], sourceState(databasePath, "invalid", "unsupported-schema"));
    const row = db.prepare("SELECT thread_id, source_updated_at, generated_at, raw_memory, rollout_summary FROM stage1_outputs WHERE thread_id = ?").get(sessionId);
    if (!row) return metadata([], sourceState(databasePath, "available", null));
    if (!validRow(row, sessionId)) return metadata([], sourceState(databasePath, "invalid", "invalid-record"));
    const evidence = productionEvidence(db, row);
    const artifacts = fields.map((field) => {
      const digest = hash(row[field]);
      return contextArtifact({
        id: artifactId(row, field, digest), sessionId: row.thread_id,
        kind: field === "raw_memory" ? "memory" : "summary", scope: "session", origin: "provider-generated",
        contentAccess: "full", title: null, summary: null,
        sourcePath: databasePath, producerRunId: null, lineageId: `codex:stage1:${row.thread_id}:${field}`,
        sourceSessionIds: [row.thread_id], hash: digest, redacted: false,
        provenance: { fidelity: "recorded", sourceType: "codex.memories.stage1_outputs", sourceId: `${row.thread_id}:${field}` },
        timeCreated: row.generated_at * 1000, contentSourceTime: row.source_updated_at * 1000,
        productionEvidence: evidence
      });
    });
    return metadata(artifacts, sourceState(databasePath, "available", null));
  } catch {
    return metadata([], sourceState(databasePath, "unavailable", "read-failed"));
  } finally {
    db?.close();
  }
}

/** DB/WAL changes invalidate metadata, while revisions depend only on this session's facts. */
export function readCodexMemoryMetadata(codexDir: string, sessionId: string): CodexMemoryMetadata {
  const databasePath = path.join(codexDir, "memories_1.sqlite");
  let signature: string;
  try {
    signature = `${databasePath}|${fileSignature(databasePath)}|${fileSignature(`${databasePath}-wal`)}`;
  } catch {
    return metadata([], sourceState(databasePath, "unavailable", "read-failed"));
  }
  if (signature !== cachedSignature) {
    metadataCache.clear();
    cachedSignature = signature;
  }
  const cached = metadataCache.get(sessionId);
  if (cached) {
    metadataCache.delete(sessionId);
    metadataCache.set(sessionId, cached);
    return cached;
  }
  const result = readMetadata(databasePath, sessionId);
  // Permission/locking failures can recover without a new file signature.
  if (result.sourceState.code !== "read-failed") {
    metadataCache.set(sessionId, result);
    while (metadataCache.size > maxCachedSessions) metadataCache.delete(metadataCache.keys().next().value!);
  }
  return result;
}

/** Version-checked content reads do not access session transcripts or protocol builders. */
export function readCodexMemoryContent(codexDir: string, sessionId: string, id: string): ContextArtifactContentResult {
  const field = fields.find((candidate) => id.startsWith(artifactPrefix(sessionId, candidate)));
  if (!field) return { status: "not-found" };
  const databasePath = path.join(codexDir, "memories_1.sqlite");
  let db: DatabaseSync | undefined;
  try {
    if (fileSignature(databasePath) === "missing") return { status: "unavailable", sourceState: sourceState(databasePath, "unavailable", "not-found") };
    db = new DatabaseSync(databasePath, { readOnly: true });
    const schema = columns(db, "stage1_outputs");
    if (!requiredColumns.every((column) => schema.has(column))) return { status: "unavailable", sourceState: sourceState(databasePath, "invalid", "unsupported-schema") };
    const row = db.prepare("SELECT thread_id, source_updated_at, generated_at, raw_memory, rollout_summary FROM stage1_outputs WHERE thread_id = ?").get(sessionId);
    if (!row) return { status: "not-found" };
    if (!validRow(row, sessionId)) return { status: "unavailable", sourceState: sourceState(databasePath, "invalid", "invalid-record") };
    if (artifactId(row, field, hash(row[field])) !== id) return { status: "stale" };
    return { status: "readable", artifactId: id, content: row[field], format: "markdown" };
  } catch {
    return { status: "unavailable", sourceState: sourceState(databasePath, "unavailable", "read-failed") };
  } finally {
    db?.close();
  }
}
