import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../ui/package.json', import.meta.url));
const { createServer } = require('vite');
const ui = fileURLToPath(new URL('../ui/', import.meta.url));
const event = { provider: 'codex', sessionId: 'controlled-parent', messageId: 'spawn', segment: 'tool' };
const item = metadata => ({ event, ordinal: 1, owner: null, role: 'tool', timestamp: null,
  preview: 'spawn_agent: recorded result', totalChars: 15, toolName: 'spawn_agent',
  presentationPhase: null, processId: null, processCount: null, replyMetadata: null,
  toolMetadata: metadata, contentRevisions: {} });
const progress = text => ({ text, hasLoaded: true, totalChars: text.length,
  nextOffset: null, done: true, loading: false, error: '' });
const metadata = { summary: null, directory: null, taskName: 'reviewer<&>', model: 'gpt-6-luna', reasoningEffort: 'max', forkTurns: 'none', inputState: 'encrypted' };

test('tool cards expose one collapsed normalized row and reserve exact input for details', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'agentsession-v3-tool-metadata-cache-'));
  const server = await createServer({ root: ui, cacheDir, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const { language } = await server.ssrLoadModule('/src/lib/i18n.ts');
    language.set('en');
    const { default: Card } = await server.ssrLoadModule('/src/lib/EventCard.svelte');
    const { render } = await server.ssrLoadModule('svelte/server');
    const { agentAppearance } = await server.ssrLoadModule('/src/lib/transcript-collaboration.ts');
    const props = { display: { item: item(metadata), key: 'spawn', anchor: 'spawn-anchor' },
      toolInputProgress: progress('{"message":"gAAAAA_fixture_ciphertext"}'),
      collaborationIdentity: { from: '/root', to: '/root/reviewer', fromSession: null,
        toSession: { provider: 'codex', sessionId: 'recorded-child' }, fromKey: 'main', toKey: 'codex\0recorded-child' },
      onReadMore: () => {} };
    const html = render(Card, { props }).body;
    const row = html.slice(html.indexOf('<summary class="tool-row'), html.indexOf('</summary>'));
    assert.match(row, /spawn_agent/);
    assert.match(row, /reviewer&lt;&amp;>/);
    assert.doesNotMatch(row, /Model:|Reasoning:|Context:|Encrypted|gAAAAA|tool-kind/);
    assert.doesNotMatch(html, /<details class="tool-disclosure[^"]*"[^>]*\bopen\b/);
    const detailStart = html.indexOf('<div class="tool-detail-body');
    assert.match(html.slice(detailStart), /Agent: reviewer&lt;&amp;>/);
    assert.match(html.slice(detailStart), /Model: gpt-6-luna/);
    assert.match(html.slice(detailStart), /Reasoning: max/);
    assert.match(html.slice(detailStart), /Context: none/);
    assert.ok(row.includes(agentAppearance('codex\0recorded-child').icon), 'dispatch uses the recorded child visual identity');
    assert.match(html, /Encrypted task message/);
    assert.match(html, /The task message is encrypted in the recorded source\./);
    assert.match(html, /<details class="technical-raw-input[^"]*"[^>]*>\s*<summary[^>]*>Raw input<\/summary>[\s\S]*gAAAAA_fixture_ciphertext/);
    assert.doesNotMatch(html, /<details class="technical-raw-input[^"]*"[^>]*\bopen\b/);
    const rawStart = html.indexOf('<details class="technical-raw-input');
    assert.ok(html.indexOf('gAAAAA_fixture_ciphertext') > rawStart);

    const readable = render(Card, { props: { ...props, display: { ...props.display,
      item: item({ ...metadata, inputState: 'recorded' }) },
      toolInputProgress: progress('Read the exact source and return findings.') } }).body;
    assert.match(readable, /Read the exact source and return findings\./);
    assert.doesNotMatch(readable, /Encrypted task message|technical-raw-input/);
    const ordinary = render(Card, { props: { ...props, display: { ...props.display,
      item: { ...item(null), toolName: 'exec_command' } }, toolInputProgress: progress('{"cmd":"git status --short"}') } }).body;
    assert.match(ordinary, /git status --short/);
    const ordinaryRow = ordinary.slice(ordinary.indexOf('<summary class="tool-row'), ordinary.indexOf('</summary>'));
    assert.doesNotMatch(ordinaryRow, /git status|cmd|recorded result/);
    assert.match(ordinaryRow, /exec_command/);
    assert.doesNotMatch(ordinary, /tool-metadata|Encrypted task message|technical-raw-input/);
    const command = render(Card, { props: { ...props, display: { ...props.display,
      item: { ...item({ ...metadata, taskName: null, model: null, reasoningEffort: null, forkTurns: null,
        inputState: 'recorded', summary: '<script>& "quoted"', directory: '/recorded/workspace' }), toolName: 'exec_command' } } } }).body;
    const commandRow = command.slice(command.indexOf('<summary class="tool-row'), command.indexOf('</summary>'));
    assert.match(commandRow, /&lt;script>&amp; "quoted"/);
    assert.doesNotMatch(commandRow, /<script>|Agent launch|Agent:|Context:/);
    assert.match(command, /Directory: \/recorded\/workspace/);

    const completed = render(Card, { props: { ...props, executionLandmarks: [
      { phase: 'yielded', label: 'Continued in the background' },
      { phase: 'completed', label: 'Result returned', counterpart: { ...event, messageId: 'yielded' }, counterpartLabel: 'Back to background handoff' },
    ], onOpenCounterpart: () => {} } }).body;
    const completedRow = completed.slice(completed.indexOf('<summary class="tool-row'), completed.indexOf('</summary>'));
    assert.match(completedRow, /data-phase="completed"[^>]*>Returned result/);
    assert.doesNotMatch(completedRow, /Continued in the background|Back to background handoff/);
    assert.match(completed, /data-execution-counterpart="yielded"/);
    assert.doesNotMatch(ordinaryRow, /data-phase/);

    const search = render(Card, { props: { ...props, searchReveal: { field: 'toolOutput', offset: 20,
      matchLength: 6, text: 'needle in exact output', totalChars: 100 } } }).body;
    assert.match(search, /<details class="tool-disclosure[^"]*"[^>]*\bopen\b/);
    assert.match(search, /id="spawn-anchor"/);
    assert.match(search, /data-field="toolOutput"/);
    assert.match(search, /<mark[^>]*>needle<\/mark>/);

  } finally { await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
