//! Scope-isolated, rebuildable catalog of provider source summaries.
use crate::providers::{ProviderAdapter, SourceEntry};
use crate::search_index;
use crate::{CoreError, Result, SessionSummary};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::path::Path;

#[cfg(all(feature = "crash-test-hook", not(debug_assertions)))]
compile_error!("crash-test-hook is only available in debug builds");

pub(crate) struct PublishedCatalog {
    pub rows: Vec<SessionSummary>,
    pub revision: String,
    pub source_uncertainty: Option<(&'static str, usize)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexResult {
    pub provider: String,
    pub status: &'static str,
    pub revision: Option<String>,
    pub session_count: Option<usize>,
    pub diagnostic: Option<String>,
}

const STORED_SUMMARY_SCHEMA_VERSION: u8 = 14;

#[derive(Deserialize, Serialize)]
struct StoredSummary {
    #[serde(rename = "_schemaVersion", default)]
    schema_version: u8,
    #[serde(flatten)]
    summary: SessionSummary,
    #[serde(rename = "_searchTitle")]
    search_title: Option<String>,
    #[serde(
        rename = "_indexCaptureRevision",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    index_capture_revision: Option<String>,
}

fn storage(error: impl std::fmt::Display) -> CoreError {
    CoreError::Storage(error.to_string())
}

/// The file lock covers inventory, capture, and publication. A crashed process
/// releases the OS lock; SQLite readers see either complete generation.
pub(crate) fn refresh(
    index_dir: &Path,
    scope: &str,
    provider: &str,
    adapter: &dyn ProviderAdapter,
) -> Result<Option<PublishedCatalog>> {
    publish(
        index_dir,
        scope,
        provider,
        adapter,
        false,
        #[cfg(feature = "search-phase-probe")]
        None,
    )
}

#[cfg(feature = "search-phase-probe")]
pub(crate) fn refresh_with_probe(
    index_dir: &Path,
    scope: &str,
    provider: &str,
    adapter: &dyn ProviderAdapter,
    probe: &mut crate::search::SearchPhaseProbe,
) -> Result<Option<PublishedCatalog>> {
    publish(index_dir, scope, provider, adapter, false, Some(probe))
}

fn publish(
    index_dir: &Path,
    scope: &str,
    provider: &str,
    adapter: &dyn ProviderAdapter,
    force: bool,
    #[cfg(feature = "search-phase-probe")] mut probe: Option<&mut crate::search::SearchPhaseProbe>,
) -> Result<Option<PublishedCatalog>> {
    if !adapter.supports_index() {
        return Ok(None);
    }
    fs::create_dir_all(index_dir).map_err(|source| CoreError::Io {
        path: index_dir.to_owned(),
        source,
    })?;
    let lock_path = index_dir.join(format!("{scope}.lock"));
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)
        .map_err(|source| CoreError::Io {
            path: lock_path,
            source,
        })?;
    #[cfg(feature = "search-phase-probe")]
    let phase_started = probe.as_ref().and_then(|probe| probe.begin());
    lock.lock().map_err(storage)?;
    #[cfg(feature = "search-phase-probe")]
    if let Some(probe) = probe.as_mut() {
        probe.add("index_publish_lock", phase_started);
    }
    #[cfg(feature = "search-phase-probe")]
    let phase_started = probe.as_ref().and_then(|probe| probe.begin());
    let observation = adapter.inventory_observation(force)?;
    let inventory = observation.entries.ok_or_else(|| {
        CoreError::Storage(format!(
            "{provider} declared indexed capture without inventory"
        ))
    })?;
    #[cfg(feature = "search-phase-probe")]
    if let Some(probe) = probe.as_mut() {
        probe.add("inventory", phase_started);
    }
    let db_path = index_dir.join(format!("{scope}.sqlite"));
    let mut db = Connection::open(db_path).map_err(storage)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS catalog_state (
           provider TEXT PRIMARY KEY, revision INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS catalog_entry (
           provider TEXT NOT NULL, session_id TEXT NOT NULL,
           signature TEXT NOT NULL, summary_json TEXT NOT NULL,
           PRIMARY KEY (provider, session_id)
         );",
    )
    .map_err(storage)?;
    #[cfg(feature = "search-phase-probe")]
    let phase_started = probe.as_ref().and_then(|probe| probe.begin());
    let mut existing = BTreeMap::<String, (String, SessionSummary, u8, Option<String>)>::new();
    {
        let mut query = db
            .prepare(
                "SELECT session_id, signature, summary_json FROM catalog_entry WHERE provider = ?1",
            )
            .map_err(storage)?;
        let rows = query
            .query_map([provider], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(storage)?;
        for row in rows {
            let (id, signature, encoded) = row.map_err(storage)?;
            let stored: StoredSummary = serde_json::from_str(&encoded).map_err(storage)?;
            let mut summary = stored.summary;
            summary.search_title = stored.search_title;
            existing.insert(
                id,
                (
                    signature,
                    summary,
                    stored.schema_version,
                    stored.index_capture_revision,
                ),
            );
        }
    }
    #[cfg(feature = "search-phase-probe")]
    if let Some(probe) = probe.as_mut() {
        probe.add("catalog_decode", phase_started);
    }
    let mut incoming = BTreeMap::<String, SourceEntry>::new();
    for entry in inventory {
        if incoming.insert(entry.session_id.clone(), entry).is_some() {
            return Err(CoreError::Storage(format!(
                "duplicate source identity in {provider} inventory"
            )));
        }
    }
    let backfill = search_index::needs_backfill(&db, provider)?;
    let changed = force
        || backfill
        || incoming.len() != existing.len()
        || incoming.iter().any(|(id, entry)| {
            existing.get(id).is_none_or(|(signature, _, version, _)| {
                signature != &entry.signature || *version != STORED_SUMMARY_SCHEMA_VERSION
            })
        });
    if changed {
        // Capture outside the short SQLite write transaction. The provider
        // chooses each source and checks its bytes after parsing.
        let mut captured = BTreeMap::new();
        for (id, entry) in &incoming {
            if !backfill
                && let Some((signature, _, version, revision)) = existing.get(id)
                && signature == &entry.signature
                && *version == STORED_SUMMARY_SCHEMA_VERSION
            {
                if !force {
                    continue;
                }
                if let Some(revision) = revision
                    && adapter.index_capture_revision(entry)?.as_ref() == Some(revision)
                {
                    // The exact probe is the byte-verification point, just as
                    // capture's final exact hash is. Preserve its stat check too.
                    if adapter.source_signature(entry)? != entry.signature {
                        return Err(CoreError::SourceChanged);
                    }
                    continue;
                }
            }
            let snapshot = adapter.capture_for_index(entry)?;
            if snapshot.summary.session.session_id != *id
                || snapshot.summary.session.provider != provider
            {
                return Err(CoreError::Storage(format!(
                    "capture identity differs from {provider}/{id} inventory"
                )));
            }
            captured.insert(id.clone(), snapshot);
        }
        adapter.validate_inventory(&incoming)?;
        let deleted: Vec<_> = existing
            .keys()
            .filter(|id| !incoming.contains_key(*id))
            .cloned()
            .collect();
        let tx = db.transaction().map_err(storage)?;
        for id in &deleted {
            tx.execute(
                "DELETE FROM catalog_entry WHERE provider = ?1 AND session_id = ?2",
                params![provider, id],
            )
            .map_err(storage)?;
        }
        for (id, snapshot) in &captured {
            let signature = &incoming[id].signature;
            let encoded = serde_json::to_string(&StoredSummary {
                schema_version: STORED_SUMMARY_SCHEMA_VERSION,
                summary: snapshot.summary.clone(),
                search_title: snapshot.summary.search_title.clone(),
                index_capture_revision: Some(snapshot.revision.clone()),
            })
            .map_err(storage)?;
            tx.execute(
                "INSERT INTO catalog_entry (provider, session_id, signature, summary_json)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (provider, session_id) DO UPDATE SET
                   signature = excluded.signature, summary_json = excluded.summary_json",
                params![provider, id, signature, encoded],
            )
            .map_err(storage)?;
        }
        search_index::publish_docs(&tx, provider, &captured, &deleted)?;
        tx.execute(
            "INSERT INTO catalog_state (provider, revision) VALUES (?1, 1)
             ON CONFLICT (provider) DO UPDATE SET revision = revision + 1",
            [provider],
        )
        .map_err(storage)?;
        #[cfg(feature = "crash-test-hook")]
        if std::env::var("AGENTSESSION_V3_TEST_PAUSE_BEFORE_CATALOG_COMMIT")
            .is_ok_and(|value| value == provider)
        {
            eprintln!("AGENTSESSION_V3_TEST_BEFORE_CATALOG_COMMIT provider={provider}");
            loop {
                std::thread::park();
            }
        }
        tx.commit().map_err(storage)?;
        for (id, snapshot) in captured {
            let signature = incoming[&id].signature.clone();
            existing.insert(
                id,
                (
                    signature,
                    snapshot.summary,
                    STORED_SUMMARY_SCHEMA_VERSION,
                    Some(snapshot.revision),
                ),
            );
        }
        existing.retain(|id, _| incoming.contains_key(id));
    }
    let revision: Option<i64> = db
        .query_row(
            "SELECT revision FROM catalog_state WHERE provider = ?1",
            [provider],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage)?;
    if revision.is_none() && !existing.is_empty() {
        return Err(CoreError::Storage(format!(
            "{provider} catalog entries have no published revision"
        )));
    }
    Ok(Some(PublishedCatalog {
        rows: existing
            .into_values()
            .map(|(_, summary, _, _)| summary)
            .collect(),
        revision: format!("{provider}:{}", revision.unwrap_or(0)),
        source_uncertainty: observation.source_uncertainty,
    }))
}

pub(crate) fn rebuild(
    index_dir: &Path,
    scope: &str,
    provider: &str,
    adapter: &dyn ProviderAdapter,
) -> Result<PublishedCatalog> {
    publish(
        index_dir,
        scope,
        provider,
        adapter,
        true,
        #[cfg(feature = "search-phase-probe")]
        None,
    )?
    .ok_or_else(|| CoreError::Storage(format!("{provider} has no durable catalog support")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SessionRef;
    use crate::providers::SessionSnapshot;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::tempdir;

    fn source_config(root: &Path) -> crate::SourceConfig {
        crate::SourceConfig {
            codex_dir: root.join("codex"),
            opencode_db: root.join("opencode.db"),
            claude_dir: root.join("claude"),
            pi_dir: root.join("pi"),
            dsh_dir: root.join("dsh"),
            meta_dir: root.join("meta"),
            index_dir: root.join("index"),
            cache_dir: root.join("cache"),
        }
    }

    struct FixtureAdapter {
        path: PathBuf,
        captures: Arc<AtomicUsize>,
    }

    impl ProviderAdapter for FixtureAdapter {
        fn available(&self) -> bool {
            true
        }
        fn unavailable_diagnostic(&self) -> &'static str {
            "unavailable"
        }
        fn list(&self) -> Result<Vec<SessionSummary>> {
            unreachable!("indexed fixture only")
        }
        fn load(&self, _session_id: &str) -> Result<SessionSnapshot> {
            unreachable!("capture must use selected source")
        }
        fn supports_index(&self) -> bool {
            true
        }
        fn inventory(&self) -> Result<Option<Vec<SourceEntry>>> {
            if !self.path.exists() {
                return Ok(Some(Vec::new()));
            }
            Ok(Some(vec![SourceEntry::new(
                "session".into(),
                self.path.clone(),
            )?]))
        }
        fn index_capture_revision(&self, entry: &SourceEntry) -> Result<Option<String>> {
            fs::read_to_string(&entry.path)
                .map(Some)
                .map_err(|source| CoreError::Io {
                    path: entry.path.clone(),
                    source,
                })
        }
        fn capture(&self, entry: &SourceEntry) -> Result<SessionSnapshot> {
            self.captures.fetch_add(1, Ordering::SeqCst);
            let body = fs::read_to_string(&entry.path).map_err(|source| CoreError::Io {
                path: entry.path.clone(),
                source,
            })?;
            if body == "corrupt" {
                return Err(CoreError::Parse {
                    path: entry.path.clone(),
                    reason: "corrupt fixture".into(),
                });
            }
            Ok(SessionSnapshot {
                summary: SessionSummary {
                    diagnostic: None,
                    session: SessionRef {
                        provider: "codex".into(),
                        session_id: "session".into(),
                    },
                    title: "same summary".into(),
                    search_title: Some("same summary".into()),
                    directory: None,
                    created_at: Some(1),
                    updated_at: Some(1),
                    message_count: 1,
                    conversation_message_count: None,
                    token_count: None,
                    duration_ms: None,
                    summary_files: None,
                    summary_additions: None,
                    summary_deletions: None,
                    parent: None,
                },
                revision: body,
                events: Vec::new(),
                relations: Vec::new(),
            })
        }
    }

    #[test]
    fn forced_exact_capture_reuses_after_restart_and_captures_changed_bytes() {
        let root = tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        fs::write(&path, "before").unwrap();
        let captures = Arc::new(AtomicUsize::new(0));
        let index = root.path().join("index");
        let first = refresh(
            &index,
            "scope",
            "codex",
            &FixtureAdapter {
                path: path.clone(),
                captures: captures.clone(),
            },
        )
        .unwrap()
        .unwrap();
        let db = Connection::open(index.join("scope.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TRIGGER retain_search_documents BEFORE DELETE ON search_doc
            BEGIN SELECT RAISE(ABORT, 'unchanged search documents rewritten'); END;",
        )
        .unwrap();
        let restarted = FixtureAdapter {
            path: path.clone(),
            captures: captures.clone(),
        };
        let unchanged = rebuild(&index, "scope", "codex", &restarted).unwrap();
        assert_ne!(unchanged.revision, first.revision);
        assert_eq!(
            captures.load(Ordering::SeqCst),
            1,
            "unchanged exact bytes must not normalize again"
        );
        db.execute_batch("DROP TRIGGER retain_search_documents")
            .unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let signature = SourceEntry::new("session".into(), path.clone())
            .unwrap()
            .signature;
        fs::write(&path, "after!").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(
            SourceEntry::new("session".into(), path.clone())
                .unwrap()
                .signature,
            signature
        );
        let changed = rebuild(&index, "scope", "codex", &restarted).unwrap();
        assert_ne!(changed.revision, unchanged.revision);
        assert_eq!(
            captures.load(Ordering::SeqCst),
            2,
            "same-stat changed bytes must normalize"
        );
        fs::write(&path, "after! appended").unwrap();
        rebuild(&index, "scope", "codex", &restarted).unwrap();
        assert_eq!(captures.load(Ordering::SeqCst), 3);
        fs::write(&path, "short").unwrap();
        rebuild(&index, "scope", "codex", &restarted).unwrap();
        assert_eq!(captures.load(Ordering::SeqCst), 4);
        fs::remove_file(&path).unwrap();
        let deleted = rebuild(&index, "scope", "codex", &restarted).unwrap();
        assert!(deleted.rows.is_empty());
        assert_eq!(captures.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn forced_exact_capture_requires_current_metadata_and_stat_signature() {
        let root = tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        fs::write(&path, "unchanged").unwrap();
        let captures = Arc::new(AtomicUsize::new(0));
        let adapter = FixtureAdapter {
            path: path.clone(),
            captures: captures.clone(),
        };
        let index = root.path().join("index");
        refresh(&index, "scope", "codex", &adapter).unwrap();
        let db = Connection::open(index.join("scope.sqlite")).unwrap();
        for (position, field) in ["_indexCaptureRevision", "_schemaVersion", "searchVersion"]
            .iter()
            .enumerate()
        {
            if *field == "searchVersion" {
                db.execute("UPDATE search_doc_state SET version=2", [])
                    .unwrap();
            } else {
                let encoded: String = db
                    .query_row("SELECT summary_json FROM catalog_entry", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                let mut stored: serde_json::Value = serde_json::from_str(&encoded).unwrap();
                stored.as_object_mut().unwrap().remove(*field);
                db.execute(
                    "UPDATE catalog_entry SET summary_json=?1",
                    [stored.to_string()],
                )
                .unwrap();
            }
            rebuild(&index, "scope", "codex", &adapter).unwrap();
            assert_eq!(
                captures.load(Ordering::SeqCst),
                position + 2,
                "{field} must recapture"
            );
            rebuild(&index, "scope", "codex", &adapter).unwrap();
            assert_eq!(captures.load(Ordering::SeqCst), position + 2);
        }
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(modified + std::time::Duration::from_secs(1)),
            )
            .unwrap();
        rebuild(&index, "scope", "codex", &adapter).unwrap();
        assert_eq!(
            captures.load(Ordering::SeqCst),
            5,
            "stat changes recapture even identical bytes for timestamp-derived facts"
        );
    }

    struct ProbeFixture<'a> {
        fixture: &'a FixtureAdapter,
        action: &'static str,
    }

    impl ProviderAdapter for ProbeFixture<'_> {
        fn available(&self) -> bool {
            true
        }
        fn unavailable_diagnostic(&self) -> &'static str {
            "unavailable"
        }
        fn list(&self) -> Result<Vec<SessionSummary>> {
            self.fixture.list()
        }
        fn load(&self, id: &str) -> Result<SessionSnapshot> {
            self.fixture.load(id)
        }
        fn supports_index(&self) -> bool {
            true
        }
        fn inventory(&self) -> Result<Option<Vec<SourceEntry>>> {
            self.fixture.inventory()
        }
        fn capture(&self, entry: &SourceEntry) -> Result<SessionSnapshot> {
            self.fixture.capture(entry)
        }
        fn index_capture_revision(&self, entry: &SourceEntry) -> Result<Option<String>> {
            match self.action {
                "unavailable" => Ok(None),
                "error" => Err(CoreError::SourceChanged),
                "inventory-change" => self.fixture.index_capture_revision(entry),
                "stat-change" => {
                    let revision = self.fixture.index_capture_revision(entry)?;
                    let modified = fs::metadata(&entry.path).unwrap().modified().unwrap();
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&entry.path)
                        .unwrap()
                        .set_times(
                            fs::FileTimes::new()
                                .set_modified(modified + std::time::Duration::from_secs(1)),
                        )
                        .unwrap();
                    Ok(revision)
                }
                "removed" => {
                    fs::remove_file(&entry.path).unwrap();
                    self.fixture.index_capture_revision(entry)
                }
                _ => unreachable!("test probe action"),
            }
        }
        fn validate_inventory(&self, _incoming: &BTreeMap<String, SourceEntry>) -> Result<()> {
            if self.action == "inventory-change" {
                Err(CoreError::SourceChanged)
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn forced_exact_probe_failure_keeps_complete_catalog_and_documents() {
        for action in ["error", "stat-change", "removed", "inventory-change"] {
            let root = tempdir().unwrap();
            let path = root.path().join("source.jsonl");
            fs::write(&path, "unchanged").unwrap();
            let captures = Arc::new(AtomicUsize::new(0));
            let fixture = FixtureAdapter {
                path,
                captures: captures.clone(),
            };
            let index = root.path().join("index");
            refresh(&index, "scope", "codex", &fixture).unwrap();
            let db = Connection::open(index.join("scope.sqlite")).unwrap();
            let published = || {
                let revision: i64 = db
                    .query_row("SELECT revision FROM catalog_state", [], |row| row.get(0))
                    .unwrap();
                let encoded: String = db
                    .query_row("SELECT summary_json FROM catalog_entry", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                let documents: String = db
                    .query_row("SELECT group_concat(text) FROM search_doc", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                let fts: String = db
                    .query_row(
                        "SELECT group_concat(lower_text) FROM search_doc_fts",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                (revision, encoded, documents, fts)
            };
            let before = published();
            let failed = rebuild(
                &index,
                "scope",
                "codex",
                &ProbeFixture {
                    fixture: &fixture,
                    action,
                },
            );
            assert!(failed.is_err(), "{action} must fail publication");
            assert_eq!(
                published(),
                before,
                "{action} must retain complete previous generation"
            );
            assert_eq!(captures.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn forced_unavailable_exact_probe_keeps_capture_mandatory() {
        let root = tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        fs::write(&path, "unchanged").unwrap();
        let captures = Arc::new(AtomicUsize::new(0));
        let fixture = FixtureAdapter {
            path,
            captures: captures.clone(),
        };
        let index = root.path().join("index");
        let first = refresh(&index, "scope", "codex", &fixture)
            .unwrap()
            .unwrap();
        let forced = rebuild(
            &index,
            "scope",
            "codex",
            &ProbeFixture {
                fixture: &fixture,
                action: "unavailable",
            },
        )
        .unwrap();
        assert_ne!(forced.revision, first.revision);
        assert_eq!(captures.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn prior_summary_schema_recaptures_unchanged_provider_source() {
        let root = tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        fs::write(&path, "unchanged").unwrap();
        let captures = Arc::new(AtomicUsize::new(0));
        let adapter = FixtureAdapter {
            path,
            captures: captures.clone(),
        };
        let index = root.path().join("index");
        let first = refresh(&index, "scope", "codex", &adapter)
            .unwrap()
            .unwrap();
        let db = Connection::open(index.join("scope.sqlite")).unwrap();
        let encoded: String = db
            .query_row(
                "SELECT summary_json FROM catalog_entry WHERE provider='codex' AND session_id='session'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut old: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        old["_schemaVersion"] = STORED_SUMMARY_SCHEMA_VERSION.saturating_sub(1).into();
        old["tokenCount"] = 999.into();
        db.execute(
            "UPDATE catalog_entry SET summary_json=?1 WHERE provider='codex' AND session_id='session'",
            [old.to_string()],
        )
        .unwrap();
        drop(db);

        let refreshed = refresh(&index, "scope", "codex", &adapter)
            .unwrap()
            .unwrap();
        assert_ne!(refreshed.revision, first.revision);
        assert_eq!(refreshed.rows[0].token_count, None);
        assert_eq!(captures.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn restart_skips_capture_and_rewrite_or_deletion_publishes_new_generation() {
        let root = tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        fs::write(&path, "before").unwrap();
        let captures = Arc::new(AtomicUsize::new(0));
        let adapter = FixtureAdapter {
            path: path.clone(),
            captures: captures.clone(),
        };
        let index = root.path().join("index");
        let first = refresh(&index, "scope", "codex", &adapter)
            .unwrap()
            .unwrap();
        assert_eq!(first.rows.len(), 1);
        assert_eq!(captures.load(Ordering::SeqCst), 1);
        let restarted = FixtureAdapter {
            path: path.clone(),
            captures: captures.clone(),
        };
        let unchanged = refresh(&index, "scope", "codex", &restarted)
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.revision, first.revision);
        assert_eq!(captures.load(Ordering::SeqCst), 1);
        assert_eq!("before".len(), "after!".len());
        fs::write(&path, "after!").unwrap();
        let changed = refresh(&index, "scope", "codex", &adapter)
            .unwrap()
            .unwrap();
        assert_eq!(changed.rows[0].title, first.rows[0].title);
        assert_ne!(changed.revision, first.revision);
        assert_eq!(captures.load(Ordering::SeqCst), 2);
        fs::write(&path, "corrupt").unwrap();
        assert!(matches!(
            refresh(&index, "scope", "codex", &adapter),
            Err(CoreError::Parse { .. })
        ));
        let db = Connection::open(index.join("scope.sqlite")).unwrap();
        let published: i64 = db
            .query_row(
                "SELECT revision FROM catalog_state WHERE provider='codex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            published, 2,
            "failed capture cannot publish a partial generation"
        );
        drop(db);
        fs::remove_file(path).unwrap();
        let deleted = refresh(&index, "scope", "codex", &adapter)
            .unwrap()
            .unwrap();
        assert!(deleted.rows.is_empty());
        assert_ne!(deleted.revision, changed.revision);
    }

    #[test]
    fn prior_search_document_version_recaptures_unchanged_source() {
        let root = tempdir().unwrap();
        let path = root.path().join("source.jsonl");
        fs::write(&path, "unchanged").unwrap();
        let captures = Arc::new(AtomicUsize::new(0));
        let adapter = FixtureAdapter {
            path,
            captures: captures.clone(),
        };
        let index = root.path().join("index");
        let first = refresh(&index, "scope", "codex", &adapter)
            .unwrap()
            .unwrap();
        let db = Connection::open(index.join("scope.sqlite")).unwrap();
        db.execute(
            "UPDATE search_doc_state SET version=2 WHERE provider='codex'",
            [],
        )
        .unwrap();
        db.execute("UPDATE search_doc SET text='stale' WHERE field='title'", [])
            .unwrap();
        drop(db);
        let second = refresh(&index, "scope", "codex", &adapter)
            .unwrap()
            .unwrap();
        assert_ne!(second.revision, first.revision);
        assert_eq!(captures.load(Ordering::SeqCst), 2);
        assert_eq!(second.rows[0].search_title.as_deref(), Some("same summary"));
        let db = Connection::open(index.join("scope.sqlite")).unwrap();
        let (version, text): (i64, String) = db
            .query_row(
                "SELECT s.version, d.text FROM search_doc_state s JOIN search_doc d ON d.provider=s.provider WHERE d.field='title' AND d.provider='codex'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((version, text.as_str()), (4, "same summary"));
    }

    #[test]
    fn incomplete_codex_inventory_replaces_prior_catalog_with_diagnostic_rows() {
        let root = tempdir().unwrap();
        let codex_dir = root.path().join("codex");
        fs::create_dir_all(codex_dir.join("sessions")).unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/codex/sessions/2026/09/26")
            .join("rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl");
        let original = fs::read_to_string(&fixture).unwrap();
        let first_path = codex_dir.join("sessions/rollout-first.jsonl");
        let second_path = codex_dir.join("sessions/rollout-second.jsonl");
        fs::write(&first_path, &original).unwrap();
        fs::write(
            &second_path,
            original.replace(
                "44444444-4444-4444-8444-444444444444",
                "55555555-5555-4555-8555-555555555555",
            ),
        )
        .unwrap();
        let config = crate::SourceConfig {
            codex_dir,
            opencode_db: root.path().join("opencode.db"),
            claude_dir: root.path().join("claude"),
            pi_dir: root.path().join("pi"),
            dsh_dir: root.path().join("dsh"),
            meta_dir: root.path().join("meta"),
            index_dir: root.path().join("index"),
            cache_dir: root.path().join("cache"),
        };
        let adapter = crate::providers::adapter(&config, "scope", "codex").unwrap();
        let first = refresh(&config.index_dir, "scope", "codex", adapter.as_ref())
            .unwrap()
            .unwrap();
        assert_eq!(first.rows.len(), 2);
        fs::write(&first_path, "{invalid header}\n").unwrap();
        let incomplete = refresh(&config.index_dir, "scope", "codex", adapter.as_ref())
            .unwrap()
            .unwrap();
        assert_eq!(incomplete.rows.len(), 1);
        assert_eq!(
            incomplete.rows[0].diagnostic.as_deref(),
            Some("codex_source_inventory_incomplete")
        );
        let db = Connection::open(config.index_dir.join("scope.sqlite")).unwrap();
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM catalog_entry WHERE provider='codex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let revision: i64 = db
            .query_row(
                "SELECT revision FROM catalog_state WHERE provider='codex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 1,
            "unknown source identity cannot publish a complete old row"
        );
        assert_eq!(
            revision, 2,
            "diagnostic refresh replaces stale complete catalog content"
        );
        let documents: i64 = db.query_row(
            "SELECT count(*) FROM search_doc WHERE provider='codex' AND field IN ('user','assistant','toolName')",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(documents, 0, "stale fragment search documents are removed");
    }

    #[test]
    fn shared_index_directory_keeps_source_scopes_independent() {
        let root = tempdir().unwrap();
        let left = root.path().join("left.jsonl");
        let right = root.path().join("right.jsonl");
        fs::write(&left, "left").unwrap();
        fs::write(&right, "right").unwrap();
        let index = root.path().join("index");
        let captures = Arc::new(AtomicUsize::new(0));
        let left_adapter = FixtureAdapter {
            path: left.clone(),
            captures: captures.clone(),
        };
        let right_adapter = FixtureAdapter {
            path: right.clone(),
            captures: captures.clone(),
        };
        let left_first = refresh(&index, "left-scope", "codex", &left_adapter)
            .unwrap()
            .unwrap();
        let right_first = refresh(&index, "right-scope", "codex", &right_adapter)
            .unwrap()
            .unwrap();
        assert_eq!(left_first.rows.len(), 1);
        assert_eq!(right_first.rows.len(), 1);
        fs::remove_file(left).unwrap();
        let left_deleted = refresh(&index, "left-scope", "codex", &left_adapter)
            .unwrap()
            .unwrap();
        let right_unchanged = refresh(&index, "right-scope", "codex", &right_adapter)
            .unwrap()
            .unwrap();
        assert!(left_deleted.rows.is_empty());
        assert_eq!(right_unchanged.rows.len(), 1);
        assert_eq!(right_unchanged.revision, right_first.revision);
    }

    #[test]
    fn explicit_rebuild_captures_same_stat_rewrite_and_keeps_other_scope() {
        let root = tempdir().unwrap();
        let left = root.path().join("left.jsonl");
        let right = root.path().join("right.jsonl");
        fs::write(&left, "before").unwrap();
        fs::write(&right, "right!").unwrap();
        let index = root.path().join("index");
        let captures = Arc::new(AtomicUsize::new(0));
        let left_adapter = FixtureAdapter {
            path: left.clone(),
            captures: captures.clone(),
        };
        let right_adapter = FixtureAdapter {
            path: right.clone(),
            captures: captures.clone(),
        };
        let first = refresh(&index, "left-scope", "codex", &left_adapter)
            .unwrap()
            .unwrap();
        let other = refresh(&index, "right-scope", "codex", &right_adapter)
            .unwrap()
            .unwrap();
        let stat = fs::metadata(&left).unwrap();
        let signature = SourceEntry::new("session".into(), left.clone())
            .unwrap()
            .signature;
        fs::write(&left, "after!").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&left)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(stat.modified().unwrap()))
            .unwrap();
        assert_eq!(
            SourceEntry::new("session".into(), left.clone())
                .unwrap()
                .signature,
            signature,
            "the ordinary stat inventory cannot observe this rewrite"
        );
        let unchanged = refresh(&index, "left-scope", "codex", &left_adapter)
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.revision, first.revision);
        let forced = rebuild(&index, "left-scope", "codex", &left_adapter).unwrap();
        assert_ne!(forced.revision, first.revision);
        assert_eq!(captures.load(Ordering::SeqCst), 3);
        let other_still = refresh(&index, "right-scope", "codex", &right_adapter)
            .unwrap()
            .unwrap();
        assert_eq!(other_still.revision, other.revision);
        fs::write(&left, "corrupt").unwrap();
        assert!(matches!(
            rebuild(&index, "left-scope", "codex", &left_adapter),
            Err(CoreError::Parse { .. })
        ));
        let db = Connection::open(index.join("left-scope.sqlite")).unwrap();
        let revision: i64 = db
            .query_row(
                "SELECT revision FROM catalog_state WHERE provider='codex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            revision, 2,
            "failed rebuild cannot publish a partial generation"
        );
    }

    #[test]
    fn core_reindex_reports_each_provider_and_preserves_legacy_and_source_data() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        fs::create_dir_all(config.codex_dir.join("sessions")).unwrap();
        fs::create_dir_all(&config.meta_dir).unwrap();
        fs::create_dir_all(&config.index_dir).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/codex/sessions/2026/09/26")
            .join("rollout-2026-09-26T00-00-00-44444444-4444-4444-8444-444444444444.jsonl");
        let source = config.codex_dir.join("sessions/rollout.jsonl");
        let original = fs::read(&fixture).unwrap();
        fs::write(&source, &original).unwrap();
        let legacy = config.meta_dir.join("meta.db");
        {
            let db = Connection::open(&legacy).unwrap();
            db.execute_batch(
                "CREATE TABLE session_index (provider TEXT, session_id TEXT);\
                 INSERT INTO session_index VALUES ('openclaw', 'retired-session');\
                 CREATE TABLE viewer_meta (provider TEXT, session_id TEXT, title TEXT);\
                 INSERT INTO viewer_meta VALUES ('codex', 'saved-session', 'My title');",
            )
            .unwrap();
        }
        let meta_before = fs::read(&legacy).unwrap();
        let core = crate::Core::new(config.clone()).unwrap();
        let first = core.reindex();
        assert_eq!(first.len(), crate::PROVIDERS.len());
        let codex = first
            .iter()
            .find(|result| result.provider == "codex")
            .unwrap();
        assert_eq!(codex.status, "rebuilt");
        assert_eq!(codex.session_count, Some(1));
        assert!(
            first
                .iter()
                .filter(|result| result.provider != "codex")
                .all(|result| result.status == "unavailable")
        );
        let revision = codex.revision.clone().unwrap();
        let catalog_path = config
            .index_dir
            .join(format!("{}.sqlite", core.source_scope()));
        {
            let catalog = Connection::open(&catalog_path).unwrap();
            catalog
                .execute("INSERT INTO catalog_state VALUES ('openclaw', 7)", [])
                .unwrap();
            catalog
                .execute(
                    "INSERT INTO catalog_entry VALUES ('openclaw', 'retired-session', 'old', '{}')",
                    [],
                )
                .unwrap();
        }
        let second = core.reindex();
        let next = second
            .iter()
            .find(|result| result.provider == "codex")
            .unwrap();
        assert_eq!(next.status, "rebuilt");
        assert_ne!(
            next.revision.as_ref().unwrap(),
            &revision,
            "explicit reindex must republish even an unchanged stat signature"
        );
        let search_before: String = Connection::open(&catalog_path)
            .unwrap()
            .query_row(
                "SELECT group_concat(text, char(31)) FROM
             (SELECT text FROM search_doc WHERE provider='codex'
              ORDER BY session_id, field, position)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(fs::read(&legacy).unwrap(), meta_before);
        let db = Connection::open(&legacy).unwrap();
        let retired: String = db
            .query_row(
                "SELECT session_id FROM session_index WHERE provider='openclaw'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retired, "retired-session");
        drop(db);

        fs::write(&source, "{invalid header}\n").unwrap();
        let rebuilt = core.reindex();
        let codex_result = rebuilt
            .iter()
            .find(|result| result.provider == "codex")
            .unwrap();
        assert_eq!(codex_result.status, "rebuilt");
        let catalog = Connection::open(catalog_path).unwrap();
        let published: i64 = catalog
            .query_row(
                "SELECT revision FROM catalog_state WHERE provider='codex'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            published, 3,
            "unknown source identity removes the previous complete catalog row"
        );
        let retired_catalog: i64 = catalog
            .query_row(
                "SELECT revision FROM catalog_state WHERE provider='openclaw'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            retired_catalog, 7,
            "reindex preserves retired provider catalog rows"
        );
        let search_after: Option<String> = catalog
            .query_row(
                "SELECT group_concat(text, char(31)) FROM
             (SELECT text FROM search_doc WHERE provider='codex'
              ORDER BY session_id, field, position)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!search_before.is_empty());
        assert_eq!(
            search_after, None,
            "unknown source identity removes stale search documents"
        );
        assert_eq!(fs::read(&legacy).unwrap(), meta_before);
    }

    #[test]
    fn claude_append_and_body_rewrite_publish_new_generations() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let dir = config.claude_dir.join("transcripts");
        fs::create_dir_all(&dir).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/claude-legacy.jsonl");
        let original = fs::read_to_string(&fixture).unwrap();
        let copied = dir.join("legacy-id.jsonl");
        fs::write(&copied, &original).unwrap();
        let adapter = crate::providers::adapter(&config, "scope", "claude-code").unwrap();
        let first = refresh(&config.index_dir, "scope", "claude-code", adapter.as_ref())
            .unwrap()
            .expect("Claude must publish a durable catalog");
        assert_eq!(first.rows.len(), 1);
        fs::write(
            &copied,
            original.replace("Legacy response", "Modern response"),
        )
        .unwrap();
        let rewritten = refresh(&config.index_dir, "scope", "claude-code", adapter.as_ref())
            .unwrap()
            .unwrap();
        assert_eq!(rewritten.rows[0].title, first.rows[0].title);
        assert_ne!(rewritten.revision, first.revision);
        fs::OpenOptions::new().append(true).open(&copied).unwrap()
            .write_all(b"{\"type\":\"user\",\"uuid\":\"later\",\"timestamp\":\"2025-01-01T00:00:02.000Z\",\"message\":{\"content\":\"Later\"}}\n").unwrap();
        let appended = refresh(&config.index_dir, "scope", "claude-code", adapter.as_ref())
            .unwrap()
            .unwrap();
        assert_ne!(appended.revision, rewritten.revision);
        assert_eq!(fs::read_to_string(&fixture).unwrap(), original);
    }

    #[test]
    fn pi_branch_rewrite_publishes_new_generation() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let dir = config.pi_dir.join("sessions/project");
        fs::create_dir_all(&dir).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/pi-v3-current.jsonl");
        let original = fs::read_to_string(&fixture).unwrap();
        let copied = dir.join("current_019f8a00-0000-7000-8000-000000000001.jsonl");
        fs::write(&copied, &original).unwrap();
        let adapter = crate::providers::adapter(&config, "scope", "pi").unwrap();
        let first = refresh(&config.index_dir, "scope", "pi", adapter.as_ref())
            .unwrap()
            .expect("Pi must publish a durable catalog");
        assert_eq!(first.rows.len(), 1);
        fs::write(
            &copied,
            original.replace("Abandoned branch", "Discarded branch"),
        )
        .unwrap();
        let rewritten = refresh(&config.index_dir, "scope", "pi", adapter.as_ref())
            .unwrap()
            .unwrap();
        assert_ne!(rewritten.revision, first.revision);
        assert_eq!(fs::read_to_string(&fixture).unwrap(), original);
    }

    #[test]
    fn opencode_wal_body_update_publishes_without_writing_main_database() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let writer = Connection::open(&config.opencode_db).unwrap();
        writer.execute_batch(concat!(
            "PRAGMA journal_mode=WAL;",
            "CREATE TABLE session (id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,directory TEXT,",
            "time_created INTEGER,time_updated INTEGER,time_archived INTEGER);",
            "CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER);",
            "CREATE TABLE part (id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT,time_created INTEGER);",
            "INSERT INTO session VALUES ('root',NULL,'Same title','/synthetic',1,2,NULL);",
            "INSERT INTO message VALUES ('user','root','{\"role\":\"user\",\"time\":{\"created\":1}}',1);",
            "INSERT INTO part VALUES ('part','user','root','{\"type\":\"text\",\"text\":\"before\"}',1);"
        )).unwrap();
        let wal = PathBuf::from(format!("{}-wal", config.opencode_db.display()));
        let main_before_read = fs::read(&config.opencode_db).unwrap();
        let wal_before_read = fs::read(&wal).unwrap();
        let adapter = crate::providers::adapter(&config, "scope", "opencode").unwrap();
        let first = refresh(&config.index_dir, "scope", "opencode", adapter.as_ref())
            .unwrap()
            .expect("OpenCode must publish a durable catalog");
        assert_eq!(first.rows.len(), 1);
        assert_eq!(fs::read(&config.opencode_db).unwrap(), main_before_read);
        assert_eq!(fs::read(&wal).unwrap(), wal_before_read);
        let main_before = fs::read(&config.opencode_db).unwrap();
        writer
            .execute(
                "UPDATE part SET data=?1 WHERE id='part'",
                [r#"{"type":"text","text":"after!"}"#],
            )
            .unwrap();
        assert_eq!(
            fs::read(&config.opencode_db).unwrap(),
            main_before,
            "WAL update does not require writing the main source database"
        );
        let changed = refresh(&config.index_dir, "scope", "opencode", adapter.as_ref())
            .unwrap()
            .unwrap();
        assert_eq!(changed.rows[0].title, first.rows[0].title);
        assert_ne!(changed.revision, first.revision);
    }
}
