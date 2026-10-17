//! Recorded current-rollout selection from Codex's native state database.
use super::{CoreError, Result, SourceEntry};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RecordedRollout {
    pub path: PathBuf,
    pub database: PathBuf,
}

fn invalid(path: &Path, reason: impl std::fmt::Display) -> CoreError {
    CoreError::Parse {
        diagnostic: crate::ParseDiagnostic::new("invalid Codex rollout authority"),
        path: path.into(),
        reason: format!("Codex recorded rollout authority: {reason}"),
    }
}

fn canonical(path: &Path) -> Result<Option<PathBuf>> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(CoreError::Io {
            path: path.into(),
            source,
        }),
    }
}

fn recorded_path(database: &Path, id: &str) -> Result<Option<PathBuf>> {
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| invalid(database, error))?;
    db.execute_batch("PRAGMA query_only = ON; BEGIN")
        .map_err(|error| invalid(database, error))?;
    let mut statement = db
        .prepare("PRAGMA table_info(threads)")
        .map_err(|error| invalid(database, error))?;
    let columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|error| invalid(database, error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| invalid(database, error))?;
    if !columns
        .iter()
        .any(|(name, kind, _, key)| name == "id" && kind.eq_ignore_ascii_case("TEXT") && *key == 1)
        || columns
            .iter()
            .any(|(name, _, _, key)| *key != 0 && name != "id")
        || !columns.iter().any(|(name, kind, required, _)| {
            name == "rollout_path" && kind.eq_ignore_ascii_case("TEXT") && *required
        })
    {
        return Err(invalid(database, "unsupported threads schema"));
    }
    let path: Option<String> = db
        .query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| invalid(database, error))?;
    path.map(|path| {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(invalid(database, "rollout_path must be absolute"));
        }
        Ok(path)
    })
    .transpose()
}

pub(super) fn resolve(
    root: &Path,
    id: &str,
    entries: &[SourceEntry],
) -> Result<Option<RecordedRollout>> {
    // These two locations are native state_5 layouts. Other schema versions
    // require their own evidence rather than a newest-file selection.
    let mut authority: Option<(PathBuf, PathBuf, Option<PathBuf>)> = None;
    for path in [
        root.join("state_5.sqlite"),
        root.join("sqlite/state_5.sqlite"),
    ] {
        let Some(database) = canonical(&path)? else {
            continue;
        };
        let Some(recorded) = recorded_path(&database, id)? else {
            continue;
        };
        let current = canonical(&recorded)?;
        if let Some((_, previous, previous_canonical)) = &authority {
            let same = match (previous_canonical, &current) {
                (Some(previous), Some(current)) => previous == current,
                _ => previous == &recorded,
            };
            if !same {
                return Err(invalid(&database, "conflicting recorded rollout paths"));
            }
        } else {
            authority = Some((database, recorded, current));
        }
    }
    let Some((database, _, Some(current))) = authority else {
        return Ok(None);
    };
    for entry in entries.iter().filter(|entry| entry.session_id == id) {
        if canonical(&entry.path)?.as_ref() == Some(&current) {
            let header = super::read_primary_meta(&entry.path)?;
            if header
                .as_ref()
                .and_then(|header| super::session_meta_id(&header["payload"]))
                != Some(id)
            {
                return Err(CoreError::SourceChanged);
            }
            let payload = &header.as_ref().expect("validated canonical header")["payload"];
            if !payload["history_base"].is_null()
                || !payload["parent_thread_id"].is_null()
                || !payload["forked_from_id"].is_null()
                || !payload["source"]["subagent"].is_null()
            {
                return Ok(None);
            }
            return Ok(Some(RecordedRollout {
                path: entry.path.clone(),
                database,
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::super::{
        CODEX_NORMALIZATION_COUNT, CODEX_REVISION_FILE_READS, CODEX_USAGE_DIGEST_READS,
    };
    use super::super::{CODEX_STREAM_READ_HOOK, CodexAdapter, ProviderAdapter};
    use super::*;
    use std::collections::BTreeMap;

    fn source(root: &Path, filename: &str, id: &str) -> SourceEntry {
        let path = root.join(filename);
        fs::write(
            &path,
            format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n"),
        )
        .unwrap();
        SourceEntry::new(id.into(), path).unwrap()
    }

    fn database(path: &Path) -> Connection {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = Connection::open(path).unwrap();
        db.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)")
            .unwrap();
        db
    }

    fn record(db: &Connection, id: &str, path: &Path) {
        db.execute(
            "INSERT OR REPLACE INTO threads (id, rollout_path) VALUES (?1, ?2)",
            rusqlite::params![id, path.to_str().unwrap()],
        )
        .unwrap();
    }

    #[test]
    fn recorded_rollout_selects_candidate_and_preserves_scanned_path() {
        let root = tempfile::tempdir().unwrap();
        let first = source(root.path(), "first.jsonl", "same");
        let later = source(root.path(), "later.jsonl", "same");
        let db_path = root.path().join("state_5.sqlite");
        let db = database(&db_path);
        record(&db, "same", &fs::canonicalize(&later.path).unwrap());
        assert_eq!(
            resolve(root.path(), "same", &[first, later.clone()]).unwrap(),
            Some(RecordedRollout {
                path: later.path,
                database: fs::canonicalize(db_path).unwrap(),
            })
        );
    }

    #[test]
    fn recorded_rollout_missing_database_row_or_candidate_keeps_collision() {
        let root = tempfile::tempdir().unwrap();
        let selected = source(root.path(), "selected.jsonl", "same");
        assert!(
            resolve(root.path(), "same", &[selected.clone()])
                .unwrap()
                .is_none()
        );
        // An unsupported native version is not selected heuristically.
        let other_version = database(&root.path().join("state_6.sqlite"));
        record(&other_version, "same", &selected.path);
        assert!(
            resolve(root.path(), "same", &[selected.clone()])
                .unwrap()
                .is_none()
        );
        let db = database(&root.path().join("state_5.sqlite"));
        assert!(
            resolve(root.path(), "same", &[selected.clone()])
                .unwrap()
                .is_none()
        );
        let outside = source(root.path(), "outside.jsonl", "same");
        record(&db, "same", &outside.path);
        assert!(resolve(root.path(), "same", &[selected]).unwrap().is_none());
    }

    #[test]
    fn recorded_rollout_invalid_schema_or_record_is_explicit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state_5.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE threads (id TEXT, rollout_path TEXT)")
            .unwrap();
        assert!(matches!(
            resolve(root.path(), "same", &[]),
            Err(CoreError::Parse { .. })
        ));
        db.execute_batch("DROP TABLE threads; CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)")
            .unwrap();
        record(&db, "same", Path::new("relative.jsonl"));
        assert!(matches!(
            resolve(root.path(), "same", &[]),
            Err(CoreError::Parse { .. })
        ));
    }

    #[test]
    fn recorded_rollout_native_locations_must_agree() {
        let root = tempfile::tempdir().unwrap();
        let first = source(root.path(), "first.jsonl", "same");
        let later = source(root.path(), "later.jsonl", "same");
        let root_db = database(&root.path().join("state_5.sqlite"));
        let nested_db = database(&root.path().join("sqlite/state_5.sqlite"));
        record(&root_db, "same", &later.path);
        record(&nested_db, "same", &fs::canonicalize(&later.path).unwrap());
        assert_eq!(
            resolve(root.path(), "same", &[first.clone(), later.clone()])
                .unwrap()
                .unwrap()
                .path,
            later.path
        );
        record(&nested_db, "same", &first.path);
        assert!(matches!(
            resolve(root.path(), "same", &[first, later]),
            Err(CoreError::Parse { .. })
        ));
    }

    #[test]
    fn recorded_rollout_reads_wal_and_tracks_selection_identity() {
        let root = tempfile::tempdir().unwrap();
        let first = source(root.path(), "first.jsonl", "same");
        let later = source(root.path(), "later.jsonl", "same");
        let db_path = root.path().join("state_5.sqlite");
        let db = database(&db_path);
        db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0")
            .unwrap();
        record(&db, "same", &later.path);
        assert!(db_path.with_extension("sqlite-wal").exists());
        let entries = [first.clone(), later.clone()];
        let before = resolve(root.path(), "same", &entries).unwrap().unwrap();
        record(&db, "unrelated", &first.path);
        assert_eq!(
            resolve(root.path(), "same", &entries).unwrap(),
            Some(before.clone())
        );
        record(&db, "same", &first.path);
        let after = resolve(root.path(), "same", &entries).unwrap().unwrap();
        assert_ne!(before, after);
        assert_eq!(after.path, first.path);
        let readonly =
            Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert!(readonly.execute("DELETE FROM threads", []).is_err());
        assert_eq!(
            db.query_row("SELECT count(*) FROM threads", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn recorded_rollout_rejects_header_changed_after_inventory() {
        let root = tempfile::tempdir().unwrap();
        let entry = source(root.path(), "selected.jsonl", "same");
        let db = database(&root.path().join("state_5.sqlite"));
        record(&db, "same", &entry.path);
        fs::write(
            &entry.path,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"other\"}}\n",
        )
        .unwrap();
        assert!(matches!(
            resolve(root.path(), "same", &[entry]),
            Err(CoreError::SourceChanged)
        ));
    }

    #[test]
    fn recorded_rollout_declared_base_or_ancestry_keeps_collision() {
        let root = tempfile::tempdir().unwrap();
        let entry = source(root.path(), "selected.jsonl", "same");
        let db = database(&root.path().join("state_5.sqlite"));
        record(&db, "same", &entry.path);
        for (field, value) in [
            ("history_base", serde_json::json!({"thread_id": "same"})),
            ("parent_thread_id", serde_json::json!("parent")),
            ("forked_from_id", serde_json::json!("parent")),
            (
                "source",
                serde_json::json!({"subagent": {"parent_thread_id": "parent"}}),
            ),
        ] {
            let mut payload = serde_json::json!({"id": "same"});
            payload[field] = value;
            fs::write(
                &entry.path,
                format!(
                    "{}\n",
                    serde_json::json!({"type": "session_meta", "payload": payload})
                ),
            )
            .unwrap();
            assert!(
                resolve(root.path(), "same", &[entry.clone()])
                    .unwrap()
                    .is_none()
            );
        }
    }

    fn adapter_source(root: &Path, filename: &str, id: &str, answer: &str) -> SourceEntry {
        let sessions = root.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let entry = source(&sessions, filename, id);
        let rows = [
            serde_json::json!({"type": "session_meta", "timestamp": "2026-09-26T00:00:00Z", "payload": {"id": id, "cwd": root.to_str().unwrap()}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "request"}]}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "x".repeat(16_384)}]}}),
            serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": answer}]}}),
        ];
        fs::write(
            &entry.path,
            format!(
                "{}\n",
                rows.into_iter()
                    .map(|row| row.to_string())
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        )
        .unwrap();
        SourceEntry::new(id.into(), entry.path).unwrap()
    }

    #[test]
    fn recorded_index_capture_rejects_restored_inventory_generation() {
        for with_native_title in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let id = "recorded-index-aba";
            let first = adapter_source(root.path(), "first.jsonl", id, "first answer");
            adapter_source(root.path(), "later.jsonl", id, "later answer");
            let db = database(&root.path().join("state_5.sqlite"));
            record(&db, id, &first.path);
            if with_native_title {
                fs::write(
                    root.path().join("session_index.jsonl"),
                    format!(
                        "{}\n",
                        serde_json::json!({"id": id, "thread_name": "native title", "updated_at": "2026-10-11T00:00:00Z"})
                    ),
                )
                .unwrap();
            }
            let adapter = CodexAdapter {
                root: root.path(),
                scope: "recorded-index-aba",
            };
            let incoming: BTreeMap<_, _> = adapter
                .inventory()
                .unwrap()
                .into_iter()
                .map(|entry| (entry.session_id.clone(), entry))
                .collect();
            let original = fs::read_to_string(&first.path).unwrap();
            let replacement = original.replace("first answer", "other answer");
            assert_ne!(replacement, original);
            assert_eq!(replacement.len(), original.len());
            let modified = fs::metadata(&first.path).unwrap().modified().unwrap();
            let rewrite = |bytes: &str| {
                fs::write(&first.path, bytes).unwrap();
                fs::OpenOptions::new()
                    .write(true)
                    .open(&first.path)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(modified))
                    .unwrap();
            };
            rewrite(&replacement);
            let captured = adapter.capture_for_index(&incoming[id]);
            rewrite(&original);
            adapter.validate_inventory(&incoming).unwrap();
            assert!(
                matches!(captured, Err(CoreError::SourceChanged)),
                "a stable capture of B cannot publish with restored inventory A; native title: {with_native_title}"
            );
        }
    }

    #[test]
    fn recorded_index_capture_reuses_final_inventory_verification() {
        let root = tempfile::tempdir().unwrap();
        let id = "recorded-index";
        let first = adapter_source(root.path(), "first.jsonl", id, "first answer");
        let later = adapter_source(root.path(), "later.jsonl", id, "later answer");
        let db = database(&root.path().join("state_5.sqlite"));
        record(&db, id, &first.path);
        let adapter = CodexAdapter {
            root: root.path(),
            scope: "recorded-index-reuse",
        };
        let index = root.path().join("index");
        CODEX_USAGE_DIGEST_READS.with(|count| count.set(0));
        CODEX_REVISION_FILE_READS.with(|count| count.set(0));
        let published = crate::index::refresh(&index, adapter.scope, "codex", &adapter).unwrap();
        assert_eq!(
            CODEX_USAGE_DIGEST_READS.with(std::cell::Cell::get),
            0,
            "catalog signatures reuse the parser's scoped digest rather than a separate raw SHA"
        );
        assert_eq!(
            CODEX_REVISION_FILE_READS.with(std::cell::Cell::get),
            3,
            "initial inventory, parser verification and final inventory each read once"
        );
        assert_eq!(published.rows[0].message_count, 1);
        CODEX_NORMALIZATION_COUNT.with(|count| count.set(0));
        let unchanged = crate::index::refresh(&index, adapter.scope, "codex", &adapter).unwrap();
        assert_eq!(unchanged.revision, published.revision);
        assert_eq!(
            CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get),
            0,
            "exactly unchanged catalog reuses normalization"
        );

        let incoming: BTreeMap<_, _> = adapter
            .inventory()
            .unwrap()
            .into_iter()
            .map(|entry| (entry.session_id.clone(), entry))
            .collect();
        let captured = adapter.capture_for_index(&incoming[id]).unwrap();
        assert_eq!(captured.summary.message_count, 1);
        assert!(
            captured
                .events
                .iter()
                .any(|event| event.body.contains("first answer"))
        );
        let bytes = fs::read_to_string(&first.path).unwrap();
        let modified = fs::metadata(&first.path).unwrap().modified().unwrap();
        fs::write(&first.path, bytes.replace("first answer", "other answer")).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&first.path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert!(
            matches!(
                adapter.validate_inventory(&incoming),
                Err(CoreError::SourceChanged)
            ),
            "same-size same-mtime rewrite after capture cannot publish an old catalog"
        );
        fs::write(&first.path, bytes).unwrap();
        record(&db, id, &later.path);
        assert!(
            matches!(
                adapter.validate_inventory(&incoming),
                Err(CoreError::SourceChanged)
            ),
            "authority changes remain a catalog publication boundary"
        );
    }

    #[test]
    fn recorded_rollout_mapping_race_rejects_adapter_publication() {
        let root = tempfile::tempdir().unwrap();
        let id = "recorded-root";
        let first = adapter_source(root.path(), "first.jsonl", id, "first answer");
        let later = adapter_source(root.path(), "later.jsonl", id, "later answer");
        let first_bytes = fs::read(&first.path).unwrap();
        let later_bytes = fs::read(&later.path).unwrap();
        let db_path = root.path().join("state_5.sqlite");
        let db = database(&db_path);
        let adapter = CodexAdapter {
            root: root.path(),
            scope: "recorded-rollout-race",
        };
        for operation in 0..4 {
            record(&db, id, &first.path);
            let invoke = || match operation {
                0 => adapter.reader_capture(id).map(|_| ()),
                1 => adapter.load(id).map(|_| ()),
                2 => adapter.protocol_bundle(id).map(|_| ()),
                _ => adapter.native_protocol_snapshot(id).map(|_| ()),
            };
            invoke().unwrap();
            let changed = std::rc::Rc::new(std::cell::Cell::new(false));
            let changed_in_hook = changed.clone();
            let database_in_hook = db_path.clone();
            let path_in_hook = later.path.clone();
            CODEX_STREAM_READ_HOOK.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move |read_count| {
                    if read_count == 2 && !changed_in_hook.get() {
                        let writer = Connection::open(&database_in_hook).unwrap();
                        record(&writer, id, &path_in_hook);
                        changed_in_hook.set(true);
                    }
                }));
            });
            let result = invoke();
            CODEX_STREAM_READ_HOOK.with(|hook| *hook.borrow_mut() = None);
            assert!(changed.get(), "operation {operation} missed stream refill");
            assert!(
                matches!(result, Err(CoreError::SourceChanged)),
                "operation {operation} returned {result:?}"
            );
            assert_eq!(fs::read(&first.path).unwrap(), first_bytes);
            assert_eq!(fs::read(&later.path).unwrap(), later_bytes);
        }
    }

    #[test]
    fn recorded_rollout_stats_revision_tracks_mapping_without_transcript_mutation() {
        let root = tempfile::tempdir().unwrap();
        let id = "recorded-root";
        let first = adapter_source(root.path(), "first.jsonl", id, "first answer");
        let later = adapter_source(root.path(), "later.jsonl", id, "later answer");
        let first_bytes = fs::read(&first.path).unwrap();
        let later_bytes = fs::read(&later.path).unwrap();
        let db = database(&root.path().join("state_5.sqlite"));
        let adapter = CodexAdapter {
            root: root.path(),
            scope: "recorded-rollout-stats",
        };
        record(&db, id, &first.path);
        let before = adapter.stats_usage_source_revision().unwrap();
        record(&db, "unrelated", &later.path);
        assert_eq!(adapter.stats_usage_source_revision().unwrap(), before);
        record(&db, id, &later.path);
        assert_ne!(adapter.stats_usage_source_revision().unwrap(), before);
        assert_eq!(fs::read(&first.path).unwrap(), first_bytes);
        assert_eq!(fs::read(&later.path).unwrap(), later_bytes);
    }

    #[test]
    fn recorded_rollout_inventory_signature_tracks_only_selected_content() {
        let root = tempfile::tempdir().unwrap();
        let id = "recorded-root";
        let first = adapter_source(root.path(), "first.jsonl", id, "first answer");
        let later = adapter_source(root.path(), "later.jsonl", id, "later answer");
        let db = database(&root.path().join("state_5.sqlite"));
        record(&db, id, &first.path);
        let adapter = CodexAdapter {
            root: root.path(),
            scope: "recorded-rollout-inventory",
        };
        let signature = || {
            let entries = adapter.inventory().unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].session_id, id);
            entries[0].signature.clone()
        };
        let rewrite = |path: &Path, before: &str, after: &str| {
            let original = fs::read_to_string(path).unwrap();
            let metadata = fs::metadata(path).unwrap();
            let modified = metadata.modified().unwrap();
            let replacement = original.replace(before, after);
            assert_ne!(replacement, original);
            assert_eq!(replacement.len(), original.len());
            fs::write(path, replacement).unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(modified))
                .unwrap();
            let rewritten = fs::metadata(path).unwrap();
            assert_eq!(rewritten.len(), metadata.len());
            assert_eq!(rewritten.modified().unwrap(), modified);
        };
        let before = signature();
        assert!(before.starts_with("recorded-rollout:"));
        rewrite(&first.path, "first answer", "fresh answer");
        let selected_changed = signature();
        assert_ne!(selected_changed, before);
        rewrite(&later.path, "later answer", "other answer");
        assert_eq!(signature(), selected_changed);
        record(&db, "unrelated", &later.path);
        assert_eq!(signature(), selected_changed);
    }
}
