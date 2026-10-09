//! Durable, scope-isolated search documents published with the source catalog.
use crate::providers::SessionSnapshot;
use crate::{CoreError, EventRef, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug)]
pub(crate) struct SearchDocument {
    pub session_id: String,
    pub field: String,
    pub position: usize,
    pub text: String,
    pub event: Option<EventRef>,
    pub role: Option<String>,
}

const DOCUMENT_VERSION: i64 = 4;

pub(crate) struct SearchRead {
    pub docs: Vec<SearchDocument>,
    #[cfg(test)]
    pub scanned_rows: usize,
    #[cfg(test)]
    pub indexed: bool,
    #[cfg(test)]
    pub query_plan: Vec<String>,
}

fn storage(error: impl std::fmt::Display) -> CoreError {
    CoreError::Storage(error.to_string())
}

pub(crate) fn needs_backfill(db: &Connection, provider: &str) -> Result<bool> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_doc_state')",
        [], |row| row.get(0),
    ).map_err(storage)?;
    if !exists {
        return Ok(true);
    }
    let version: Option<i64> = db
        .query_row(
            "SELECT version FROM search_doc_state WHERE provider=?1",
            [provider],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage)?;
    if version != Some(DOCUMENT_VERSION) {
        return Ok(true);
    }
    let fts_exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_doc_fts')",
        [], |row| row.get(0),
    ).map_err(storage)?;
    Ok(!fts_exists)
}

pub(crate) fn publish_docs(
    tx: &Transaction<'_>,
    provider: &str,
    changed: &BTreeMap<String, SessionSnapshot>,
    deleted: &[String],
) -> Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS search_doc_state (
        provider TEXT PRIMARY KEY, version INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS search_doc (
        provider TEXT NOT NULL, session_id TEXT NOT NULL, field TEXT NOT NULL,
        position INTEGER NOT NULL, message_id TEXT, segment TEXT, role TEXT, text TEXT NOT NULL,
        PRIMARY KEY (provider, session_id, field, position)
    ); CREATE INDEX IF NOT EXISTS search_doc_provider_session ON search_doc(provider, session_id)",
    )
    .map_err(storage)?;
    // FTS stores the Rust-normalized text. The exact matcher uses the same
    // normalization, so a three-character ASCII trigram is a safe superset.
    tx.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS search_doc_fts USING fts5(lower_text, tokenize='trigram')",
    ).map_err(storage)?;
    for id in deleted.iter().chain(changed.keys()) {
        tx.execute(
            "DELETE FROM search_doc_fts WHERE rowid IN
                (SELECT rowid FROM search_doc WHERE provider=?1 AND session_id=?2)",
            params![provider, id],
        )
        .map_err(storage)?;
        tx.execute(
            "DELETE FROM search_doc WHERE provider=?1 AND session_id=?2",
            params![provider, id],
        )
        .map_err(storage)?;
    }
    let mut insert = tx
        .prepare(
            "INSERT INTO search_doc
        (provider,session_id,field,position,message_id,segment,role,text)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        )
        .map_err(storage)?;
    for (id, snapshot) in changed {
        if snapshot.summary.session.provider != provider
            || snapshot.summary.session.session_id != *id
        {
            return Err(CoreError::Storage(format!(
                "search document identity differs from {provider}/{id}"
            )));
        }
        if let Some(title) = &snapshot.summary.search_title {
            insert
                .execute(params![
                    provider,
                    id,
                    "title",
                    0,
                    None::<&str>,
                    None::<&str>,
                    None::<&str>,
                    title
                ])
                .map_err(storage)?;
            tx.execute(
                "INSERT INTO search_doc_fts(rowid,lower_text) VALUES (?1,?2)",
                params![tx.last_insert_rowid(), indexed_text(title)],
            )
            .map_err(storage)?;
        }
        if let Some(directory) = &snapshot.summary.directory {
            insert
                .execute(params![
                    provider,
                    id,
                    "directory",
                    0,
                    None::<&str>,
                    None::<&str>,
                    None::<&str>,
                    directory
                ])
                .map_err(storage)?;
            tx.execute(
                "INSERT INTO search_doc_fts(rowid,lower_text) VALUES (?1,?2)",
                params![tx.last_insert_rowid(), indexed_text(directory)],
            )
            .map_err(storage)?;
        }
        for record in &snapshot.events {
            let event = &record.item.event;
            if event.provider != provider || event.session_id != *id {
                return Err(CoreError::Storage(format!(
                    "search event identity differs from {provider}/{id}"
                )));
            }
            match (event.segment.as_str(), record.item.role.as_str()) {
                ("message", role @ ("user" | "assistant" | "agent")) if !record.body.is_empty() => {
                    let field = if role == "agent" { "assistant" } else { role };
                    insert
                        .execute(params![
                            provider,
                            id,
                            field,
                            record.item.ordinal as i64,
                            &event.message_id,
                            &event.segment,
                            role,
                            &record.body
                        ])
                        .map_err(storage)?;
                    tx.execute(
                        "INSERT INTO search_doc_fts(rowid,lower_text) VALUES (?1,?2)",
                        params![tx.last_insert_rowid(), indexed_text(&record.body)],
                    )
                    .map_err(storage)?;
                }
                ("tool", _) => {
                    if let Some(name) = record.item.tool_name.as_deref() {
                        insert
                            .execute(params![
                                provider,
                                id,
                                "toolName",
                                record.item.ordinal as i64,
                                &event.message_id,
                                &event.segment,
                                &record.item.role,
                                name
                            ])
                            .map_err(storage)?;
                        tx.execute(
                            "INSERT INTO search_doc_fts(rowid,lower_text) VALUES (?1,?2)",
                            params![tx.last_insert_rowid(), indexed_text(name)],
                        )
                        .map_err(storage)?;
                    }
                }
                _ => {}
            }
        }
    }
    tx.execute(
        "INSERT INTO search_doc_state(provider,version) VALUES (?1,?2)
        ON CONFLICT(provider) DO UPDATE SET version=excluded.version",
        params![provider, DOCUMENT_VERSION],
    )
    .map_err(storage)?;
    Ok(())
}

fn indexed_text(text: &str) -> String {
    text.to_lowercase().replace('\0', " ")
}

fn exact_match(text: &str, terms: &[String]) -> bool {
    let lower = text.to_lowercase();
    terms.iter().all(|term| lower.contains(term))
}

fn ascii_trigram(terms: &[String]) -> Option<String> {
    if terms.iter().any(|term| term.contains('\0')) {
        return None;
    }
    terms
        .iter()
        .flat_map(|term| term.as_bytes().windows(3))
        .find(|bytes| bytes.iter().all(u8::is_ascii_alphanumeric))
        .map(|bytes| String::from_utf8(bytes.to_vec()).expect("ASCII trigram"))
}

#[cfg(test)]
pub(crate) fn read_docs(
    index_dir: &Path,
    scope: &str,
    provider: &str,
    expected_revision: &str,
    fields: &[String],
    terms: &[String],
) -> Result<SearchRead> {
    read_docs_with_utf16(
        index_dir,
        scope,
        provider,
        expected_revision,
        fields,
        terms,
        None,
    )
}

pub(crate) fn read_docs_with_utf16(
    index_dir: &Path,
    scope: &str,
    provider: &str,
    expected_revision: &str,
    fields: &[String],
    terms: &[String],
    utf16_terms: Option<&[Vec<u16>]>,
) -> Result<SearchRead> {
    let path = index_dir.join(format!("{scope}.sqlite"));
    let db =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(storage)?;
    db.execute_batch("BEGIN").map_err(storage)?;
    let revision: Option<i64> = db
        .query_row(
            "SELECT revision FROM catalog_state WHERE provider=?1",
            [provider],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage)?;
    if format!("{provider}:{}", revision.unwrap_or(0)) != expected_revision {
        return Err(CoreError::SourceChanged);
    }
    if needs_backfill(&db, provider)? {
        return Err(CoreError::Storage(format!(
            "{provider} search documents require backfill"
        )));
    }
    if fields.is_empty() {
        return Ok(SearchRead {
            docs: Vec::new(),
            #[cfg(test)]
            scanned_rows: 0,
            #[cfg(test)]
            indexed: false,
            #[cfg(test)]
            query_plan: Vec::new(),
        });
    }
    let fts_available: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_doc_fts')",
        [], |row| row.get(0),
    ).map_err(storage)?;
    let trigram = if fts_available && utf16_terms.is_none() {
        ascii_trigram(terms)
    } else {
        None
    };
    let selected_fields = std::iter::repeat_n("?", fields.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut sql =
        String::from("SELECT d.session_id,d.field,d.position,d.text,d.message_id,d.segment,d.role");
    if trigram.is_some() {
        // Preserve FTS as the outer loop: bundled SQLite otherwise prefers the
        // provider/order index and reruns MATCH for each provider document.
        sql.push_str(
            " FROM search_doc_fts CROSS JOIN search_doc d ON d.rowid=search_doc_fts.rowid",
        );
    } else {
        sql.push_str(" FROM search_doc d");
    }
    sql.push_str(&format!(
        " WHERE d.provider=? AND d.field IN ({selected_fields})"
    ));
    if trigram.is_some() {
        sql.push_str(" AND search_doc_fts MATCH ?");
    }
    sql.push_str(" ORDER BY d.session_id,d.field,d.position");
    let mut bind: Vec<rusqlite::types::Value> = Vec::with_capacity(fields.len() + 2);
    bind.push(provider.to_owned().into());
    bind.extend(fields.iter().cloned().map(Into::into));
    if let Some(token) = &trigram {
        bind.push(format!("\"{token}\"").into());
    }
    #[cfg(test)]
    let query_plan: Vec<String> = db
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .map_err(storage)?
        .query_map(rusqlite::params_from_iter(&bind), |row| row.get(3))
        .map_err(storage)?
        .collect::<rusqlite::Result<_>>()
        .map_err(storage)?;
    let mut statement = db.prepare(&sql).map_err(storage)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(&bind), |row| {
            let session_id: String = row.get(0)?;
            let message_id: Option<String> = row.get(4)?;
            let segment: Option<String> = row.get(5)?;
            Ok(SearchDocument {
                event: message_id
                    .zip(segment)
                    .map(|(message_id, segment)| EventRef {
                        provider: provider.into(),
                        session_id: session_id.clone(),
                        message_id,
                        segment,
                    }),
                session_id,
                field: row.get(1)?,
                position: row.get::<_, i64>(2)?.max(0) as usize,
                text: row.get(3)?,
                role: row.get(6)?,
            })
        })
        .map_err(storage)?;
    let mut best = BTreeMap::<String, SearchDocument>::new();
    #[cfg(test)]
    let mut scanned_rows = 0;
    for row in rows {
        let doc = row.map_err(storage)?;
        #[cfg(test)]
        {
            scanned_rows += 1;
        }
        let matched = utf16_terms.map_or_else(
            || exact_match(&doc.text, terms),
            |needles| {
                let lower: Vec<u16> = doc.text.to_lowercase().encode_utf16().collect();
                needles
                    .iter()
                    .all(|needle| lower.windows(needle.len()).any(|window| window == needle))
            },
        );
        if matched {
            let priority = |item: &SearchDocument| match item.field.as_str() {
                "title" => 0,
                "directory" => 1,
                "user" | "assistant" => 2,
                _ => 3,
            };
            match best.entry(doc.session_id.clone()) {
                std::collections::btree_map::Entry::Vacant(slot) => {
                    slot.insert(doc);
                }
                std::collections::btree_map::Entry::Occupied(mut slot) => {
                    let current = slot.get();
                    if priority(&doc) < priority(current)
                        || priority(&doc) == priority(current) && doc.position < current.position
                    {
                        slot.insert(doc);
                    }
                }
            }
        }
    }
    Ok(SearchRead {
        docs: best.into_values().collect(),
        #[cfg(test)]
        scanned_rows,
        #[cfg(test)]
        indexed: trigram.is_some(),
        #[cfg(test)]
        query_plan,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::NormalizedEvent;
    use crate::{ReaderItem, SessionRef, SessionSummary};
    use tempfile::tempdir;

    fn snapshot(id: &str, body: &str) -> SessionSnapshot {
        let reference = SessionRef {
            provider: "codex".into(),
            session_id: id.into(),
        };
        let event = |message_id: &str, segment: &str| EventRef {
            provider: "codex".into(),
            session_id: id.into(),
            message_id: message_id.into(),
            segment: segment.into(),
        };
        let record =
            |message_id: &str, segment: &str, role: &str, text: &str, tool_name: Option<&str>| {
                NormalizedEvent {
                    item: ReaderItem {
                        ordinal: 0,
                        owner: None,
                        event: event(message_id, segment),
                        role: role.into(),
                        timestamp: Some(1),
                        preview: "preview".into(),
                        total_chars: text.encode_utf16().count(),
                        tool_name: tool_name.map(str::to_owned),
                        owner_message_id: None,
                        presentation_phase: None,
                        process_id: None,
                        process_count: None,
                        tool_metadata: None,
                        reply_metadata: None,
                    },
                    body: text.into(),
                    tool_input: "SECRET_INPUT".into(),
                    tool_output: "SECRET_OUTPUT".into(),
                    tool_status: None,
                }
            };
        SessionSnapshot {
            summary: SessionSummary {
                diagnostic: None,
                session: reference,
                title: format!("Title {id}"),
                search_title: Some(format!("Title {id}")),
                directory: Some("/project".into()),
                created_at: Some(1),
                updated_at: Some(2),
                message_count: 2,
                conversation_message_count: None,
                token_count: None,
                duration_ms: None,
                summary_files: None,
                summary_additions: None,
                summary_deletions: None,
                parent: None,
            },
            revision: format!("revision-{id}"),
            events: vec![
                record("user", "message", "user", body, None),
                record("assistant", "message", "assistant", "answer", None),
                record(
                    "reasoning",
                    "thinking",
                    "assistant",
                    "SECRET_THINKING",
                    None,
                ),
                record("tool", "tool", "tool", "", Some("Read")),
            ],
            relations: Vec::new(),
        }
    }

    #[test]
    fn fallback_display_title_never_becomes_an_indexed_title_document() {
        let root = tempdir().unwrap();
        let mut db = Connection::open(root.path().join("scope.sqlite")).unwrap();
        let mut session = snapshot("canonical-id", "body");
        session.summary.title = "canonical-id".into();
        session.summary.search_title = None;
        let tx = db.transaction().unwrap();
        publish_docs(
            &tx,
            "codex",
            &BTreeMap::from([("canonical-id".into(), session)]),
            &[],
        )
        .unwrap();
        tx.commit().unwrap();
        let title_count: i64 = db
            .query_row(
                "SELECT count(*) FROM search_doc WHERE provider='codex' AND field='title'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title_count, 0);
    }

    #[test]
    fn utf16_scan_keeps_the_later_matching_document_in_a_session() {
        let root = tempdir().unwrap();
        let mut db = Connection::open(root.path().join("scope.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE catalog_state (provider TEXT PRIMARY KEY, revision INTEGER NOT NULL); INSERT INTO catalog_state VALUES ('codex',1)").unwrap();
        let mut session = snapshot("one", "\u{e000}");
        let mut later = snapshot("one", "🙂").events.into_iter().next().unwrap();
        later.item.event.message_id = "later".into();
        later.item.ordinal = 2;
        later.body = "🙂".into();
        session.events.push(later);
        let tx = db.transaction().unwrap();
        publish_docs(
            &tx,
            "codex",
            &BTreeMap::from([("one".into(), session)]),
            &[],
        )
        .unwrap();
        tx.commit().unwrap();
        let result = read_docs_with_utf16(
            root.path(),
            "scope",
            "codex",
            "codex:1",
            &["user".into()],
            &[],
            Some(&[vec![0xd83d]]),
        )
        .unwrap();
        assert_eq!(result.docs.len(), 1);
        assert_eq!(result.docs[0].event.as_ref().unwrap().message_id, "later");
        assert!(
            !result.indexed,
            "surrogate units require the exact document scan"
        );
    }

    #[test]
    fn changed_documents_publish_atomically_and_unchanged_reads_need_no_provider() {
        let root = tempdir().unwrap();
        let db_path = root.path().join("scope.sqlite");
        let mut db = Connection::open(&db_path).unwrap();
        db.execute_batch("CREATE TABLE catalog_state (provider TEXT PRIMARY KEY, revision INTEGER NOT NULL); INSERT INTO catalog_state VALUES ('codex',1)").unwrap();
        assert!(needs_backfill(&db, "codex").unwrap());
        let tx = db.transaction().unwrap();
        publish_docs(
            &tx,
            "codex",
            &BTreeMap::from([
                ("one".into(), snapshot("one", "first needle")),
                ("two".into(), snapshot("two", "second needle")),
            ]),
            &[],
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(!needs_backfill(&db, "codex").unwrap());
        let fields = ["title", "directory", "user", "assistant", "toolName"].map(str::to_owned);
        let first = read_docs(
            root.path(),
            "scope",
            "codex",
            "codex:1",
            &fields,
            &["needle".into()],
        )
        .unwrap()
        .docs;
        let second = read_docs(
            root.path(),
            "scope",
            "codex",
            "codex:1",
            &fields,
            &["needle".into()],
        )
        .unwrap()
        .docs;
        assert_eq!(
            first.len(),
            second.len(),
            "repeated reads use published rows without source access"
        );
        assert!(first.iter().any(|doc| {
            doc.event
                .as_ref()
                .is_some_and(|event| event.message_id == "user")
                && doc.text == "first needle"
        }));
        let tools = read_docs(
            root.path(),
            "scope",
            "codex",
            "codex:1",
            &fields,
            &["read".into()],
        )
        .unwrap()
        .docs;
        assert!(
            tools
                .iter()
                .any(|doc| doc.field == "toolName" && doc.text == "Read")
        );
        assert!(!first.iter().any(|doc| doc.text.contains("SECRET")));
        let tx = db.transaction().unwrap();
        publish_docs(
            &tx,
            "codex",
            &BTreeMap::from([
                ("one".into(), snapshot("one", "rewritten needle")),
                ("three".into(), snapshot("three", "appended needle")),
            ]),
            &["two".into()],
        )
        .unwrap();
        tx.execute(
            "UPDATE catalog_state SET revision=2 WHERE provider='codex'",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(matches!(
            read_docs(
                root.path(),
                "scope",
                "codex",
                "codex:1",
                &fields,
                &["needle".into()]
            ),
            Err(CoreError::SourceChanged)
        ));
        let updated = read_docs(
            root.path(),
            "scope",
            "codex",
            "codex:2",
            &fields,
            &["needle".into()],
        )
        .unwrap()
        .docs;
        assert!(updated.iter().any(|doc| doc.text == "rewritten needle"));
        assert!(updated.iter().any(|doc| doc.text == "appended needle"));
        assert!(
            !updated
                .iter()
                .any(|doc| doc.text == "first needle" || doc.session_id == "two")
        );
        let documents: i64 = db
            .query_row("SELECT count(*) FROM search_doc", [], |row| row.get(0))
            .unwrap();
        let tokens: i64 = db
            .query_row("SELECT count(*) FROM search_doc_fts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            tokens, documents,
            "rewrite and deletion remove prior FTS rows"
        );
    }

    #[test]
    fn trigram_candidates_are_selective_and_preserve_unicode_and_nul_matches() {
        let root = tempdir().unwrap();
        let mut db = Connection::open(root.path().join("scope.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE catalog_state (provider TEXT PRIMARY KEY, revision INTEGER NOT NULL); INSERT INTO catalog_state VALUES ('codex',1)").unwrap();
        let mut changed = BTreeMap::new();
        for i in 0..100 {
            let id = format!("noise-{i}");
            changed.insert(id.clone(), snapshot(&id, "ordinary unrelated text"));
        }
        changed.insert(
            "target".into(),
            snapshot("target", "İK\0abc!? search target"),
        );
        let tx = db.transaction().unwrap();
        publish_docs(&tx, "codex", &changed, &[]).unwrap();
        tx.commit().unwrap();
        let fields = ["user".into(), "assistant".into()];
        let selected = read_docs(
            root.path(),
            "scope",
            "codex",
            "codex:1",
            &fields,
            &["abc".into()],
        )
        .unwrap();
        assert!(selected.indexed, "bundled SQLite provides FTS5 trigram");
        assert!(
            selected.scanned_rows < 10,
            "candidate query must avoid materializing all documents"
        );
        assert!(
            selected
                .query_plan
                .first()
                .is_some_and(|step| { step.contains("search_doc_fts VIRTUAL TABLE INDEX") }),
            "FTS candidates must drive document rowid lookups, not be rerun per provider document: {:?}",
            selected.query_plan
        );
        assert!(
            selected
                .query_plan
                .iter()
                .any(|step| step.contains("SEARCH d USING INTEGER PRIMARY KEY")),
            "candidate rowids must fetch documents directly: {:?}",
            selected.query_plan
        );
        assert_eq!(selected.docs.len(), 1);
        assert_eq!(selected.docs[0].session_id, "target");
        for term in ["i\u{307}", "k", "\0abc"] {
            let result = read_docs(
                root.path(),
                "scope",
                "codex",
                "codex:1",
                &fields,
                &[term.into()],
            )
            .unwrap();
            assert!(!result.indexed, "short or NUL terms use the exact scan");
            assert_eq!(result.docs.len(), 1, "Rust lowercase match for {term:?}");
        }
        let ascii_expansion = read_docs(
            root.path(),
            "scope",
            "codex",
            "codex:1",
            &fields,
            &["i".into()],
        )
        .unwrap();
        assert!(
            ascii_expansion
                .docs
                .iter()
                .any(|doc| doc.session_id == "target"),
            "ASCII i must match Rust lowercase expansion of İ"
        );
        let punctuation = read_docs(
            root.path(),
            "scope",
            "codex",
            "codex:1",
            &fields,
            &["abc!?".into()],
        )
        .unwrap();
        assert!(punctuation.indexed);
        assert_eq!(punctuation.docs.len(), 1);
        let combined = read_docs(
            root.path(),
            "scope",
            "codex",
            "codex:1",
            &fields,
            &["abc".into(), "missing".into()],
        )
        .unwrap();
        assert!(
            combined.docs.is_empty(),
            "all terms remain required in one document"
        );
    }
}
