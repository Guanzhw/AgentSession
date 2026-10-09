// Private, file-backed evidence for benchmark subprocess and HTTP calls.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const format = 'agentsession-v3-call-evidence/v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => `${JSON.stringify(value, null, 2)}\n`;

export function serializeError(error, ancestors = new Set()) {
  if (error === null || typeof error !== 'object') return { name: 'Error', message: String(error) };
  if (ancestors.has(error)) return { name: 'Error', message: 'Circular error cause' };
  const next = new Set(ancestors).add(error);
  const result = { name: error.name ?? 'Error', message: String(error.message ?? error) };
  for (const key of ['code', 'data', 'stack']) if (error[key] !== undefined) result[key] = error[key];
  if (error.cause !== undefined) result.cause = serializeError(error.cause, next);
  if (error instanceof AggregateError) result.errors = error.errors.map(item => serializeError(item, next));
  return result;
}

export function classifyCallError(error, seen = new Set()) {
  if (error && !seen.has(error)) {
    seen.add(error);
    if (error.code === 'BENCH_TIMEOUT' || error.code === 'REQUEST_TIMEOUT' || error.name === 'TimeoutError') return 'Timeout';
    const nested = [error.cause, ...(error instanceof AggregateError ? error.errors : [])];
    if (nested.some(item => item && !seen.has(item) && classifyCallError(item, seen) === 'Timeout')) return 'Timeout';
  }
  return /^[A-Za-z][A-Za-z0-9]*$/.test(error?.name ?? '') ? error.name : 'Error';
}

export function childExitSnapshot(item) {
  const child = item.child ?? item.transport?._process;
  return { name: item.name, pid: child?.pid ?? item.transport?.pid ?? null,
    code: child?.exitCode ?? null, signal: child?.signalCode ?? null, handleAvailable: Boolean(child),
    ...(item.spawnError ? { spawnError: serializeError(item.spawnError) } : {}) };
}

export function createCallEvidence({ directory }) {
  if (!path.isAbsolute(directory)) throw new Error('Evidence directory must be absolute');
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length) throw new Error('Evidence directory must be fresh');
  const journal = { format, calls: [] };
  const journalPath = path.join(directory, 'journal.private.json');
  const saveJournal = () => writeFileSync(journalPath, jsonBytes(journal));
  saveJournal();
  return {
    directory,
    begin(request) {
      const id = String(journal.calls.length + 1).padStart(6, '0');
      const file = `${id}.begin.private.json`;
      const bytes = jsonBytes({ format, id, atUtc: new Date().toISOString(), request });
      writeFileSync(path.join(directory, file), bytes, { flag: 'wx' });
      journal.calls.push({ id, beginSha256: sha(bytes) });
      saveJournal();
      return id;
    },
    finish(id, terminal) {
      const entry = journal.calls.find(call => call.id === id);
      if (!entry || entry.terminalSha256) throw new Error(`Unknown or completed evidence call ${id}`);
      const bytes = jsonBytes({ format, id, atUtc: new Date().toISOString(), ...terminal });
      writeFileSync(path.join(directory, `${id}.terminal.private.json`), bytes, { flag: 'wx' });
      entry.terminalSha256 = sha(bytes);
      saveJournal();
    },
    audit() { return auditCallEvidence(directory); },
  };
}

export function auditCallEvidence(directory) {
  const journalBytes = readFileSync(path.join(directory, 'journal.private.json'));
  const journal = JSON.parse(journalBytes);
  if (journal.format !== format || !Array.isArray(journal.calls)) throw new Error('Invalid evidence journal');
  const issues = [], expected = new Set(['journal.private.json']), counts = {};
  let pending = 0;
  const ids = new Set();
  for (const call of journal.calls) {
    if (!/^\d{6,}$/.test(call.id) || ids.has(call.id)) { issues.push('Invalid or duplicate call id'); continue; }
    ids.add(call.id);
    let begin;
    for (const stage of ['begin', 'terminal']) {
      const name = `${call.id}.${stage}.private.json`;
      expected.add(name);
      const declared = call[`${stage}Sha256`];
      if (stage === 'terminal' && !declared) { pending++; issues.push(`Pending call ${call.id}`); continue; }
      try {
        const bytes = readFileSync(path.join(directory, name));
        if (sha(bytes) !== declared) issues.push(`Evidence hash mismatch: ${name}`);
        const value = JSON.parse(bytes);
        if (value.format !== format || value.id !== call.id) issues.push(`Evidence identity mismatch: ${name}`);
        if (stage === 'begin') begin = value;
      } catch (error) { issues.push(`${name}: ${error.message}`); }
    }
    if (begin) counts[begin.request.transport] = (counts[begin.request.transport] ?? 0) + 1;
  }
  for (const name of readdirSync(directory)) if (!expected.has(name)) issues.push(`Unlisted evidence file: ${name}`);
  return { ok: issues.length === 0, issues, calls: journal.calls.length, pending, counts, journalSha256: sha(journalBytes) };
}

async function withTimeout(operation, ms) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`Timed out after ${ms} ms`), { code: 'BENCH_TIMEOUT' })), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function recordedCall(evidence, request, operation, ms) {
  const id = evidence?.begin(request);
  const started = performance.now();
  let response;
  try { response = await withTimeout(operation, ms); }
  catch (error) {
    try { if (id) evidence.finish(id, { outcome: 'error', error: serializeError(error), wallMs: performance.now() - started }); }
    catch (captureError) { throw new AggregateError([error, captureError], error.message, { cause: error }); }
    throw error;
  }
  if (id) evidence.finish(id, { outcome: 'response', response, wallMs: performance.now() - started });
  return response;
}

export async function callMcpRaw(session, tool, args, timeoutMs, options = {}) {
  const phase = options.phase ?? session.phase ?? 'unspecified';
  return recordedCall(options.evidence ?? session.evidence, {
    transport: 'mcp', service: options.service ?? session.name ?? 'mcp',
    pid: options.pid ?? session.child?.pid ?? session.pid ?? session.transport?.pid,
    phase: typeof phase === 'function' ? phase() : phase, tool, args, timeoutMs,
  }, () => session.client.callTool({ name: tool, arguments: args }, { timeout: timeoutMs }), timeoutMs);
}

export async function callHttpRaw(url, fetchOptions = {}, options = {}) {
  const { evidence, timeoutMs = 120000, fetchImpl = fetch, phase = 'unspecified', service = 'web', pid } = options;
  const signal = fetchOptions.signal
    ? AbortSignal.any([fetchOptions.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  return recordedCall(evidence, {
    transport: 'http', service, pid, phase: typeof phase === 'function' ? phase() : phase,
    url: String(url), method: fetchOptions.method ?? 'GET', body: fetchOptions.body, timeoutMs,
  }, async () => {
    const response = await fetchImpl(url, { ...fetchOptions, signal });
    const text = await response.text();
    return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), text };
  }, timeoutMs);
}

// Promise.all rejects before peer operations have reached their terminal records.
export async function settleCalls(promises) {
  let failure;
  const results = await Promise.allSettled(promises.map(promise => Promise.resolve(promise).catch(error => {
    failure ??= error;
    throw error;
  })));
  if (failure !== undefined) throw failure;
  return results.map(result => result.value);
}
