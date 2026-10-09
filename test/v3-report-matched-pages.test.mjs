import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildMatchedPagesReport } from '../scripts/v3-report-matched-pages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tmp');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const labels = Array.from({ length: 9 }, (_, index) => `query-${String(index + 1).padStart(2, '0')}`);
const inside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function removeFixtureSafely(directory) {
  const absoluteTmp = path.resolve(tmp);
  const absoluteDirectory = path.resolve(directory);
  const tmpInfo = await lstat(absoluteTmp);
  const directoryInfo = await lstat(absoluteDirectory);
  if (tmpInfo.isSymbolicLink() || !tmpInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
      !inside(absoluteTmp, absoluteDirectory)) {
    throw new Error('Refusing to clean a report fixture outside tmp/ or through a symbolic link');
  }
  const realTmp = await realpath(absoluteTmp);
  const realDirectory = await realpath(absoluteDirectory);
  if (!inside(realTmp, realDirectory)) throw new Error('Refusing to clean a report fixture outside real tmp/');
  await rm(absoluteDirectory, { recursive: true, force: false });
}

async function fixture(t, { missingPage = false } = {}) {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(path.join(tmp, 'v3-report-matched-pages-test-'));
  t.after(() => removeFixtureSafely(directory));

  const inputDir = path.join(directory, 'matched-run');
  await mkdir(inputDir);
  const queryLabels = labels.map((label, index) => ({ label, querySha256: sha256(`query-body-${index}`) }));
  const frozenQueries = queryLabels.map((query, index) => ({
    label: query.label,
    count: index === 0 ? 3 : index === 8 ? 0 : index + 1,
    orderedSemanticSha256: sha256(`ordered-matches-${index}`),
  }));
  const summary = {
    format: 'agentsession-v3-matched-performance/v1',
    searchParityPassed: true,
    searchGoldenPassed: true,
    searchSpeedupEligible: true,
    input: { repetitions: 5, queryLabels },
    metrics: Object.fromEntries(['v2', 'v3'].map(arm => [arm, {
      attempts: Array.from({ length: 5 }, (_, index) => ({ repetition: index + 1, status: 'ok' })),
      queries: frozenQueries,
    }])),
  };
  const summaryPath = path.join(inputDir, 'summary.public.json');
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  const records = [];
  for (const arm of ['v2', 'v3']) {
    for (let repetition = 1; repetition <= 5; repetition++) {
      const record = {
        arm,
        repetition,
        status: 'ok',
        errors: [],
        statePath: path.join(directory, 'private-state', `${arm}-${repetition}`),
        command: { args: ['query-body-secret'] },
        queries: queryLabels.map((query, queryIndex) => {
          const count = queryIndex === 0 ? 3 : queryIndex === 8 ? 0 : queryIndex + 1;
          const pageCount = queryIndex === 0 ? 2 : 1;
          const pageCounts = pageCount === 2 ? [2, 1] : [count];
          const armOffset = arm === 'v2' ? 0 : 100;
          const pages = pageCounts.map((pageCountValue, pageIndex) => ({
            wallMs: pageIndex === 0
              ? armOffset + repetition * 10 + queryIndex + 1
              : repetition * 2 + queryIndex + 2,
            count: pageCountValue,
            semanticHash: sha256(`${query.label}-page-${pageIndex + 1}`),
          }));
          return {
            label: query.label,
            querySha256: query.querySha256,
            complete: true,
            count,
            orderedSemanticSha256: frozenQueries[queryIndex].orderedSemanticSha256,
            pageCount,
            pages,
            repeat: { wallMs: repetition * 2 + queryIndex, semanticHash: pages[0].semanticHash },
            matches: Array.from({ length: count }, (_, matchIndex) => ({
              session: { sessionId: `private-session-id-${matchIndex}` }, snippet: 'private-search-content',
            })),
          };
        }),
      };
      if (missingPage && arm === 'v2' && repetition === 1) record.queries[0].pages.pop();
      const recordPath = path.join(inputDir, `rep-${repetition}-${arm}`, 'record.private.json');
      await mkdir(path.dirname(recordPath), { recursive: true });
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      records.push({ arm, repetition, record: recordPath });
    }
  }
  const ledgerPath = path.join(inputDir, 'ledger.private.json');
  await writeFile(ledgerPath, `${JSON.stringify({
    format: 'agentsession-v3-matched-performance/v1', inputManifest: path.join(directory, 'private-manifest.json'), records,
  }, null, 2)}\n`);
  return { directory, inputDir, summaryPath, ledgerPath, records, outputPath: path.join(inputDir, 'pagination.public.json') };
}

test('reports five timing samples and safe v2/v3 comparisons for all queries', async t => {
  const f = await fixture(t);
  const report = await buildMatchedPagesReport({ summaryPath: f.summaryPath, ledgerPath: f.ledgerPath });
  const written = JSON.parse(await readFile(f.outputPath, 'utf8'));

  assert.equal(report.complete, true);
  assert.equal(report.queryCount, 9);
  assert.equal(report.queries.length, 9);
  assert.deepEqual(report, written);
  assert.equal(report.queries[0].arms.v2.firstPageWallMs.samples.length, 5);
  assert.deepEqual(report.queries[0].arms.v2.firstPageWallMs.samples, [11, 21, 31, 41, 51]);
  assert.equal(report.queries[0].arms.v2.firstPageWallMs.medianMs, 31);
  assert.equal(report.queries[0].arms.v2.firstPageWallMs.p95Ms, 51);
  assert.deepEqual(report.queries[0].arms.v2.completePaginationWallMs.samples, [15, 27, 39, 51, 63]);
  assert.deepEqual(report.queries[0].arms.v2.pageCountSamples, [2, 2, 2, 2, 2]);
  assert.deepEqual(report.queries[0].arms.v2.resultCountSamples, [3, 3, 3, 3, 3]);
  assert.equal(report.queries[0].comparison.pageCountParity, true);
  assert.equal(report.queries[0].comparison.resultCountParity, true);
  assert.match(report.inputSha256.summary, /^[0-9a-f]{64}$/);
  assert.match(report.inputSha256.ledger, /^[0-9a-f]{64}$/);
  assert.equal(report.inputSha256.records.length, 10);

  const publicText = JSON.stringify(report);
  assert.equal(publicText.includes(f.directory), false);
  assert.equal(publicText.includes('query-body'), false);
  assert.equal(publicText.includes('private-session-id'), false);
  assert.equal(publicText.includes('private-search-content'), false);
});

test('rejects a missing cursor page instead of dropping that run from samples', async t => {
  const f = await fixture(t, { missingPage: true });

  await assert.rejects(buildMatchedPagesReport({ summaryPath: f.summaryPath, ledgerPath: f.ledgerPath }), /incomplete/i);
  await assert.rejects(stat(f.outputPath), { code: 'ENOENT' });
});

test('rejects record count or semantic hash that differs from frozen summary', async t => {
  for (const field of ['count', 'orderedSemanticSha256']) {
    const f = await fixture(t);
    const recordEntry = f.records.find(entry => entry.arm === 'v2' && entry.repetition === 1);
    const record = JSON.parse(await readFile(recordEntry.record, 'utf8'));
    if (field === 'count') {
      record.queries[0].count++;
      record.queries[0].matches.push({ session: { sessionId: 'extra-private-session' } });
    } else {
      record.queries[0].orderedSemanticSha256 = sha256('different-ordered-matches');
    }
    await writeFile(recordEntry.record, JSON.stringify(record));

    await assert.rejects(buildMatchedPagesReport({ summaryPath: f.summaryPath, ledgerPath: f.ledgerPath }),
      /frozen summary.*count or semantic hash/i);
    await assert.rejects(stat(f.outputPath), { code: 'ENOENT' });
  }
});
