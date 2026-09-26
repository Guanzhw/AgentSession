import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getConfig } from "./config.js";
import type { Message, ProviderAdapter, SearchIndexSource } from "./providers/interface.js";
import { matchesSearchQuery, splitSearchTerms } from "./providers/shared/parser.js";
import { questionAnswersText } from "./providers/shared/question-answers.js";

export type SearchDocumentField = "user" | "assistant" | "toolName";

export interface SearchDocumentMatch {
  provider: string;
  sessionId: string;
  messageId: string;
  field: SearchDocumentField;
  role: string;
  text: string;
  timestamp: number;
  title: string | null;
  directory: string | null;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokenCount: number | null;
}

let searchDb: DatabaseSync | undefined;
const SEARCH_INDEX_FORMAT = `1:${process.versions.icu || "no-icu"}`;

export function closeSearchDb() {
  searchDb?.close();
  searchDb = undefined;
}

function ensureSchema() {
  if (searchDb) return searchDb;
  const db = new DatabaseSync(`${getConfig().metaPath}.search.db`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_index_revision (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_index_source (
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      title TEXT,
      directory TEXT,
      parent_id TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      token_count INTEGER,
      PRIMARY KEY (provider, session_id)
    );
    CREATE TABLE IF NOT EXISTS search_document (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      field TEXT NOT NULL,
      role TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      text TEXT NOT NULL,
      folded TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_document_session ON search_document(provider, session_id);
    CREATE INDEX IF NOT EXISTS idx_search_document_field ON search_document(provider, field);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_document_fts USING fts5(
      folded, content='search_document', content_rowid='id', tokenize='trigram', detail='none'
    );
    CREATE TRIGGER IF NOT EXISTS search_document_insert AFTER INSERT ON search_document BEGIN
      INSERT INTO search_document_fts(rowid, folded) VALUES (new.id, new.folded);
    END;
    CREATE TRIGGER IF NOT EXISTS search_document_delete AFTER DELETE ON search_document BEGIN
      INSERT INTO search_document_fts(search_document_fts, rowid, folded)
      VALUES ('delete', old.id, old.folded);
    END;
  `);
  db.prepare("INSERT OR IGNORE INTO search_index_revision(id, revision) VALUES (1, ?)").run(randomUUID());
  searchDb = db;
  return searchDb;
}

export function getSearchIndexRevision(): string {
  const db = ensureSchema();
  const durable = db.prepare("SELECT revision FROM search_index_revision WHERE id = 1").get()!.revision;
  const external = db.prepare("PRAGMA data_version").get()!.data_version;
  const local = db.prepare("SELECT total_changes() AS value").get()!.value;
  return `${durable}:${external}:${local}`;
}

function searchableText(message: Message): string {
  return message.questionAnswers ? questionAnswersText(message.questionAnswers) : message.content;
}

function* documents(messages: Message[]) {
  for (let ordinal = 0; ordinal < messages.length; ordinal += 1) {
    const message = messages[ordinal];
    if (message.role === "user" || message.role === "assistant") {
      const text = searchableText(message);
      if (text) yield { messageId: message.id, field: message.role, role: message.role, ordinal, timestamp: message.timestamp, text };
    }
    if (message.role === "tool" || message.toolName) {
      const text = message.toolName?.trim() || "tool";
      yield { messageId: message.id, field: "toolName", role: message.role, ordinal, timestamp: message.timestamp, text };
    }
  }
}

/** Synchronize only changed source revisions into the viewer-owned search index. */
export function refreshSearchIndex(provider: ProviderAdapter): { sources: number; changed: number } {
  if (!provider.getSearchIndexSources) throw new Error(`${provider.id} has no search source revision contract.`);
  const db = ensureSchema();
  const sources = provider.getSearchIndexSources();
  const revisionOf = (source: SearchIndexSource) => JSON.stringify([SEARCH_INDEX_FORMAT, source.revision]);
  const current = new Map<string, string>(sources.map((source: SearchIndexSource) => [source.sessionId, revisionOf(source)]));
  const previous = new Map<string, string>((db.prepare(
    "SELECT session_id, revision FROM search_index_source WHERE provider = ?"
  ).all(provider.id) as Array<{ session_id: string; revision: string }>).map(row => [row.session_id, row.revision]));
  const changed = sources.filter(source => previous.get(source.sessionId) !== revisionOf(source));
  const removed = [...previous.keys()].filter(sessionId => !current.has(sessionId));
  if (!changed.length && !removed.length) return { sources: sources.length, changed: 0 };

  const deleteDocuments = db.prepare("DELETE FROM search_document WHERE provider = ? AND session_id = ?");
  const deleteSource = db.prepare("DELETE FROM search_index_source WHERE provider = ? AND session_id = ?");
  const insertSource = db.prepare(`
    INSERT INTO search_index_source(provider, session_id, revision, title, directory, parent_id,
      time_created, time_updated, message_count, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDocument = db.prepare(`
    INSERT INTO search_document(provider, session_id, message_id, field, role, ordinal, timestamp, text, folded)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const sessionId of removed) {
      deleteDocuments.run(provider.id, sessionId);
      deleteSource.run(provider.id, sessionId);
    }
    for (const source of changed) {
      const session = provider.getSession(source.sessionId);
      if (!session || session.id !== source.sessionId) {
        throw new Error(`${provider.id} source ${source.sessionId} is not canonically readable.`);
      }
      const raw = session as Record<string, any>;
      const messages = provider.getSearchIndexMessages
        ? provider.getSearchIndexMessages(source.sessionId)
        : provider.getMessages(source.sessionId);
      deleteDocuments.run(provider.id, source.sessionId);
      deleteSource.run(provider.id, source.sessionId);
      for (const document of documents(messages)) {
        insertDocument.run(provider.id, source.sessionId, document.messageId, document.field, document.role,
          document.ordinal, document.timestamp, document.text,
          document.text.toLocaleLowerCase().replaceAll("\u0000", " "));
      }
      insertSource.run(provider.id, source.sessionId, revisionOf(source), raw.title ?? raw.slug ?? null,
        raw.directory ?? null, raw.parentId ?? raw.parent_id ?? null,
        Number(raw.timeCreated ?? raw.time_created) || 0, Number(raw.timeUpdated ?? raw.time_updated) || 0,
        Number(raw.messageCount ?? raw.message_count) || 0, raw.tokenCount ?? raw.token_count ?? null);
    }
    db.prepare("UPDATE search_index_revision SET revision = ? WHERE id = 1").run(randomUUID());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { sources: sources.length, changed: changed.length + removed.length };
}

/** The FTS trigram is a candidate filter; the existing matcher decides every hit. */
export function* findSearchDocuments(
  provider: string,
  query: string,
  fields: SearchDocumentField[]
): IterableIterator<SearchDocumentMatch> {
  if (!fields.length) return;
  const terms = splitSearchTerms(query);
  if (!terms.length) return;
  const db = ensureSchema();
  const candidate = terms.find(term => Array.from(term).length >= 3 && !/[%_\u0000]/u.test(term));
  const join = candidate ? "JOIN search_document_fts ON search_document_fts.rowid = d.id" : "";
  const candidateWhere = candidate ? "AND search_document_fts.folded LIKE ?" : "";
  const statement = db.prepare(`
    SELECT d.session_id, d.message_id, d.field, d.role, d.timestamp, d.text,
      s.title, s.directory, s.parent_id, s.time_created, s.time_updated, s.message_count, s.token_count
    FROM search_document AS d
    ${join}
    JOIN search_index_source AS s ON s.provider = d.provider AND s.session_id = d.session_id
    WHERE d.provider = ? AND d.field IN (SELECT value FROM json_each(?)) ${candidateWhere}
    ORDER BY s.time_updated DESC, s.time_created DESC, d.session_id ASC, d.ordinal ASC, d.id ASC
  `);
  const params = candidate
    ? [provider, JSON.stringify(fields), `%${candidate}%`]
    : [provider, JSON.stringify(fields)];
  for (const row of statement.iterate(...params) as Iterable<Record<string, any>>) {
    if (!matchesSearchQuery(row.text, query)) continue;
    yield {
      provider,
      sessionId: row.session_id,
      messageId: row.message_id,
      field: row.field,
      role: row.role,
      text: row.text,
      timestamp: Number(row.timestamp) || 0,
      title: row.title,
      directory: row.directory,
      parentId: row.parent_id,
      createdAt: Number(row.time_created) || 0,
      updatedAt: Number(row.time_updated) || 0,
      messageCount: Number(row.message_count) || 0,
      tokenCount: row.token_count
    };
  }
}
