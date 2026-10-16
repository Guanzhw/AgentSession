//! Finite Codex catalog observations and provider-owned publication receipts.
//! Opening metadata fixes both the invalidation signature and complete-record
//! boundary. Captured and reused rows verify that exact prefix at publication;
//! later suffix bytes belong to the next observation.
use super::*;
use crate::providers::{IndexCaptureBatch, IndexObservationBatch, InventoryObservation};

#[cfg(test)]
thread_local! {
    static AFTER_SOURCE_SCAN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
}

#[derive(PartialEq, Eq)]
enum Selection {
    Single(PathBuf),
    Recorded(rollout_authority::RecordedRollout),
    Pair(PathBuf, PathBuf, usize, usize),
    Collision,
}

struct PrefixReceipt {
    path: PathBuf,
    canonical_path: PathBuf,
    length: u64,
    opening_revision: Option<String>,
    revision: Option<String>,
}

struct Batch<'a, 'b> {
    adapter: &'a CodexAdapter<'b>,
    incoming: BTreeMap<String, SourceEntry>,
    membership: BTreeMap<String, Vec<PathBuf>>,
    selection: BTreeMap<String, Selection>,
    titles: CodexNativeTitles,
    sources: CodexSources,
    identities: SelectedChildIdentities,
    dependencies: BTreeMap<String, String>,
    prefixes: BTreeMap<String, PrefixReceipt>,
    unresolved: bool,
}

fn membership(scan: &CodexSourceScan) -> BTreeMap<String, Vec<PathBuf>> {
    scan.grouped
        .iter()
        .map(|(id, entries)| {
            (
                id.clone(),
                entries.iter().map(|entry| entry.path.clone()).collect(),
            )
        })
        .collect()
}

fn select(
    adapter: &CodexAdapter<'_>,
    scan: &CodexSourceScan,
) -> Result<(CodexSources, BTreeMap<String, Selection>)> {
    let mut sources = CodexSources::default();
    let mut selection = BTreeMap::new();
    for (id, entries) in &scan.grouped {
        let selected = if entries.len() == 1 {
            sources.paths.insert(id.clone(), entries[0].path.clone());
            Selection::Single(entries[0].path.clone())
        } else {
            match adapter.resolve_multiple_sources(id, entries)? {
                CodexSourceSelection::Pair(pair) => {
                    let selected = Selection::Pair(
                        pair.first.clone(),
                        pair.later.clone(),
                        pair.cutoff,
                        pair.prefix_records,
                    );
                    sources.paths.insert(id.clone(), pair.first.clone());
                    sources.pairs.insert(id.clone(), pair);
                    selected
                }
                CodexSourceSelection::Recorded(recorded) => {
                    sources.paths.insert(id.clone(), recorded.path.clone());
                    sources.recorded.insert(id.clone(), recorded.clone());
                    sources.recorded_entries.insert(id.clone(), entries.clone());
                    Selection::Recorded(recorded)
                }
                CodexSourceSelection::Collision => Selection::Collision,
            }
        };
        selection.insert(id.clone(), selected);
    }
    Ok((sources, selection))
}

fn dependency_signature(base: &str, dependencies: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"codex-catalog-prefix-v1\0");
    hash.update(base.as_bytes());
    hash.update(dependencies.as_bytes());
    format!("{:x}", hash.finalize())
}

pub(super) fn observe<'a>(adapter: &'a CodexAdapter<'_>) -> Result<IndexObservationBatch<'a>> {
    let scan = adapter.source_entries()?;
    #[cfg(test)]
    AFTER_SOURCE_SCAN.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook();
        }
    });
    let titles = CodexNativeTitles::read(adapter.root);
    let members = membership(&scan);
    // Unknown source identity retains its existing explicit, strict inventory
    // contract. It cannot supply a selected plain-file receipt.
    let unresolved = !scan.unresolved.is_empty();
    let (sources, selection) = if unresolved {
        (CodexSources::default(), BTreeMap::new())
    } else {
        select(adapter, &scan)?
    };
    let identities = selected_child_identities(&sources);
    let mut dependencies = BTreeMap::new();
    let mut prefixes = BTreeMap::new();
    let mut incoming = BTreeMap::new();
    if unresolved {
        for entry in adapter
            .codex_inventory_observation_from_scan(&scan, &titles)?
            .entries
            .expect("Codex inventory")
        {
            incoming.insert(entry.session_id.clone(), entry);
        }
    } else {
        for (id, entries) in &scan.grouped {
            let mut entry = entries.last().expect("grouped Codex source").clone();
            let base = match &selection[id] {
                Selection::Single(path) if !is_compressed(path) => {
                    let (_, length, metadata) = open_codex_prefix_observation(&entry.path)?;
                    entry = SourceEntry::from_metadata(id.clone(), entry.path, &metadata)?;
                    prefixes.insert(
                        id.clone(),
                        PrefixReceipt {
                            path: entry.path.clone(),
                            canonical_path: canonical(&entry.path)?,
                            length,
                            opening_revision: None,
                            revision: None,
                        },
                    );
                    entry.signature.clone()
                }
                Selection::Single(_) => entry.signature.clone(),
                Selection::Recorded(recorded) if !is_compressed(&recorded.path) => {
                    entry.path = recorded.path.clone();
                    let (_, length) = open_codex_complete_prefix(&entry.path)?;
                    let revision = codex_prefix_revision(&entry.path, adapter.scope, length)?;
                    let base = CodexAdapter::recorded_signature_from_revision(
                        recorded, entries, &revision,
                    );
                    prefixes.insert(
                        id.clone(),
                        PrefixReceipt {
                            path: entry.path.clone(),
                            canonical_path: canonical(&entry.path)?,
                            length,
                            opening_revision: Some(revision),
                            revision: None,
                        },
                    );
                    base
                }
                Selection::Recorded(recorded) => {
                    entry.path = recorded.path.clone();
                    adapter.recorded_signature(recorded, entries)?
                }
                Selection::Pair(..) => sources.pairs[id].revision(adapter.scope)?,
                Selection::Collision => CodexAdapter::collision_signature(entries)?,
            };
            entry.signature = if matches!(selection[id], Selection::Collision) {
                base
            } else {
                titles.signature(id, &base)
            };
            if prefixes.contains_key(id) {
                let dependency =
                    codex_child_dependencies_with_identities(&sources, id, Some(&identities));
                entry.signature = dependency_signature(&entry.signature, &dependency);
                dependencies.insert(id.clone(), dependency);
            }
            incoming.insert(id.clone(), entry);
        }
    }
    let inventory = InventoryObservation {
        entries: Some(incoming.values().cloned().collect()),
        source_uncertainty: unresolved
            .then_some((UNRESOLVED_SOURCE_DIAGNOSTIC, scan.unresolved.len())),
    };
    Ok(IndexObservationBatch {
        inventory,
        capture: Box::new(Batch {
            adapter,
            incoming,
            membership: members,
            selection,
            titles,
            sources,
            identities,
            dependencies,
            prefixes,
            unresolved,
        }),
    })
}

fn canonical(path: &Path) -> Result<PathBuf> {
    fs::canonicalize(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })
}

impl IndexCaptureBatch for Batch<'_, '_> {
    fn reuse(&mut self, entry: &SourceEntry, revision: &str, force: bool) -> Result<bool> {
        if let Some(prefix) = self.prefixes.get_mut(&entry.session_id) {
            if force
                && codex_prefix_revision(&prefix.path, self.adapter.scope, prefix.length)?
                    != revision
            {
                return Ok(false);
            }
            prefix.revision = Some(revision.into());
            return Ok(true);
        }
        if !force {
            return Ok(true);
        }
        if self.adapter.index_capture_revision(entry)?.as_deref() != Some(revision) {
            return Ok(false);
        }
        if self.adapter.source_signature(entry)? != entry.signature {
            return Err(CoreError::SourceChanged);
        }
        Ok(true)
    }

    fn capture(&mut self, entry: &SourceEntry) -> Result<SessionSnapshot> {
        let Some(prefix) = self.prefixes.get_mut(&entry.session_id) else {
            return self.adapter.capture_for_index(entry);
        };
        let file = fs::File::open(&prefix.path)
            .map_err(|source| codex_line_error(&prefix.path, source))?;
        let mut loaded = load_codex_fixed_prefix(
            &prefix.path,
            self.adapter.scope,
            &entry.session_id,
            file,
            prefix.length,
        )?;
        if prefix
            .opening_revision
            .as_ref()
            .is_some_and(|revision| revision != &loaded.revision)
            || codex_prefix_revision(&prefix.path, self.adapter.scope, prefix.length)?
                != loaded.revision
        {
            return Err(CoreError::SourceChanged);
        }
        prefix.revision = Some(loaded.revision.clone());
        if loaded.ownership_unavailable {
            return Ok(unavailable_snapshot(
                &entry.session_id,
                &loaded.revision,
                CHILD_OWNERSHIP_BOUNDARY_DIAGNOSTIC,
                &[],
            ));
        }
        if self.sources.recorded.contains_key(&entry.session_id) {
            source_set::mark_recorded_rollout(&mut loaded);
        }
        resolve_spawn_children_with_identities(&mut loaded, &self.sources, Some(&self.identities));
        let mut snapshot = codex_snapshot_from_loaded(loaded)?;
        self.titles.apply(&mut snapshot.summary);
        Ok(snapshot)
    }

    fn validate(&self) -> Result<()> {
        if self.unresolved {
            return self.adapter.validate_inventory(&self.incoming);
        }
        let scan = self.adapter.source_entries()?;
        if !scan.unresolved.is_empty() || membership(&scan) != self.membership {
            return Err(CoreError::SourceChanged);
        }
        let (sources, selection) = select(self.adapter, &scan)?;
        if selection != self.selection {
            return Err(CoreError::SourceChanged);
        }
        let titles = CodexNativeTitles::read(self.adapter.root);
        let identities = selected_child_identities(&sources);
        for (id, entry) in &self.incoming {
            if titles.stamp(id) != self.titles.stamp(id) {
                return Err(CoreError::SourceChanged);
            }
            if let Some(prefix) = self.prefixes.get(id) {
                let revision = prefix.revision.as_ref().ok_or(CoreError::SourceChanged)?;
                if canonical(&prefix.path)? != prefix.canonical_path
                    || codex_child_dependencies_with_identities(&sources, id, Some(&identities))
                        != self.dependencies[id]
                    || codex_prefix_revision(&prefix.path, self.adapter.scope, prefix.length)?
                        != *revision
                {
                    return Err(CoreError::SourceChanged);
                }
            } else if self.adapter.source_signature(entry)? != entry.signature {
                return Err(CoreError::SourceChanged);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn source(root: &Path, id: &str) -> PathBuf {
        let directory = root.join("sessions");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{id}.jsonl"));
        fs::write(&path, bytes(id)).unwrap();
        path
    }

    fn bytes(id: &str) -> String {
        let rows = [
            serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":"/synthetic/catalog"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"OLD-early"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"x".repeat(32_768)}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OLD-late"}]}}),
        ];
        rows.into_iter().map(|row| row.to_string() + "\n").collect()
    }

    fn append(path: &Path, body: &str) {
        writeln!(
            fs::OpenOptions::new().append(true).open(path).unwrap(),
            "{}",
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":body}})
        )
        .unwrap();
    }

    fn entries(batch: &mut IndexObservationBatch<'_>) -> Vec<SourceEntry> {
        batch.inventory.entries.take().unwrap()
    }

    fn has(snapshot: &SessionSnapshot, text: &str) -> bool {
        snapshot
            .events
            .iter()
            .any(|event| event.body.contains(text))
    }

    #[test]
    fn catalog_prefix_accepts_append_during_capture_and_refreshes_suffix() {
        let root = tempfile::tempdir().unwrap();
        let path = source(root.path(), "active");
        let adapter = CodexAdapter {
            root: root.path(),
            scope: "catalog-append",
        };
        let mut batch = observe(&adapter).unwrap();
        let entry = entries(&mut batch).remove(0);
        let writer_path = path.clone();
        let appended = std::rc::Rc::new(std::cell::Cell::new(false));
        let changed = appended.clone();
        CODEX_STREAM_READ_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |read| {
                if read == 2 && !changed.replace(true) {
                    append(&writer_path, "APPENDED-SUFFIX");
                }
            }))
        });
        let captured = batch.capture.capture(&entry);
        CODEX_STREAM_READ_HOOK.with(|hook| *hook.borrow_mut() = None);
        let captured = captured.unwrap();
        assert!(appended.get());
        assert!(!has(&captured, "APPENDED-SUFFIX"));
        batch.capture.validate().unwrap();
        let mut next = observe(&adapter).unwrap();
        let next_entry = entries(&mut next).remove(0);
        assert_ne!(next_entry.signature, entry.signature);
        assert!(has(
            &next.capture.capture(&next_entry).unwrap(),
            "APPENDED-SUFFIX"
        ));
        next.capture.validate().unwrap();
    }

    #[test]
    fn catalog_prefix_rejects_mixed_rewrite_and_truncation_during_capture() {
        for truncate in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let path = source(root.path(), "rewrite");
            let adapter = CodexAdapter {
                root: root.path(),
                scope: "catalog-rewrite",
            };
            let mut batch = observe(&adapter).unwrap();
            let entry = entries(&mut batch).remove(0);
            let replacement = bytes("rewrite").replace("OLD-", "NEW-");
            let writer_path = path.clone();
            let changed = std::rc::Rc::new(std::cell::Cell::new(false));
            let mutated = changed.clone();
            CODEX_STREAM_READ_HOOK.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move |read| {
                    if read == 2 && !mutated.replace(true) {
                        if truncate {
                            fs::write(&writer_path, "").unwrap();
                        } else {
                            fs::write(&writer_path, &replacement).unwrap();
                        }
                    }
                }))
            });
            let captured = batch.capture.capture(&entry);
            CODEX_STREAM_READ_HOOK.with(|hook| *hook.borrow_mut() = None);
            assert!(changed.get());
            assert!(
                matches!(captured, Err(CoreError::SourceChanged)),
                "{captured:?}"
            );
        }
    }

    #[test]
    fn catalog_prefix_rejects_rewrite_after_capture_and_aba_restore() {
        for restore in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let path = source(root.path(), "rewrite");
            let original = fs::read(&path).unwrap();
            let adapter = CodexAdapter {
                root: root.path(),
                scope: "catalog-aba",
            };
            let mut batch = observe(&adapter).unwrap();
            let entry = entries(&mut batch).remove(0);
            if restore {
                fs::write(&path, bytes("rewrite").replace("OLD-", "NEW-")).unwrap();
            }
            batch.capture.capture(&entry).unwrap();
            if restore {
                fs::write(&path, original).unwrap();
            } else {
                fs::write(&path, bytes("rewrite").replace("OLD-", "NEW-")).unwrap();
            }
            assert!(matches!(
                batch.capture.validate(),
                Err(CoreError::SourceChanged)
            ));
        }
    }

    #[test]
    fn catalog_cached_prefix_allows_append_while_another_session_refreshes() {
        let root = tempfile::tempdir().unwrap();
        let active = source(root.path(), "a-active");
        let healthy = source(root.path(), "z-healthy");
        let adapter = CodexAdapter {
            root: root.path(),
            scope: "catalog-cache",
        };
        let index = root.path().join("index");
        let first = crate::index::refresh(&index, adapter.scope, "codex", &adapter)
            .unwrap()
            .unwrap();
        append(&healthy, "HEALTHY-UPDATE");
        let writer_path = active.clone();
        let changed = std::rc::Rc::new(std::cell::Cell::new(false));
        let appended = changed.clone();
        CODEX_STREAM_READ_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |read| {
                if read == 2 && !appended.replace(true) {
                    append(&writer_path, "CACHED-ACTIVE-UPDATE");
                }
            }))
        });
        let refreshed = crate::index::refresh(&index, adapter.scope, "codex", &adapter);
        CODEX_STREAM_READ_HOOK.with(|hook| *hook.borrow_mut() = None);
        let refreshed = refreshed.unwrap().unwrap();
        assert!(changed.get());
        assert_ne!(refreshed.revision, first.revision);
        assert_eq!(refreshed.rows.len(), 2);
        let next = crate::index::refresh(&index, adapter.scope, "codex", &adapter)
            .unwrap()
            .unwrap();
        assert_ne!(
            next.revision, refreshed.revision,
            "append was not stamped as already indexed"
        );
        let unchanged = crate::index::refresh(&index, adapter.scope, "codex", &adapter)
            .unwrap()
            .unwrap();
        assert_eq!(next.revision, unchanged.revision);
    }

    #[test]
    fn catalog_prefix_stat_and_length_share_the_same_opening_observation() {
        let root = tempfile::tempdir().unwrap();
        let active = source(root.path(), "active");
        let adapter = CodexAdapter {
            root: root.path(),
            scope: "catalog-opening",
        };
        let index = root.path().join("index");
        let first = crate::index::refresh(&index, adapter.scope, "codex", &adapter)
            .unwrap()
            .unwrap();
        AFTER_SOURCE_SCAN.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                append(&active, "APPEND-BETWEEN-SCAN-AND-PREFIX");
            }))
        });
        let next = crate::index::refresh(&index, adapter.scope, "codex", &adapter)
            .unwrap()
            .unwrap();
        assert_ne!(first.revision, next.revision);
        let unchanged = crate::index::refresh(&index, adapter.scope, "codex", &adapter)
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.revision, next.revision);
    }

    #[test]
    fn catalog_prefix_validates_membership_titles_and_child_dependencies() {
        for change in ["membership", "title", "child"] {
            let root = tempfile::tempdir().unwrap();
            let path = source(root.path(), "parent");
            let child = source(root.path(), "child");
            fs::write(&child, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"child\",\"parent_thread_id\":\"parent\"}}\n").unwrap();
            let adapter = CodexAdapter {
                root: root.path(),
                scope: "catalog-facts",
            };
            let mut batch = observe(&adapter).unwrap();
            for entry in entries(&mut batch) {
                batch.capture.capture(&entry).unwrap();
            }
            match change {
                "membership" => {
                    fs::copy(path, root.path().join("sessions/duplicate.jsonl")).unwrap();
                }
                "title" => {
                    fs::write(root.path().join("session_index.jsonl"), "{\"id\":\"parent\",\"thread_name\":\"New title\",\"updated_at\":\"2026-10-16T00:00:00Z\"}\n").unwrap();
                }
                _ => {
                    fs::write(child, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"child\",\"parent_thread_id\":\"other!\"}}\n").unwrap();
                }
            }
            assert!(
                matches!(batch.capture.validate(), Err(CoreError::SourceChanged)),
                "{change}"
            );
        }
    }

    #[test]
    fn catalog_prefix_distinguishes_partial_valid_unterminated_and_malformed_records() {
        for tail in [
            "{\"type\":",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"FINAL-NO-NEWLINE\"}}",
            "{broken}\n",
            "{broken}",
        ] {
            let root = tempfile::tempdir().unwrap();
            let path = source(root.path(), "tail");
            fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap()
                .write_all(tail.as_bytes())
                .unwrap();
            let adapter = CodexAdapter {
                root: root.path(),
                scope: "catalog-tail",
            };
            let mut batch = observe(&adapter).unwrap();
            let entry = entries(&mut batch).remove(0);
            let snapshot = batch.capture.capture(&entry).unwrap();
            assert_eq!(snapshot.summary.session.session_id, "tail");
            batch.capture.validate().unwrap();
            if tail.starts_with("{broken}") {
                match adapter.protocol_bundle("tail").map(|_| ()) {
                    Err(CoreError::Protocol(ProtocolError::Invalid { diagnostics })) => assert!(
                        diagnostics
                            .iter()
                            .any(|diagnostic| diagnostic.code == "malformed_source_record"),
                        "{tail}: {diagnostics:?}",
                    ),
                    other => panic!(
                        "{tail}: expected explicit malformed Protocol diagnostic, got {other:?}"
                    ),
                }
            } else {
                assert_eq!(
                    has(&snapshot, "FINAL-NO-NEWLINE"),
                    tail.contains("FINAL-NO-NEWLINE")
                );
            }
        }
    }

    #[test]
    fn catalog_recorded_prefix_preserves_opening_generation_and_authority() {
        for change in ["append", "aba", "authority"] {
            let root = tempfile::tempdir().unwrap();
            let first = source(root.path(), "recorded");
            let later = root.path().join("sessions/later.jsonl");
            fs::write(&later, bytes("recorded").replace("OLD-", "NEW-")).unwrap();
            let db = rusqlite::Connection::open(root.path().join("state_5.sqlite")).unwrap();
            db.execute_batch(
                "CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)",
            )
            .unwrap();
            db.execute(
                "INSERT INTO threads VALUES ('recorded', ?1)",
                [first.to_string_lossy().as_ref()],
            )
            .unwrap();
            let adapter = CodexAdapter {
                root: root.path(),
                scope: "catalog-authority",
            };
            let mut batch = observe(&adapter).unwrap();
            let entry = entries(&mut batch).remove(0);
            match change {
                "append" => append(&first, "ACTIVE-RECORDED-SUFFIX"),
                "aba" => fs::write(&first, bytes("recorded").replace("OLD-", "NEW-")).unwrap(),
                _ => {}
            }
            let captured = batch.capture.capture(&entry);
            if change == "aba" {
                fs::write(&first, bytes("recorded")).unwrap();
                assert!(matches!(captured, Err(CoreError::SourceChanged)));
                continue;
            }
            let captured = captured.unwrap();
            assert!(!has(&captured, "ACTIVE-RECORDED-SUFFIX"));
            if change == "authority" {
                db.execute(
                    "UPDATE threads SET rollout_path = ?1",
                    [later.to_string_lossy().as_ref()],
                )
                .unwrap();
                assert!(matches!(
                    batch.capture.validate(),
                    Err(CoreError::SourceChanged)
                ));
            } else {
                batch.capture.validate().unwrap();
            }
        }
    }
}
