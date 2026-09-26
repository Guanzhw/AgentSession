import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const dir = new URL('./tmp/fixture/', import.meta.url);
mkdirSync(dir, { recursive: true });
const records = [
  { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'fixture' } },
  { timestamp: '2026-01-01T00:00:01Z', type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: 'fixture only' }] } },
  { timestamp: '2026-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 3 } } } }
];
const plain = Buffer.from(records.map(record => JSON.stringify(record)).join('\r\n') + '\r\n  \r\n{malformed');
writeFileSync(new URL('plain.jsonl', dir), plain);
writeFileSync(new URL('compressed.jsonl.zst', dir), zstdCompressSync(plain));
writeFileSync(new URL('manifest.json', dir), JSON.stringify(['plain.jsonl', 'compressed.jsonl.zst']));
