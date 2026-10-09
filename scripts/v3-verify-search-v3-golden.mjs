#!/usr/bin/env node
// Source-derived 3.0 search expectations are persisted before product output is read.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCodexSearchSources } from './v3-search-source-set-oracle.mjs';
import { deriveMetadataMatches, scanCodexFile, verifySources } from './v3-verify-search-golden.mjs';
import { privateDir, sourceStat } from './v3-bench-matched.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canon = value => Array.isArray(value) ? '[' + value.map(canon).join(',') + ']'
  : value !== null && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canon(value[key])).join(',') + '}'
    : JSON.stringify(value);
const order = (a, b) => b.updatedAt - a.updatedAt
  || (a.session.provider + '\0' + a.session.sessionId < b.session.provider + '\0' + b.session.sessionId ? -1
    : a.session.provider + '\0' + a.session.sessionId > b.session.provider + '\0' + b.session.sessionId ? 1 : 0);

function stats(manifest) {
  return Object.fromEntries(Object.entries(manifest.providerRoots).map(([provider, source]) =>
    [provider, sourceStat(source.path, provider === 'codex')]));
}

export async function sourceSetsForV3(duplicates, queries, outputDir) {
  const direct = [], unresolved = [];
  for (const [index, group] of duplicates.entries()) {
    if (group.provider !== 'codex' || !Array.isArray(group.candidates)) throw new Error('UnexpectedSourceGroup');
    const selected = classifyCodexSearchSources(group.candidates.map(candidate => ({
      path: candidate.path, bytes: readFileSync(candidate.path)
    })));
    if (selected.sessionId !== group.sessionId) throw new Error('SourceGroupIdentityChanged');
    if (canon(selected.sourceSha256.slice().sort()) !== canon(group.candidates.map(row => row.source.sha256).sort())) {
      throw new Error('SourceSetContentChangedDuringDerivation');
    }
    if (selected.status === 'unresolved') {
      unresolved.push({ sessionId: selected.sessionId, directory: selected.directory,
        sourceSha256: selected.sourceSha256 });
      continue;
    }
    if (selected.status !== 'direct-pair') throw new Error('UnexpectedDuplicateResolution');
    const virtual = path.join(outputDir, 'direct-pair-' + index + '.private.jsonl');
    writeFileSync(virtual, selected.activeBytes);
    const scanned = await scanCodexFile(virtual, queries);
    if (!scanned.projection.complete || scanned.metadata.sessionId !== selected.sessionId) {
      throw new Error('DirectPairProjectionUnavailable');
    }
    const recordedIds = new Set(selected.activeBytes.toString('utf8').trimEnd().split('\n')
      .map(line => JSON.parse(line).payload?.id).filter(id => typeof id === 'string'));
    if (Object.values(scanned.projection.matches).some(match => match?.event
      && !recordedIds.has(match.event.messageId))) {
      throw new Error('DirectPairSyntheticEventReferenceUnsupported');
    }
    direct.push({ ...scanned, path: virtual, sourceSet: {
      excludedRecords: selected.excludedRecords, prefixRecords: selected.prefixRecords,
      sourceSha256: selected.sourceSha256
    } });
  }
  return { direct, unresolved };
}

export function deriveV3SearchExpectations(manifest, facts, sourceSets) {
  const collisions = new Set(facts.duplicateMetadata.filter(row => row.provider === 'codex')
    .map(row => row.sessionId));
  const selected = facts.codexProjections.filter(row => !collisions.has(row.metadata.sessionId))
    .concat(sourceSets.direct);
  const unresolvedIds = new Set(sourceSets.unresolved.map(row => row.sessionId));
  if (selected.some(row => !row.projection.complete)
    || sourceSets.direct.some(row => !collisions.has(row.metadata.sessionId))
    || [...unresolvedIds].some(id => !collisions.has(id))
    || selected.length + unresolvedIds.size !== new Set(facts.codexProjections.map(row => row.metadata.sessionId)).size) {
    throw new Error('SourceSetCoverageMismatch');
  }
  const metadata = facts.metadata.filter(row => row.provider !== 'codex')
    .concat(selected.map(row => row.metadata));
  const queries = manifest.queries.map(query => {
    const diagnostics = query.providers.map(provider => ({
      provider, status: provider === 'codex' && unresolvedIds.size ? 'partial' : 'ok'
    }));
    if (query.fields.every(field => field === 'title' || field === 'directory')) {
      const knownMatches = deriveMetadataMatches(metadata, query, manifest.updatedBeforeUnixMs);
      const terms = query.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const unknownMatches = sourceSets.unresolved.flatMap(row => {
        const field = ['title', 'directory'].find(name => query.fields.includes(name)
          && terms.every(term => String(name === 'title' ? row.sessionId : row.directory ?? '')
            .toLowerCase().includes(term)));
        return field ? [{ session: { provider: 'codex', sessionId: row.sessionId },
          matchField: field, title: row.sessionId, directory: row.directory }] : [];
      });
      return { label: query.label, querySha256: query.querySha256,
        coverage: 'partial-unresolved-metadata', count: knownMatches.length + unknownMatches.length,
        knownOrderedSemanticSha256: sha(canon(knownMatches)), diagnostics, knownMatches, unknownMatches };
    }
    const codex = selected.filter(row => row.metadata.updatedAt <= manifest.updatedBeforeUnixMs)
      .map(row => row.projection.matches[query.label]).filter(Boolean);
    let matches;
    if (query.fields.length === 1 && query.fields[0] === 'toolName') {
      matches = codex.concat(facts.toolSources.opencode, facts.toolSources.small.hits).sort(order);
    } else if (query.providers.every(provider => provider === 'codex')
      && query.fields.every(field => field === 'user' || field === 'assistant')) {
      matches = codex.sort(order);
    } else throw new Error('UnsupportedQueryShape');
    return { label: query.label, querySha256: query.querySha256,
      coverage: unresolvedIds.size ? 'partial-unresolved-content' : 'complete',
      count: matches.length, orderedSemanticSha256: sha(canon(matches)),
      firstPageSemanticSha256: sha(canon(matches.slice(0, query.limit))),
      diagnostics, matches };
  });
  return { format: 'agentsession-v3-source-search-expected/v1',
    coverage: { status: unresolvedIds.size ? 'partial' : 'complete',
      unresolvedCodexGroups: unresolvedIds.size, directCodexPairs: sourceSets.direct.length },
    queries };
}

async function main(args) {
  if (args.length !== 6 || args[0] !== '--manifest' || args[2] !== '--source-ledger'
    || args[4] !== '--output-dir') {
    throw new Error('Expected --manifest, --source-ledger, --output-dir');
  }
  const manifest = JSON.parse(readFileSync(args[1]));
  if (manifest.format !== 'agentsession-v3-performance-input/v1' || manifest.queries?.length !== 9
    || manifest.queries.some(query => sha(query.query) !== query.querySha256 || query.limit !== 20)) {
    throw new Error('FrozenQueryIdentityChanged');
  }
  const output = privateDir(args[5]), before = stats(manifest);
  if (canon(before.codex) !== canon(manifest.codexStat)) throw new Error('FrozenCodexStatChanged');
  const facts = await verifySources(manifest, progress =>
    console.log(JSON.stringify({ provider: progress.provider, filesScanned: progress.filesScanned })));
  const ledger = JSON.parse(readFileSync(args[3]));
  if (canon(before) !== canon(ledger.providerStats)
    || facts.codexSources.length !== ledger.codexSources?.length
    || facts.codexSources.some((source, index) =>
      source.path !== ledger.codexSources[index].path || source.sha256 !== ledger.codexSources[index].sha256)) {
    throw new Error('FrozenSourceHashesChanged');
  }
  const sets = await sourceSetsForV3(facts.duplicateMetadata, manifest.queries, output);
  if (sets.direct.length !== 1 || sets.unresolved.length !== 2) throw new Error('UnexpectedFrozenCodexSourceSets');
  const expected = deriveV3SearchExpectations(manifest, facts, sets);
  if (canon(before) !== canon(stats(manifest))
    || facts.codexSources.some(source => sha(readFileSync(source.path)) !== source.sha256)) {
    throw new Error('SourcesChangedDuringDerivation');
  }
  writeFileSync(path.join(output, 'expected.private.json'), JSON.stringify(expected, null, 2) + '\n');
  const summary = { format: 'agentsession-v3-source-search-golden-summary/v1',
    coverage: expected.coverage, sourceHashesUnchanged: true,
    rows: expected.queries.map(query => ({ label: query.label, coverage: query.coverage,
      count: query.count, orderedSemanticSha256: query.orderedSemanticSha256 ?? null,
      knownOrderedSemanticSha256: query.knownOrderedSemanticSha256 ?? null,
      unresolvedMetadataMatches: query.unknownMatches?.length ?? 0,
      diagnostics: query.diagnostics.map(row => row.provider + ':' + row.status) })) };
  writeFileSync(path.join(output, 'summary.public.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error('3.0 source oracle failed: ' + error.message);
    process.exitCode = 1;
  });
}
