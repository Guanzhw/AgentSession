import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { acceptedSearchGolden, codexBodySuperset, compareMetadata, compareDocumentProjection, deriveDocumentMatches, deriveExactSnippet, deriveSourceSnippet, deriveMetadataMatches, scanCodexFile, scanJsonl, selectCodexMetadata } from '../scripts/v3-verify-search-golden.mjs';

const fixture = name => fileURLToPath(new URL(`./fixtures/v3-search-source/${name}.jsonl`, import.meta.url));
const query = { query: 'omega alpha', fields: ['title', 'directory'], providers: ['codex'] };
const metadata = await Promise.all(['gamma', 'alpha', 'beta'].map(async name => (await scanCodexFile(fixture(name), [])).metadata));
const expected = [
  { session: { provider: 'codex', sessionId: 'alpha' }, event: null, matchField: 'title', matchRole: null, snippet: 'Alpha title OMEGA', title: 'Alpha title OMEGA', directory: '/alpha/omega', updatedAt: 50, untrustedContent: true },
  { session: { provider: 'codex', sessionId: 'beta' }, event: null, matchField: 'directory', matchRole: null, snippet: '/ALPHA/omega', title: 'Second', directory: '/ALPHA/omega', updatedAt: 100, untrustedContent: true },
  { session: { provider: 'codex', sessionId: 'gamma' }, event: null, matchField: 'directory', matchRole: null, snippet: '/alpha/omega', title: 'Third', directory: '/alpha/omega', updatedAt: 100, untrustedContent: true }
];

test('only nine independently verified source queries can become a benchmark golden', () => {
  const queries = Array.from({ length: 9 }, (_, i) => ({ label: `query-${i}`, querySha256: 'a'.repeat(64),
    status: 'source-verified', count: i, orderedSemanticSha256: 'b'.repeat(64), firstPageSemanticSha256: 'c'.repeat(64) }));
  const report = { verification: { status: 'source-verified' }, providerStats: { codex: { fileCount: 2 } }, queries };
  const golden = acceptedSearchGolden(report);
  assert.equal(golden.format, 'agentsession-v3-search-golden/v1');
  assert.equal(golden.verification.status, 'source-verified');
  assert.deepEqual(golden.queries[2], { label: 'query-2', querySha256: 'a'.repeat(64), count: 2,
    orderedSemanticSha256: 'b'.repeat(64), firstPageSemanticSha256: 'c'.repeat(64) });
  const withUnserializedEvidence = { ...report, sourceEvidence: { firstMatch: undefined } };
  assert.equal(acceptedSearchGolden(withUnserializedEvidence).verification.sourceReportSha256,
    acceptedSearchGolden(JSON.parse(JSON.stringify(withUnserializedEvidence))).verification.sourceReportSha256,
    'The report fingerprint must be reproducible from its written JSON');
  assert.throws(() => acceptedSearchGolden({ ...report, queries: queries.slice(1) }), /SourceVerificationIncomplete/);
  assert.throws(() => acceptedSearchGolden({ ...report, queries: queries.map((row, i) => i === 2 ? { ...row, status: 'partial-source-verified' } : row) }), /SourceVerificationIncomplete/);
  assert.throws(() => acceptedSearchGolden({ ...report, queries: queries.map((row, i) => i === 2 ? { ...row, count: undefined } : row) }), /SourceVerificationIncomplete/);
});

test('raw short Codex sources match handwritten ordered metadata, refs and excerpts', () => {
  const derived = deriveMetadataMatches(metadata, query, 100);
  assert.deepEqual(derived, expected);
  assert.equal(compareMetadata(derived, expected).passed, true);
  assert.deepEqual(deriveMetadataMatches(metadata, query, 99), [expected[0]]);
});

test('canonical segment collision uses frozen v2 discovery order and retains v3 disagreement', async () => {
  const candidates = await Promise.all(['segment-a', 'segment-z'].map(async name => ({
    path: fixture(name), ...await scanCodexFile(fixture(name), [])
  })));
  const result = selectCodexMetadata(candidates);
  assert.equal(result.metadata.length, 1);
  assert.deepEqual(result.metadata[0], { provider: 'codex', sessionId: 'shared-session', title: 'Later discovered', directory: '/segment', updatedAt: 20 });
  const conflict = result.duplicateMetadata[0];
  assert.equal(conflict.identical, false);
  assert.equal(conflict.resolution, 'frozen-v2-last-discovered');
  assert.equal(conflict.selectedPath, fixture('segment-z'));
  assert.equal(conflict.firstSortedPath, fixture('segment-a'));
  assert.equal(conflict.differsFromFirstSorted, true);
  assert.equal(conflict.candidates.length, 2);
  assert.ok(conflict.candidates.every(row => /^[0-9a-f]{64}$/.test(row.source.sha256)));
  // Native discovery, not lexical order or latest timestamp, owns v2 selection.
  const reversed = selectCodexMetadata([...candidates].reverse());
  assert.equal(reversed.metadata[0].title, 'Earlier discovered');
  assert.equal(reversed.duplicateMetadata[0].differsFromFirstSorted, false);
});

test('identical duplicate metadata still retains source selection evidence', async () => {
  const facts = await scanCodexFile(fixture('alpha'), []);
  const result = selectCodexMetadata([{ path: 'a', ...facts }, { path: 'z', ...facts }]);
  assert.equal(result.metadata.length, 1);
  assert.equal(result.duplicateMetadata[0].identical, true);
  assert.equal(result.duplicateMetadata[0].selectedPath, 'z');
});

test('missing raw title matches only directory but returns canonical ID as summary title', () => {
  const source = [{ provider: 'codex', sessionId: 'canonical', title: null, directory: '/alpha/omega', updatedAt: 10 }];
  assert.equal(deriveMetadataMatches(source, query, 100)[0].title, 'canonical');
  assert.deepEqual(deriveMetadataMatches(source, { ...query, query: 'canonical' }, 100), []);
});

test('independent source comparison catches missing, reordered, wrong-ref and wrong-snippet results', () => {
  assert.equal(compareMetadata(expected, expected.slice(0, 2)).passed, false);
  const swapped = [expected[0], expected[2], expected[1]];
  assert.equal(compareMetadata(expected, swapped).orderedFieldsPassed, false);
  for (const mutate of [row => { row.session.sessionId = 'wrong'; }, row => { row.event = { messageId: 'invented' }; }, row => { row.snippet = 'wrong'; }]) {
    const rows = structuredClone(expected); mutate(rows[1]);
    assert.equal(compareMetadata(expected, rows).passed, false);
  }
});

test('source metadata derives the full bounded excerpt and catches drift', () => {
  const source = [{ ...metadata[0], title: 'alpha ' + 'x'.repeat(260) + ' omega' }];
  const derived = deriveMetadataMatches(source, query, 100);
  assert.equal(derived[0].snippet, source[0].title.slice(0, 240) + '…');
  assert.equal(compareMetadata(derived, derived).passed, true);
  const result = compareMetadata(derived, [{ ...derived[0], snippet: 'arbitrary' }]);
  assert.equal(result.passed, false);
  assert.equal(result.shortSnippetsPassed, false);
});

test('absence superset joins text blocks and includes encrypted task synthesis', () => {
  const response = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'nee' }, { type: 'output_text', text: 'dle' }] } };
  assert.deepEqual(codexBodySuperset(response), ['needle']);
  const task = codexBodySuperset({ type: 'response_item', payload: { type: 'agent_message', content: [{ type: 'text', text: 'Message Type: NEW_TASK\nTask name: example' }, { type: 'encrypted_content' }] } });
  assert.ok(task.some(text => text.includes('Subagent task: example')));
  assert.ok(task.some(text => text.includes('cannot be recovered locally')));
});

test('source-derived absence distinguishes no hit from any raw positive observation', async () => {
  const facts = await scanCodexFile(fixture('alpha'), [{ label: 'absent', query: 'never-found-sentinel', fields: ['user', 'assistant'] }, { label: 'present', query: 'alpha omega', fields: ['user', 'assistant'] }]);
  assert.deepEqual(facts.rawHits, { absent: 0, present: 1 });
  assert.equal(facts.source.records, 2);
  assert.match(facts.source.sha256, /^[0-9a-f]{64}$/);
});

test('stream scanner rejects malformed, truncated UTF-8, and oversized source lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'search-source-'));
  try {
    const file = path.join(dir, 'source.jsonl');
    await writeFile(file, '{}\n{bad\n');
    await assert.rejects(scanJsonl(file, () => {}), SyntaxError);
    await writeFile(file, Buffer.from([0x7b, 0x7d, 0x0a, 0xe4, 0xb8]));
    await assert.rejects(scanJsonl(file, () => {}), TypeError);
    await writeFile(file, JSON.stringify({ text: 'x'.repeat(100) }));
    await assert.rejects(scanJsonl(file, () => {}, 50), /SourceLineLimit/);
  } finally { await rm(dir, { recursive: true }); }
});

test('raw hybrid messages prove first hit, canonical counter IDs, tool names and question presentation', async () => {
  const queries = [
    { label: 'body', query: 'needle', fields: ['user', 'assistant'], providers: ['codex'] },
    { label: 'assistant', query: 'answer', fields: ['assistant'], providers: ['codex'] },
    { label: 'tool', query: 'read', fields: ['toolName'], providers: ['codex'] },
    { label: 'question', query: 'option yes', fields: ['user'], providers: ['codex'] },
    { label: 'hidden', query: 'private-id', fields: ['user'], providers: ['codex'] }
  ];
  const facts = await scanCodexFile(fixture('positive'), queries);
  assert.equal(facts.projection.complete, true);
  const matches = facts.projection.matches;
  assert.equal(matches.body.event.messageId, 'recorded-user');
  assert.equal(matches.body.matchRole, 'user');
  assert.equal(matches.assistant.event.messageId, 'agent-message-1');
  assert.equal(matches.assistant.snippet, 'The answer');
  assert.equal(matches.tool.event.messageId, 'tool-2');
  assert.equal(matches.tool.event.segment, 'tool');
  assert.equal(matches.tool.snippet, 'read_file');
  assert.equal(matches.question.event.messageId, 'msg-3');
  assert.equal(matches.hidden, null);
  const source = [{ ...facts, path: 'positive.jsonl' }];
  assert.equal(compareDocumentProjection(source, queries[0], Infinity, [matches.body]).passed, true);
  assert.equal(compareDocumentProjection(source, queries[0], Infinity, []).passed, false);
  const invented = structuredClone(matches.body); invented.session.sessionId = 'invented';
  assert.equal(compareDocumentProjection(source, queries[0], Infinity, [matches.body, invented]).passed, false);
  const foreign = structuredClone(matches.body); foreign.session.provider = 'pi';
  assert.equal(compareDocumentProjection(source, queries[0], Infinity, [matches.body, foreign]).passed, false);
  assert.equal(compareDocumentProjection(source, queries[0], 0, [matches.body]).passed, false);
  const wrong = structuredClone(matches.body); wrong.event.messageId = 'msg-0';
  assert.equal(compareDocumentProjection(source, queries[0], Infinity, [wrong]).orderedFieldsPassed, false);
});

test('task envelope excludes inherited hits and unresolved legacy forks never count as verified', async () => {
  const queries = [{ label: 'body', query: 'needle', fields: ['user', 'assistant'], providers: ['codex'] }];
  const child = await scanCodexFile(fixture('positive-child'), queries);
  assert.equal(child.projection.complete, true);
  assert.equal(child.projection.matches.body.event.messageId, 'msg-1');
  assert.equal(child.projection.matches.body.matchRole, 'assistant');
  const unresolved = await scanCodexFile(fixture('unresolved-parent'), queries);
  assert.equal(unresolved.projection.complete, false);
  const compared = compareDocumentProjection([{ ...child, path: 'child' }, { ...unresolved, path: 'unresolved' }], queries[0], Infinity, [child.projection.matches.body]);
  assert.equal(compared.orderedFieldsPassed, true);
  assert.equal(compared.passed, false);
  assert.equal(compared.unresolvedSessions, 1);
});

test('recorded subagent FINAL_ANSWER uses acknowledged actor evidence and assistant field', async () => {
  const queries = [
    { label: 'first', query: 'codex', fields: ['assistant'], providers: ['codex'] },
    { label: 'body', query: 'session review', fields: ['assistant'], providers: ['codex'] },
    { label: 'fallback', query: 'second recorded', fields: ['assistant'], providers: ['codex'] },
    { label: 'not-user', query: 'codex', fields: ['user'], providers: ['codex'] },
    { label: 'premature', query: 'premature', fields: ['assistant'], providers: ['codex'] },
    { label: 'spoofed', query: 'spoofed', fields: ['assistant'], providers: ['codex'] },
    { label: 'outgoing', query: 'outgoing', fields: ['assistant'], providers: ['codex'] }
  ];
  const facts = await scanCodexFile(fixture('agent-final'), queries);
  assert.equal(facts.projection.complete, true);
  const first = facts.projection.matches.first;
  assert.equal(first.event.messageId, 'recorded-result');
  assert.equal(first.matchField, 'message');
  assert.equal(first.matchRole, 'agent');
  assert.equal(first.snippet, '  codex session review found the issue.');
  assert.equal(facts.projection.matches.body.event.messageId, 'recorded-result');
  assert.equal(facts.projection.matches.fallback.event.messageId, 'agent-result-0');
  assert.deepEqual(facts.projection.agentEvidence.first, {
    author: '/root/reviewer', recipient: '/root', spawnCallId: 'spawn-1',
    spawnLine: 3, spawnTaskName: 'reviewer', acknowledgementLine: 6,
    answerTaskName: 'reviewer', answerLine: 7,
    answerBodySha256: '0045bb65e7d873bf621b9179378b4af08d5ab995ecf93df547b9667c43a241c1',
    messageId: 'recorded-result', firstMatchingDocumentOrdinal: 2
  });
  assert.equal(facts.projection.agentEvidence.fallback.messageId, 'agent-result-0');
  for (const label of ['not-user', 'premature', 'spoofed', 'outgoing']) assert.equal(facts.projection.matches[label], null);
  assert.equal(compareDocumentProjection([{ ...facts, path: fixture('agent-final') }], queries[0], 11, [first]).passed, true);
  const wrongRole = structuredClone(first); wrongRole.matchRole = 'assistant';
  assert.equal(compareDocumentProjection([{ ...facts, path: fixture('agent-final') }], queries[0], 11, [wrongRole]).passed, false);
});

test('source excerpts include literal percent, UTF-16 context and separated terms', () => {
  assert.equal(deriveExactSnippet('abc 100% done', '%'), 'abc 100% done');
  assert.equal(deriveExactSnippet('x'.repeat(50) + '中文' + 'y'.repeat(100), '中文'), '…' + 'x'.repeat(40) + '中文' + 'y'.repeat(80) + '…');
  assert.equal(deriveExactSnippet('codex distant session', 'codex session'), null);
  assert.equal(deriveSourceSnippet('codex' + 'x'.repeat(300) + 'session', 'codex session'),
    'codex' + 'x'.repeat(20) + '…' + 'x'.repeat(20) + 'session');
  assert.equal(deriveSourceSnippet('before codex between session after', 'codex session'),
    'before codex between session after');
});

test('legacy fork without an immediately copied parent header has owned body under frozen v2 rules', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'search-source-'));
  try {
    const file = path.join(dir, 'fork.jsonl');
    await writeFile(file, [
      { type: 'session_meta', timestamp: 10, payload: { id: 'fork', parent_thread_id: 'parent' } },
      { type: 'event_msg', timestamp: 9, payload: { type: 'user_message', message: 'before needle' } },
      { type: 'event_msg', timestamp: 11, payload: { type: 'user_message', message: 'owned needle' } }
    ].map(JSON.stringify).join('\n'));
    const facts = await scanCodexFile(file, [{ label: 'body', query: 'needle', fields: ['user'] }]);
    assert.equal(facts.projection.complete, true);
    assert.equal(facts.projection.matches.body.snippet, 'owned needle');
    assert.equal(facts.projection.matches.body.event.messageId, 'msg-0');
  } finally { await rm(dir, { recursive: true }); }
});

test('source title keeps a space at the 120-unit cut; comparison preserves mismatch witnesses', async () => {
  const facts = await scanCodexFile(fixture('positive'), [{ label: 'body', query: 'needle', fields: ['user'] }]);
  facts.projection.matches.body.title = 'x'.repeat(119) + ' ';
  assert.equal(deriveDocumentMatches({ ...facts.metadata, title: facts.projection.matches.body.title },
    [{ id: 'recorded', role: 'user', text: 'needle' }], [{ label: 'body', query: 'needle', fields: ['user'] }]).body.title,
  facts.projection.matches.body.title);
  const query = { label: 'body', providers: ['codex'] };
  const wrong = structuredClone(facts.projection.matches.body); wrong.title = wrong.title.trim();
  const result = compareDocumentProjection([{ ...facts, path: 'fixture' }], query, Infinity, [wrong]);
  assert.equal(result.passed, false);
  assert.equal(result.mismatchedSessions, 1);
  assert.deepEqual(result.mismatches[0].fields, ['title']);
});
