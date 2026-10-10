import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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

test('tool cards render normalized launch fields before collapsed input and reserve encrypted source for raw details', async () => {
  const server = await createServer({ root: ui, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
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
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.match(header, /Agent: reviewer&lt;&amp;>/);
    assert.match(header, /Model: gpt-6-luna/);
    assert.match(header, /Reasoning: max/);
    assert.match(header, /Context: none/);
    assert.ok(header.includes(agentAppearance('codex\0recorded-child').icon), 'dispatch uses the recorded child visual identity');
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
    assert.doesNotMatch(ordinary, /tool-metadata|Encrypted task message|technical-raw-input/);
    const command = render(Card, { props: { ...props, display: { ...props.display,
      item: { ...item({ ...metadata, taskName: null, model: null, reasoningEffort: null, forkTurns: null,
        inputState: 'recorded', summary: '<script>& "quoted"', directory: '/recorded/workspace' }), toolName: 'exec_command' } } } }).body;
    const commandHeader = command.slice(command.indexOf('<header'), command.indexOf('</header>'));
    assert.match(commandHeader, /&lt;script>&amp; "quoted"/);
    assert.doesNotMatch(commandHeader, /<script>/);
    assert.match(commandHeader, /Directory: \/recorded\/workspace/);
    assert.doesNotMatch(commandHeader, /Agent launch|Agent:|Context:/);

  } finally { await server.close(); }
});
