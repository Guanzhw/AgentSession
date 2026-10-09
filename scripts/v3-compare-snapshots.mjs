import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SNAPSHOT_FORMAT = 'agentsession-v3-snapshot/v1';
const POLICY_FORMAT = 'agentsession-v3-volatile-policy/v1';
const VOLATILE_POINTERS = new Set([
  '/response/structuredContent/result/snapshotUpdatedBefore',
  '/response/structuredContent/result/diagnostics/0/durationMs',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function summarize(value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const hash = createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12);
  return `${type} sha256:${hash}`;
}

function identifier(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function propertyPath(path, key) {
  // Provider payloads may use private filenames or text as object keys.
  return `${path}[key-${identifier(key)}]`;
}

function validateSnapshot(snapshot, label) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`${label} snapshot must be an object`);
  }
  const snapshotKeys = Object.keys(snapshot);
  if (snapshotKeys.length !== 2 || !snapshotKeys.includes('format') || !snapshotKeys.includes('cases')) {
    throw new Error(`${label} snapshot must contain only format and cases`);
  }
  if (snapshot.format !== SNAPSHOT_FORMAT) {
    throw new Error(`${label} snapshot format must be ${SNAPSHOT_FORMAT}`);
  }
  if (!Array.isArray(snapshot.cases)) {
    throw new Error(`${label} snapshot cases must be an array`);
  }

  const ids = new Set();
  for (let index = 0; index < snapshot.cases.length; index += 1) {
    const item = snapshot.cases[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label} snapshot case at index ${index} must be an object`);
    }
    const caseKeys = Object.keys(item);
    if (caseKeys.length !== 2 || !caseKeys.includes('id') || !caseKeys.includes('result')) {
      throw new Error(`${label} snapshot case at index ${index} must contain only id and result`);
    }
    if (typeof item.id !== 'string' || !item.id) {
      throw new Error(`${label} snapshot case at index ${index} must have a nonempty string id`);
    }
    if (ids.has(item.id)) {
      throw new Error(`${label} snapshot has duplicate case id ${identifier(item.id)}`);
    }
    ids.add(item.id);
  }

  return snapshot;
}

function valueType(value) {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function pointerValue(result, pointer) {
  let value = result;
  for (const segment of pointer.slice(1).split('/')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return { exists: false };
    value = value[segment];
  }
  return { exists: true, value };
}

function validatePolicy(policy, expected, actual) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).length !== 2 || !Object.hasOwn(policy, 'format') || !Object.hasOwn(policy, 'cases') ||
      policy.format !== POLICY_FORMAT || !Array.isArray(policy.cases)) {
    throw new Error(`volatile policy must contain format ${POLICY_FORMAT} and cases`);
  }
  const expectedById = new Map(expected.cases.map((item) => [item.id, item]));
  const actualById = new Map(actual.cases.map((item) => [item.id, item]));
  const ignoredByCase = new Map();
  for (let index = 0; index < policy.cases.length; index += 1) {
    const item = policy.cases[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).length !== 2 || !Object.hasOwn(item, 'id') || !Object.hasOwn(item, 'ignore') ||
        typeof item.id !== 'string' || !item.id || !Array.isArray(item.ignore) || item.ignore.length === 0 ||
        item.ignore.some((pointer) => typeof pointer !== 'string')) {
      throw new Error(`volatile policy case at index ${index} must have an id and nonempty ignore array`);
    }
    const caseHash = identifier(item.id);
    if (ignoredByCase.has(item.id)) throw new Error(`volatile policy has duplicate case ${caseHash}`);
    if (!expectedById.has(item.id) || !actualById.has(item.id)) {
      throw new Error(`volatile policy case ${caseHash} must exist in both snapshots`);
    }
    const pointers = new Set();
    for (const pointer of item.ignore) {
      if (!VOLATILE_POINTERS.has(pointer)) {
        throw new Error(`volatile policy case ${caseHash} has an unsupported pointer ${identifier(pointer)}`);
      }
      if (pointers.has(pointer)) throw new Error(`volatile policy case ${caseHash} has a duplicate pointer ${identifier(pointer)}`);
      pointers.add(pointer);
      const left = pointerValue(expectedById.get(item.id).result, pointer);
      const right = pointerValue(actualById.get(item.id).result, pointer);
      if (!left.exists || !right.exists) {
        throw new Error(`volatile policy case ${caseHash} pointer ${identifier(pointer)} must exist on both sides`);
      }
      const leftType = valueType(left.value);
      if (leftType !== valueType(right.value) || leftType === 'object' || leftType === 'array') {
        throw new Error(`volatile policy case ${caseHash} pointer ${identifier(pointer)} must have the same primitive type on both sides`);
      }
    }
    ignoredByCase.set(item.id, pointers);
  }
  return ignoredByCase;
}

function compareValue(expected, actual, path, pointer, ignoredPointers, addDifference, addIgnoredDifference) {
  const expectedType = valueType(expected);
  const actualType = valueType(actual);

  if (expectedType !== actualType) {
    addDifference(`${path}: type differs (expected ${summarize(expected)}; actual ${summarize(actual)})`);
    return;
  }

  if (expectedType === 'object') {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      const nextPath = propertyPath(path, key);
      const inExpected = Object.hasOwn(expected, key);
      const inActual = Object.hasOwn(actual, key);
      if (!inExpected) {
        addDifference(`${nextPath}: property missing from expected (actual ${summarize(actual[key])})`);
      } else if (!inActual) {
        addDifference(`${nextPath}: property missing from actual (expected ${summarize(expected[key])})`);
      } else {
        compareValue(expected[key], actual[key], nextPath, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, ignoredPointers, addDifference, addIgnoredDifference);
      }
    }
    return;
  }

  if (expectedType === 'array') {
    const sharedLength = Math.min(expected.length, actual.length);
    for (let index = 0; index < sharedLength; index += 1) {
      compareValue(expected[index], actual[index], `${path}[${index}]`, `${pointer}/${index}`, ignoredPointers, addDifference, addIgnoredDifference);
    }
    for (let index = sharedLength; index < expected.length; index += 1) {
      addDifference(`${path}[${index}]: item missing from actual (expected ${summarize(expected[index])})`);
    }
    for (let index = sharedLength; index < actual.length; index += 1) {
      addDifference(`${path}[${index}]: unexpected item in actual (${summarize(actual[index])})`);
    }
    return;
  }

  if (expected !== actual) {
    if (ignoredPointers?.has(pointer)) addIgnoredDifference();
    else addDifference(`${path}: value differs (expected ${summarize(expected)}; actual ${summarize(actual)})`);
  }
}

function compareSnapshots(expected, actual, ignoredByCase) {
  const differences = [];
  let ignoredDifferences = 0;
  const expectedById = new Map(expected.cases.map((item) => [item.id, item]));
  const actualById = new Map(actual.cases.map((item) => [item.id, item]));
  const expectedCommonCases = expected.cases.filter((item) => actualById.has(item.id));
  const actualCommonCases = actual.cases.filter((item) => expectedById.has(item.id));
  for (let index = 0; index < expectedCommonCases.length; index += 1) {
    if (expectedCommonCases[index].id !== actualCommonCases[index].id) {
      const id = expectedCommonCases[index].id;
      const expectedPosition = expected.cases.findIndex((item) => item.id === id);
      const actualPosition = actual.cases.findIndex((item) => item.id === id);
      differences.push(`case ${identifier(id)} path $.cases[${expectedPosition}].id: order differs (actual position ${actualPosition})`);
    }
  }

  for (const id of [...expectedById.keys()].sort()) {
    if (!actualById.has(id)) {
      differences.push(`case ${identifier(id)} path $.cases: missing from actual`);
      continue;
    }
    compareValue(expectedById.get(id).result, actualById.get(id).result, '$.result', '', ignoredByCase?.get(id), (entry) => {
      differences.push(`case ${identifier(id)} ${entry}`);
    }, () => { ignoredDifferences += 1; });
  }
  for (const id of [...actualById.keys()].sort()) {
    if (!expectedById.has(id)) differences.push(`case ${identifier(id)} path $.cases: extra in actual`);
  }

  return { caseCount: expected.cases.length, differences, ignoredDifferences, policyUsed: ignoredByCase !== undefined };
}

function renderReport(comparison) {
  const ignored = comparison.policyUsed ? `; ${comparison.ignoredDifferences} ignored differences` : '';
  if (comparison.differences.length === 0) {
    return `Snapshots match (${comparison.caseCount} cases${ignored}).\n`;
  }
  return `Snapshots differ (${comparison.differences.length} differences${ignored}):\n${comparison.differences.map((difference) => `- ${difference}`).join('\n')}\n`;
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--expected', '--actual', '--output', '--volatile-policy'].includes(flag)) {
      throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a path`);
    }
    if (Object.hasOwn(options, flag)) {
      throw new Error(`${flag} may be specified once`);
    }
    options[flag] = value;
    index += 1;
  }
  if (!options['--expected'] || !options['--actual']) {
    throw new Error('usage: node scripts/v3-compare-snapshots.mjs --expected <path> --actual <path> [--output <path>] [--volatile-policy <path>]');
  }
  return options;
}

async function loadSnapshot(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} snapshot is not valid JSON`);
    throw new Error(`cannot read ${label} snapshot`);
  }
  return validateSnapshot(parsed, label);
}

async function loadPolicy(filePath, expected, actual) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('volatile policy is not valid JSON');
    throw new Error('cannot read volatile policy');
  }
  return validatePolicy(parsed, expected, actual);
}

async function main(args) {
  let options;
  try {
    options = parseArguments(args);
    const expected = await loadSnapshot(options['--expected'], 'expected');
    const actual = await loadSnapshot(options['--actual'], 'actual');
    const ignoredByCase = options['--volatile-policy']
      ? await loadPolicy(options['--volatile-policy'], expected, actual) : undefined;
    const report = renderReport(compareSnapshots(expected, actual, ignoredByCase));
    if (options['--output']) await writeFile(options['--output'], report, 'utf8');
    process.stdout.write(report);
    return report.startsWith('Snapshots match') ? 0 : 1;
  } catch (error) {
    let message = error.message;
    if (options?.['--output']) {
      try {
        await writeFile(options['--output'], `Snapshot comparison error: ${message}\n`, 'utf8');
      } catch {
        message = `${message}; cannot write output report`;
      }
    }
    process.stderr.write(`Snapshot comparison error: ${message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
