import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLASSIFICATIONS = new Set([
  'proved-request',
  'proved-mirror',
  'proved-parent-copy',
  'proved-context-snapshot',
  'unresolved',
]);
const VECTOR_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];
const USAGE_KINDS = new Set(['request', 'legacy', 'usage']);

class CertificateVerifierError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function verifierError(code, message) {
  return new CertificateVerifierError(code, message);
}

// This validates a hand-curated certificate set against its supplied source
// bundle. It does not enumerate or classify unlisted provider records.
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      lines.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

function parseSource(bytes) {
  const lines = sourceLines(bytes);
  const rows = lines.map((line, index) => {
    try {
      const value = JSON.parse(line.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw verifierError('SOURCE_JSONL_INVALID', `Invalid JSONL source row ${index + 1}`);
    }
  });
  return { bytes, lines, rows };
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isExplicitId(value) {
  return typeof value === 'string' && value.length > 0;
}

function completeVector(value) {
  return isObject(value) && VECTOR_KEYS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function equalVector(left, right) {
  return completeVector(left) && completeVector(right) && VECTOR_KEYS.every(key => left[key] === right[key]);
}

function addVectors(left, right) {
  if (!completeVector(left) || !completeVector(right)) return null;
  const sum = Object.fromEntries(VECTOR_KEYS.map(key => [key, left[key] + right[key]]));
  return completeVector(sum) ? sum : null;
}

function witness(refs, role) {
  const ref = refs.get(role);
  return ref?.row ? ref : null;
}

function ownerWitness(refs, role, ownerId) {
  const ref = witness(refs, role);
  return ref && ref.row.kind === 'owner' && ref.row.ownerId === ownerId ? ref : null;
}

function checkRequest(certificate, selected, refs, sources) {
  const ownerId = certificate.ownerEvidence.ownerId;
  const responseId = certificate.identityEvidence.responseId;
  if (selected.kind !== 'request' || !isExplicitId(ownerId) || selected.ownerId !== ownerId) return 'request owner is not explicit';
  const owner = ownerWitness(refs, 'owner', ownerId);
  if (!owner || owner.source !== certificate.source || owner.line >= certificate.line) return 'owner witness is missing, late, or differs';
  if (!isExplicitId(responseId) || selected.responseId !== responseId) return 'response identity is not recorded';
  if (!completeVector(selected.request)) return 'complete six-field request vector is missing';
  const matches = [...sources.values()].flatMap(source => source.rows)
    .filter(row => row.kind === 'request' && row.ownerId === ownerId && row.responseId === responseId);
  if (matches.length !== 1) return 'response identity is not unique within the supplied source bundle';
  return null;
}

function checkMirrorSequence(source, ownerId, baselineLine, canonicalLine, selectedLine, baseline) {
  for (let line = baselineLine + 1; line < selectedLine; line += 1) {
    const row = source.rows[line - 1];
    if (row.kind === 'owner') return 'owner boundary interrupts the proof';
    if (!USAGE_KINDS.has(row.kind)) continue;
    if (line !== canonicalLine || row.kind !== 'request') return 'an additional usage row interrupts the mirror proof';
    if (row.ownerId !== ownerId) return 'usage owner is unknown or changed';
    if (!completeVector(row.cumulative)) return 'cumulative evidence is incomplete';
    if (VECTOR_KEYS.some(key => row.cumulative[key] < baseline[key])) return 'cumulative decrease ends the proof';
  }
  return null;
}

function checkMirror(certificate, selected, refs, sources) {
  const ownerId = certificate.ownerEvidence.ownerId;
  const responseId = certificate.identityEvidence.responseId;
  const owner = ownerWitness(refs, 'owner', ownerId);
  const canonical = witness(refs, 'canonical-request');
  const baseline = witness(refs, 'baseline');
  if (selected.kind !== 'legacy' || !isExplicitId(ownerId) || selected.ownerId !== ownerId || !owner) return 'explicit mirror owner evidence is missing';
  if (!isExplicitId(responseId) || owner.source !== certificate.source || !canonical || canonical.row.kind !== 'request' || canonical.row.responseId !== responseId) return 'canonical response identity or owner witness is missing';
  if (canonical.row.ownerId !== ownerId || canonical.source !== certificate.source || owner.source !== certificate.source) return 'canonical response owner differs';
  const responseMatches = [...sources.values()].flatMap(source => source.rows)
    .filter(row => row.kind === 'request' && row.ownerId === ownerId && row.responseId === responseId);
  if (responseMatches.length !== 1) return 'response identity is not unique within the supplied source bundle';
  if (!baseline || baseline.source !== certificate.source || !['baseline', 'request', 'legacy'].includes(baseline.row.kind) || baseline.row.ownerId !== ownerId) return 'cumulative baseline is missing';
  if (!(owner.line < baseline.line && baseline.line < canonical.line && canonical.line < certificate.line)) return 'mirror evidence is out of order';
  if (!completeVector(canonical.row.request) || !completeVector(canonical.row.cumulative) ||
      !completeVector(selected.request) || !completeVector(selected.cumulative) || !completeVector(baseline.row.cumulative)) return 'full request and cumulative vectors are required';
  if (!equalVector(canonical.row.request, selected.request) || !equalVector(canonical.row.cumulative, selected.cumulative)) return 'legacy request and cumulative vectors differ from the response';
  if (!equalVector(addVectors(baseline.row.cumulative, canonical.row.request), canonical.row.cumulative)) return 'baseline does not add to the canonical cumulative vector';
  const sequenceFailure = checkMirrorSequence(sources.get(certificate.source), ownerId, baseline.line, canonical.line, certificate.line, baseline.row.cumulative);
  if (sequenceFailure) return sequenceFailure;
  return null;
}

function checkParentCopy(certificate, selected, refs, sources) {
  const parentId = certificate.ownerEvidence.parentOwner;
  const childId = certificate.ownerEvidence.childOwner;
  const parentOwner = witness(refs, 'parent-owner');
  const childOwner = witness(refs, 'child-owner');
  const parentContent = witness(refs, 'parent-content');
  const childContent = witness(refs, 'child-content');
  const parentUsage = witness(refs, 'parent-usage');
  const boundary = witness(refs, 'dispatch-boundary');
  if (!isExplicitId(parentId) || !isExplicitId(childId) || parentId === childId || selected.kind !== 'usage' || selected.ownerId !== childId) return 'parent and child owners are not explicit';
  if (!parentOwner || parentOwner.row.kind !== 'owner' || parentOwner.row.ownerId !== parentId) return 'parent owner witness is missing';
  if (!childOwner || childOwner.row.kind !== 'owner' || childOwner.row.ownerId !== childId || childOwner.row.parentId !== parentId) return 'child parent link is missing';
  if (!boundary || boundary.row.kind !== 'boundary' || boundary.row.ownerId !== parentId || boundary.row.childId !== childId || boundary.row.marker !== 'NEW_TASK' ||
      !isExplicitId(boundary.row.taskId) || childOwner.row.parentTaskId !== boundary.row.taskId || certificate.identityEvidence.taskId !== boundary.row.taskId) return 'NEW_TASK boundary is missing or ambiguous';
  const boundaryMatches = [...sources.entries()].flatMap(([sourceId, source]) => source.rows
    .map((row, index) => ({ source: sourceId, line: index + 1, row }))
    .filter(({ row }) => row.kind === 'boundary' && row.ownerId === parentId && row.childId === childId && row.taskId === boundary.row.taskId && row.marker === 'NEW_TASK'));
  if (boundaryMatches.length !== 1 || boundaryMatches[0].source !== boundary.source || boundaryMatches[0].line !== boundary.line) return 'NEW_TASK boundary is not unique within the supplied source bundle';
  if (!parentContent || !childContent || parentContent.row.kind !== 'content' || childContent.row.kind !== 'content') return 'unique content witness is missing';
  if (parentOwner.source !== boundary.source || parentContent.source !== boundary.source || parentUsage?.source !== boundary.source ||
      childContent.source !== certificate.source || childOwner.source !== certificate.source || boundary.source === certificate.source) return 'content witnesses cross the wrong source boundary';
  if (parentContent.row.ownerId !== parentId || childContent.row.ownerId !== childId || parentUsage?.row.kind !== 'usage' || parentUsage.row.ownerId !== parentId) return 'content or parent usage owner differs';
  const content = parentContent.row.text;
  if (typeof content !== 'string' || content !== childContent.row.text || sha256(Buffer.from(content, 'utf8')) !== certificate.identityEvidence.contentSha256) return 'content identity differs';
  const contentMatches = [...sources.entries()].flatMap(([sourceId, source]) => source.rows
    .map((row, index) => ({ source: sourceId, line: index + 1, row }))
    .filter(({ row }) => row.kind === 'content' && row.text === content));
  const parentContentMatches = contentMatches.filter(({ row }) => row.ownerId === parentId);
  const childContentMatches = contentMatches.filter(({ row }) => row.ownerId === childId);
  if (contentMatches.length !== 2 || parentContentMatches.length !== 1 || childContentMatches.length !== 1 ||
      parentContentMatches[0].source !== parentContent.source || parentContentMatches[0].line !== parentContent.line ||
      childContentMatches[0].source !== childContent.source || childContentMatches[0].line !== childContent.line) return 'content witness is not unique within the supplied source bundle';
  if (!(parentOwner.line < parentContent.line && parentContent.line < parentUsage.line && parentUsage.line < boundary.line &&
        childOwner.line < childContent.line && childContent.line < certificate.line)) return 'parent-copy witnesses are out of order';
  const parentSource = sources.get(parentUsage.source);
  for (let line = parentOwner.line + 1; line < boundary.line; line += 1) {
    const row = parentSource.rows[line - 1];
    if (row.kind === 'owner') return 'parent owner boundary interrupts the copy proof';
    if (line > parentContent.line && USAGE_KINDS.has(row.kind) && line !== parentUsage.line) return 'additional parent usage interrupts the copy proof';
  }
  const childSource = sources.get(certificate.source);
  for (let line = childOwner.line + 1; line < certificate.line; line += 1) {
    const row = childSource.rows[line - 1];
    if (row.kind === 'owner') return 'child owner boundary interrupts the copy proof';
    if (USAGE_KINDS.has(row.kind)) return 'additional child usage interrupts the copy proof';
  }
  if (!completeVector(parentUsage.row.request) || !completeVector(parentUsage.row.cumulative) ||
      !equalVector(parentUsage.row.request, selected.request) || !equalVector(parentUsage.row.cumulative, selected.cumulative)) return 'copied usage differs from the parent witness';
  return null;
}

function checkContextSnapshot(certificate, selected, refs, sources) {
  const ownerId = certificate.ownerEvidence.ownerId;
  const owner = ownerWitness(refs, 'owner', ownerId);
  const baseline = witness(refs, 'baseline');
  const compaction = witness(refs, 'compaction');
  if (selected.kind !== 'legacy' || !isExplicitId(ownerId) || selected.ownerId !== ownerId || !owner) return 'context snapshot owner is not explicit';
  if (!baseline || baseline.source !== certificate.source || !['legacy', 'request'].includes(baseline.row.kind) || baseline.row.ownerId !== ownerId) return 'complete cumulative baseline is missing';
  if (!compaction || compaction.source !== certificate.source || compaction.row.kind !== 'compaction' || compaction.row.ownerId !== ownerId || compaction.row.marker !== 'compacted') return 'compaction marker is missing';
  if (owner.source !== certificate.source || !(owner.line < baseline.line && baseline.line < compaction.line && compaction.line < certificate.line)) return 'context evidence is out of order';
  if (!completeVector(selected.request) || !completeVector(selected.cumulative) || !completeVector(baseline.row.cumulative)) return 'full context and cumulative vectors are required';
  if (VECTOR_KEYS.slice(0, -1).some(key => selected.request[key] !== 0) || selected.request.total_tokens <= 0) return 'request vector is not a total-only context snapshot';
  if (!equalVector(selected.cumulative, baseline.row.cumulative)) return 'cumulative vector changed across compaction';
  const source = sources.get(certificate.source);
  for (let line = baseline.line + 1; line < certificate.line; line += 1) {
    const row = source.rows[line - 1];
    if (row.kind === 'owner' && row.ownerId !== ownerId) return 'owner boundary interrupts the context proof';
    if (USAGE_KINDS.has(row.kind)) {
      if (row.ownerId !== ownerId) return 'usage owner is unknown or changed';
      return 'a usage row interrupts the context baseline';
    }
  }
  return null;
}

function validateCertificate(certificate, sourceById, sources) {
  if (!isObject(certificate) || !isObject(certificate.ownerEvidence) || !isObject(certificate.identityEvidence) ||
      !Array.isArray(certificate.witnessRefs) || typeof certificate.reason !== 'string' || !certificate.reason.trim() ||
      !CLASSIFICATIONS.has(certificate.classification) || !Number.isSafeInteger(certificate.line) || certificate.line < 1 ||
      !/^[0-9a-f]{64}$/.test(certificate.sourceSha256 ?? '') || !/^[0-9a-f]{64}$/.test(certificate.rawHash ?? '')) {
    throw verifierError('CERTIFICATE_SCHEMA_INVALID', 'Certificate schema is invalid');
  }
  const sourceMeta = sourceById.get(certificate.source);
  const source = sources.get(certificate.source);
  if (!sourceMeta || !source || certificate.sourceSha256 !== sourceMeta.sourceSha256) throw verifierError('CERTIFICATE_SCHEMA_INVALID', 'Certificate source reference is invalid');
  const rawLine = source.lines[certificate.line - 1];
  if (!rawLine || sha256(rawLine) !== certificate.rawHash) throw verifierError('RAW_HASH_MISMATCH', 'Certificate rawHash does not match its selected line');

  const refs = new Map();
  for (const ref of certificate.witnessRefs) {
    if (!isObject(ref) || typeof ref.role !== 'string' || !ref.role || !Number.isSafeInteger(ref.line) || ref.line < 1 ||
        typeof ref.source !== 'string' || !/^[0-9a-f]{64}$/.test(ref.sourceSha256 ?? '') || !/^[0-9a-f]{64}$/.test(ref.rawHash ?? '')) {
      throw verifierError('CERTIFICATE_SCHEMA_INVALID', 'Certificate witness reference is invalid');
    }
    const witnessSourceMeta = sourceById.get(ref.source);
    const witnessSource = sources.get(ref.source);
    const witnessLine = witnessSource?.lines[ref.line - 1];
    if (!witnessSourceMeta || !witnessSource) throw verifierError('CERTIFICATE_SCHEMA_INVALID', 'Certificate witness source reference is invalid');
    if (ref.sourceSha256 !== witnessSourceMeta.sourceSha256) throw verifierError('SOURCE_HASH_MISMATCH', 'Certificate witness source hash differs');
    if (!witnessLine || sha256(witnessLine) !== ref.rawHash) throw verifierError('RAW_HASH_MISMATCH', 'Certificate witness raw hash differs');
    if (refs.has(ref.role)) throw verifierError('CERTIFICATE_SCHEMA_INVALID', 'Duplicate witness role');
    refs.set(ref.role, { ...ref, row: witnessSource.rows[ref.line - 1] });
  }

  const selected = source.rows[certificate.line - 1];
  let reason = null;
  if (certificate.classification === 'proved-request') reason = checkRequest(certificate, selected, refs, sources);
  else if (certificate.classification === 'proved-mirror') reason = checkMirror(certificate, selected, refs, sources);
  else if (certificate.classification === 'proved-parent-copy') reason = checkParentCopy(certificate, selected, refs, sources);
  else if (certificate.classification === 'proved-context-snapshot') reason = checkContextSnapshot(certificate, selected, refs, sources);
  if (certificate.classification === 'unresolved') reason = certificate.reason;
  return {
    source: certificate.source,
    line: certificate.line,
    claimedClassification: certificate.classification,
    classification: reason ? 'unresolved' : certificate.classification,
    reason: reason ?? certificate.reason,
  };
}

export function verifyCertificateBundle(bundle, sourceBytesById) {
  if (!isObject(bundle) || bundle.schemaVersion !== 1 || typeof bundle.scope !== 'string' ||
      !Array.isArray(bundle.sources) || !Array.isArray(bundle.certificates) || bundle.certificates.length === 0) {
    throw verifierError('BUNDLE_SCHEMA_INVALID', 'Certificate bundle schema is invalid');
  }
  const sourceById = new Map();
  const sources = new Map();
  for (const sourceMeta of bundle.sources) {
    if (!isObject(sourceMeta) || typeof sourceMeta.id !== 'string' || !sourceMeta.id || typeof sourceMeta.path !== 'string' ||
        !/^[0-9a-f]{64}$/.test(sourceMeta.sourceSha256 ?? '') || sourceById.has(sourceMeta.id)) throw verifierError('BUNDLE_SCHEMA_INVALID', 'Certificate source schema is invalid');
    const bytes = sourceBytesById.get(sourceMeta.id);
    if (!(bytes instanceof Uint8Array)) throw verifierError('SOURCE_READ_FAILED', 'Certificate source bytes are missing');
    if (sha256(bytes) !== sourceMeta.sourceSha256) throw verifierError('SOURCE_HASH_MISMATCH', 'Source SHA-256 differs from certificate bundle');
    sourceById.set(sourceMeta.id, sourceMeta);
    sources.set(sourceMeta.id, parseSource(bytes));
  }
  const certificates = bundle.certificates.map(certificate => validateCertificate(certificate, sourceById, sources));
  const classifications = Object.fromEntries([...CLASSIFICATIONS].map(category => [category, 0]));
  for (const certificate of certificates) classifications[certificate.classification] += 1;
  return {
    verified: true,
    scope: bundle.scope,
    identityScope: 'supplied-source-bundle',
    certificateCount: certificates.length,
    unresolvedCount: classifications.unresolved,
    classifications,
    coverage: 'Only supplied hand-curated certificate rows were adjudicated; bundle identity is not corpus-wide and unlisted rows remain outside this result.',
    certificates,
  };
}

async function main(args) {
  if (args.length !== 1) throw verifierError('USAGE', 'Expected a certificate bundle path');
  const bundlePath = resolve(args[0]);
  let bundleText;
  try {
    bundleText = await readFile(bundlePath, 'utf8');
  } catch {
    throw verifierError('BUNDLE_READ_FAILED', 'Certificate bundle could not be read');
  }
  let bundle;
  try {
    bundle = JSON.parse(bundleText);
  } catch {
    throw verifierError('BUNDLE_SCHEMA_INVALID', 'Certificate bundle JSON is invalid');
  }
  if (!isObject(bundle) || !Array.isArray(bundle.sources)) throw verifierError('BUNDLE_SCHEMA_INVALID', 'Certificate bundle schema is invalid');
  const sources = new Map();
  for (const source of bundle.sources) {
    if (!isObject(source) || typeof source.id !== 'string' || typeof source.path !== 'string') throw verifierError('BUNDLE_SCHEMA_INVALID', 'Certificate source path is invalid');
    try {
      sources.set(source.id, await readFile(resolve(dirname(bundlePath), source.path)));
    } catch {
      throw verifierError('SOURCE_READ_FAILED', 'Certificate source could not be read');
    }
  }
  const result = verifyCertificateBundle(bundle, sources);
  const { certificates: _details, ...summary } = result;
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const code = error instanceof CertificateVerifierError ? error.code : 'VERIFICATION_FAILED';
    console.error(`Usage certificate verification failed: ${code}`);
    process.exitCode = 1;
  });
}
