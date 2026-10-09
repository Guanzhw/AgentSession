// Source-only search witness for the frozen OpenCode v2 SQLite transcript.
// This does not import AgentSession's parser, adapter, index, or search code.
import { DatabaseSync } from 'node:sqlite';

export function deriveOpenCodeToolMatches(file, query, updatedBefore) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error('EmptyToolQuery');
  const db = new DatabaseSync(file, { readOnly: true });
  const matches = new Map();
  try {
    const rows = db.prepare(`
      SELECT s.id AS session_id, s.title, s.slug, s.directory, s.time_updated,
        s.fork_session_id, m.id AS message_id, m.seq, m.data
      FROM session_v2 s JOIN session_message m ON m.session_id = s.id
      WHERE s.time_archived IS NULL AND s.time_updated <= ? AND m.type = 'assistant'
      ORDER BY s.id, m.seq, m.id
    `).iterate(updatedBefore);
    for (const row of rows) {
      if (matches.has(row.session_id)) continue;
      // A v2 fork copies settled parent messages as *_<source-seq>. Those
      // records are context, not tool calls owned by this session.
      if (row.fork_session_id && String(row.message_id).endsWith(`_${row.seq}`)) continue;
      const data = JSON.parse(row.data);
      if (!Array.isArray(data.content)) throw new Error('InvalidOpenCodeAssistantContent');
      for (const [index, part] of data.content.entries()) {
        if (part?.type !== 'tool') continue;
        if (typeof part.name !== 'string') throw new Error('InvalidOpenCodeToolName');
        if (!terms.every(term => part.name.toLowerCase().includes(term))) continue;
        if (part.name.length > 160) throw new Error('LongToolNameSnippetUnsupported');
        const session = { provider: 'opencode', sessionId: row.session_id };
        matches.set(row.session_id, {
          session, event: { ...session, messageId: `${row.message_id}:content:${index}`, segment: 'tool' },
          matchField: 'toolName', matchRole: 'tool', snippet: part.name,
          title: row.title || row.slug || row.session_id, directory: row.directory || null,
          updatedAt: Number(row.time_updated) || 0, untrustedContent: true
        });
        break;
      }
    }
  } finally { db.close(); }
  return [...matches.values()].sort((a, b) => b.updatedAt - a.updatedAt
    || a.session.sessionId.localeCompare(b.session.sessionId));
}
