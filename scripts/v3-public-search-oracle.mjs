import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

// Independent, deliberately bounded source model: no provider parser, index,
// search implementation, or captured 2.0 response is imported.
export function derivePublicSearchMatches(source) {
  if (source.format !== 'agentsession-v3-public-search-source/v1' ||
      source.query !== 'omega alpha' ||
      !isDeepStrictEqual(source.fields, ['title', 'directory', 'user', 'assistant'])) {
    throw new Error('Unsupported public oracle scenario');
  }
  const found = [];
  for (const session of source.sessions) {
    if (!/^[a-z]+$/.test(session.sessionId)) throw new Error('Oracle IDs must be ASCII lowercase');
    if (session.updatedAt > source.updatedBefore) continue;
    const candidates = [
      { text: session.title, field: 'title', role: null, id: null },
      { text: session.directory, field: 'directory', role: null, id: null },
      ...session.messages.map(message => ({ text: message.text, field: 'message', role: message.role, id: message.id }))
    ];
    for (const candidate of candidates) {
      // This fixture's full short string is its manually specified excerpt.
      // Long-window/ellipsis behavior is intentionally outside this oracle.
      if (typeof candidate.text !== 'string' || candidate.text.length > 40 ||
          candidate.role !== null && !['user', 'assistant'].includes(candidate.role)) {
        throw new Error('Unsupported public oracle source text');
      }
    }
    const hit = candidates.find(candidate => {
      const folded = candidate.text.toLowerCase();
      return folded.includes('alpha') && folded.includes('omega');
    });
    if (!hit) continue;
    const ref = { provider: 'codex', sessionId: session.sessionId };
    found.push({
      session: ref, event: hit.id === null ? null : { ...ref, messageId: hit.id, segment: 'message' },
      matchField: hit.field, matchRole: hit.role, snippet: hit.text,
      title: session.title, directory: session.directory, updatedAt: session.updatedAt, untrustedContent: true
    });
  }
  const priority = { title: 0, directory: 1, message: 2 };
  return found.sort((a, b) => priority[a.matchField] - priority[b.matchField] || b.updatedAt - a.updatedAt ||
    (a.session.sessionId < b.session.sessionId ? -1 : a.session.sessionId > b.session.sessionId ? 1 : 0));
}

export function verifyPublicSearchMatches(source, expected, actualMatches) {
  if (expected.format !== 'agentsession-v3-public-search-expected/v1' ||
      !isDeepStrictEqual(derivePublicSearchMatches(source), expected.matches)) {
    throw new Error('Public source and handwritten expectation disagree');
  }
  const passed = isDeepStrictEqual(actualMatches, expected.matches);
  return { passed, expectedCount: expected.matches.length,
    actualCount: Array.isArray(actualMatches) ? actualMatches.length : null,
    scope: 'public-short-text-only', privateGoldenVerified: false };
}

async function main(args) {
  if (args.length !== 1) throw new Error('Expected candidate JSON path containing matches');
  const fixture = new URL('../test/fixtures/v3-search-oracle/', import.meta.url);
  const [source, expected, actual] = await Promise.all([
    readFile(new URL('source.json', fixture), 'utf8'),
    readFile(new URL('expected.json', fixture), 'utf8'), readFile(args[0], 'utf8')
  ]).then(values => values.map(value => JSON.parse(value)));
  const result = verifyPublicSearchMatches(source, expected, actual.matches);
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error('Public search oracle failed: invalid input or unsupported scenario');
    process.exitCode = 2;
  });
}
