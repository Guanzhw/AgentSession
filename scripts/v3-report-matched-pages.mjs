#!/usr/bin/env node

// Summarize per-page timings from a completed matched-search benchmark without
// copying query text, session details, commands, or private file paths.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const inputFormat = 'agentsession-v3-matched-performance/v1';
const outputFormat = 'agentsession-v3-matched-pagination-report/v1';
const safeLabelPattern = /^[a-z][a-z0-9-]{0,63}$/i;
const shaPattern = /^[0-9a-f]{64}$/;
const arms = ['v2', 'v3'];
const repetitions = [1, 2, 3, 4, 5];

const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const canonicalPath = value => process.platform === 'win32'
  ? path.normalize(value).toLowerCase() : path.normalize(value);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    const key = { '--summary': 'summaryPath', '--ledger': 'ledgerPath', '--output': 'outputPath' }[flag];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`Invalid or incomplete option: ${flag}`);
    }
    options[key] = argv[index + 1];
  }
  if (!options.summaryPath || !options.ledgerPath) throw new Error('--summary and --ledger are required');
  return options;
}

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function finiteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function summarize(samples) {
  if (samples.length !== 5 || samples.some(value => !finiteTime(value))) {
    throw new Error('Pagination report is incomplete: expected five finite timing samples');
  }
  const sorted = samples.slice().sort((left, right) => left - right);
  return { samples, medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function safeRecordPath(value, runRoot, runRootReal) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('Pagination report is incomplete: ledger contains an invalid record reference');
  }
  const resolved = path.resolve(value);
  if (!inside(runRoot, resolved) || path.basename(resolved) !== 'record.private.json') {
    throw new Error('Pagination report is incomplete: ledger record reference is outside its run directory');
  }
  return realpath(resolved).then(async actual => {
    const info = await lstat(resolved);
    if (info.isSymbolicLink() || !info.isFile() || !inside(runRootReal, actual)) {
      throw new Error('Pagination report is incomplete: ledger record is not a regular in-run file');
    }
    return { path: resolved, key: canonicalPath(actual) };
  });
}

async function readInputFile(filePath, runRootReal, expectedName) {
  const resolved = path.resolve(filePath);
  if (path.basename(resolved) !== expectedName) throw new Error('Pagination report input filename is invalid');
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Pagination report input is not a regular file');
  const actual = await realpath(resolved);
  if (!inside(runRootReal, actual) && actual !== runRootReal) {
    throw new Error('Pagination report input is outside its run directory');
  }
  const bytes = await readFile(resolved);
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}

function validateSummary(summary) {
  if (summary?.format !== inputFormat || summary.searchSpeedupEligible !== true ||
      summary.searchParityPassed !== true || summary.searchGoldenPassed !== true ||
      summary.input?.repetitions !== 5 || !Array.isArray(summary.input.queryLabels) ||
      summary.input.queryLabels.length !== 9) {
    throw new Error('Pagination report is incomplete: eligible 5x9 benchmark summary is required');
  }
  const labels = [];
  const querySummariesByArm = {};
  const seen = new Set();
  for (const item of summary.input.queryLabels) {
    if (!item || typeof item.label !== 'string' || !safeLabelPattern.test(item.label) ||
        !shaPattern.test(item.querySha256 || '') || seen.has(item.label)) {
      throw new Error('Pagination report is incomplete: summary query labels are invalid');
    }
    labels.push({ label: item.label, querySha256: item.querySha256 });
    seen.add(item.label);
  }
  for (const arm of arms) {
    const attempts = summary.metrics?.[arm]?.attempts;
    const querySummaries = summary.metrics?.[arm]?.queries;
    if (!Array.isArray(attempts) || attempts.length !== 5 ||
        !Array.isArray(querySummaries) || querySummaries.length !== labels.length) {
      throw new Error(`Pagination report is incomplete: ${arm} summary samples are missing`);
    }
    const attemptIds = attempts.map(item => `${item?.repetition}:${item?.status}`).sort();
    if (attemptIds.some(value => !repetitions.some(rep => value === `${rep}:ok`)) ||
        new Set(attemptIds).size !== repetitions.length ||
        repetitions.some(rep => !attemptIds.includes(`${rep}:ok`))) {
      throw new Error(`Pagination report is incomplete: ${arm} summary attempts are not five successful repetitions`);
    }
    if (querySummaries.some((query, index) => query?.label !== labels[index].label ||
        !Number.isSafeInteger(query.count) || query.count < 0 ||
        !shaPattern.test(query.orderedSemanticSha256 || ''))) {
      throw new Error(`Pagination report is incomplete: ${arm} summary query labels differ`);
    }
    querySummariesByArm[arm] = querySummaries;
  }
  for (let index = 0; index < labels.length; index++) {
    const v2 = querySummariesByArm.v2[index];
    const v3 = querySummariesByArm.v3[index];
    if (v2.count !== v3.count || v2.orderedSemanticSha256 !== v3.orderedSemanticSha256) {
      throw new Error(`Pagination report is incomplete: frozen query parity differs for ${labels[index].label}`);
    }
  }
  return { labels, querySummariesByArm };
}

function normalizeQuery(query, label, frozenSummary, arm, repetition) {
  const context = `${arm} repetition ${repetition} ${label.label}`;
  if (!query || query.label !== label.label || query.querySha256 !== label.querySha256 ||
      query.complete !== true || !Number.isSafeInteger(query.count) || query.count < 0 ||
      !Number.isSafeInteger(query.pageCount) || query.pageCount < 1 ||
      !Array.isArray(query.pages) || query.pages.length !== query.pageCount ||
      !Array.isArray(query.matches) || query.matches.length !== query.count ||
      !query.repeat || !finiteTime(query.repeat.wallMs)) {
    throw new Error(`Pagination report is incomplete: ${context} does not have a complete result`);
  }
  if (query.count !== frozenSummary.count ||
      query.orderedSemanticSha256 !== frozenSummary.orderedSemanticSha256) {
    throw new Error(`Pagination report is incomplete: ${context} differs from the frozen summary count or semantic hash`);
  }
  let pageResultCount = 0;
  let completePaginationWallMs = 0;
  const pages = query.pages.map(page => {
    if (!page || !finiteTime(page.wallMs) || !Number.isSafeInteger(page.count) || page.count < 0 ||
        !shaPattern.test(page.semanticHash || '') || page.errorKind) {
      throw new Error(`Pagination report is incomplete: ${context} has a missing or failed page`);
    }
    pageResultCount += page.count;
    completePaginationWallMs += page.wallMs;
    return { wallMs: page.wallMs, count: page.count, semanticHash: page.semanticHash };
  });
  if (pageResultCount !== query.count || query.repeat.semanticHash !== pages[0].semanticHash ||
      !shaPattern.test(query.repeat.semanticHash || '') || query.repeat.errorKind ||
      !Number.isFinite(completePaginationWallMs)) {
    throw new Error(`Pagination report is incomplete: ${context} has inconsistent page or repeat evidence`);
  }
  return { label: label.label, firstPageWallMs: pages[0].wallMs,
    repeatFirstPageWallMs: query.repeat.wallMs, completePaginationWallMs,
    pageCount: pages.length, resultCount: query.count };
}

export async function buildMatchedPagesReport({ summaryPath, ledgerPath, outputPath }) {
  if (typeof summaryPath !== 'string' || typeof ledgerPath !== 'string') {
    throw new Error('Pagination report requires summary and ledger paths');
  }
  const resolvedLedger = path.resolve(ledgerPath);
  const runRoot = path.dirname(resolvedLedger);
  const runRootReal = await realpath(runRoot);
  const resolvedSummary = path.resolve(summaryPath);
  if (path.dirname(resolvedSummary) !== runRoot || resolvedSummary === resolvedLedger) {
    throw new Error('Pagination report summary and ledger must share a run directory');
  }
  const resolvedOutput = path.resolve(outputPath || path.join(runRoot, 'pagination.public.json'));
  if (path.dirname(resolvedOutput) !== runRoot ||
      path.basename(resolvedOutput) !== 'pagination.public.json' ||
      resolvedOutput === resolvedSummary || resolvedOutput === resolvedLedger) {
    throw new Error('Pagination report output must be pagination.public.json in the run directory');
  }
  try {
    await lstat(resolvedOutput);
    throw new Error('Pagination report output already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const summaryInput = await readInputFile(resolvedSummary, runRootReal, 'summary.public.json');
  const ledgerInput = await readInputFile(resolvedLedger, runRootReal, 'ledger.private.json');
  const summary = requireObject(summaryInput.value, 'Pagination report summary is invalid');
  const ledger = requireObject(ledgerInput.value, 'Pagination report ledger is invalid');
  const { labels, querySummariesByArm } = validateSummary(summary);
  if (ledger.format !== inputFormat || !Array.isArray(ledger.records) || ledger.records.length !== 10) {
    throw new Error('Pagination report is incomplete: ledger must contain ten record references');
  }

  const loaded = [];
  const seen = new Set();
  const seenPaths = new Set();
  for (const entry of ledger.records) {
    if (!entry || !arms.includes(entry.arm) || !repetitions.includes(entry.repetition)) {
      throw new Error('Pagination report is incomplete: ledger has an invalid arm or repetition');
    }
    const id = `${entry.arm}:${entry.repetition}`;
    if (seen.has(id)) throw new Error('Pagination report is incomplete: ledger repeats an arm and repetition');
    seen.add(id);
    const recordFile = await safeRecordPath(entry.record, runRoot, runRootReal);
    if (seenPaths.has(recordFile.key)) throw new Error('Pagination report is incomplete: ledger reuses a record file');
    seenPaths.add(recordFile.key);
    const bytes = await readFile(recordFile.path);
    const record = requireObject(JSON.parse(bytes.toString('utf8')), 'Pagination report record is invalid');
    if (record.arm !== entry.arm || record.repetition !== entry.repetition || record.status !== 'ok' ||
        !Array.isArray(record.errors) || record.errors.length !== 0 || !Array.isArray(record.queries) ||
        record.queries.length !== labels.length) {
      throw new Error(`Pagination report is incomplete: ${entry.arm} repetition ${entry.repetition} failed or is missing`);
    }
    const queryMetrics = record.queries.map((query, index) =>
      normalizeQuery(query, labels[index], querySummariesByArm[entry.arm][index], entry.arm, entry.repetition));
    loaded.push({ arm: entry.arm, repetition: entry.repetition, sha256: sha256(bytes), queryMetrics });
  }
  for (const arm of arms) {
    const runs = loaded.filter(item => item.arm === arm).sort((left, right) => left.repetition - right.repetition);
    if (runs.length !== 5 || runs.some((run, index) => run.repetition !== repetitions[index])) {
      throw new Error(`Pagination report is incomplete: ${arm} must have repetitions 1 through 5`);
    }
    const attempts = summary.metrics[arm].attempts;
    if (runs.some(run => !attempts.some(item => item.repetition === run.repetition && item.status === 'ok'))) {
      throw new Error(`Pagination report is incomplete: ${arm} summary and ledger attempts differ`);
    }
  }

  const queryReports = labels.map((label, queryIndex) => {
    const armReports = {};
    for (const arm of arms) {
      const runs = loaded.filter(item => item.arm === arm).sort((left, right) => left.repetition - right.repetition);
      const metrics = runs.map(run => run.queryMetrics[queryIndex]);
      armReports[arm] = {
        firstPageWallMs: summarize(metrics.map(item => item.firstPageWallMs)),
        repeatFirstPageWallMs: summarize(metrics.map(item => item.repeatFirstPageWallMs)),
        completePaginationWallMs: summarize(metrics.map(item => item.completePaginationWallMs)),
        pageCountSamples: metrics.map(item => item.pageCount),
        resultCountSamples: metrics.map(item => item.resultCount),
      };
    }
    const v2 = armReports.v2;
    const v3 = armReports.v3;
    const ratios = metric => ({
      medianV2OverV3: ratio(v2[metric].medianMs, v3[metric].medianMs),
      p95V2OverV3: ratio(v2[metric].p95Ms, v3[metric].p95Ms),
    });
    return {
      label: label.label,
      arms: armReports,
      comparison: {
        firstPageWallMs: ratios('firstPageWallMs'),
        repeatFirstPageWallMs: ratios('repeatFirstPageWallMs'),
        completePaginationWallMs: ratios('completePaginationWallMs'),
        pageCountParity: JSON.stringify(v2.pageCountSamples) === JSON.stringify(v3.pageCountSamples),
        resultCountParity: JSON.stringify(v2.resultCountSamples) === JSON.stringify(v3.resultCountSamples),
      },
    };
  });
  const report = {
    format: outputFormat,
    complete: true,
    repetitionsPerArm: 5,
    queryCount: labels.length,
    inputSha256: {
      summary: summaryInput.sha256,
      ledger: ledgerInput.sha256,
      records: loaded.slice().sort((left, right) => arms.indexOf(left.arm) - arms.indexOf(right.arm) || left.repetition - right.repetition)
        .map(({ arm, repetition, sha256: digest }) => ({ arm, repetition, sha256: digest })),
    },
    queries: queryReports,
  };
  const outputBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolvedOutput, outputBytes, { flag: 'wx' });
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/v3-report-matched-pages.mjs --summary PATH --ledger PATH [--output PATH]');
    return;
  }
  const report = await buildMatchedPagesReport(options);
  console.log(JSON.stringify({ complete: report.complete, queryCount: report.queryCount,
    repetitionsPerArm: report.repetitionsPerArm,
    inputSha256: { summary: report.inputSha256.summary, ledger: report.inputSha256.ledger } }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
