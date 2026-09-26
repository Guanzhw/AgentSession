import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { zstdDecompressSync } from 'node:zlib';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--manifest') {
  console.error('Usage: node probe.mjs --manifest FILE');
  process.exit(2);
}
const manifest = resolve(args[1]);
const entries = JSON.parse(readFileSync(manifest, 'utf8'));
if (!Array.isArray(entries) || entries.some(x => typeof x !== 'string' || !x)) {
  throw new Error('Manifest must be a JSON array of file paths');
}
const paths = entries.map(x => isAbsolute(x) ? x : resolve(dirname(manifest), x));
const inputHash = createHash('sha256');
const outputHash = createHash('sha256');
const counts = { files: paths.length, compressedFiles: 0, inputBytes: 0, decodedBytes: 0, lines: 0, records: 0, malformed: 0, types: {} };
const timings = { readMs: 0, decompressMs: 0, parseMs: 0, totalMs: 0 };
let peakRssBytes = process.resourceUsage().maxRSS * 1024;
const started = performance.now();
const cpuStarted = process.cpuUsage();

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}
function field(value) {
  const bytes = Buffer.from(value, 'utf8');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bytes.length);
  outputHash.update(size).update(bytes);
}
function inspectLine(line, fileIndex, lineIndex) {
  if (line.length === 0 || !line.toString('utf8').trim()) return;
  counts.lines++;
  let record;
  let parsed = false;
  try {
    record = JSON.parse(line.toString('utf8').trim());
    parsed = true;
  } catch {
    record = null;
  }
  const valid = parsed && record !== null && typeof record === 'object' && !Array.isArray(record);
  const type = valid && typeof record.type === 'string' ? record.type : '';
  const payloadType = valid && record.payload && typeof record.payload.type === 'string' ? record.payload.type : '';
  if (valid) {
    counts.records++;
    counts.types[type] = (counts.types[type] ?? 0) + 1;
  } else {
    counts.malformed++;
  }
  outputHash.update(u64(fileIndex)).update(u64(lineIndex));
  outputHash.update(Buffer.from([valid ? 1 : 0]));
  outputHash.update(createHash('sha256').update(line).digest());
  field(type);
  field(payloadType);
}

for (const [fileIndex, path] of paths.entries()) {
  const readStart = performance.now();
  const source = readFileSync(path);
  timings.readMs += performance.now() - readStart;
  counts.inputBytes += source.length;
  inputHash.update(u64(fileIndex)).update(u64(source.length)).update(source);
  const compressed = path.toLowerCase().endsWith('.jsonl.zst');
  if (!compressed && !path.toLowerCase().endsWith('.jsonl')) throw new Error('Unsupported extension');
  let decoded = source;
  if (compressed) {
    counts.compressedFiles++;
    const decompressStart = performance.now();
    decoded = zstdDecompressSync(source);
    timings.decompressMs += performance.now() - decompressStart;
  }
  counts.decodedBytes += decoded.length;
  const parseStart = performance.now();
  let lineIndex = 0;
  let start = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] !== 10) continue;
    inspectLine(decoded.subarray(start, i), fileIndex, lineIndex++);
    start = i + 1;
  }
  if (start < decoded.length) inspectLine(decoded.subarray(start), fileIndex, lineIndex);
  timings.parseMs += performance.now() - parseStart;
  peakRssBytes = Math.max(peakRssBytes, process.resourceUsage().maxRSS * 1024);
}
timings.totalMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStarted);
timings.cpuMs = (cpu.user + cpu.system) / 1000;
counts.types = Object.fromEntries(Object.entries(counts.types).sort(([a], [b]) => a.localeCompare(b, 'en')));
console.log(JSON.stringify({ counts, inputSha256: inputHash.digest('hex'), outputSha256: outputHash.digest('hex'), timings, peakRssBytes }));
