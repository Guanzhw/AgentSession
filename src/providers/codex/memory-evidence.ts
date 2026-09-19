import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ContextArtifact, ContextArtifactEvidenceActivity, ContextArtifactEvidenceRecord,
  ContextArtifactEvidenceRequest, ContextArtifactEvidenceResult, ContextArtifactSourceState,
  EventProvenance
} from "../shared/session-protocol.js";
import { readCodexMemoryContent, readCodexMemoryMetadata } from "./memory.js";
import { parseCodexMemoryRequest, parseCodexMemorySubmission, type CodexMemoryLogOperation } from "./memory-evidence-parser.js";

const limits = { metadata: 2048, bytes: 1024 * 1024, recordBytes: 128 * 1024, fileBytes: 256 * 1024 };
const submissionTarget = "codex_core::session::handlers";
const requestTarget = "codex_core::stream_events_utils";
type Position = [number, number, number];
type Binding = ContextArtifactEvidenceActivity["binding"];
interface LogMetadata { id: number; ts: number; ts_nanos: number; target: string; thread_id: string | null; bytes: number }
interface Locator { rowId: number; hash: string }
interface PendingThread {
  submission: LogMetadata;
  submissionHash: string;
  turnId: string;
  phase: "binding" | "records";
  after: Position;
  binding?: Binding;
  read?: { locator: Locator; operation: CodexMemoryLogOperation };
  bindingRow?: { locator: Locator; nextOperation: number };
}
interface ScanState {
  directory: string;
  artifactId: string;
  databaseIdentity: string;
  from: number;
  to: number;
  highWater: number;
  upper: Position;
  after: Position;
  pending: PendingThread | null;
  done: boolean;
  issues: string[];
  scannedRecords: number;
  readBytes: number;
}
interface RecordProof {
  locator: Locator;
  submission: Locator;
  threadId: string;
  turnId: string;
  kind: ContextArtifactEvidenceRecord["kind"];
  targetPath: string;
  binding: Binding;
  read: PendingThread["read"];
}
interface Budget { scanned: number; bytes: number }
type BindingCheck = { binding: Binding } | { issue: string } | { budget: true } | null;

// These caches contain selectors and positions, never diagnostic or memory bodies.
// A restart/eviction requires a fresh lookup instead of accepting a caller-supplied log row.
const cursors = new Map<string, ScanState>();
const recordProofs = new Map<string, RecordProof>();

function remember<T>(cache: Map<string, T>, key: string, value: T, maximum: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maximum) cache.delete(cache.keys().next().value!);
}

function hash(content: string | Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }
function position(row: LogMetadata): Position { return [row.ts, row.ts_nanos, row.id]; }
function lowerPosition(time: number): Position { return [Math.floor(time / 1000), time % 1000 * 1_000_000, -1]; }
function upperPosition(time: number): Position { return [Math.floor(time / 1000), time % 1000 * 1_000_000 + 999_999, Number.MAX_SAFE_INTEGER]; }
function timeCreated(row: LogMetadata): number { return row.ts * 1000 + Math.floor(row.ts_nanos / 1_000_000); }
function provenance(id: number): EventProvenance {
  return { fidelity: "recorded", sourceType: "codex.logs_2.sqlite.logs", sourceId: String(id) };
}
function issue(state: ScanState, code: string): void { if (!state.issues.includes(code)) state.issues.push(code); }
function proofKey(directory: string, artifactId: string, recordId: string): string { return `${directory}\0${artifactId}\0${recordId}`; }
function unavailable(sourcePath: string, code: ContextArtifactSourceState["code"]): ContextArtifactEvidenceResult {
  return { status: "unavailable", sourceState: {
    state: code === "unsupported-schema" || code === "invalid-record" ? "invalid" : "unavailable",
    code, sourcePath, provenance: { fidelity: "recorded", sourceType: "codex.logs_2.sqlite" }
  } };
}

class InvalidStore extends Error {
  constructor(readonly code: "unsupported-schema" | "invalid-record") { super(code); }
}

function checkSchema(db: DatabaseSync): void {
  const columns = new Set(db.prepare("PRAGMA table_info(logs)").all().map(row => row.name));
  if (!["id", "ts", "ts_nanos", "target", "thread_id", "feedback_log_body"].every(name => columns.has(name))) throw new InvalidStore("unsupported-schema");
  for (const [name, expected] of [["idx_logs_ts", ["ts", "ts_nanos", "id"]], ["idx_logs_thread_id_ts", ["thread_id", "ts", "ts_nanos", "id"]]] as const) {
    const actual = db.prepare(`PRAGMA index_info(${name})`).all().map(row => row.name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new InvalidStore("unsupported-schema");
  }
}

function metadata(row: Record<string, unknown> | undefined): LogMetadata | null {
  if (!row) return null;
  if (![row.id, row.ts, row.ts_nanos, row.bytes].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(Number(row.ts) * 1000) || Number(row.ts_nanos) >= 1_000_000_000
    || typeof row.target !== "string" || (row.thread_id !== null && typeof row.thread_id !== "string")) throw new InvalidStore("invalid-record");
  return row as unknown as LogMetadata;
}

const metadataFields = "id, ts, ts_nanos, target, thread_id, coalesce(octet_length(feedback_log_body), 0) AS bytes";

function nextMetadata(db: DatabaseSync, state: ScanState): LogMetadata | null {
  const pending = state.pending;
  const index = pending ? "idx_logs_thread_id_ts" : "idx_logs_ts";
  const where = pending ? "thread_id = ? AND " : "";
  const parameters = pending ? [pending.submission.thread_id, ...pending.after, ...state.upper] : [...state.after, ...state.upper];
  return metadata(db.prepare(`SELECT ${metadataFields} FROM logs INDEXED BY ${index}
    WHERE ${where}(ts, ts_nanos, id) > (?, ?, ?) AND (ts, ts_nanos, id) <= (?, ?, ?)
    ORDER BY ts, ts_nanos, id LIMIT 1`).get(...parameters));
}

function rowBody(db: DatabaseSync, row: LogMetadata, budget: Budget): string | null {
  const value = db.prepare("SELECT feedback_log_body FROM logs WHERE id = ?").get(row.id)?.feedback_log_body;
  if (typeof value !== "string") return null;
  budget.bytes += row.bytes;
  return value;
}

function summaryPath(operation: CodexMemoryLogOperation): string | null {
  const segments = operation.targetPath.replace(/\\/g, "/").split("/");
  if (!segments.includes("rollout_summaries")) return null;
  if (!operation.workdir || !path.isAbsolute(operation.workdir)) return null;
  return path.resolve(operation.workdir, operation.targetPath.replace(/[\\/]/g, path.sep));
}

function checkBinding(directory: string, artifact: ContextArtifact, summary: string, operation: CodexMemoryLogOperation, budget: Budget): BindingCheck {
  const selected = summaryPath(operation);
  if (!selected) return null;
  let descriptor: number | undefined;
  try {
    const root = realpathSync(path.join(directory, "memories", "rollout_summaries"));
    const resolved = realpathSync(selected);
    const relative = path.relative(root, resolved);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return { issue: "summary-path-outside-root" };
    descriptor = openSync(resolved, "r");
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { issue: "summary-file-mismatch" };
    if (stat.size > limits.fileBytes) return { issue: "summary-file-too-large" };
    if (budget.bytes + stat.size + 1 > limits.bytes) return { budget: true };
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!count) break;
      bytesRead += count;
    }
    budget.bytes += bytesRead;
    if (bytesRead !== stat.size) return { issue: "summary-file-mismatch" };
    const content = buffer.toString("utf8", 0, bytesRead);
    const sourceId = /^thread_id: ([^\r\n]+)$/m.exec(content)?.[1];
    const updated = /^updated_at: ([^\r\n]+)$/m.exec(content)?.[1];
    const rollout = /^rollout_path: ([^\r\n]+)$/m.exec(content)?.[1]?.replace(/\\/g, "/").split("/").at(-1);
    if (sourceId && sourceId !== artifact.sessionId) return null;
    if (sourceId !== artifact.sessionId || Date.parse(updated ?? "") !== artifact.contentSourceTime
      || !rollout || !(rollout.endsWith(`-${artifact.sessionId}.jsonl`) || rollout.endsWith(`-${artifact.sessionId}.jsonl.zst`))
      || !summary || !content.includes(summary)) return { issue: "summary-file-mismatch" };
    return { binding: {
      sourcePath: resolved, fileHash: hash(buffer.subarray(0, bytesRead)), checkedAt: Date.now(),
      sourceSessionId: artifact.sessionId, sourceUpdatedAt: artifact.contentSourceTime!,
      provenance: { fidelity: "derived", sourceType: "codex.memory-summary-file", sourceId: artifact.id }
    } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { issue: "summary-file-missing" };
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function recordFor(directory: string, artifact: ContextArtifact, pending: PendingThread, row: LogMetadata, body: string, operation: CodexMemoryLogOperation): ContextArtifactEvidenceRecord {
  const targetPath = operation.kind === "read-request" ? pending.binding!.sourcePath : operation.targetPath;
  const digest = hash(body);
  const id = `codex:memory-log:${row.id}:${hash(`${artifact.id}\0${pending.turnId}\0${operation.kind}\0${targetPath}\0${digest}`)}`;
  remember(recordProofs, proofKey(directory, artifact.id, id), {
    locator: { rowId: row.id, hash: digest }, threadId: row.thread_id!, turnId: pending.turnId,
    submission: { rowId: pending.submission.id, hash: pending.submissionHash },
    kind: operation.kind, targetPath, binding: pending.binding!, read: pending.read
  }, 2048);
  return { id, kind: operation.kind, targetPath, timeCreated: timeCreated(row), provenance: provenance(row.id), contentLength: operation.content.length };
}

function appendActivity(activities: Map<string, ContextArtifactEvidenceActivity>, artifact: ContextArtifact, pending: PendingThread, record: ContextArtifactEvidenceRecord): void {
  const id = `codex:memory-followup:${hash(`${artifact.id}\0${pending.submission.thread_id}\0${pending.turnId}\0${pending.binding!.fileHash}`)}`;
  let activity = activities.get(id);
  if (!activity) {
    activity = { id, sessionId: pending.submission.thread_id!, turnId: pending.turnId,
      timeCreated: timeCreated(pending.submission), provenance: provenance(pending.submission.id),
      historyAvailability: "unavailable", binding: pending.binding!, records: [] };
    activities.set(id, activity);
  }
  if (!activity.records.some(item => item.id === record.id)) activity.records.push(record);
}

function contentResult(db: DatabaseSync, directory: string, artifact: ContextArtifact, summary: string, recordId: string): ContextArtifactEvidenceResult {
  if (!/^codex:memory-log:\d+:[a-f0-9]{64}$/.test(recordId)) return { status: "invalid" };
  const proof = recordProofs.get(proofKey(directory, artifact.id, recordId));
  if (!proof) return { status: "stale" };
  const budget: Budget = { scanned: 0, bytes: 0 };
  const row = metadata(db.prepare(`SELECT ${metadataFields} FROM logs WHERE id = ?`).get(proof.locator.rowId));
  if (!row || row.bytes > limits.recordBytes || row.thread_id !== proof.threadId || row.target !== requestTarget) return { status: "stale" };
  const body = rowBody(db, row, budget);
  if (!body || hash(body) !== proof.locator.hash) return { status: "stale" };
  const request = parseCodexMemoryRequest(body, proof.threadId);
  if (!request || request.turnId !== proof.turnId) return { status: "stale" };
  const submission = metadata(db.prepare(`SELECT ${metadataFields} FROM logs WHERE id = ?`).get(proof.submission.rowId));
  if (!submission || submission.bytes > limits.recordBytes) return { status: "stale" };
  const submissionBody = rowBody(db, submission, budget);
  if (!submissionBody || hash(submissionBody) !== proof.submission.hash) return { status: "stale" };
  const binding = checkBinding(directory, artifact, summary, proof.read!.operation, budget);
  if (!binding || !("binding" in binding) || binding.binding.fileHash !== proof.binding.fileHash) return { status: "stale" };
  const readRow = metadata(db.prepare(`SELECT ${metadataFields} FROM logs WHERE id = ?`).get(proof.read!.locator.rowId));
  if (!readRow || readRow.bytes > limits.recordBytes || budget.bytes + readRow.bytes > limits.bytes) return { status: "stale" };
  const readBody = rowBody(db, readRow, budget);
  if (!readBody || hash(readBody) !== proof.read!.locator.hash) return { status: "stale" };
  const operation = request.operations.find(item => item.kind === proof.kind
    && (item.kind === "read-request" ? summaryPath(item) === summaryPath(proof.read!.operation) : item.targetPath === proof.targetPath));
  return operation ? { status: "content", artifactId: artifact.id, recordId, content: operation.content } : { status: "stale" };
}

function readPage(db: DatabaseSync, directory: string, artifact: ContextArtifact, summary: string, state: ScanState): ContextArtifactEvidenceResult {
  const budget: Budget = { scanned: 0, bytes: 0 };
  const activities = new Map<string, ContextArtifactEvidenceActivity>();
  let pause: string | null = null;
  if (state.pending) {
    const pending = state.pending;
    const locators = [{ rowId: pending.submission.id, hash: pending.submissionHash }, ...(pending.read ? [pending.read.locator] : [])];
    for (const locator of locators) {
      const row = metadata(db.prepare(`SELECT ${metadataFields} FROM logs WHERE id = ?`).get(locator.rowId));
      budget.scanned++;
      if (!row || row.bytes > limits.recordBytes) return { status: "stale" };
      const body = rowBody(db, row, budget);
      if (!body || hash(body) !== locator.hash) return { status: "stale" };
    }
    if (pending.binding) {
      const checked = checkBinding(directory, artifact, summary, pending.read!.operation, budget);
      if (!checked || !("binding" in checked) || checked.binding.fileHash !== pending.binding.fileHash) return { status: "stale" };
      pending.binding = checked.binding;
    }
  }
  while (!state.done && budget.scanned < limits.metadata) {
    const row = nextMetadata(db, state);
    if (!row) {
      if (state.pending?.bindingRow) return { status: "stale" };
      if (state.pending) { state.pending = null; continue; }
      state.done = true;
      break;
    }
    budget.scanned++;
    const advance = () => { if (state.pending) state.pending.after = position(row); else state.after = position(row); };
    const expectedTarget = state.pending ? requestTarget : submissionTarget;
    if (row.id > state.highWater || row.target !== expectedTarget || !row.thread_id || !row.bytes) { advance(); continue; }
    if (row.bytes > limits.recordBytes) { issue(state, "record-too-large"); advance(); continue; }
    if (budget.bytes + row.bytes > limits.bytes) { pause = "byte-budget"; break; }
    const body = rowBody(db, row, budget);
    if (!body) { issue(state, "retained-record-missing"); advance(); continue; }
    if (!state.pending) {
      const turnId = parseCodexMemorySubmission(body, row.thread_id);
      advance();
      if (turnId) state.pending = { submission: row, submissionHash: hash(body), turnId, phase: "binding", after: lowerPosition(state.from) };
      continue;
    }
    const pending = state.pending;
    if (pending.bindingRow && (pending.bindingRow.locator.rowId !== row.id || pending.bindingRow.locator.hash !== hash(body))) return { status: "stale" };
    const request = parseCodexMemoryRequest(body, row.thread_id);
    if (!request || request.turnId !== pending.turnId) { advance(); continue; }
    if (request.unsupported) issue(state, "unsupported-record");
    if (pending.phase === "binding") {
      let found: Binding | null = null;
      let read: CodexMemoryLogOperation | null = null;
      for (let index = pending.bindingRow?.nextOperation ?? 0; index < request.operations.length; index++) {
        const operation = request.operations[index];
        if (operation.kind !== "read-request") continue;
        const checked = checkBinding(directory, artifact, summary, operation, budget);
        if (checked && "budget" in checked) {
          pending.bindingRow = { locator: { rowId: row.id, hash: hash(body) }, nextOperation: index };
          pause = "byte-budget";
          break;
        }
        if (checked && "issue" in checked) issue(state, checked.issue);
        if (checked && "binding" in checked) { found = checked.binding; read = operation; break; }
      }
      if (pause) break;
      delete pending.bindingRow;
      if (found) {
        pending.binding = found;
        pending.read = { locator: { rowId: row.id, hash: hash(body) }, operation: { ...read!, content: "" } };
        pending.phase = "records";
        pending.after = lowerPosition(state.from);
      } else advance();
      continue;
    }
    for (const operation of request.operations) {
      if (operation.kind === "read-request" && summaryPath(operation) !== summaryPath(pending.read!.operation)) continue;
      if (operation.kind === "modification-request" && !path.isAbsolute(operation.targetPath)) { issue(state, "unsupported-record"); continue; }
      appendActivity(activities, artifact, pending, recordFor(directory, artifact, pending, row, body, operation));
    }
    advance();
  }
  if (!state.done && !pause && budget.scanned >= limits.metadata) pause = "metadata-budget";
  state.scannedRecords += budget.scanned;
  state.readBytes += budget.bytes;
  let nextCursor: string | null = null;
  if (!state.done) {
    nextCursor = randomUUID();
    remember(cursors, nextCursor, structuredClone(state), 64);
  }
  return {
    status: "page", artifactId: artifact.id,
    revision: hash(`${artifact.id}\0${state.databaseIdentity}\0${state.highWater}\0${state.from}\0${state.to}`),
    coverage: { from: state.from, to: state.to, scannedRecords: state.scannedRecords, readBytes: state.readBytes,
      complete: state.done && state.issues.length === 0, issues: [...state.issues, ...(pause ? [pause] : [])] },
    activities: [...activities.values()], nextCursor
  };
}

/** On-demand, read-only log evidence; normal memory/protocol revisions never call this. */
export function readCodexMemoryEvidence(codexDir: string, sessionId: string, artifactId: string, request: ContextArtifactEvidenceRequest): ContextArtifactEvidenceResult {
  const directory = path.resolve(codexDir);
  if (!artifactId.startsWith(`codex:stage1:${encodeURIComponent(sessionId)}:rollout_summary:`)) return { status: "not-found" };
  const content = readCodexMemoryContent(directory, sessionId, artifactId);
  if (content.status !== "readable") return content;
  const artifact = readCodexMemoryMetadata(directory, sessionId).artifacts.find(item => item.id === artifactId);
  if (!artifact) return { status: "stale" };
  const databasePath = path.join(directory, "logs_2.sqlite");
  let db: DatabaseSync | undefined;
  try {
    const stat = statSync(databasePath, { bigint: true });
    const databaseIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec("BEGIN");
    checkSchema(db);
    if (request.mode === "content") return contentResult(db, directory, artifact, content.content, request.recordId);
    let state: ScanState;
    if (request.cursor) {
      const saved = cursors.get(request.cursor);
      if (!saved) return { status: "invalid" };
      if (saved.directory !== directory || saved.artifactId !== artifactId
        || (request.from !== undefined && request.from !== saved.from) || (request.to !== undefined && request.to !== saved.to)) return { status: "invalid" };
      if (saved.databaseIdentity !== databaseIdentity) return { status: "stale" };
      state = structuredClone(saved);
    } else {
      const from = request.from ?? artifact.timeCreated!;
      const to = request.to ?? from + 60 * 60 * 1000;
      if (![from, to].every(value => Number.isSafeInteger(value) && value >= 0) || to < from) return { status: "invalid" };
      const highWater = Number(db.prepare("SELECT coalesce(max(id), 0) AS id FROM logs").get()!.id);
      const last = db.prepare(`SELECT ts, ts_nanos, id FROM logs INDEXED BY idx_logs_ts
        WHERE (ts, ts_nanos, id) > (?, ?, ?) AND (ts, ts_nanos, id) <= (?, ?, ?)
        ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT 1`).get(...lowerPosition(from), ...upperPosition(to));
      state = { directory, artifactId, databaseIdentity, from, to, highWater,
        upper: last ? [Number(last.ts), Number(last.ts_nanos), Number(last.id)] : upperPosition(to),
        after: lowerPosition(from), pending: null, done: !last,
        issues: [], scannedRecords: 0, readBytes: 0 };
    }
    return readPage(db, directory, artifact, content.content, state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return unavailable(databasePath, "not-found");
    return unavailable(databasePath, error instanceof InvalidStore ? error.code : "read-failed");
  } finally { db?.close(); }
}
