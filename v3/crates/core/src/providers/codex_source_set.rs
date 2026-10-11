//! Direct history-base source sets. The source records remain provider-owned.
use super::*;

#[cfg(test)]
thread_local! {
    static AFTER_PAIR_LOAD: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
    static PAIR_RESOLVE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(super) fn before_pair_publication() {
    AFTER_PAIR_LOAD.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook();
        }
    });
}

#[derive(Default)]
pub(super) struct Sources {
    pub paths: BTreeMap<String, PathBuf>,
    pub pairs: BTreeMap<String, DirectPair>,
    pub recorded: BTreeMap<String, rollout_authority::RecordedRollout>,
    pub recorded_entries: BTreeMap<String, Vec<SourceEntry>>,
}
impl std::ops::Deref for Sources {
    type Target = BTreeMap<String, PathBuf>;
    fn deref(&self) -> &Self::Target {
        &self.paths
    }
}
impl From<BTreeMap<String, PathBuf>> for Sources {
    fn from(paths: BTreeMap<String, PathBuf>) -> Self {
        Self {
            paths,
            pairs: BTreeMap::new(),
            recorded: BTreeMap::new(),
            recorded_entries: BTreeMap::new(),
        }
    }
}

pub(super) struct DirectPair {
    pub first: PathBuf,
    pub later: PathBuf,
    pub cutoff: usize,
    pub prefix_records: usize,
}

#[derive(Clone)]
pub(super) struct Position {
    pub source_id: String,
    pub event_key: String,
    pub physical_order: u64,
}

fn read(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })
}

impl DirectPair {
    pub fn resolve(entries: &[SourceEntry], id: &str) -> Result<Option<Self>> {
        #[cfg(test)]
        PAIR_RESOLVE_COUNT.with(|count| count.set(count.get() + 1));
        if entries.len() != 2 || entries.iter().any(|e| is_compressed(&e.path)) {
            return Ok(None);
        }
        let headers = entries
            .iter()
            .map(|e| read_primary_meta(&e.path))
            .collect::<Result<Vec<_>>>()?;
        for later in 0..2 {
            let first = 1 - later;
            let (Some(a), Some(b)) = (&headers[first], &headers[later]) else {
                continue;
            };
            let a = &a["payload"];
            let b = &b["payload"];
            // This slice owns direct, root-session continuation only. An inherited
            // base requires ancestry and child-ownership semantics of its own.
            if a["id"] != id
                || b["id"] != id
                || !a["history_base"].is_null()
                || [a, b].iter().any(|p| {
                    !p["parent_thread_id"].is_null()
                        || !p["forked_from_id"].is_null()
                        || !p["source"]["subagent"].is_null()
                })
            {
                continue;
            }
            let base = &b["history_base"];
            if base["thread_id"] != id {
                continue;
            }
            let (Some(cutoff), Some(prefix_records)) = (
                base["end_byte_offset"].as_u64(),
                base["end_ordinal_exclusive"].as_u64(),
            ) else {
                continue;
            };
            let (Ok(cutoff), Ok(prefix_records)) =
                (usize::try_from(cutoff), usize::try_from(prefix_records))
            else {
                continue;
            };
            let pair = Self {
                first: entries[first].path.clone(),
                later: entries[later].path.clone(),
                cutoff,
                prefix_records,
            };
            let first_bytes = read(&pair.first)?;
            let later_bytes = read(&pair.later)?;
            if pair.validate(&first_bytes, &later_bytes, id)? {
                return Ok(Some(pair));
            }
        }
        Ok(None)
    }

    fn validate(&self, first: &[u8], later: &[u8], id: &str) -> Result<bool> {
        if self.cutoff == 0
            || self.cutoff >= first.len()
            || first.get(self.cutoff - 1) != Some(&b'\n')
            || first.last() != Some(&b'\n')
            || later.last() != Some(&b'\n')
        {
            return Ok(false);
        }
        if first[..self.cutoff].iter().filter(|b| **b == b'\n').count() != self.prefix_records {
            return Ok(false);
        }
        let mut last_window = None;
        let mut first_window = None;
        let mut later_window = None;
        let mut suffix_first = None;
        let mut suffix_last = None;
        for (segment, bytes) in [first, later].into_iter().enumerate() {
            for (line, raw) in bytes.split_inclusive(|b| *b == b'\n').enumerate() {
                let Ok(record) = serde_json::from_slice::<Value>(raw) else {
                    return Ok(false);
                };
                let p = &record["payload"];
                if line == 0 && (record["type"] != "session_meta" || p["id"] != id) {
                    return Ok(false);
                }
                if line == 0
                    && (!p["parent_thread_id"].is_null()
                        || !p["forked_from_id"].is_null()
                        || !p["source"]["subagent"].is_null()
                        || (segment == 0 && !p["history_base"].is_null()))
                {
                    return Ok(false);
                }
                if line == 0
                    && segment == 1
                    && (p["history_base"]["thread_id"] != id
                        || p["history_base"]["end_byte_offset"].as_u64()
                            != Some(self.cutoff as u64)
                        || p["history_base"]["end_ordinal_exclusive"].as_u64()
                            != Some(self.prefix_records as u64))
                {
                    return Ok(false);
                }
                if segment == 0 && line >= self.prefix_records {
                    if record["type"] == "token_usage_record"
                        || (record["type"] == "event_msg" && p["type"] == "token_count")
                    {
                        return Ok(false);
                    }
                    let kind = p["type"].as_str().unwrap_or("").to_owned();
                    suffix_first.get_or_insert(kind.clone());
                    suffix_last = Some(kind);
                }
                if record["type"] == "compacted" {
                    if segment == 0 && line < self.prefix_records {
                        last_window = p["window_id"].as_str().map(str::to_owned);
                        first_window = p["first_window_id"].as_str().map(str::to_owned);
                    } else if segment == 1 && later_window.is_none() {
                        later_window = Some((
                            p["previous_window_id"].as_str().map(str::to_owned),
                            p["first_window_id"].as_str().map(str::to_owned),
                        ));
                    }
                }
            }
        }
        if suffix_first.as_deref() != Some("task_started")
            || suffix_last.as_deref() != Some("turn_aborted")
        {
            return Ok(false);
        }
        if let (Some(last), Some((previous, next_first))) = (last_window, later_window) {
            if previous.as_deref() != Some(&last) || first_window != next_first {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn revision(&self, scope: &str) -> Result<String> {
        let mut hash = Sha256::new();
        hash.update(b"codex-direct-source-set-v5\0");
        hash.update(scope.as_bytes());
        hash.update((self.cutoff as u64).to_le_bytes());
        hash.update((self.prefix_records as u64).to_le_bytes());
        for path in [&self.first, &self.later] {
            let rendered = path.to_string_lossy();
            hash.update((rendered.len() as u64).to_le_bytes());
            hash.update(rendered.as_bytes());
            let (size, digest) = codex_usage_file_digest(path)?;
            hash.update(size.to_le_bytes());
            hash.update(digest);
        }
        Ok(format!("source-set:{:x}", hash.finalize()))
    }

    pub fn active_bytes(&self, id: &str) -> Result<Vec<u8>> {
        let first = read(&self.first)?;
        let later = read(&self.later)?;
        if !self.validate(&first, &later, id)? {
            return Err(CoreError::SourceChanged);
        }
        let mut selected = Vec::with_capacity(self.cutoff + later.len());
        selected.extend_from_slice(&first[..self.cutoff]);
        selected.extend_from_slice(&later);
        Ok(selected)
    }

    pub fn source_line(&self, index: usize) -> String {
        if index < self.prefix_records {
            format!("{}#L{}", self.first.display(), index + 1)
        } else {
            format!(
                "{}#L{}",
                self.later.display(),
                index - self.prefix_records + 1
            )
        }
    }

    pub fn load(&self, scope: &str, id: &str) -> Result<LoadedSession> {
        let revision = self.revision(scope)?;
        let first = read(&self.first)?;
        let later = read(&self.later)?;
        if !self.validate(&first, &later, id)? {
            return Err(CoreError::SourceChanged);
        }
        let first_count = first.iter().filter(|b| **b == b'\n').count();
        let key = |path: &Path| format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()));
        let first_key = key(&self.first);
        let later_key = key(&self.later);
        let mut positions = Vec::new();
        let mut selected = Vec::with_capacity(self.cutoff + later.len());
        selected.extend_from_slice(&first[..self.cutoff]);
        selected.extend_from_slice(&later);
        for (path, key, bytes, order) in [
            (&self.first, &first_key, &first[..self.cutoff], 0),
            (&self.later, &later_key, &later[..], first_count),
        ] {
            let mut start = 0;
            for (line, raw) in bytes.split_inclusive(|b| *b == b'\n').enumerate() {
                let end = start + raw.len();
                positions.push(Position {
                    source_id: format!("{}#L{};bytes={start}..{end}", path.display(), line + 1),
                    event_key: format!("{key}:{line}"),
                    physical_order: (order + line) as u64,
                });
                start = end;
            }
        }
        let mut reader = std::io::Cursor::new(&selected);
        let mut loaded = load_codex_reader_positioned(
            &self.first,
            id,
            revision.clone(),
            &mut reader,
            Some(&selected),
            Some(&positions),
        )?;
        for event in &mut loaded.protocol_candidates {
            event.source_order.record =
                positions[event.source_order.record as usize].physical_order;
        }
        let mut start = self.cutoff;
        for (offset, raw) in first[self.cutoff..]
            .split_inclusive(|b| *b == b'\n')
            .enumerate()
        {
            let line = self.prefix_records + offset;
            let record: Value = serde_json::from_slice(raw).expect("validated source record");
            let end = start + raw.len();
            let source_id = format!(
                "{}#L{};bytes={start}..{end}",
                self.first.display(),
                line + 1
            );
            let event_id = format!("event:codex:{first_key}:{line}");
            start = end;
            loaded.observations.facts.diagnostics.push(Diagnostic {
                code: "codex_history_base_excluded_record",
                event_id: Some(event_id.clone()),
            });
            loaded.protocol_candidates.push(EventCandidate {
                id: event_id,
                session: SessionRef {
                    provider: "codex".into(),
                    session_id: id.into(),
                },
                source_order: SourceOrder {
                    record: line as u64,
                    ordinal: 0,
                },
                timestamp: record["timestamp"].as_str().and_then(timestamp_ms),
                category: "context".into(),
                kind: "source.history_base_excluded".into(),
                provenance: Provenance {
                    fidelity: Fidelity::Recorded,
                    source_type: format!(
                        "codex.{}:{}",
                        record["type"].as_str().unwrap_or(""),
                        record["payload"]["type"].as_str().unwrap_or("")
                    ),
                    source_id: Some(source_id),
                },
                reader_event: None,
                execution: None,
            });
        }
        if self.revision(scope)? != revision {
            return Err(CoreError::SourceChanged);
        }
        Ok(loaded)
    }
}

pub(super) fn load_selected(
    path: &Path,
    scope: &str,
    id: &str,
    sources: Option<&Sources>,
) -> Result<LoadedSession> {
    if let Some(pair) = sources.and_then(|sources| sources.pairs.get(id)) {
        pair.load(scope, id)
    } else {
        let mut loaded = load_codex(path, scope, id)?;
        if sources.is_some_and(|sources| sources.recorded.contains_key(id)) {
            mark_recorded_rollout(&mut loaded);
        }
        Ok(loaded)
    }
}

pub(super) fn mark_recorded_rollout(loaded: &mut LoadedSession) {
    loaded.observations.facts.diagnostics.push(Diagnostic {
        code: "codex_recorded_rollout_selected",
        event_id: None,
    });
    loaded.observations.facts.coverage.insert("sourceHistory".into(), DomainCoverage {
        state: ObservationState::Unknown,
        details: "Reading the current rollout recorded in Codex threads.rollout_path; continuity with other same-ID source files is unrecorded.".into(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transcript_path(root: &Path, name: impl AsRef<Path>) -> PathBuf {
        let directory = root.join("sessions");
        fs::create_dir_all(&directory).unwrap();
        directory.join(name)
    }

    fn row(value: Value) -> String {
        format!("{value}\n")
    }
    fn fixture(root: &Path) -> (PathBuf, PathBuf, String) {
        let id = "11111111-1111-4111-8111-111111111111";
        let first = transcript_path(root, format!("rollout-a-{id}.jsonl"));
        let later = transcript_path(root, format!("rollout-z-{id}.jsonl"));
        let header = |second: u8| serde_json::json!({"type":"session_meta","timestamp":format!("2026-09-29T00:00:{second:02}.000Z"),"payload":{"id":id,"cwd":"/source-set"}});
        let mut prefix = row(header(0));
        prefix += &row(
            serde_json::json!({"type":"event_msg","timestamp":"2026-09-29T00:00:01.000Z","payload":{"type":"user_message","message":"First selected question"}}),
        );
        prefix += &row(
            serde_json::json!({"type":"token_usage_record","timestamp":"2026-09-29T00:00:02.000Z","payload":{"thread_id":id,"response_id":"first-response","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}),
        );
        let mut source = prefix.clone();
        source += &row(
            serde_json::json!({"type":"event_msg","timestamp":"2026-09-29T00:00:03.000Z","payload":{"type":"task_started","turn_id":"aborted"}}),
        );
        source += &row(
            serde_json::json!({"type":"event_msg","timestamp":"2026-09-29T00:00:04.000Z","payload":{"type":"user_message","message":"Excluded aborted question"}}),
        );
        source += &row(
            serde_json::json!({"type":"event_msg","timestamp":"2026-09-29T00:00:05.000Z","payload":{"type":"turn_aborted","turn_id":"aborted"}}),
        );
        fs::write(&first, source).unwrap();
        let mut next = header(6);
        next["payload"]["history_base"] = serde_json::json!({"thread_id":id,"end_ordinal_exclusive":3,"end_byte_offset":prefix.len()});
        let mut source = row(next);
        source += &row(
            serde_json::json!({"type":"event_msg","timestamp":"2026-09-29T00:00:07.000Z","payload":{"type":"user_message","message":"Later selected question"}}),
        );
        source += &row(
            serde_json::json!({"type":"token_usage_record","timestamp":"2026-09-29T00:00:08.000Z","payload":{"thread_id":id,"response_id":"later-response","usage":{"input_tokens":20,"output_tokens":3,"total_tokens":23}}}),
        );
        fs::write(&later, source).unwrap();
        (first, later, id.into())
    }

    #[test]
    fn direct_source_set_preserves_history_usage_and_excluded_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let (first, later, id) = fixture(directory.path());
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "direct-source-set",
        };
        let snapshot = adapter.load(&id).expect("anchored source set must load");
        assert!(adapter.storage_diagnostic().is_none());
        let content = format!("{snapshot:?}");
        assert!(content.contains("First selected question"));
        assert!(content.contains("Later selected question"));
        assert!(!content.contains("Excluded aborted question"));
        assert_eq!(snapshot.summary.token_count, Some(35));
        let protocol = adapter.native_protocol_snapshot(&id).unwrap();
        assert_eq!(protocol.usage_records().len(), 2);
        let json = serde_json::to_value(&protocol).unwrap();
        let diagnostics = json["diagnostics"].as_array().unwrap();
        assert_eq!(
            diagnostics
                .iter()
                .filter(|d| d["code"] == "codex_history_base_excluded_record")
                .count(),
            3
        );
        assert!(json["runObservations"].as_array().unwrap().is_empty());
        let stream = adapter.protocol_event_stream(&id).unwrap();
        for diagnostic in diagnostics {
            if diagnostic["code"] == "codex_history_base_excluded_record" {
                let event = stream
                    .event_detail(diagnostic["event_id"].as_str().unwrap())
                    .unwrap()
                    .event;
                assert_eq!(event.kind, "source.history_base_excluded");
                assert!(event.reader_event.is_none());
                assert!(event.execution.is_none());
                assert!(
                    event
                        .provenance
                        .source_id
                        .as_deref()
                        .unwrap()
                        .starts_with(&first.to_string_lossy().to_string())
                );
                assert!(
                    event
                        .provenance
                        .source_id
                        .as_deref()
                        .unwrap()
                        .contains(";bytes=")
                );
            }
        }
        assert_eq!(
            stream.revision(),
            adapter.reader_revision(&id).unwrap().unwrap().revision
        );
        assert_eq!(snapshot.revision, stream.revision());
        assert_eq!(
            adapter.reader_capture(&id).unwrap().snapshot.revision,
            snapshot.revision
        );
        let revision = adapter.stats_usage_source_revision().unwrap();
        let batch = adapter
            .stats_observation_batch(revision.as_deref())
            .unwrap()
            .unwrap();
        assert_eq!(batch.observations(&id).unwrap().usage_records().len(), 2);
        batch.validate_source_revision().unwrap();
        let inventory = adapter.inventory().unwrap().unwrap();
        assert_eq!(inventory.len(), 1);
        assert!(
            adapter
                .capture(&inventory[0])
                .unwrap()
                .summary
                .diagnostic
                .is_none()
        );
        assert_eq!(
            adapter.source_signature(&inventory[0]).unwrap(),
            inventory[0].signature
        );
        let old = adapter.reader_revision(&id).unwrap().unwrap().revision;
        let bytes = fs::read_to_string(&first)
            .unwrap()
            .replace("Excluded aborted question", "Replaced aborted question");
        fs::write(&first, bytes).unwrap();
        assert_ne!(adapter.reader_revision(&id).unwrap().unwrap().revision, old);
        assert!(batch.validate_source_revision().is_err());
        assert!(adapter.capture(&inventory[0]).is_err());
        assert!(fs::read(&later).is_ok());
    }

    #[test]
    fn direct_source_set_rejects_unproved_boundaries_and_excluded_usage() {
        for mutation in [
            "no-anchor",
            "wrong-owner",
            "wrong-byte",
            "wrong-ordinal",
            "inherited",
            "third-source",
            "excluded-usage",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let (first, later, id) = fixture(directory.path());
            if mutation == "third-source" {
                fs::copy(
                    &later,
                    transcript_path(directory.path(), "rollout-third.jsonl"),
                )
                .unwrap();
            } else {
                let target = if matches!(mutation, "inherited" | "excluded-usage") {
                    &first
                } else {
                    &later
                };
                let mut records: Vec<Value> = fs::read_to_string(target)
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect();
                match mutation {
                    "no-anchor" => {
                        records[0]["payload"]
                            .as_object_mut()
                            .unwrap()
                            .remove("history_base");
                    }
                    "wrong-owner" => {
                        records[0]["payload"]["history_base"]["thread_id"] = "another".into()
                    }
                    "wrong-byte" => {
                        records[0]["payload"]["history_base"]["end_byte_offset"] =
                            (records[0]["payload"]["history_base"]["end_byte_offset"]
                                .as_u64()
                                .unwrap()
                                - 1)
                            .into()
                    }
                    "wrong-ordinal" => {
                        records[0]["payload"]["history_base"]["end_ordinal_exclusive"] = 4.into()
                    }
                    "inherited" => {
                        records[0]["payload"]["history_base"] = serde_json::json!({"thread_id":"ancestor","end_ordinal_exclusive":100,"end_byte_offset":500})
                    }
                    "excluded-usage" => {
                        records[4] = serde_json::json!({"type":"token_usage_record","payload":{"thread_id":id,"response_id":"excluded","usage":{"total_tokens":3}}})
                    }
                    _ => unreachable!(),
                }
                fs::write(target, records.into_iter().map(row).collect::<String>()).unwrap();
            }
            let adapter = CodexAdapter {
                root: directory.path(),
                scope: "source-set-reject",
            };
            assert!(
                matches!(
                    adapter.load(&id),
                    Err(CoreError::Protocol(ProtocolError::Unavailable { .. }))
                ),
                "{mutation}"
            );
            assert_eq!(
                adapter.list().unwrap()[0].diagnostic.as_deref(),
                Some(MULTIPLE_SOURCE_DIAGNOSTIC),
                "{mutation}"
            );
        }
    }

    #[test]
    fn direct_source_set_keeps_unreadable_identity_gate() {
        let directory = tempfile::tempdir().unwrap();
        let (_, _, id) = fixture(directory.path());
        fs::write(
            transcript_path(directory.path(), "rollout-unknown.jsonl"),
            "{invalid header}\n",
        )
        .unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "source-set-unknown",
        };
        assert!(
            matches!(adapter.load(&id), Err(CoreError::Protocol(ProtocolError::Unavailable { diagnostic })) if diagnostic == UNRESOLVED_SOURCE_DIAGNOSTIC)
        );
        assert_eq!(
            adapter.list().unwrap()[0].diagnostic.as_deref(),
            Some(UNRESOLVED_SOURCE_DIAGNOSTIC)
        );
    }

    #[test]
    fn direct_source_set_does_not_read_unrelated_pair_bodies_for_single_session() {
        let directory = tempfile::tempdir().unwrap();
        fixture(directory.path());
        let healthy = "22222222-2222-4222-8222-222222222222";
        fs::write(
            transcript_path(directory.path(), "rollout-healthy.jsonl"),
            row(serde_json::json!({"type":"session_meta","payload":{"id":healthy}})),
        )
        .unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "source-set-targeted",
        };
        PAIR_RESOLVE_COUNT.with(|count| count.set(0));
        let sources = adapter.selected_sources(Some(healthy)).unwrap();
        assert!(sources.contains_key(healthy));
        assert!(sources.pairs.is_empty());
        PAIR_RESOLVE_COUNT.with(|count| assert_eq!(count.get(), 0));
    }

    #[test]
    fn direct_source_set_protocol_rejects_member_added_during_load() {
        for route in [
            "bundle",
            "stream",
            "observations",
            "reader",
            "revision",
            "parent-fact",
            "unknown-identity",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let (_, later, id) = fixture(directory.path());
            let third = transcript_path(directory.path(), "rollout-third.jsonl");
            AFTER_PAIR_LOAD.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || {
                    if route == "unknown-identity" {
                        fs::write(third, "{unreadable header}\n").unwrap();
                    } else {
                        fs::copy(later, third).unwrap();
                    }
                }))
            });
            let adapter = CodexAdapter {
                root: directory.path(),
                scope: "source-set-member-race",
            };
            let result = match route {
                "stream" => adapter.protocol_event_stream(&id).map(|_| ()),
                "observations" => adapter.protocol_observations(&id).map(|_| ()),
                "reader" => adapter.reader_capture(&id).map(|_| ()),
                "revision" => adapter.reader_revision(&id).map(|_| ()),
                "parent-fact" => adapter.reader_parent_fact(&id).map(|_| ()),
                _ => adapter.protocol_bundle(&id).map(|_| ()),
            };
            assert!(matches!(result, Err(CoreError::SourceChanged)), "{route}");
        }
    }

    #[test]
    #[ignore = "requires retained private 373/422 witness copies"]
    fn direct_source_set_private_witness() {
        let root =
            PathBuf::from(std::env::var("AGENTSESSION_CODEX_SOURCE_SET_WITNESS_DIR").unwrap());
        let adapter = CodexAdapter {
            root: &root,
            scope: "source-set-private-witness",
        };
        let scan = adapter.source_entries().unwrap();
        assert!(scan.unresolved.is_empty());
        assert_eq!(scan.grouped.len(), 1);
        let (id, entries) = scan.grouped.iter().next().unwrap();
        assert_eq!(entries.len(), 2);
        let before: Vec<_> = entries
            .iter()
            .map(|entry| codex_usage_file_digest(&entry.path).unwrap())
            .collect();
        let pair = DirectPair::resolve(entries, id).unwrap().unwrap();
        assert_eq!(pair.prefix_records, 1296);
        let loaded = pair.load(adapter.scope, id).unwrap();
        assert_eq!(
            loaded
                .protocol_candidates
                .iter()
                .filter(|e| e.kind == "source.history_base_excluded")
                .count(),
            8
        );
        let facts = adapter.native_protocol_snapshot(id).unwrap();
        assert_eq!(facts.usage_records().len(), 206);
        assert_eq!(facts.usage_observations().len(), 214);
        let json = serde_json::to_value(&facts).unwrap();
        let missing: Vec<_> = json["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["code"] == "codex_usage_payload_unavailable")
            .collect();
        assert_eq!(missing.len(), 1);
        let event = adapter
            .protocol_event_stream(id)
            .unwrap()
            .event_detail(missing[0]["event_id"].as_str().unwrap())
            .unwrap()
            .event;
        assert!(event.provenance.source_id.unwrap().contains("#L961;bytes="));
        let mut expected = HashSet::new();
        for path in [&pair.first, &pair.later] {
            for line in fs::read_to_string(path).unwrap().lines() {
                let record: Value = serde_json::from_str(line).unwrap();
                if record["type"] == "token_usage_record" {
                    expected.insert(
                        record["payload"]["response_id"]
                            .as_str()
                            .unwrap()
                            .to_owned(),
                    );
                }
            }
        }
        let actual: HashSet<_> = facts
            .usage_records()
            .iter()
            .map(|r| r.provenance.source_id.clone().unwrap())
            .collect();
        assert_eq!(actual, expected);
        let snapshot = adapter.reader_capture(id).unwrap();
        assert_eq!(
            snapshot.snapshot.revision,
            adapter.reader_revision(id).unwrap().unwrap().revision
        );
        assert_eq!(
            snapshot.snapshot.revision,
            adapter.protocol_event_stream(id).unwrap().revision()
        );
        let batch = adapter.stats_observation_batch(None).unwrap().unwrap();
        assert_eq!(batch.observations(id).unwrap().usage_records().len(), 206);
        batch.validate_source_revision().unwrap();
        let after: Vec<_> = entries
            .iter()
            .map(|entry| codex_usage_file_digest(&entry.path).unwrap())
            .collect();
        assert_eq!(before, after);
        eprintln!(
            "373/422 witness: 206 canonical requests, 214 numeric unresolved usage observations plus 1 unavailable payload event, 8 excluded evidence events; source hashes unchanged"
        );
    }
}
