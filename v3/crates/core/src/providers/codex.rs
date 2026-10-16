//! Codex discovery, decoding, source revision and normalization.
pub(super) fn default_data_path(home: &std::path::Path) -> std::path::PathBuf {
    super::paths::probe(
        &[
            std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from),
            Some(home.join(".codex")),
            super::paths::app_data_dir(home, "codex"),
        ],
        home.join(".codex"),
    )
}

#[path = "codex_rollout_authority.rs"]
mod rollout_authority;
#[path = "codex_source_set.rs"]
mod source_set;
#[path = "codex_tool_presentation.rs"]
mod tool_presentation;
use super::{
    InheritedContextSnapshot, InheritedEvent, NormalizedEvent, ProviderAdapter, SessionSnapshot,
    SourceEntry, StatsObservationBatch,
};
use crate::protocol::{
    AgentRunObservation, ContextObservation, CoordinationFact, Diagnostic, DomainCoverage,
    EventCandidate, EventStream, Evidence, ExecutionKind, ExecutionObservation, ExecutionPhase,
    Fidelity, ObservationCandidates, ObservationSnapshot, ObservationState, Pairing,
    ProtocolBundle, ProtocolError, Provenance, RelationshipObservation, RunObservation, RunStatus,
    SourceOrder, TaskObservation, UsageObservation, UsageRecord, UsageTokenComponents,
    finalize_events, finalize_protocol_bundle,
};
use crate::{
    CollaborationLaunchRequest, CoordinationObservation, CoreError, EventRef, InheritedItem,
    ReaderItem, RelationEntry, RelationProvenance, Result, SessionRef, SessionSummary,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use source_set::{DirectPair, Sources as CodexSources, load_selected};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use walkdir::WalkDir;
const PREVIEW_CHARS: usize = 240;
const CODEX_REVISION_NAMESPACE: &[u8] = b"codex-jsonl-v3-s2-6\0";
const MULTIPLE_SOURCE_DIAGNOSTIC: &str = "codex_multiple_source_files_unmerged";
const UNRESOLVED_SOURCE_DIAGNOSTIC: &str = "codex_source_inventory_incomplete";
const CHILD_OWNERSHIP_BOUNDARY_DIAGNOSTIC: &str = "codex_child_ownership_boundary_unavailable";
const INHERITED_PARSER_VERSION: &str = "codex-inherited-v1";
const INHERITED_CACHE_LIMIT: usize = 4;
const INHERITED_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;
#[derive(PartialEq, Eq)]
struct InheritedCacheKey {
    path: PathBuf,
    scope: String,
    session_id: String,
    source_sha256: String,
    parser_version: &'static str,
}
struct InheritedCacheEntry {
    key: InheritedCacheKey,
    snapshot: InheritedContextSnapshot,
    estimated_bytes: usize,
}
static INHERITED_CACHE: OnceLock<Mutex<Vec<InheritedCacheEntry>>> = OnceLock::new();
fn inherited_cache_get(key: &InheritedCacheKey) -> Option<InheritedContextSnapshot> {
    let cache = INHERITED_CACHE.get_or_init(|| Mutex::new(Vec::new()));
    let mut entries = cache.lock().unwrap();
    let index = entries.iter().position(|entry| &entry.key == key)?;
    let entry = entries.remove(index);
    let snapshot = entry.snapshot.clone();
    entries.push(entry);
    Some(snapshot)
}

fn inherited_cache_put(
    key: InheritedCacheKey,
    snapshot: &InheritedContextSnapshot,
    source_bytes: usize,
) {
    let projected_bytes = snapshot.events.iter().fold(0usize, |size, event| {
        size.saturating_add(
            std::mem::size_of::<InheritedEvent>()
                + event.body.len()
                + event.tool_input.len()
                + event.tool_output.len()
                + event.item.preview.len()
                + event.item.message_id.len()
                + event.item.segment.len()
                + event.item.role.len()
                + event.item.tool_name.as_ref().map_or(0, String::len),
        )
    });
    let estimated_bytes = source_bytes.saturating_add(projected_bytes);
    if estimated_bytes > INHERITED_CACHE_MAX_BYTES {
        return;
    }
    let cache = INHERITED_CACHE.get_or_init(|| Mutex::new(Vec::new()));
    let mut entries = cache.lock().unwrap();
    entries.retain(|entry| {
        !(entry.key.path == key.path
            && entry.key.scope == key.scope
            && entry.key.session_id == key.session_id)
    });
    while entries.len() >= INHERITED_CACHE_LIMIT
        || entries
            .iter()
            .map(|entry| entry.estimated_bytes)
            .sum::<usize>()
            + estimated_bytes
            > INHERITED_CACHE_MAX_BYTES
    {
        entries.remove(0);
    }
    entries.push(InheritedCacheEntry {
        key,
        snapshot: snapshot.clone(),
        estimated_bytes,
    });
}
#[cfg(test)]
thread_local! {
    static INHERITED_PARSE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CODEX_NORMALIZATION_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static COPIED_CHILD_PARSE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CODEX_STREAM_READ_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(usize)>>> = std::cell::RefCell::new(None);
    static CODEX_INVENTORY_WALKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CODEX_USAGE_DIGEST_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CODEX_REVISION_FILE_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
pub(super) fn inventory_walks() -> usize {
    CODEX_INVENTORY_WALKS.with(std::cell::Cell::get)
}
#[cfg(test)]
pub(super) fn reader_probe_counts() -> (usize, usize) {
    (
        CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get),
        COPIED_CHILD_PARSE_COUNT.with(std::cell::Cell::get),
    )
}
pub(super) struct CodexAdapter<'a> {
    pub root: &'a Path,
    pub scope: &'a str,
}
struct CodexSourceScan {
    grouped: BTreeMap<String, Vec<SourceEntry>>,
    unresolved: Vec<PathBuf>,
}
enum CodexSourceSelection {
    Pair(DirectPair),
    Recorded(rollout_authority::RecordedRollout),
    Collision,
}
impl CodexAdapter<'_> {
    fn resolve_multiple_sources(
        &self,
        id: &str,
        entries: &[SourceEntry],
    ) -> Result<CodexSourceSelection> {
        if let Some(pair) = DirectPair::resolve(entries, id)? {
            return Ok(CodexSourceSelection::Pair(pair));
        }
        Ok(match rollout_authority::resolve(self.root, id, entries)? {
            Some(recorded) => CodexSourceSelection::Recorded(recorded),
            None => CodexSourceSelection::Collision,
        })
    }

    fn recorded_signature(
        &self,
        recorded: &rollout_authority::RecordedRollout,
        entries: &[SourceEntry],
    ) -> Result<String> {
        if recorded
            .path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            return Ok(Self::recorded_signature_from_revision(
                recorded,
                entries,
                &codex_revision_file(&recorded.path, self.scope)?,
            ));
        }
        let mut digest = Sha256::new();
        digest.update(b"codex-recorded-rollout-v1\0");
        digest.update(recorded.database.to_string_lossy().as_bytes());
        digest.update(recorded.path.to_string_lossy().as_bytes());
        let (size, bytes) = codex_usage_file_digest(&recorded.path)?;
        digest.update(size.to_le_bytes());
        digest.update(bytes);
        for entry in entries {
            let path = entry.path.to_string_lossy();
            digest.update((path.len() as u64).to_le_bytes());
            digest.update(path.as_bytes());
        }
        Ok(format!("recorded-rollout:{:x}", digest.finalize()))
    }

    fn recorded_signature_from_revision(
        recorded: &rollout_authority::RecordedRollout,
        entries: &[SourceEntry],
        revision: &str,
    ) -> String {
        let mut digest = Sha256::new();
        digest.update(b"codex-recorded-rollout-v2\0");
        digest.update(recorded.database.to_string_lossy().as_bytes());
        digest.update(recorded.path.to_string_lossy().as_bytes());
        digest.update(revision.as_bytes());
        for entry in entries {
            let path = entry.path.to_string_lossy();
            digest.update((path.len() as u64).to_le_bytes());
            digest.update(path.as_bytes());
        }
        format!("recorded-rollout:{:x}", digest.finalize())
    }

    fn source_entries(&self) -> Result<CodexSourceScan> {
        let mut grouped = BTreeMap::<String, Vec<SourceEntry>>::new();
        let mut unresolved = Vec::new();
        for path in self.codex_files()? {
            match header_entry(path.clone()) {
                Ok(Some(entry)) => grouped
                    .entry(entry.session_id.clone())
                    .or_default()
                    .push(entry),
                Ok(None) | Err(_) => unresolved.push(path),
            }
        }
        Ok(CodexSourceScan {
            grouped,
            unresolved,
        })
    }

    fn unresolved_signature(paths: &[PathBuf]) -> Result<String> {
        let mut digest = Sha256::new();
        digest.update(b"codex-unresolved-source-identity-v1\0");
        for path in paths {
            let rendered = path.to_string_lossy();
            digest.update((rendered.len() as u64).to_le_bytes());
            digest.update(rendered.as_bytes());
            match codex_usage_file_digest(path) {
                Ok((size, bytes)) => {
                    digest.update(b"readable\0");
                    digest.update(size.to_le_bytes());
                    digest.update(bytes);
                }
                Err(_) => {
                    // Identity remains unknown; direct access stays unavailable until a later scan reads the header.
                    digest.update(b"unreadable\0");
                    if let Ok(metadata) = fs::metadata(path) {
                        digest.update(metadata.len().to_le_bytes());
                        if let Ok(modified) = metadata.modified()
                            && let Ok(nanos) = modified.duration_since(std::time::UNIX_EPOCH)
                        {
                            digest.update(nanos.as_nanos().to_le_bytes());
                        }
                    }
                }
            }
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    fn unresolved_error() -> CoreError {
        CoreError::Protocol(ProtocolError::Unavailable {
            diagnostic: UNRESOLVED_SOURCE_DIAGNOSTIC.into(),
        })
    }

    fn collision_signature(entries: &[SourceEntry]) -> Result<String> {
        let mut digest = Sha256::new();
        digest.update(b"codex-multiple-source-files-unmerged-v1\0");
        for entry in entries {
            let path = entry.path.to_string_lossy();
            let (size, file_digest) = codex_usage_file_digest(&entry.path)?;
            digest.update((path.len() as u64).to_le_bytes());
            digest.update(path.as_bytes());
            digest.update(size.to_le_bytes());
            digest.update(file_digest);
        }
        Ok(format!("collision:{:x}", digest.finalize()))
    }

    fn collision_error(session_id: &str) -> CoreError {
        CoreError::Protocol(ProtocolError::Unavailable {
            diagnostic: format!("{MULTIPLE_SOURCE_DIAGNOSTIC}: codex/{session_id}"),
        })
    }

    fn codex_inventory_observation(&self) -> Result<super::InventoryObservation> {
        let mut selected = Vec::new();
        let native_titles = CodexNativeTitles::read(self.root);
        let scan = self.source_entries()?;
        let unresolved_count = scan.unresolved.len();
        let unresolved = if scan.unresolved.is_empty() {
            None
        } else {
            Some(Self::unresolved_signature(&scan.unresolved)?)
        };
        for (id, entries) in scan.grouped {
            let mut entry = entries.last().expect("grouped source entry").clone();
            if entries.len() > 1 {
                entry.signature = match self.resolve_multiple_sources(&id, &entries)? {
                    CodexSourceSelection::Pair(pair) => pair.revision(self.scope)?,
                    CodexSourceSelection::Recorded(recorded) => {
                        entry.path = recorded.path.clone();
                        self.recorded_signature(&recorded, &entries)?
                    }
                    CodexSourceSelection::Collision => Self::collision_signature(&entries)?,
                };
            }
            if let Some(unresolved) = &unresolved {
                entry.signature = format!("unresolved:{unresolved}:{}", entry.signature);
            }
            if !entry.signature.starts_with("unresolved:")
                && !entry.signature.starts_with("collision:")
            {
                entry.signature = native_titles.signature(&id, &entry.signature);
            }
            selected.push(entry);
        }
        Ok(super::InventoryObservation {
            entries: Some(selected),
            source_uncertainty: (unresolved_count > 0)
                .then_some((UNRESOLVED_SOURCE_DIAGNOSTIC, unresolved_count)),
        })
    }

    fn codex_inventory(&self) -> Result<Option<Vec<SourceEntry>>> {
        Ok(self.codex_inventory_observation()?.entries)
    }
    fn capture_selected_entry(
        &self,
        entry: &SourceEntry,
        sources: &CodexSources,
        expected_index_signature: Option<&str>,
    ) -> Result<SessionSnapshot> {
        let mut loaded = load_selected(&entry.path, self.scope, &entry.session_id, Some(sources))?;
        let captured_signature = if let Some(expected) = expected_index_signature {
            let recorded = sources
                .recorded
                .get(&entry.session_id)
                .ok_or(CoreError::SourceChanged)?;
            let entries = sources
                .recorded_entries
                .get(&entry.session_id)
                .ok_or(CoreError::SourceChanged)?;
            Some((
                expected,
                Self::recorded_signature_from_revision(recorded, entries, &loaded.revision),
            ))
        } else {
            None
        };
        resolve_spawn_children(&mut loaded, sources);
        codex_apply_child_revision(&mut loaded, sources);
        let mut snapshot = codex_snapshot_from_loaded(loaded)?;
        let native_titles = CodexNativeTitles::read(self.root);
        if let Some((expected, base)) = captured_signature
            && native_titles.signature(&entry.session_id, &base) != expected
        {
            return Err(CoreError::SourceChanged);
        }
        native_titles.apply(&mut snapshot.summary);
        self.validate_source_set_membership(sources, &entry.session_id)?;
        Ok(snapshot)
    }
    pub(crate) fn native_protocol_snapshot(&self, session_id: &str) -> Result<ObservationSnapshot> {
        let sources = self.selected_sources(Some(session_id))?;
        self.native_protocol_snapshot_with_sources(session_id, &sources)
    }
    fn native_protocol_snapshot_with_sources(
        &self,
        session_id: &str,
        sources: &CodexSources,
    ) -> Result<ObservationSnapshot> {
        self.native_protocol_snapshot_with_sources_and_identities(session_id, sources, None)
    }
    fn native_protocol_snapshot_with_sources_and_identities(
        &self,
        session_id: &str,
        sources: &CodexSources,
        child_identities: Option<&SelectedChildIdentities>,
    ) -> Result<ObservationSnapshot> {
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        let mut bundle = codex_protocol_bundle_with_sources_and_identities(
            path,
            self.scope,
            session_id,
            Some(sources),
            child_identities,
        )?;
        let memory = super::codex_memory::read_metadata(self.root, session_id);
        bundle.set_context_artifacts(memory.artifacts, memory.source_state);
        let observations = bundle.into_observations();
        self.validate_source_set_membership(sources, session_id)?;
        Ok(observations)
    }
    fn codex_files(&self) -> Result<Vec<PathBuf>> {
        #[cfg(test)]
        CODEX_INVENTORY_WALKS.with(|walks| walks.set(walks.get() + 1));
        let mut files = Vec::new();
        for directory in ["sessions", "archived_sessions"] {
            let root = self.root.join(directory);
            match fs::metadata(&root) {
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    return Err(CoreError::Parse {
                        path: root,
                        reason: "Codex transcript root is not a directory".into(),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(source) => return Err(CoreError::Io { path: root, source }),
            }
            for entry in WalkDir::new(&root) {
                let entry = entry.map_err(|error| CoreError::Parse {
                    path: root.clone(),
                    reason: error.to_string(),
                })?;
                if entry.file_type().is_file()
                    && is_codex_file(entry.path())
                    && !(is_compressed(entry.path()) && entry.path().with_extension("").exists())
                {
                    files.push(entry.into_path());
                }
            }
        }
        files.sort();
        Ok(files)
    }

    fn selected_sources(&self, target: Option<&str>) -> Result<CodexSources> {
        let scan = self.source_entries()?;
        if !scan.unresolved.is_empty() {
            return Err(Self::unresolved_error());
        }
        let mut selected = CodexSources::default();
        for (id, entries) in scan.grouped {
            if entries.len() > 1 {
                // Supported pairs are roots, so an unrelated pair cannot be
                // needed to verify this session's direct child identities.
                if target.is_some_and(|target| target != id) {
                    continue;
                }
                match self.resolve_multiple_sources(&id, &entries)? {
                    CodexSourceSelection::Pair(pair) => {
                        selected.paths.insert(id.clone(), pair.first.clone());
                        selected.pairs.insert(id, pair);
                    }
                    CodexSourceSelection::Recorded(recorded) => {
                        selected.paths.insert(id.clone(), recorded.path.clone());
                        selected.recorded_entries.insert(id.clone(), entries);
                        selected.recorded.insert(id, recorded);
                    }
                    CodexSourceSelection::Collision if target == Some(id.as_str()) => {
                        return Err(Self::collision_error(&id));
                    }
                    CodexSourceSelection::Collision => {}
                }
            } else {
                selected.paths.insert(id, entries[0].path.clone());
            }
        }
        Ok(selected)
    }
    fn reader_sources(&self) -> Result<CodexSources> {
        self.selected_sources(None)
    }

    fn validate_source_set_membership(&self, sources: &CodexSources, id: &str) -> Result<()> {
        if let Some(recorded) = sources.recorded.get(id) {
            #[cfg(test)]
            source_set::before_pair_publication();
            let scan = self.source_entries()?;
            if !scan.unresolved.is_empty() {
                return Err(CoreError::SourceChanged);
            }
            let entries = scan.grouped.get(id).ok_or(CoreError::SourceChanged)?;
            if !matches!(self.resolve_multiple_sources(id, entries)?, CodexSourceSelection::Recorded(current) if &current == recorded)
            {
                return Err(CoreError::SourceChanged);
            }
            return Ok(());
        }
        let Some(pair) = sources.pairs.get(id) else {
            return Ok(());
        };
        #[cfg(test)]
        source_set::before_pair_publication();
        let scan = self.source_entries()?;
        if !scan.unresolved.is_empty() {
            return Err(CoreError::SourceChanged);
        }
        let entries = scan.grouped.get(id).ok_or(CoreError::SourceChanged)?;
        if entries.len() != 2
            || !entries.iter().any(|entry| entry.path == pair.first)
            || !entries.iter().any(|entry| entry.path == pair.later)
        {
            return Err(CoreError::SourceChanged);
        }
        Ok(())
    }
}
struct CodexStatsBatch<'a, 'b> {
    adapter: &'a CodexAdapter<'b>,
    sources: CodexSources,
    collisions: HashSet<String>,
    child_identities: SelectedChildIdentities,
    source_revision: String,
}
impl StatsObservationBatch for CodexStatsBatch<'_, '_> {
    fn observations(&self, session_id: &str) -> Result<ObservationSnapshot> {
        if self.collisions.contains(session_id) {
            return Err(CodexAdapter::collision_error(session_id));
        }
        self.adapter
            .native_protocol_snapshot_with_sources_and_identities(
                session_id,
                &self.sources,
                Some(&self.child_identities),
            )
    }
    fn validate_source_revision(&self) -> Result<()> {
        if self.adapter.stats_usage_source_revision()?.as_deref() != Some(&self.source_revision) {
            return Err(CoreError::SourceChanged);
        }
        Ok(())
    }
}
fn codex_usage_source_revision(sources: &BTreeMap<String, PathBuf>) -> Result<String> {
    let workers = std::thread::available_parallelism()
        .map_or(1, std::num::NonZeroUsize::get)
        .min(4);
    codex_usage_source_revision_with_workers(sources, workers)
}

fn codex_usage_file_digest(path: &Path) -> Result<(u64, [u8; 32])> {
    #[cfg(test)]
    CODEX_USAGE_DIGEST_READS.with(|count| count.set(count.get() + 1));
    let mut file = fs::File::open(path).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let count = file.read(&mut buffer).map_err(|source| CoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        size += count as u64;
    }
    Ok((size, digest.finalize().into()))
}

fn codex_usage_source_revision_with_workers(
    sources: &BTreeMap<String, PathBuf>,
    worker_limit: usize,
) -> Result<String> {
    codex_usage_source_revision_with_workers_using(sources, worker_limit, &codex_usage_file_digest)
}

fn codex_usage_source_revision_with_workers_using<F>(
    sources: &BTreeMap<String, PathBuf>,
    worker_limit: usize,
    digest_file: &F,
) -> Result<String>
where
    F: Fn(&Path) -> Result<(u64, [u8; 32])> + Sync,
{
    let selected: Vec<_> = sources.iter().collect();
    let next = AtomicUsize::new(0);
    let first_error = AtomicUsize::new(usize::MAX);
    let mut file_digests = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..worker_limit.max(1).min(selected.len()))
            .map(|_| {
                scope.spawn(|| {
                    let mut completed = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        if index > first_error.load(Ordering::Acquire) {
                            break;
                        }
                        let Some((_, path)) = selected.get(index) else {
                            break;
                        };
                        let result = digest_file(path);
                        if result.is_err() {
                            first_error.fetch_min(index, Ordering::AcqRel);
                        }
                        completed.push((index, result));
                    }
                    completed
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().expect("Codex digest worker panicked"))
            .collect::<Vec<_>>()
    });
    file_digests.sort_by_key(|(index, _)| *index);
    let mut digest = Sha256::new();
    digest.update(b"codex-stats-usage-source-v10\0");
    for ((id, path), (_, file_digest)) in selected.into_iter().zip(file_digests) {
        let path_bytes = path.to_string_lossy();
        digest.update((id.len() as u64).to_le_bytes());
        digest.update(id.as_bytes());
        digest.update((path_bytes.len() as u64).to_le_bytes());
        digest.update(path_bytes.as_bytes());
        let (size, file_digest) = file_digest?;
        digest.update(file_digest);
        digest.update(size.to_le_bytes());
    }
    Ok(format!("{:x}", digest.finalize()))
}
#[derive(Default)]
struct CodexNativeTitles {
    titles: BTreeMap<String, (i64, String)>,
    diagnostic: Option<&'static str>,
}
impl CodexNativeTitles {
    fn read(root: &Path) -> Self {
        let path = root.join("session_index.jsonl");
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(_) => {
                return Self {
                    diagnostic: Some("codex_native_title_index_read_failed"),
                    ..Self::default()
                };
            }
        };
        let mut result = Self::default();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let row = serde_json::from_str::<Value>(line).ok();
            let valid = row.as_ref().and_then(|row| {
                Some((
                    nonempty(&row["id"])?,
                    nonempty(&row["thread_name"])?,
                    timestamp_ms(row["updated_at"].as_str()?)?,
                ))
            });
            let Some((id, title, updated_at)) = valid else {
                result.diagnostic = Some("codex_native_title_index_invalid");
                continue;
            };
            if result
                .titles
                .get(&id)
                .is_none_or(|(current, _)| updated_at >= *current)
            {
                result.titles.insert(id, (updated_at, title));
            }
        }
        result
    }
    fn stamp(&self, id: &str) -> String {
        let mut hash = Sha256::new();
        hash.update(b"codex-native-title-v1\0");
        if let Some((time, title)) = self.titles.get(id) {
            hash.update(time.to_le_bytes());
            hash.update(title.as_bytes());
        }
        hash.update(self.diagnostic.unwrap_or("valid").as_bytes());
        format!("{:x}", hash.finalize())
    }
    fn signature(&self, id: &str, base: &str) -> String {
        if !self.titles.contains_key(id) && self.diagnostic.is_none() {
            return base.into();
        }
        let mut hash = Sha256::new();
        hash.update(base.as_bytes());
        hash.update(self.stamp(id).as_bytes());
        let prefix = if base.starts_with("source-set:") {
            "source-set:"
        } else if base.starts_with("recorded-rollout:") {
            "recorded-rollout:"
        } else {
            ""
        };
        format!("{prefix}{:x}", hash.finalize())
    }
    fn apply(&self, summary: &mut SessionSummary) {
        if summary.diagnostic.is_none()
            && let Some((_, title)) = self.titles.get(&summary.session.session_id)
        {
            summary.title = title.clone();
            summary.search_title = Some(title.clone());
        }
    }
}

impl ProviderAdapter for CodexAdapter<'_> {
    fn storage_diagnostic(&self) -> Option<Value> {
        let mut diagnostic = match self.source_entries() {
            Ok(scan) if !scan.unresolved.is_empty() => Some(serde_json::json!({
                "code": UNRESOLVED_SOURCE_DIAGNOSTIC,
                "unresolvedFileCount": scan.unresolved.len(),
                "sourceDiagnostics": [{
                    "code": UNRESOLVED_SOURCE_DIAGNOSTIC,
                    "affectedSources": scan.unresolved.len()
                }],
                "note": "Codex source identity is unreadable in one or more files; session history is unavailable."
            })),
            Ok(scan) => {
                let mut affected = 0;
                for (id, entries) in &scan.grouped {
                    if entries.len() <= 1 {
                        continue;
                    }
                    match self.resolve_multiple_sources(id, entries) {
                        Ok(CodexSourceSelection::Pair(_) | CodexSourceSelection::Recorded(_)) => {}
                        Ok(CodexSourceSelection::Collision) => affected += 1,
                        Err(_) => {
                            return Some(serde_json::json!({
                                "code": "codex_source_set_read_failed",
                                "note": "A Codex source set could not be read; its merge status is unavailable."
                            }));
                        }
                    }
                }
                (affected > 0).then(|| serde_json::json!({
                    "code": MULTIPLE_SOURCE_DIAGNOSTIC,
                    "sourceDiagnostics": [{
                        "code": MULTIPLE_SOURCE_DIAGNOSTIC,
                        "affectedSessions": affected
                    }],
                    "note": "Some Codex sessions have multiple unmerged source files; their history is unavailable."
                }))
            }
            Err(_) => Some(serde_json::json!({
                "code": "codex_source_inventory_read_failed",
                "note": "The Codex source inventory could not be read."
            })),
        };
        if let Some(code) = CodexNativeTitles::read(self.root).diagnostic {
            let value = diagnostic.get_or_insert_with(|| serde_json::json!({
                "code":code, "sourceDiagnostics":[],
                "note":"Some native Codex titles could not be read; affected sessions use their recorded request title."
            }));
            if let Some(object) = value.as_object_mut() {
                object.entry("sourceDiagnostics").or_insert_with(|| serde_json::json!([]))
                    .as_array_mut().unwrap().push(serde_json::json!({"code":code,"sourcePath":self.root.join("session_index.jsonl")}));
            }
        }
        diagnostic
    }
    fn source_uncertainty(&self) -> Result<Option<(&'static str, usize)>> {
        let count = self.source_entries()?.unresolved.len();
        Ok((count > 0).then_some((UNRESOLVED_SOURCE_DIAGNOSTIC, count)))
    }
    fn stats_usage_source_revision(&self) -> Result<Option<String>> {
        let scan = self.source_entries()?;
        if !scan.unresolved.is_empty() {
            return Err(Self::unresolved_error());
        }
        let mut digest = Sha256::new();
        digest.update(b"codex-stats-recorded-rollout-v1\0");
        for (id, entries) in &scan.grouped {
            if entries.len() > 1
                && let CodexSourceSelection::Recorded(recorded) =
                    self.resolve_multiple_sources(id, entries)?
            {
                digest.update((id.len() as u64).to_le_bytes());
                digest.update(id.as_bytes());
                digest.update(recorded.database.to_string_lossy().as_bytes());
                digest.update(recorded.path.to_string_lossy().as_bytes());
            }
        }
        let sources = scan
            .grouped
            .into_values()
            .flatten()
            .map(|entry| (entry.path.to_string_lossy().into_owned(), entry.path))
            .collect();
        digest.update(codex_usage_source_revision(&sources)?.as_bytes());
        Ok(Some(format!("{:x}", digest.finalize())))
    }
    fn stats_observation_batch(
        &self,
        source_revision: Option<&str>,
    ) -> Result<Option<Box<dyn StatsObservationBatch + '_>>> {
        let scan = self.source_entries()?;
        if !scan.unresolved.is_empty() {
            return Err(Self::unresolved_error());
        }
        let mut collisions = HashSet::new();
        let mut sources = CodexSources::default();
        for (id, entries) in scan.grouped {
            if entries.len() == 1 {
                sources.paths.insert(id, entries[0].path.clone());
            } else {
                match self.resolve_multiple_sources(&id, &entries)? {
                    CodexSourceSelection::Pair(pair) => {
                        sources.paths.insert(id.clone(), pair.first.clone());
                        sources.pairs.insert(id, pair);
                    }
                    CodexSourceSelection::Recorded(recorded) => {
                        sources.paths.insert(id.clone(), recorded.path.clone());
                        sources.recorded.insert(id, recorded);
                    }
                    CodexSourceSelection::Collision => {
                        collisions.insert(id);
                    }
                }
            }
        }
        let source_revision = match source_revision {
            Some(revision) => revision.to_owned(),
            None => self
                .stats_usage_source_revision()?
                .expect("Codex source revision"),
        };
        let child_identities = selected_child_identities(&sources);
        Ok(Some(Box::new(CodexStatsBatch {
            adapter: self,
            sources,
            collisions,
            child_identities,
            source_revision,
        })))
    }
    fn memory_artifacts(&self, session_id: &str) -> Result<super::MemoryArtifacts> {
        Ok(super::codex_memory::read_metadata(self.root, session_id))
    }

    fn memory_content(
        &self,
        session_id: &str,
        id: &str,
        revision: &str,
        offset: usize,
        max_chars: usize,
    ) -> Result<super::MemoryContent> {
        super::codex_memory::read_content(self.root, session_id, id, revision, offset, max_chars)
    }
    fn resume_command(&self) -> Option<crate::DefaultResumeCommand> {
        Some(crate::DefaultResumeCommand {
            command: crate::ResumeCommandSpec {
                executable: "codex".into(),
                args: vec!["resume".into(), "{sessionId}".into()],
                cwd: None,
            },
            npm: None,
        })
    }

    fn resume_directory(&self, session_id: &str) -> Result<Option<String>> {
        let sources = self.selected_sources(Some(session_id))?;
        if sources.pairs.contains_key(session_id) {
            return Ok(self.load(session_id)?.summary.directory);
        }
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        let (id, directory, _) = read_header(path)?.ok_or(CoreError::SourceChanged)?;
        if id != session_id {
            return Err(CoreError::SourceChanged);
        }
        // Resume consumes only canonical header metadata. Body appends do not
        // affect it; reselect and reread those facts rather than hash the body.
        let current = self.selected_sources(Some(session_id))?;
        if current.get(session_id) != Some(path) || current.pairs.contains_key(session_id) {
            return Err(CoreError::SourceChanged);
        }
        let (current_id, current_directory, _) =
            read_header(path)?.ok_or(CoreError::SourceChanged)?;
        if current_id != id || current_directory != directory {
            return Err(CoreError::SourceChanged);
        }
        Ok(directory)
    }

    fn available(&self) -> bool {
        self.root.join("sessions").is_dir() || self.root.join("archived_sessions").is_dir()
    }

    fn protocol_capabilities(&self) -> super::ProtocolCapabilities {
        super::protocol_capability_map(&[
            ("sessionEvents", "recorded"),
            ("sessionRelationships", "mixed"),
            ("tasks", "recorded"),
            ("agentRuns", "recorded"),
            ("contextArtifacts", "recorded"),
        ])
    }
    fn unavailable_diagnostic(&self) -> &'static str {
        "Codex source directory is unavailable"
    }
    fn list(&self) -> Result<Vec<SessionSummary>> {
        let mut rows = Vec::new();
        let scan = self.source_entries()?;
        let incomplete = !scan.unresolved.is_empty();
        for (id, entries) in scan.grouped {
            if incomplete {
                rows.push(
                    unavailable_snapshot(&id, "unindexed", UNRESOLVED_SOURCE_DIAGNOSTIC, &[])
                        .summary,
                );
                continue;
            }
            if entries.len() > 1 {
                match self.resolve_multiple_sources(&id, &entries)? {
                    CodexSourceSelection::Pair(pair) => {
                        rows.push(summarize(&pair.load(self.scope, &id)?))
                    }
                    CodexSourceSelection::Recorded(_) => {
                        let sources = self.selected_sources(Some(&id))?;
                        let path = sources.get(&id).ok_or(CoreError::SourceChanged)?;
                        let loaded = load_selected(path, self.scope, &id, Some(&sources))?;
                        self.validate_source_set_membership(&sources, &id)?;
                        rows.push(summarize(&loaded));
                    }
                    CodexSourceSelection::Collision => {
                        rows.push(collision_snapshot(&id, "unindexed", &entries).summary)
                    }
                }
                continue;
            }
            let path = &entries[0].path;
            // Isolate corrupt individual provider files, preserving existing behavior.
            if let Ok(session) = load_codex(&path, self.scope, &id) {
                rows.push(summarize(&session));
            }
        }
        let native_titles = CodexNativeTitles::read(self.root);
        for row in &mut rows {
            native_titles.apply(row);
        }
        Ok(rows)
    }
    fn load(&self, session_id: &str) -> Result<SessionSnapshot> {
        let sources = self.selected_sources(Some(session_id))?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        let mut loaded = load_selected(path, self.scope, session_id, Some(&sources))?;
        resolve_spawn_children(&mut loaded, &sources);
        codex_apply_child_revision(&mut loaded, &sources);
        let mut snapshot = codex_snapshot_from_loaded(loaded)?;
        CodexNativeTitles::read(self.root).apply(&mut snapshot.summary);
        self.validate_source_set_membership(&sources, session_id)?;
        Ok(snapshot)
    }
    fn system_prompt_evidence(&self, session_id: &str) -> Result<crate::SystemPromptEvidence> {
        let sources = self.selected_sources(Some(session_id))?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        let loaded = load_selected(path, self.scope, session_id, Some(&sources))?;
        let summary = summarize(&loaded);
        let owned_boundary = loaded.owned_boundary_line;
        let is_child = loaded.parent_id.is_some();
        let mut evidence = crate::SystemPromptEvidence::new(&summary, "codex-resolved");
        let pair = sources.pairs.get(session_id);
        let mut reader: Box<dyn BufRead> = match pair {
            Some(pair) => Box::new(std::io::Cursor::new(pair.active_bytes(session_id)?)),
            None => open_codex_reader(path)?,
        };
        let mut line = Vec::new();
        let mut line_number = 0usize;
        while reader
            .read_until(b'\n', &mut line)
            .map_err(|source| codex_line_error(path, source))?
            > 0
        {
            line_number += 1;
            let source_line = pair.map_or_else(
                || format!("{}#L{line_number}", path.display()),
                |pair| pair.source_line(line_number - 1),
            );
            if let Ok(row) = serde_json::from_slice::<Value>(&line) {
                let payload = &row["payload"];
                if row["type"] == "session_meta" && payload["id"] == session_id {
                    if let Some(content) = payload["base_instructions"]["text"].as_str() {
                        evidence.recorded_with_metadata(
                            "Recorded Codex base instructions",
                            content.into(),
                            format!("{source_line}:base_instructions"),
                            row["timestamp"]
                                .as_str()
                                .and_then(timestamp_ms)
                                .unwrap_or(0)
                                .max(0) as u64,
                            payload["base_instructions"]["provenance"]
                                .as_object()
                                .map(|_| payload["base_instructions"]["provenance"].clone()),
                        );
                    }
                }
                if (!is_child || owned_boundary.is_some_and(|boundary| line_number - 1 >= boundary))
                    && row["type"] == "response_item"
                    && payload["type"] == "message"
                {
                    let role = payload["role"].as_str().unwrap_or("");
                    if matches!(role, "system" | "developer") {
                        evidence.recorded(
                            &format!("Recorded {role} message"),
                            text_parts(&payload["content"]),
                            source_line,
                            row["timestamp"]
                                .as_str()
                                .and_then(timestamp_ms)
                                .unwrap_or(0)
                                .max(0) as u64,
                        );
                    }
                }
            }
            line.clear();
        }
        if is_child && owned_boundary.is_none() {
            evidence.diagnostics.push(crate::system_prompts::PromptDiagnostic {
                code: "child_prompt_ownership_unavailable",
                message: "This child source has no owned-message boundary; inherited prompt rows are not attributed to the child.".into(),
                source: Some(path.to_string_lossy().into_owned()),
            });
        }
        let revision = match pair {
            Some(pair) => pair.revision(self.scope)?,
            None => codex_revision_file(path, self.scope)?,
        };
        if revision != loaded.revision {
            return Err(CoreError::SourceChanged);
        }
        evidence.current_files(&summary, &["AGENTS.md"]);
        self.validate_source_set_membership(&sources, session_id)?;
        Ok(evidence)
    }
    fn reader_snapshot_navigation(&self) -> bool {
        true
    }
    fn reader_revision(&self, session_id: &str) -> Result<Option<super::ReaderStamp>> {
        let sources = self.selected_sources(Some(session_id))?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        if let Some(pair) = sources.pairs.get(session_id) {
            let child_dependencies = codex_child_dependencies(&sources, session_id);
            let dependencies = format!(
                "{}:native-title:{}",
                child_dependencies,
                CodexNativeTitles::read(self.root).stamp(session_id)
            );
            let stamp = super::ReaderStamp {
                revision: codex_revision_with_dependencies(
                    &pair.revision(self.scope)?,
                    &child_dependencies,
                ),
                dependencies,
            };
            self.validate_source_set_membership(&sources, session_id)?;
            return Ok(Some(stamp));
        }
        let (file, length) = if path.to_string_lossy().ends_with(".zst") {
            let file = fs::File::open(path).map_err(|source| codex_line_error(path, source))?;
            let length = file
                .metadata()
                .map_err(|source| codex_line_error(path, source))?
                .len();
            (file, length)
        } else {
            open_codex_complete_prefix(path)?
        };
        let mut file = file.take(length);
        let mut hasher = Sha256::new();
        hasher.update(CODEX_REVISION_NAMESPACE);
        hasher.update(self.scope.as_bytes());
        hasher.update(path.to_string_lossy().as_bytes());
        std::io::copy(&mut file, &mut hasher).map_err(|source| CoreError::Io {
            path: path.clone(),
            source,
        })?;
        let dependencies = codex_child_dependencies(&sources, session_id);

        let parent_revision = format!("{:x}", hasher.finalize());
        let mut stamp = super::ReaderStamp {
            revision: codex_revision_with_dependencies(&parent_revision, &dependencies),
            dependencies: format!(
                "{}:native-title:{}",
                dependencies,
                CodexNativeTitles::read(self.root).stamp(session_id)
            ),
        };
        if let Some(recorded) = sources.recorded.get(session_id) {
            stamp.dependencies.push_str(&format!(
                ":recorded-rollout:{}",
                recorded.database.display()
            ));
            self.validate_source_set_membership(&sources, session_id)?;
        }
        Ok(Some(stamp))
    }
    fn list_stats_revision(&self, session_id: &str) -> Result<Option<super::ReaderStamp>> {
        let Some(mut stamp) = self.reader_revision(session_id)? else {
            return Ok(None);
        };
        let memory = super::codex_memory::read_metadata(self.root, session_id);
        stamp.dependencies = format!(
            "codex-list-stats-v2:{}:{}",
            stamp.dependencies, memory.revision
        );
        Ok(Some(stamp))
    }
    fn reader_load(&self, session_id: &str) -> Result<SessionSnapshot> {
        let sources = self.selected_sources(Some(session_id))?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        let mut loaded = load_selected(path, self.scope, session_id, Some(&sources))?;
        resolve_spawn_children(&mut loaded, &sources);
        codex_apply_child_revision(&mut loaded, &sources);
        let mut snapshot = codex_snapshot_from_loaded(loaded)?;
        CodexNativeTitles::read(self.root).apply(&mut snapshot.summary);
        self.validate_source_set_membership(&sources, session_id)?;
        Ok(snapshot)
    }
    fn reader_capture(&self, session_id: &str) -> Result<super::ReaderCapture> {
        let sources = self.selected_sources(Some(session_id))?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        let bounded =
            !sources.pairs.contains_key(session_id) && !path.to_string_lossy().ends_with(".zst");
        let before_dependencies = bounded.then(|| codex_child_dependencies(&sources, session_id));
        let (mut loaded, prefix) = if bounded {
            let (loaded, bytes) = load_codex_reader_prefix(path, self.scope, session_id)?;
            (loaded, Some(bytes))
        } else {
            (
                load_selected(path, self.scope, session_id, Some(&sources))?,
                None,
            )
        };
        if bounded && sources.recorded.contains_key(session_id) {
            source_set::mark_recorded_rollout(&mut loaded);
        }
        let parent_revision = loaded.revision.clone();
        resolve_spawn_children(&mut loaded, &sources);
        if let Some(dependencies) = &before_dependencies {
            loaded.revision = codex_revision_with_dependencies(&loaded.revision, dependencies);
        } else {
            codex_apply_child_revision(&mut loaded, &sources);
        }
        let stream = if !loaded.ownership_unavailable && loaded.protocol_parse_errors.is_empty() {
            finalize_events(
                SessionRef {
                    provider: "codex".into(),
                    session_id: session_id.into(),
                },
                self.scope.into(),
                loaded.revision.clone(),
                std::mem::take(&mut loaded.protocol_candidates),
            )
            .ok()
        } else {
            None
        };
        let mut capture = super::ReaderCapture {
            stamp: None,
            parent_facts: None,
            snapshot: codex_snapshot_from_loaded(loaded)?,
            protocol_stream: Some(stream),
        };
        let titles = CodexNativeTitles::read(self.root);
        titles.apply(&mut capture.snapshot.summary);
        if let Some(prefix) = prefix {
            let mut parents = HashMap::new();
            for entry in &capture.snapshot.relations {
                if let RelationEntry::Coordination { observation } = entry
                    && let Some(child) = &observation.to_session_ref
                    && child.provider == "codex"
                {
                    parents.entry(child.clone()).or_insert_with(|| {
                        sources.get(&child.session_id).and_then(|path| {
                            reader_parent_fact_from_path(path, &child.session_id).ok()
                        })
                    });
                }
            }
            let current = self.selected_sources(Some(session_id))?;
            if current.get(session_id) != Some(path) || current.pairs.contains_key(session_id) {
                return Err(CoreError::SourceChanged);
            }
            let dependencies = codex_child_dependencies(&current, session_id);
            if before_dependencies.as_deref() != Some(&dependencies) {
                return Err(CoreError::SourceChanged);
            }
            if codex_prefix_revision(path, self.scope, prefix)? != parent_revision {
                return Err(CoreError::SourceChanged);
            }
            self.validate_source_set_membership(&sources, session_id)?;
            let mut dependencies =
                format!("{}:native-title:{}", dependencies, titles.stamp(session_id));
            if let Some(recorded) = sources.recorded.get(session_id) {
                dependencies.push_str(&format!(
                    ":recorded-rollout:{}",
                    recorded.database.display()
                ));
            }
            capture.stamp = Some(super::ReaderStamp {
                revision: capture.snapshot.revision.clone(),
                dependencies,
            });
            capture.parent_facts = Some(parents);
        } else {
            self.validate_source_set_membership(&sources, session_id)?;
        }
        Ok(capture)
    }
    fn reader_parent_fact(&self, session_id: &str) -> Result<Option<SessionRef>> {
        let sources = self.selected_sources(Some(session_id))?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        let parent = reader_parent_fact_from_path(path, session_id)?;
        self.validate_source_set_membership(&sources, session_id)?;
        Ok(parent)
    }
    fn reader_parent_facts(&self, ids: &[String]) -> BTreeMap<String, Option<Option<SessionRef>>> {
        let Ok(sources) = self.reader_sources() else {
            return ids.iter().map(|id| (id.clone(), None)).collect();
        };
        ids.iter()
            .map(|id| {
                let fact = sources
                    .get(id)
                    .ok_or_else(|| CoreError::NotFound {
                        provider: "codex".into(),
                        session_id: id.clone(),
                    })
                    .and_then(|path| reader_parent_fact_from_path(path, id))
                    .ok();
                (id.clone(), fact)
            })
            .collect()
    }
    fn inherited_context(&self, session_id: &str) -> Result<Option<InheritedContextSnapshot>> {
        let sources = self.selected_sources(Some(session_id))?;
        if sources.pairs.contains_key(session_id) {
            return Ok(None);
        }
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        if reader_parent_fact_from_path(path, session_id)?.is_none() {
            self.validate_source_set_membership(&sources, session_id)?;
            return Ok(None);
        }
        let source_bytes = fs::read(path).map_err(|source| CoreError::Io {
            path: path.into(),
            source,
        })?;
        let revision = codex_revision_with_dependencies(
            &codex_revision(path, self.scope, &source_bytes),
            &codex_child_dependencies(&sources, session_id),
        );
        let key = InheritedCacheKey {
            path: path.clone(),
            scope: self.scope.into(),
            session_id: session_id.into(),
            source_sha256: format!("{:x}", Sha256::digest(&source_bytes)),
            parser_version: INHERITED_PARSER_VERSION,
        };
        if let Some(mut snapshot) = inherited_cache_get(&key) {
            snapshot.revision = revision;
            return Ok(Some(snapshot));
        }
        let source_len = source_bytes.len();
        let loaded = load_codex_bytes(path, session_id, source_bytes, revision)?;
        let Some(parent_id) = loaded.parent_id else {
            return Ok(None);
        };
        if loaded.owned_boundary_line.is_none() {
            return Ok(None);
        }
        let snapshot = InheritedContextSnapshot {
            revision: loaded.revision,
            source_session: Some(SessionRef {
                provider: "codex".into(),
                session_id: parent_id,
            }),
            events: loaded.inherited_events.into(),
        };
        inherited_cache_put(key, &snapshot, source_len);
        Ok(Some(snapshot))
    }
    fn protocol_event_stream(&self, session_id: &str) -> Result<EventStream> {
        let sources = self.selected_sources(Some(session_id))?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        let stream =
            codex_protocol_stream_with_sources(path, self.scope, session_id, Some(&sources))?;
        self.validate_source_set_membership(&sources, session_id)?;
        Ok(stream)
    }
    fn protocol_observations(&self, session_id: &str) -> Result<ObservationSnapshot> {
        self.native_protocol_snapshot(session_id)
    }
    fn protocol_bundle(&self, session_id: &str) -> Result<ProtocolBundle> {
        let sources = self.selected_sources(Some(session_id))?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: "codex".into(),
            session_id: session_id.into(),
        })?;
        let mut bundle =
            codex_protocol_bundle_with_sources(path, self.scope, session_id, Some(&sources))?;
        let memory = super::codex_memory::read_metadata(self.root, session_id);
        bundle.set_context_artifacts(memory.artifacts, memory.source_state);
        self.validate_source_set_membership(&sources, session_id)?;
        Ok(bundle)
    }
    fn supports_index(&self) -> bool {
        true
    }
    fn inventory(&self) -> Result<Option<Vec<SourceEntry>>> {
        self.codex_inventory()
    }
    fn inventory_for_rebuild(&self) -> Result<Option<Vec<SourceEntry>>> {
        self.codex_inventory()
    }
    fn inventory_observation(&self, _rebuild: bool) -> Result<super::InventoryObservation> {
        self.codex_inventory_observation()
    }
    fn capture(&self, entry: &SourceEntry) -> Result<SessionSnapshot> {
        if entry.signature.starts_with("unresolved:") {
            return Ok(unavailable_snapshot(
                &entry.session_id,
                &entry.signature,
                UNRESOLVED_SOURCE_DIAGNOSTIC,
                &[],
            ));
        }
        if entry.signature.starts_with("collision:") {
            let scan = self.source_entries()?;
            let entries = scan
                .grouped
                .get(&entry.session_id)
                .filter(|entries| entries.len() > 1)
                .ok_or(CoreError::SourceChanged)?;
            return Ok(collision_snapshot(
                &entry.session_id,
                &entry.signature,
                entries,
            ));
        }
        if entry.signature.starts_with("source-set:")
            || entry.signature.starts_with("recorded-rollout:")
        {
            let sources = self.selected_sources(Some(&entry.session_id))?;
            if self.source_signature(entry)? != entry.signature {
                return Err(CoreError::SourceChanged);
            }
            return self.capture_selected_entry(entry, &sources, None);
        }
        let mut snapshot = match codex_snapshot(&entry.path, self.scope, &entry.session_id) {
            Ok(snapshot) => snapshot,
            Err(CoreError::Protocol(ProtocolError::Unavailable { diagnostic }))
                if diagnostic.starts_with("child_ownership_boundary_unavailable:") =>
            {
                // A copied-parent child without a recorded NEW_TASK boundary
                // stays visible in the catalog with its diagnostic instead of
                // failing the whole provider publication.
                return Ok(unavailable_snapshot(
                    &entry.session_id,
                    &entry.signature,
                    CHILD_OWNERSHIP_BOUNDARY_DIAGNOSTIC,
                    &[],
                ));
            }
            Err(error) => return Err(error),
        };
        CodexNativeTitles::read(self.root).apply(&mut snapshot.summary);
        Ok(snapshot)
    }
    fn capture_for_index(&self, entry: &SourceEntry) -> Result<SessionSnapshot> {
        if entry.signature.starts_with("recorded-rollout:")
            && entry
                .path
                .extension()
                .is_some_and(|extension| extension == "jsonl")
        {
            // Bind the parser's exact-byte revision to the incoming authority,
            // membership and native title. Final inventory validates publication
            // without accepting a different captured generation after ABA restore.
            let sources = self.selected_sources(Some(&entry.session_id))?;
            if sources.get(&entry.session_id) != Some(&entry.path) {
                return Err(CoreError::SourceChanged);
            }
            return self.capture_selected_entry(entry, &sources, Some(&entry.signature));
        }
        let snapshot = self.capture(entry)?;
        if self.source_signature(entry)? != entry.signature {
            return Err(CoreError::SourceChanged);
        }
        Ok(snapshot)
    }
    fn index_capture_revision(&self, entry: &SourceEntry) -> Result<Option<String>> {
        if entry
            .path
            .extension()
            .is_none_or(|extension| extension != "jsonl")
            || entry.signature.starts_with("unresolved:")
            || entry.signature.starts_with("collision:")
            || entry.signature.starts_with("source-set:")
        {
            return Ok(None);
        }
        codex_revision_file(&entry.path, self.scope).map(Some)
    }
    fn source_signature(&self, entry: &SourceEntry) -> Result<String> {
        if entry.signature.starts_with("unresolved:") {
            return Ok(entry.signature.clone());
        }
        if entry.signature.starts_with("source-set:") {
            let scan = self.source_entries()?;
            let entries = scan
                .grouped
                .get(&entry.session_id)
                .ok_or(CoreError::SourceChanged)?;
            let base = DirectPair::resolve(entries, &entry.session_id)?
                .ok_or(CoreError::SourceChanged)?
                .revision(self.scope)?;
            return Ok(CodexNativeTitles::read(self.root).signature(&entry.session_id, &base));
        }
        if entry.signature.starts_with("recorded-rollout:") {
            let scan = self.source_entries()?;
            let entries = scan
                .grouped
                .get(&entry.session_id)
                .ok_or(CoreError::SourceChanged)?;
            let CodexSourceSelection::Recorded(recorded) =
                self.resolve_multiple_sources(&entry.session_id, entries)?
            else {
                return Err(CoreError::SourceChanged);
            };
            let base = self.recorded_signature(&recorded, entries)?;
            return Ok(CodexNativeTitles::read(self.root).signature(&entry.session_id, &base));
        }
        if !entry.signature.starts_with("collision:") {
            return SourceEntry::new(entry.session_id.clone(), entry.path.clone()).map(|source| {
                CodexNativeTitles::read(self.root).signature(&entry.session_id, &source.signature)
            });
        }
        let scan = self.source_entries()?;
        let entries = scan
            .grouped
            .get(&entry.session_id)
            .ok_or(CoreError::SourceChanged)?;
        if entries.len() > 1 {
            Self::collision_signature(entries)
        } else {
            Err(CoreError::SourceChanged)
        }
    }
    fn validate_inventory(&self, incoming: &BTreeMap<String, SourceEntry>) -> Result<()> {
        let current = self
            .codex_inventory()?
            .expect("Codex inventory is always available")
            .into_iter()
            .map(|entry| (entry.session_id, entry.signature))
            .collect::<BTreeMap<_, _>>();
        if current.len() != incoming.len()
            || incoming
                .iter()
                .any(|(id, entry)| current.get(id) != Some(&entry.signature))
        {
            return Err(CoreError::SourceChanged);
        }
        Ok(())
    }
}

fn collision_snapshot(
    session_id: &str,
    revision: &str,
    entries: &[SourceEntry],
) -> SessionSnapshot {
    unavailable_snapshot(session_id, revision, MULTIPLE_SOURCE_DIAGNOSTIC, entries)
}

fn collision_parent(entries: &[SourceEntry], session_id: &str) -> Option<SessionRef> {
    let mut consensus = None;
    for entry in entries {
        let header = read_primary_meta(&entry.path).ok().flatten()?;
        let payload = &header["payload"];
        if payload["id"].as_str() != Some(session_id) {
            return None;
        }
        let candidates = [
            nonempty(&payload["parent_thread_id"]),
            nonempty(&payload["forked_from_id"]),
            nonempty(&payload["source"]["subagent"]["thread_spawn"]["parent_thread_id"]),
        ];
        let mut header_parent = None;
        for candidate in candidates.into_iter().flatten() {
            if header_parent
                .as_ref()
                .is_some_and(|existing| existing != &candidate)
            {
                return None;
            }
            header_parent.get_or_insert(candidate);
        }
        let header_parent = header_parent?;
        if consensus
            .as_ref()
            .is_some_and(|existing| existing != &header_parent)
        {
            return None;
        }
        consensus.get_or_insert(header_parent);
    }
    consensus.map(|session_id| SessionRef {
        provider: "codex".into(),
        session_id,
    })
}

fn unavailable_snapshot(
    session_id: &str,
    revision: &str,
    diagnostic: &str,
    entries: &[SourceEntry],
) -> SessionSnapshot {
    let directory = if diagnostic == MULTIPLE_SOURCE_DIAGNOSTIC {
        let directories = entries
            .iter()
            .map(|entry| {
                read_header(&entry.path)
                    .ok()
                    .flatten()
                    .and_then(|(_, cwd, _)| cwd)
            })
            .collect::<Vec<_>>();
        directories.first().cloned().flatten().filter(|cwd| {
            directories
                .iter()
                .all(|directory| directory.as_deref() == Some(cwd.as_str()))
        })
    } else {
        None
    };
    let parent = (diagnostic == MULTIPLE_SOURCE_DIAGNOSTIC)
        .then(|| collision_parent(entries, session_id))
        .flatten();
    SessionSnapshot {
        summary: SessionSummary {
            session: SessionRef {
                provider: "codex".into(),
                session_id: session_id.into(),
            },
            title: session_id.into(),
            search_title: Some(session_id.into()),
            diagnostic: Some(diagnostic.into()),
            directory,
            created_at: None,
            updated_at: None,
            message_count: 0,
            conversation_message_count: None,
            token_count: None,
            duration_ms: None,
            summary_files: None,
            summary_additions: None,
            summary_deletions: None,
            parent,
        },
        revision: revision.into(),
        events: Vec::new(),
        relations: Vec::new(),
    }
}

fn codex_snapshot(path: &Path, scope: &str, session_id: &str) -> Result<SessionSnapshot> {
    let session = load_codex(path, scope, session_id)?;
    codex_snapshot_from_loaded(session)
}

fn codex_snapshot_from_loaded(session: LoadedSession) -> Result<SessionSnapshot> {
    let session_id = &session.id;
    if session.ownership_unavailable {
        return Err(CoreError::Protocol(ProtocolError::Unavailable {
            diagnostic: format!("child_ownership_boundary_unavailable: codex/{session_id}"),
        }));
    }
    let summary = summarize(&session);
    let items = project_items(&session);
    let fields = session.messages.into_iter().flat_map(|mut message| {
        let segments = message_segments(&message);
        let segment_count = segments.len();
        segments
            .into_iter()
            .enumerate()
            .map(move |(index, segment)| {
                let body = match segment {
                    "message" | "context" => std::mem::take(&mut message.body),
                    "thinking" => std::mem::take(&mut message.thinking),
                    _ => String::new(),
                };
                let (tool_input, tool_output) = if index + 1 == segment_count {
                    (
                        std::mem::take(&mut message.tool_input),
                        std::mem::take(&mut message.tool_output),
                    )
                } else {
                    (message.tool_input.clone(), message.tool_output.clone())
                };
                (body, tool_input, tool_output)
            })
    });
    let events = items
        .into_iter()
        .zip(fields)
        .map(|(item, (body, tool_input, tool_output))| NormalizedEvent {
            body,
            tool_input,
            tool_output,
            tool_status: None,
            item,
        })
        .collect();
    Ok(SessionSnapshot {
        summary,
        revision: session.revision,
        events,
        relations: session.relations,
    })
}
#[derive(Clone, Debug)]
struct Message {
    id: String,
    fallback_prefix: Option<&'static str>,
    legacy_agent_message: bool,
    presentation_phase: Option<&'static str>,
    role: &'static str,
    response_group: usize,
    timestamp: Option<String>,
    body: String,
    thinking: String,
    tool_name: Option<String>,
    tool_metadata: Option<crate::ReaderToolMetadata>,
    tool_input: String,
    tool_output: String,
}

#[derive(Debug)]
struct LoadedSession {
    id: String,
    cwd: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    token_count: Option<u64>,
    parent_id: Option<String>,
    agent_title: Option<String>,
    source_title: Option<String>,
    ownership_unavailable: bool,
    owned_boundary_line: Option<usize>,
    revision: String,
    messages: Vec<Message>,
    inherited_events: Vec<InheritedEvent>,
    relations: Vec<RelationEntry>,
    spawn_activity: HashMap<String, HashSet<String>>,
    historical_targets: HashMap<usize, String>,
    protocol_candidates: Vec<EventCandidate>,
    observations: CodexObservations,
    protocol_parse_errors: Vec<Diagnostic>,
}

fn is_codex_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")
}

fn is_compressed(path: &Path) -> bool {
    path.to_string_lossy().ends_with(".jsonl.zst")
}

fn header_entry(path: PathBuf) -> Result<Option<SourceEntry>> {
    // SourceEntry's signature is the catalog's stat identity. Capture still
    // checks the canonical ID and hashes source bytes for the Reader revision.
    let mut entry = SourceEntry::new(String::new(), path.clone())?;
    let Some((id, _, _)) = read_header(&path)? else {
        return Ok(None);
    };
    entry.session_id = id;
    Ok(Some(entry))
}

fn read_header(path: &Path) -> Result<Option<(String, Option<String>, Option<String>)>> {
    #[cfg(test)]
    HEADER_READS.with(|count| count.set(count.get() + 1));
    let Some(value) = read_primary_meta(path)? else {
        return Ok(None);
    };
    let Some(id) = value["payload"]["id"].as_str() else {
        return Ok(None);
    };
    Ok(Some((
        id.into(),
        value["payload"]["cwd"].as_str().map(str::to_owned),
        value["timestamp"].as_str().map(str::to_owned),
    )))
}

fn read_primary_meta(path: &Path) -> Result<Option<Value>> {
    Ok(read_primary_meta_positioned(path)?.map(|(_, value)| value))
}

fn read_primary_meta_positioned(path: &Path) -> Result<Option<(u64, Value)>> {
    let mut reader = open_codex_reader(path)?;
    let mut line = String::new();
    for ordinal in 0..32 {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|source| CoreError::Io {
                path: path.into(),
                source,
            })?
            == 0
        {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value["type"] == "session_meta" {
            return Ok(Some((ordinal, value)));
        }
    }
    Ok(None)
}

// Canonical selected header, exact parent, optional modern actor, explicit native spawn, header ordinal.
type ChildIdentity = (String, String, Option<String>, bool, u64);

fn child_identity(path: &Path) -> Result<Option<ChildIdentity>> {
    #[cfg(test)]
    CHILD_IDENTITY_READS.with(|count| count.set(count.get() + 1));
    let Some((ordinal, record)) = read_primary_meta_positioned(path)? else {
        return Ok(None);
    };
    let payload = &record["payload"];
    let Some(id) = payload["id"].as_str() else {
        return Ok(None);
    };
    let declared = payload["source"]["subagent"]["thread_spawn"]["parent_thread_id"].as_str();
    let parent = payload["parent_thread_id"]
        .as_str()
        .or_else(|| payload["forked_from_id"].as_str())
        .or(declared);
    let Some(parent) = parent else {
        return Ok(None);
    };
    // Conflicting native parent declarations do not establish a direct child.
    if declared.is_some_and(|value| value != parent) {
        return Ok(None);
    }
    let actor = payload["agent_path"]
        .as_str()
        .or_else(|| payload["source"]["subagent"]["thread_spawn"]["agent_path"].as_str())
        .map(str::to_owned);
    Ok(Some((
        id.into(),
        parent.into(),
        actor,
        declared == Some(parent),
        ordinal,
    )))
}

type SelectedChildIdentities = BTreeMap<String, Option<ChildIdentity>>;

fn selected_child_identities(sources: &BTreeMap<String, PathBuf>) -> SelectedChildIdentities {
    sources
        .iter()
        .map(|(id, path)| {
            let identity = child_identity(path)
                .ok()
                .flatten()
                .filter(|identity| identity.0 == *id);
            (id.clone(), identity)
        })
        .collect()
}

fn reader_parent_fact_from_path(path: &Path, session_id: &str) -> Result<Option<SessionRef>> {
    let header = read_primary_meta(path)?.ok_or_else(|| CoreError::Parse {
        path: path.into(),
        reason: "Codex source has no canonical session header".into(),
    })?;
    let payload = &header["payload"];
    if payload["id"].as_str() != Some(session_id) {
        return Err(CoreError::Parse {
            path: path.into(),
            reason: "selected child header has another canonical ID".into(),
        });
    }
    let parent = payload["parent_thread_id"]
        .as_str()
        .or_else(|| payload["forked_from_id"].as_str())
        .or_else(|| payload["source"]["subagent"]["thread_spawn"]["parent_thread_id"].as_str())
        .map(str::to_owned);
    let Some(parent) = parent else {
        return Ok(None);
    };
    if copied_parent_header(path, &parent)? {
        if !copied_child_parent_evidence(path, session_id)?.1 {
            return Err(CoreError::Unavailable(format!(
                "codex/{session_id}: copied parent history has no recorded child task boundary"
            )));
        }
    }
    Ok(Some(SessionRef {
        provider: "codex".into(),
        session_id: parent,
    }))
}

/// Parent projections consume the child's canonical header and whether an owned
/// NEW_TASK exists. Later child execution/body records do not alter those facts.
fn copied_child_parent_evidence(path: &Path, session_id: &str) -> Result<(String, bool)> {
    if path.to_string_lossy().ends_with(".zst") {
        #[cfg(test)]
        COPIED_CHILD_PARSE_COUNT.with(|count| count.set(count.get() + 1));
        return Ok((
            codex_revision_file(path, "child-parent-evidence-v2")?,
            !load_codex(path, "reader-parent-check", session_id)?.ownership_unavailable,
        ));
    }
    let file = fs::File::open(path).map_err(|source| codex_line_error(path, source))?;
    let length = file
        .metadata()
        .map_err(|source| codex_line_error(path, source))?
        .len();
    let mut reader = BufReader::new(file.take(length));
    let mut digest = codex_revision_hasher(path, "child-parent-evidence-v2");
    let mut line = Vec::new();
    let mut bytes = 0;
    let mut primary = false;
    let mut owned = false;
    loop {
        line.clear();
        let count = reader
            .read_until(b'\n', &mut line)
            .map_err(|source| codex_line_error(path, source))?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        digest.update(&line);
        if let Ok(record) = serde_json::from_slice::<Value>(&line) {
            if record["type"] == "session_meta" && record["payload"]["id"] == session_id {
                primary = true;
            }
            if primary
                && record["type"] == "response_item"
                && record["payload"]["type"] == "agent_message"
                && is_task_envelope(&record["payload"])
            {
                owned = true;
                break;
            }
        }
    }
    let revision = format!("{:x}", digest.finalize());
    if codex_prefix_revision(path, "child-parent-evidence-v2", bytes)? != revision {
        return Err(CoreError::SourceChanged);
    }
    Ok((revision, owned))
}

fn copied_parent_header(path: &Path, parent: &str) -> Result<bool> {
    let mut reader = open_codex_reader(path)?;
    let mut line = String::new();
    for _ in 0..32 {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|source| CoreError::Io {
                path: path.into(),
                source,
            })?
            == 0
        {
            return Ok(false);
        }
        if serde_json::from_str::<Value>(&line)
            .ok()
            .is_some_and(|record| record["type"] == "session_meta")
        {
            line.clear();
            if reader
                .read_line(&mut line)
                .map_err(|source| CoreError::Io {
                    path: path.into(),
                    source,
                })?
                == 0
            {
                return Ok(false);
            }
            return Ok(serde_json::from_str::<Value>(&line)
                .ok()
                .is_some_and(|record| {
                    record["type"] == "session_meta"
                        && (record["payload"]["id"].as_str() == Some(parent)
                            || record["payload"]["session_id"].as_str() == Some(parent))
                }));
        }
    }
    Ok(false)
}

fn selected_child_identity<'a>(
    id: &str,
    sources: &BTreeMap<String, PathBuf>,
    cache: &'a mut HashMap<String, Option<ChildIdentity>>,
    batch_identities: Option<&'a SelectedChildIdentities>,
) -> Option<&'a ChildIdentity> {
    if let Some(batch_identities) = batch_identities {
        return batch_identities.get(id).and_then(Option::as_ref);
    }
    if !cache.contains_key(id) {
        let identity = sources
            .get(id)
            .and_then(|path| child_identity(path).ok().flatten())
            .filter(|identity| identity.0 == id);
        cache.insert(id.into(), identity);
    }
    cache.get(id).and_then(Option::as_ref)
}

fn codex_child_dependencies(sources: &BTreeMap<String, PathBuf>, session_id: &str) -> String {
    codex_child_dependencies_with_identities(sources, session_id, None)
}

fn codex_child_dependencies_with_identities(
    sources: &BTreeMap<String, PathBuf>,
    session_id: &str,
    child_identities: Option<&SelectedChildIdentities>,
) -> String {
    let mut dependencies = Sha256::new();
    dependencies.update(b"codex-reader-parent-evidence-v2\0");
    for (id, path) in sources {
        if id == session_id {
            continue;
        }
        let uncached = if child_identities.is_none() {
            child_identity(path).ok().flatten()
        } else {
            None
        };
        let identity = child_identities
            .and_then(|identities| identities.get(id).and_then(Option::as_ref))
            .or(uncached.as_ref());
        if let Some(identity) = identity {
            if identity.1 == session_id && identity.0 == *id {
                dependencies.update(id.as_bytes());
                dependencies.update([0]);
                dependencies.update(path.to_string_lossy().as_bytes());
                dependencies.update([0]);
                dependencies.update(identity.1.as_bytes());
                dependencies.update(identity.2.as_deref().unwrap_or("").as_bytes());
                dependencies.update([u8::from(identity.3)]);
                dependencies.update(identity.4.to_le_bytes());
                if copied_parent_header(path, session_id).unwrap_or(false) {
                    dependencies.update(b"copied-parent-prefix\0");
                    match copied_child_parent_evidence(path, id) {
                        Ok((hash, _)) => dependencies.update(hash.as_bytes()),
                        Err(_) => dependencies.update(b"unreadable-copied-child"),
                    }
                }
                dependencies.update([0xff]);
            }
        }
    }
    format!("{:x}", dependencies.finalize())
}

fn codex_revision_with_dependencies(parent_revision: &str, dependencies: &str) -> String {
    let mut revision = Sha256::new();
    revision.update(b"codex-protocol-child-dependencies-v1\0");
    revision.update(parent_revision.as_bytes());
    revision.update(dependencies.as_bytes());
    format!("{:x}", revision.finalize())
}

fn codex_apply_child_revision(loaded: &mut LoadedSession, sources: &BTreeMap<String, PathBuf>) {
    codex_apply_child_revision_with_identities(loaded, sources, None);
}

fn codex_apply_child_revision_with_identities(
    loaded: &mut LoadedSession,
    sources: &BTreeMap<String, PathBuf>,
    child_identities: Option<&SelectedChildIdentities>,
) {
    let dependencies =
        codex_child_dependencies_with_identities(sources, &loaded.id, child_identities);
    loaded.revision = codex_revision_with_dependencies(&loaded.revision, &dependencies);
}

fn resolve_spawn_children(loaded: &mut LoadedSession, sources: &BTreeMap<String, PathBuf>) {
    resolve_spawn_children_with_identities(loaded, sources, None);
}

fn resolve_spawn_children_with_identities(
    loaded: &mut LoadedSession,
    sources: &BTreeMap<String, PathBuf>,
    child_identities: Option<&SelectedChildIdentities>,
) {
    let mut cache = HashMap::<String, Option<ChildIdentity>>::new();
    for relation in &mut loaded.relations {
        let RelationEntry::Coordination { observation } = relation else {
            continue;
        };
        if observation.kind != "spawn" || observation.state != "started" {
            continue;
        }
        let actor = observation.to_actor_path.as_deref();
        let matching = |identity: &ChildIdentity| {
            identity.1 == loaded.id
                && identity.0 != loaded.id
                && actor.is_none_or(|actor| identity.2.as_deref() == Some(actor))
        };
        let resolved = if let Some(ids) = loaded.spawn_activity.get(&observation.correlation_id) {
            if ids.len() != 1 {
                continue;
            }
            let id = ids.iter().next().expect("exactly one recorded child id");
            selected_child_identity(id, sources, &mut cache, child_identities)
                .filter(|identity| matching(identity))
                .map(|identity| identity.0.clone())
        } else if actor.is_some() {
            let mut unique = None;
            let mut ambiguous = false;
            for id in sources.keys() {
                if selected_child_identity(id, sources, &mut cache, child_identities)
                    .is_some_and(&matching)
                {
                    if unique.is_some() {
                        ambiguous = true;
                        break;
                    }
                    unique = Some(id.clone());
                }
            }
            (!ambiguous).then_some(unique).flatten()
        } else {
            None
        };
        if let Some(id) = resolved {
            observation.to_session_ref = Some(SessionRef {
                provider: "codex".into(),
                session_id: id,
            });
        }
    }
    for (index, target) in &loaded.historical_targets {
        let verified = selected_child_identity(target, sources, &mut cache, child_identities)
            .is_some_and(|identity| identity.0 != loaded.id && identity.1 == loaded.id)
            && sources.get(target).is_some_and(|path| {
                reader_parent_fact_from_path(path, target)
                    .ok()
                    .flatten()
                    .is_some_and(|parent| parent.session_id == loaded.id)
            });
        if !verified {
            continue;
        }
        if let Some(RelationEntry::Coordination { observation }) = loaded.relations.get_mut(*index)
        {
            let child = SessionRef {
                provider: "codex".into(),
                session_id: target.clone(),
            };
            if observation.kind == "result" {
                observation.from_session_ref = Some(child);
            } else {
                observation.to_session_ref = Some(child);
            }
        }
    }
}

fn append_child_declarations(
    loaded: &mut LoadedSession,
    sources: &BTreeMap<String, PathBuf>,
    identities: Option<&SelectedChildIdentities>,
) -> Vec<(SessionRef, Evidence)> {
    let first_slot = loaded
        .protocol_candidates
        .iter()
        .map(|event| event.source_order.record)
        .max()
        .unwrap_or(0)
        + 1;
    let mut declarations = Vec::new();
    let mut cache = HashMap::new();
    for (id, path) in sources {
        let Some(identity) = selected_child_identity(id, sources, &mut cache, identities) else {
            continue;
        };
        if id == &loaded.id || identity.1 != loaded.id || !identity.3 {
            continue;
        }
        if !reader_parent_fact_from_path(path, id)
            .ok()
            .flatten()
            .is_some_and(|parent| parent.session_id == loaded.id)
        {
            continue;
        }
        let event_id = format!("event:codex:child-thread-declared:{id}");
        let provenance = Provenance {
            fidelity: Fidelity::Derived,
            source_type: "codex.session_meta:child_thread_declared".into(),
            source_id: Some(format!(
                "codex-child-header:{id}:{}:{}",
                identity.4,
                path.to_string_lossy()
            )),
        };
        loaded.protocol_candidates.push(EventCandidate {
            id: event_id.clone(),
            session: SessionRef {
                provider: "codex".into(),
                session_id: loaded.id.clone(),
            },
            source_order: SourceOrder {
                record: first_slot + declarations.len() as u64,
                ordinal: 0,
            },
            timestamp: None,
            category: "relationship".into(),
            kind: "codex.child_thread_declared".into(),
            provenance: provenance.clone(),
            reader_event: None,
            execution: None,
        });
        declarations.push((
            SessionRef {
                provider: "codex".into(),
                session_id: id.clone(),
            },
            Evidence {
                event_id,
                provenance,
            },
        ));
    }
    declarations
}

fn open_codex_reader(path: &Path) -> Result<Box<dyn BufRead>> {
    let file = fs::File::open(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })?;
    if path.to_string_lossy().ends_with(".zst") {
        let decoder = zstd::stream::read::Decoder::new(file)
            .map_err(|source| codex_line_error(path, source))?;
        Ok(Box::new(BufReader::new(decoder)))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

fn codex_line_error(path: &Path, source: std::io::Error) -> CoreError {
    if path.to_string_lossy().ends_with(".zst") {
        CoreError::Parse {
            path: path.into(),
            reason: source.to_string(),
        }
    } else {
        CoreError::Io {
            path: path.into(),
            source,
        }
    }
}

fn load_codex(path: &Path, scope: &str, expected_id: &str) -> Result<LoadedSession> {
    if path.to_string_lossy().ends_with(".zst") {
        let revision = codex_revision_file(path, scope)?;
        let mut reader = open_codex_reader(path)?;
        let loaded = load_codex_reader(path, expected_id, revision.clone(), &mut reader, None)?;
        if codex_revision_file(path, scope)? != revision {
            return Err(CoreError::SourceChanged);
        }
        return Ok(loaded);
    }
    let file = fs::File::open(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })?;
    let mut hasher = codex_revision_hasher(path, scope);
    let hashing_reader = HashingReader {
        inner: file,
        hasher: &mut hasher,
        #[cfg(test)]
        read_count: 0,
    };
    let mut reader = BufReader::new(hashing_reader);
    let mut loaded = load_codex_reader(path, expected_id, String::new(), &mut reader, None)?;
    drop(reader);
    let revision = format!("{:x}", hasher.finalize());
    if codex_revision_file(path, scope)? != revision {
        return Err(CoreError::SourceChanged);
    }
    loaded.revision = revision;
    Ok(loaded)
}

/// Capture complete JSONL records present at the opening boundary. The caller
/// verifies this exact prefix after collecting dependent facts.
fn open_codex_complete_prefix(path: &Path) -> Result<(fs::File, u64)> {
    let mut file = fs::File::open(path).map_err(|source| codex_line_error(path, source))?;
    let mut end = file
        .metadata()
        .map_err(|source| codex_line_error(path, source))?
        .len();
    let opening_length = end;
    let mut buffer = [0u8; 64 * 1024];
    while end > 0 {
        let start = end.saturating_sub(buffer.len() as u64);
        file.seek(SeekFrom::Start(start))
            .map_err(|source| codex_line_error(path, source))?;
        let bytes = (end - start) as usize;
        file.read_exact(&mut buffer[..bytes])
            .map_err(|source| codex_line_error(path, source))?;
        if let Some(last) = buffer[..bytes].iter().rposition(|byte| *byte == b'\n') {
            end = start + last as u64 + 1;
            break;
        }
        end = start;
    }
    if end < opening_length {
        file.seek(SeekFrom::Start(end))
            .map_err(|source| codex_line_error(path, source))?;
        // A complete final JSON record is valid without a newline. Only an
        // unfinished record is excluded from the captured prefix.
        let tail = serde_json::from_reader::<_, serde::de::IgnoredAny>(
            (&mut file).take(opening_length - end),
        );
        if tail.is_ok() || tail.as_ref().is_err_and(|error| !error.is_eof()) {
            end = opening_length;
        }
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|source| codex_line_error(path, source))?;
    Ok((file, end))
}

fn load_codex_reader_prefix(
    path: &Path,
    scope: &str,
    expected_id: &str,
) -> Result<(LoadedSession, u64)> {
    let (file, end) = open_codex_complete_prefix(path)?;
    let mut hasher = codex_revision_hasher(path, scope);
    let hashing = HashingReader {
        inner: file.take(end),
        hasher: &mut hasher,
        #[cfg(test)]
        read_count: 0,
    };
    let mut reader = BufReader::new(hashing);
    let mut loaded = load_codex_reader(path, expected_id, String::new(), &mut reader, None)?;
    drop(reader);
    loaded.revision = format!("{:x}", hasher.finalize());
    Ok((loaded, end))
}

fn codex_prefix_revision(path: &Path, scope: &str, length: u64) -> Result<String> {
    let file = fs::File::open(path).map_err(|source| codex_line_error(path, source))?;
    let mut reader = file.take(length);
    let mut hasher = codex_revision_hasher(path, scope);
    let read =
        std::io::copy(&mut reader, &mut hasher).map_err(|source| codex_line_error(path, source))?;
    if read != length {
        return Err(CoreError::SourceChanged);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn codex_revision(path: &Path, scope: &str, source_bytes: &[u8]) -> String {
    let mut hasher = codex_revision_hasher(path, scope);
    hasher.update(source_bytes);
    format!("{:x}", hasher.finalize())
}

fn codex_revision_hasher(path: &Path, scope: &str) -> Sha256 {
    let mut hasher = Sha256::new();
    hasher.update(CODEX_REVISION_NAMESPACE);
    hasher.update(scope.as_bytes());
    hasher.update(path.to_string_lossy().as_bytes());
    hasher
}

struct HashingReader<'a, R: Read> {
    inner: R,
    hasher: &'a mut Sha256,
    #[cfg(test)]
    read_count: usize,
}

impl<R: Read> Read for HashingReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        #[cfg(test)]
        {
            self.read_count += 1;
            CODEX_STREAM_READ_HOOK.with(|hook| {
                if let Some(callback) = hook.borrow_mut().as_mut() {
                    callback(self.read_count);
                }
            });
        }
        let count = self.inner.read(buffer)?;
        self.hasher.update(&buffer[..count]);
        Ok(count)
    }
}

fn codex_revision_file(path: &Path, scope: &str) -> Result<String> {
    #[cfg(test)]
    CODEX_REVISION_FILE_READS.with(|count| count.set(count.get() + 1));
    let mut file = fs::File::open(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })?;
    let mut hasher = codex_revision_hasher(path, scope);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut chunk).map_err(|source| CoreError::Io {
            path: path.into(),
            source,
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&chunk[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn codex_prefix(path: &Path, line_count: usize) -> Result<Vec<u8>> {
    let mut reader = open_codex_reader(path)?;
    let mut prefix = Vec::new();
    let mut line = Vec::new();
    for _ in 0..line_count {
        line.clear();
        let count = reader
            .read_until(b'\n', &mut line)
            .map_err(|source| codex_line_error(path, source))?;
        if count == 0 {
            return Err(CoreError::Parse {
                path: path.into(),
                reason: "Codex inherited prefix changed during reading".into(),
            });
        }
        prefix.extend_from_slice(&line);
    }
    Ok(prefix)
}

fn load_codex_bytes(
    path: &Path,
    expected_id: &str,
    source_bytes: Vec<u8>,
    revision: String,
) -> Result<LoadedSession> {
    let decoded = if path.to_string_lossy().ends_with(".zst") {
        zstd::stream::decode_all(source_bytes.as_slice()).map_err(|error| CoreError::Parse {
            path: path.into(),
            reason: error.to_string(),
        })?
    } else {
        source_bytes
    };
    let mut reader = std::io::Cursor::new(decoded.as_slice());
    load_codex_reader(path, expected_id, revision, &mut reader, Some(&decoded))
}

fn load_codex_reader(
    path: &Path,
    expected_id: &str,
    revision: String,
    reader: &mut dyn BufRead,
    decoded: Option<&[u8]>,
) -> Result<LoadedSession> {
    load_codex_reader_positioned(path, expected_id, revision, reader, decoded, None)
}

fn load_codex_reader_positioned(
    path: &Path,
    expected_id: &str,
    revision: String,
    reader: &mut dyn BufRead,
    decoded: Option<&[u8]>,
    positions: Option<&[source_set::Position]>,
) -> Result<LoadedSession> {
    #[cfg(feature = "search-phase-probe")]
    let mut resource_probe =
        crate::index::ResourceProbe::new("codex_positioned_reader_probe", "codex");
    #[cfg(test)]
    CODEX_NORMALIZATION_COUNT.with(|count| count.set(count.get() + 1));
    let mut id = None;
    let mut cwd = None;
    let mut created_at = None;
    let mut updated_at = None;
    let mut parent_id = None;
    let mut agent_title = None;
    let mut source_title = None;
    let mut messages: Vec<Message> = Vec::new();
    let mut relations = Vec::new();
    let mut actor_path = None::<String>;
    let mut spawn_calls = HashSet::<String>::new();
    let mut spawn_activity = HashMap::<String, HashSet<String>>::new();
    let mut historical_calls = HashMap::<String, (String, Vec<String>)>::new();
    let mut historical_assignments = HashMap::<String, HashSet<String>>::new();
    let mut historical_targets = HashMap::<usize, String>::new();
    let mut untargeted_wait_calls = HashSet::<String>::new();
    let mut acknowledged = HashMap::<String, String>::new();
    let mut protocol_candidates = Vec::new();
    let mut execution = CodexExecutionTracker::default();
    let mut observations = CodexObservations::default();
    let mut protocol_parse_errors = Vec::new();
    let mut tool_calls = HashMap::<String, usize>::new();
    let mut legacy_user_rows = Vec::<(String, usize, usize)>::new();
    let mut recorded_user_rows = Vec::<(String, usize, usize)>::new();
    let mut fallback_index = 0usize;
    let mut response_group = 0usize;
    let mut task_keys = HashSet::new();
    let mut owned_boundary_line = None;
    let mut primary_header_line = None;
    let mut copied_parent_header = false;
    let mut last_compacted_line = None;
    let mut line = Vec::new();
    let mut line_index = 0usize;
    loop {
        line.clear();
        if reader
            .read_until(b'\n', &mut line)
            .map_err(|source| codex_line_error(path, source))?
            == 0
        {
            break;
        }
        let source_id = positions.map_or_else(
            || line_index.to_string(),
            |positions| positions[line_index].source_id.clone(),
        );
        let event_key = positions.map_or_else(
            || line_index.to_string(),
            |positions| positions[line_index].event_key.clone(),
        );
        let event_id = format!("event:codex:{event_key}");
        let terminated = line.last() == Some(&b'\n');
        if terminated {
            line.pop();
        }
        if line.is_empty() || line.iter().all(u8::is_ascii_whitespace) {
            line_index += 1;
            continue;
        }
        let record: Value = match serde_json::from_slice(&line) {
            Ok(record) => record,
            Err(error) if !terminated => {
                // An actively appended transcript may end in a partial line.
                let _ = error;
                observations.facts.diagnostics.push(Diagnostic {
                    code: "incomplete_trailing_record",
                    event_id: None,
                });
                break;
            }
            Err(_) => {
                protocol_parse_errors.push(Diagnostic {
                    code: "malformed_source_record",
                    event_id: Some(event_id.clone()),
                });
                line_index += 1;
                continue;
            }
        };
        let timestamp = record["timestamp"].as_str().map(str::to_owned);
        let compaction_timestamp = (record["type"] == "compacted"
            || record["payload"]["type"] == "context_compacted")
            .then(|| timestamp.clone())
            .flatten();
        let event_timestamp = timestamp.as_deref().and_then(timestamp_ms);
        if created_at.is_none() && record["type"] == "session_meta" {
            id = record["payload"]["id"].as_str().map(str::to_owned);
            cwd = record["payload"]["cwd"].as_str().map(str::to_owned);
            parent_id = record["payload"]["parent_thread_id"]
                .as_str()
                .or_else(|| record["payload"]["forked_from_id"].as_str())
                .or_else(|| {
                    record["payload"]["source"]["subagent"]["thread_spawn"]["parent_thread_id"]
                        .as_str()
                })
                .map(str::to_owned);
            agent_title = record["payload"]["agent_path"]
                .as_str()
                .or_else(|| {
                    record["payload"]["source"]["subagent"]["thread_spawn"]["agent_path"].as_str()
                })
                .or_else(|| record["payload"]["agent_nickname"].as_str())
                .or_else(|| {
                    record["payload"]["source"]["subagent"]["thread_spawn"]["agent_nickname"]
                        .as_str()
                })
                .map(str::to_owned);
            actor_path = record["payload"]["agent_path"].as_str().map(str::to_owned);
            created_at = timestamp.clone();
            primary_header_line = Some(line_index);
        } else if record["type"] == "session_meta"
            && primary_header_line.is_some_and(|line| line + 1 == line_index)
        {
            copied_parent_header = parent_id.as_deref().is_some_and(|parent| {
                record["payload"]["id"].as_str() == Some(parent)
                    || record["payload"]["session_id"].as_str() == Some(parent)
            });
        }
        if timestamp.is_some() {
            updated_at = timestamp.clone();
        }
        let kind = record["type"].as_str().unwrap_or("");
        let payload = &record["payload"];
        let owned_user = kind == "response_item"
            && payload["type"] == "message"
            && payload["role"] == "user"
            && payload["internal_chat_message_metadata_passthrough"]["content_item_kinds"]
                .as_array()
                .is_some_and(|kinds| kinds.iter().any(|item| item == "user.text"));
        if owned_user
            || (kind == "event_msg" && payload["type"] == "user_message")
            || (kind == "response_item"
                && payload["type"] == "agent_message"
                && is_task_envelope(payload))
            || codex_usage_payload(&record).is_some()
        {
            response_group = line_index;
        }
        if kind == "event_msg"
            && payload["item"]["type"] == "SubAgentActivity"
            && payload["item"]["kind"] == "started"
        {
            if let (Some(call_id), Some(child_id)) = (
                payload["item"]["id"].as_str(),
                payload["item"]["agent_thread_id"].as_str(),
            ) {
                if spawn_calls.contains(call_id) && !child_id.is_empty() {
                    spawn_activity
                        .entry(call_id.to_owned())
                        .or_default()
                        .insert(child_id.to_owned());
                }
            }
        }
        observations.observe_positioned(
            &record,
            line_index,
            expected_id,
            &source_id,
            &event_key,
            event_timestamp,
        );
        let mut messages_before = messages.len();
        if kind == "response_item"
            && payload["type"] == "agent_message"
            && is_task_envelope(payload)
        {
            if parent_id.is_some() && owned_boundary_line.is_none() {
                owned_boundary_line = Some(line_index);
                messages.clear();
                legacy_user_rows.clear();
                recorded_user_rows.clear();
                tool_calls.clear();
                execution = CodexExecutionTracker::default();
                spawn_calls.clear();
                spawn_activity.clear();
                historical_calls.clear();
                historical_assignments.clear();
                historical_targets.clear();
                untargeted_wait_calls.clear();
                acknowledged.clear();
                relations.clear();
                fallback_index = 0;
                messages_before = 0;
            }
            let (body, task_name) = task_body(payload);
            let key = format!("{}\0{body}", task_name.as_deref().unwrap_or(""));
            if task_keys.insert(key) {
                messages.push(Message {
                    id: message_id(payload, "subagent-task", &mut fallback_index),
                    fallback_prefix: payload["id"].as_str().is_none().then_some("subagent-task"),
                    legacy_agent_message: false,
                    presentation_phase: None,
                    role: "user",
                    response_group,
                    timestamp,
                    body,
                    thinking: String::new(),
                    tool_name: None,
                    tool_metadata: None,
                    tool_input: String::new(),
                    tool_output: String::new(),
                });
            }
        } else if kind == "response_item" && payload["type"] == "agent_message" {
            let text = text_parts(&payload["content"]);
            if let (Some(author), Some(recipient)) =
                (payload["author"].as_str(), payload["recipient"].as_str())
            {
                let acknowledged_parent = author.rsplit_once('/').map(|(parent, _)| parent);
                let recipient_matches = actor_path.as_deref().map_or_else(
                    || acknowledged_parent == Some(recipient),
                    |local| local == recipient,
                );
                if recipient_matches && author != recipient {
                    if let (Some(call_id), Some(body)) =
                        (acknowledged.get(author), final_answer_body(&text, author))
                    {
                        let message_id = message_id(payload, "agent-result", &mut fallback_index);
                        let event = EventRef {
                            provider: "codex".into(),
                            session_id: expected_id.into(),
                            message_id: message_id.clone(),
                            segment: "message".into(),
                        };
                        messages.push(Message {
                            id: message_id,
                            fallback_prefix: payload["id"]
                                .as_str()
                                .is_none()
                                .then_some("agent-result"),
                            legacy_agent_message: false,
                            presentation_phase: None,
                            role: "agent",
                            response_group,
                            timestamp: timestamp.clone(),
                            body,
                            thinking: String::new(),
                            tool_name: None,
                            tool_metadata: None,
                            tool_input: String::new(),
                            tool_output: String::new(),
                        });
                        relations.push(codex_collaboration_relation(
                            "result",
                            "completed",
                            call_id,
                            &source_id,
                            &event_key,
                            expected_id,
                            Some(author),
                            Some(recipient),
                            Some(event),
                        ));
                    }
                }
            }
        } else if kind == "response_item" && payload["type"] == "message" {
            let role = payload["role"].as_str().unwrap_or("");
            let owned_user = role == "user"
                && payload["internal_chat_message_metadata_passthrough"]["content_item_kinds"]
                    .as_array()
                    .is_some_and(|kinds| kinds.iter().any(|kind| kind == "user.text"));
            if owned_user || role == "assistant" {
                let raw_body = text_parts(&payload["content"]);
                if !raw_body.is_empty() {
                    if owned_user && source_title.is_none() {
                        source_title = Some(flat_title(&raw_body));
                    }
                    let normalized_user_text = owned_user.then(|| normalize_user_text(&raw_body));
                    let body = if owned_user {
                        question_reply_text(&raw_body).unwrap_or(raw_body)
                    } else {
                        raw_body
                    };
                    let duplicate_legacy_answer = role == "assistant"
                        && messages.last().is_some_and(|previous| {
                            previous.legacy_agent_message && previous.body == body
                        });
                    if !duplicate_legacy_answer {
                        let message_index = messages.len();
                        let id = message_id(payload, "msg", &mut fallback_index);
                        messages.push(Message {
                            id,
                            fallback_prefix: payload["id"].as_str().is_none().then_some("msg"),
                            legacy_agent_message: false,
                            presentation_phase: if role == "assistant" {
                                match payload["phase"].as_str() {
                                    Some("commentary") => Some("commentary"),
                                    Some("final_answer") => Some("final_answer"),
                                    _ => None,
                                }
                            } else {
                                None
                            },
                            role: if owned_user { "user" } else { "assistant" },
                            response_group,
                            timestamp,
                            body,
                            thinking: String::new(),
                            tool_name: None,
                            tool_metadata: None,
                            tool_input: String::new(),
                            tool_output: String::new(),
                        });
                        if let Some(text) = normalized_user_text.filter(|text| !text.is_empty()) {
                            recorded_user_rows.push((text, line_index, message_index));
                        }
                    }
                }
            }
        } else if kind == "event_msg" && payload["type"] == "user_message" {
            if let Some(body) = payload["message"].as_str() {
                if !body.is_empty() {
                    if source_title.is_none() {
                        source_title = Some(flat_title(body));
                    }
                    let normalized_user_text = normalize_user_text(body);
                    let message_index = messages.len();
                    messages.push(Message {
                        id: message_id(payload, "msg", &mut fallback_index),
                        fallback_prefix: payload["id"].as_str().is_none().then_some("msg"),
                        legacy_agent_message: false,
                        presentation_phase: None,
                        role: "user",
                        response_group,
                        timestamp,
                        body: body.into(),
                        thinking: String::new(),
                        tool_name: None,
                        tool_metadata: None,
                        tool_input: String::new(),
                        tool_output: String::new(),
                    });
                    if !normalized_user_text.is_empty() {
                        legacy_user_rows.push((normalized_user_text, line_index, message_index));
                    }
                }
            }
        } else if kind == "event_msg" && payload["type"] == "agent_message" {
            if let Some(body) = payload["message"].as_str() {
                if !body.is_empty() {
                    messages.push(Message {
                        id: message_id(payload, "agent-message", &mut fallback_index),
                        fallback_prefix: payload["id"]
                            .as_str()
                            .is_none()
                            .then_some("agent-message"),
                        legacy_agent_message: true,
                        presentation_phase: None,
                        role: "assistant",
                        response_group,
                        timestamp,
                        body: body.into(),
                        thinking: String::new(),
                        tool_name: None,
                        tool_metadata: None,
                        tool_input: String::new(),
                        tool_output: String::new(),
                    });
                }
            }
        } else if kind == "response_item" && payload["type"] == "reasoning" {
            let thinking = text_parts(if payload["summary"].is_array() {
                &payload["summary"]
            } else {
                &payload["content"]
            });
            if !thinking.is_empty() {
                let progressive = messages.last_mut().is_some_and(|previous| {
                    if previous.role != "assistant"
                        || !previous.body.is_empty()
                        || previous.tool_name.is_some()
                        || previous.thinking.is_empty()
                        || !(thinking.starts_with(&previous.thinking)
                            || previous.thinking.starts_with(&thinking))
                    {
                        return false;
                    }
                    if thinking.len() > previous.thinking.len() {
                        previous.thinking = thinking.clone();
                    }
                    true
                });
                if !progressive {
                    messages.push(Message {
                        id: message_id(payload, "reasoning", &mut fallback_index),
                        fallback_prefix: payload["id"].as_str().is_none().then_some("reasoning"),
                        legacy_agent_message: false,
                        presentation_phase: None,
                        role: "assistant",
                        response_group,
                        timestamp,
                        body: String::new(),
                        thinking,
                        tool_name: None,
                        tool_metadata: None,
                        tool_input: String::new(),
                        tool_output: String::new(),
                    });
                }
            }
        } else if kind == "response_item"
            && (payload["type"] == "function_call" || payload["type"] == "custom_tool_call")
        {
            let call_id = payload["call_id"].as_str().map(str::to_owned);
            if payload["namespace"] == "multi_agent_v1" {
                if let (Some(call_id), Some(name)) = (call_id.as_deref(), payload["name"].as_str())
                {
                    let args = payload["arguments"]
                        .as_str()
                        .and_then(|v| serde_json::from_str::<Value>(v).ok());
                    let targets: Vec<String> = match name {
                        "wait_agent" => args
                            .as_ref()
                            .and_then(|v| v["targets"].as_array())
                            .map(|items| items.iter().filter_map(|v| nonempty(v)).collect())
                            .unwrap_or_default(),
                        "close_agent" | "send_input" => args
                            .as_ref()
                            .and_then(|v| nonempty(&v["target"]))
                            .into_iter()
                            .collect(),
                        "resume_agent" => args
                            .as_ref()
                            .and_then(|v| nonempty(&v["target"]).or_else(|| nonempty(&v["id"])))
                            .into_iter()
                            .collect(),
                        _ => Vec::new(),
                    };
                    let kind_state = match name {
                        "spawn_agent" => Some(("spawn", "requested")),
                        "wait_agent" => Some(("wait", "waiting")),
                        "close_agent" => Some(("close", "requested")),
                        "resume_agent" => Some(("resume", "requested")),
                        // Follow-up input is coordination, not a fresh Reader child placement.
                        "send_input" => Some(("input", "sent")),
                        _ => None,
                    };
                    if let Some((kind, state)) = kind_state {
                        historical_calls.insert(call_id.into(), (name.into(), targets.clone()));
                        if name == "spawn_agent" {
                            spawn_calls.insert(call_id.into());
                        }
                        for target in if name == "spawn_agent" {
                            vec![None]
                        } else {
                            targets.iter().map(|v| Some(v.as_str())).collect()
                        } {
                            historical_relation(
                                &mut relations,
                                &mut historical_targets,
                                kind,
                                state,
                                call_id,
                                &source_id,
                                &event_key,
                                expected_id,
                                call_id,
                                target,
                                false,
                            );
                            if name == "spawn_agent" {
                                if let Some(RelationEntry::Coordination { observation }) =
                                    relations.last_mut()
                                {
                                    observation.launch_request =
                                        args.as_ref().and_then(codex_launch_request);
                                }
                            }
                        }
                    }
                }
            }
            if payload["name"] == "spawn_agent" && payload["namespace"] == "collaboration" {
                if let Some(call_id) = call_id.as_deref() {
                    spawn_calls.insert(call_id.into());
                    relations.push(codex_collaboration_relation(
                        "spawn",
                        "requested",
                        call_id,
                        &source_id,
                        &event_key,
                        expected_id,
                        actor_path.as_deref(),
                        None,
                        Some(codex_tool_event(expected_id, call_id)),
                    ));
                    if let Some(RelationEntry::Coordination { observation }) = relations.last_mut()
                    {
                        observation.launch_request = payload["arguments"]
                            .as_str()
                            .and_then(|text| serde_json::from_str::<Value>(text).ok())
                            .as_ref()
                            .and_then(codex_launch_request);
                    }
                }
            }
            if payload["name"] == "wait_agent"
                && payload["namespace"] == "collaboration"
                && payload["arguments"]
                    .as_str()
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    .is_some_and(|args| args.is_object() && args.get("target").is_none())
            {
                if let Some(call_id) = call_id.as_deref() {
                    untargeted_wait_calls.insert(call_id.into());
                    relations.push(codex_collaboration_relation(
                        "wait",
                        "waiting",
                        call_id,
                        &source_id,
                        &event_key,
                        expected_id,
                        actor_path.as_deref(),
                        None,
                        Some(codex_tool_event(expected_id, call_id)),
                    ));
                }
            }
            let id = call_id
                .clone()
                .unwrap_or_else(|| message_id(payload, "tool", &mut fallback_index));
            let input = text_value(&payload["arguments"])
                .or_else(|| text_value(&payload["input"]))
                .unwrap_or_default();
            let index = messages.len();
            messages.push(Message {
                id,
                fallback_prefix: (call_id.is_none() && payload["id"].as_str().is_none())
                    .then_some("tool"),
                legacy_agent_message: false,
                presentation_phase: None,
                role: "tool",
                response_group,
                timestamp,
                body: String::new(),
                thinking: String::new(),
                tool_name: payload["name"].as_str().map(str::to_owned),
                tool_metadata: codex_tool_metadata(payload),
                tool_input: input,
                tool_output: String::new(),
            });
            if let Some(call_id) = call_id {
                tool_calls.insert(call_id, index);
            }
        } else if kind == "response_item"
            && (payload["type"] == "function_call_output"
                || payload["type"] == "custom_tool_call_output")
        {
            if let Some(call_id) = payload["call_id"].as_str() {
                if let Some((name, targets)) = historical_calls.get(call_id) {
                    let output_text = text_value(&payload["output"]).unwrap_or_default();
                    let output = serde_json::from_str::<Value>(&output_text).ok();
                    match name.as_str() {
                        "spawn_agent" => {
                            if let Some(child) =
                                output.as_ref().and_then(|v| nonempty(&v["agent_id"]))
                            {
                                spawn_activity
                                    .entry(call_id.into())
                                    .or_default()
                                    .insert(child.clone());
                                historical_assignments
                                    .entry(child.clone())
                                    .or_default()
                                    .insert(call_id.into());
                                historical_relation(
                                    &mut relations,
                                    &mut historical_targets,
                                    "spawn",
                                    "started",
                                    call_id,
                                    &source_id,
                                    &event_key,
                                    expected_id,
                                    call_id,
                                    Some(&child),
                                    true,
                                );
                            } else if historical_spawn_failure(&output_text) {
                                historical_relation(
                                    &mut relations,
                                    &mut historical_targets,
                                    "spawn",
                                    "failed",
                                    call_id,
                                    &source_id,
                                    &event_key,
                                    expected_id,
                                    call_id,
                                    None,
                                    true,
                                );
                            }
                        }
                        "wait_agent" => {
                            if let Some(value) = output.as_ref() {
                                if let Some(timed_out) = value["timed_out"].as_bool() {
                                    for target in targets {
                                        historical_relation(
                                            &mut relations,
                                            &mut historical_targets,
                                            "wait",
                                            if timed_out { "timed_out" } else { "returned" },
                                            call_id,
                                            &source_id,
                                            &event_key,
                                            expected_id,
                                            call_id,
                                            Some(target),
                                            true,
                                        );
                                    }
                                }
                                if let Some(status) = value["status"].as_object() {
                                    for (target, state) in status {
                                        if state["completed"].as_str().is_some() {
                                            let assignment = historical_assignments
                                                .get(target)
                                                .filter(|ids| ids.len() == 1)
                                                .and_then(|ids| ids.iter().next())
                                                .map(String::as_str)
                                                .unwrap_or(call_id);
                                            historical_relation(
                                                &mut relations,
                                                &mut historical_targets,
                                                "result",
                                                "completed",
                                                assignment,
                                                &source_id,
                                                &event_key,
                                                expected_id,
                                                call_id,
                                                Some(target),
                                                true,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        "close_agent" | "resume_agent" | "send_input" => {
                            let (kind, state, key) = match name.as_str() {
                                "close_agent" => ("close", "closed", "previous_status"),
                                "resume_agent" => ("resume", "returned", "status"),
                                _ => ("input", "submitted", "submission_id"),
                            };
                            if let Some(value) = output.as_ref().filter(|v| {
                                if key == "submission_id" {
                                    nonempty(&v[key]).is_some()
                                } else {
                                    v[key]["completed"].as_str().is_some()
                                }
                            }) {
                                for target in targets {
                                    historical_relation(
                                        &mut relations,
                                        &mut historical_targets,
                                        kind,
                                        state,
                                        call_id,
                                        &source_id,
                                        &event_key,
                                        expected_id,
                                        call_id,
                                        Some(target),
                                        true,
                                    );
                                    if name == "close_agent"
                                        && value["previous_status"]["completed"].as_str().is_some()
                                    {
                                        let assignment = historical_assignments
                                            .get(target)
                                            .filter(|ids| ids.len() == 1)
                                            .and_then(|ids| ids.iter().next())
                                            .map(String::as_str)
                                            .unwrap_or(call_id);
                                        historical_relation(
                                            &mut relations,
                                            &mut historical_targets,
                                            "result",
                                            "completed",
                                            assignment,
                                            &source_id,
                                            &event_key,
                                            expected_id,
                                            call_id,
                                            Some(target),
                                            true,
                                        );
                                        if let Some(RelationEntry::Coordination { observation }) =
                                            relations.last_mut()
                                        {
                                            observation
                                                .provenance
                                                .source_type
                                                .push_str(":previous_status");
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if untargeted_wait_calls.contains(call_id) {
                    let state = payload["output"]
                        .as_str()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .and_then(|output| output["timed_out"].as_bool())
                        .map(|timed_out| if timed_out { "timed_out" } else { "returned" });
                    if let Some(state) = state {
                        relations.push(codex_collaboration_relation(
                            "wait",
                            state,
                            call_id,
                            &source_id,
                            &event_key,
                            expected_id,
                            actor_path.as_deref(),
                            None,
                            Some(codex_tool_event(expected_id, call_id)),
                        ));
                    }
                }
                if spawn_calls.contains(call_id) && !historical_calls.contains_key(call_id) {
                    let actor = payload["output"]
                        .as_str()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .and_then(|output| nonempty(&output["task_name"]))
                        .filter(|path| path.starts_with('/') && path != "/");
                    if let Some(actor) = actor {
                        acknowledged.insert(actor.clone(), call_id.into());
                        relations.push(codex_collaboration_relation(
                            "spawn",
                            "started",
                            call_id,
                            &source_id,
                            &event_key,
                            expected_id,
                            actor_path.as_deref(),
                            Some(&actor),
                            Some(codex_tool_event(expected_id, call_id)),
                        ));
                    }
                }
            }
            if let Some(index) = payload["call_id"]
                .as_str()
                .and_then(|id| tool_calls.get(id))
            {
                messages[*index].tool_output = text_value(&payload["output"]).unwrap_or_default();
            }
        }
        if kind == "compacted"
            || (kind == "event_msg"
                && payload["type"] == "context_compacted"
                && last_compacted_line != Some(line_index.saturating_sub(1)))
        {
            messages.push(Message {
                id: format!("compaction-{line_index}"),
                fallback_prefix: None,
                legacy_agent_message: false,
                presentation_phase: None,
                role: "context",
                response_group,
                timestamp: compaction_timestamp,
                body: codex_compaction_content(payload),
                thinking: String::new(),
                tool_name: None,
                tool_metadata: None,
                tool_input: String::new(),
                tool_output: String::new(),
            });
        }
        if kind == "compacted" {
            last_compacted_line = Some(line_index);
        }
        execution.observe(&record, line_index);
        let payload_type = payload["type"].as_str();
        let (category, event_kind) = codex_event_vocabulary(kind, payload_type, payload);
        let reader_message = messages.get(messages_before).or_else(|| {
            if matches!(
                payload_type,
                Some("function_call_output" | "custom_tool_call_output")
            ) {
                payload["call_id"]
                    .as_str()
                    .and_then(|id| tool_calls.get(id))
                    .and_then(|index| messages.get(*index))
            } else {
                None
            }
        });
        let reader_event = reader_message.and_then(|message| {
            message_segments(message).first().map(|segment| EventRef {
                provider: "codex".into(),
                session_id: expected_id.into(),
                message_id: message.id.clone(),
                segment: (*segment).into(),
            })
        });
        protocol_candidates.push(EventCandidate {
            id: event_id,
            session: SessionRef {
                provider: "codex".into(),
                session_id: expected_id.into(),
            },
            source_order: SourceOrder {
                record: line_index as u64,
                ordinal: 0,
            },
            timestamp: event_timestamp,
            category: category.into(),
            kind: event_kind,
            provenance: Provenance {
                fidelity: Fidelity::Recorded,
                source_type: match payload_type {
                    _ if kind.is_empty() => String::new(),
                    Some(value) => format!("codex.{kind}:{value}"),
                    None => format!("codex.{kind}"),
                },
                source_id: Some(source_id),
            },
            reader_event,
            execution: None,
        });
        line_index += 1;
    }
    if id.as_deref() != Some(expected_id) {
        return Err(CoreError::Parse {
            path: path.into(),
            reason: "session_meta canonical ID differs from requested ID".into(),
        });
    }
    if let (Some(primary), Some(boundary)) = (primary_header_line, owned_boundary_line) {
        if parent_id.is_some() {
            let owned = |event_id: &str| {
                event_id
                    .strip_prefix("event:codex:")
                    .and_then(|value| value.parse::<usize>().ok())
                    .is_some_and(|index| index == primary || index >= boundary)
            };
            protocol_candidates.retain(|candidate| {
                let index = candidate.source_order.record as usize;
                index == primary || index >= boundary
            });
            protocol_parse_errors
                .retain(|diagnostic| diagnostic.event_id.as_deref().is_none_or(owned));
            observations
                .facts
                .tasks
                .retain(|fact| owned(&fact.evidence.event_id));
            observations
                .facts
                .agent_runs
                .retain(|fact| owned(&fact.evidence.event_id));
            observations
                .facts
                .run_observations
                .retain(|fact| owned(&fact.evidence.event_id));
            observations
                .facts
                .relationships
                .retain(|fact| owned(&fact.evidence.event_id));
            observations
                .facts
                .context_observations
                .retain(|fact| owned(&fact.evidence.event_id));
            observations
                .lifecycles
                .retain(|fact| owned(&fact.evidence.event_id));
            observations
                .facts
                .diagnostics
                .retain(|diagnostic| diagnostic.event_id.as_deref().is_none_or(owned));
            observations.copied_parent_prefix_excluded = true;
        }
    }
    let ownership_unavailable =
        parent_id.is_some() && owned_boundary_line.is_none() && copied_parent_header;
    if parent_id.is_some() && owned_boundary_line.is_none() {
        observations.facts.diagnostics.push(Diagnostic {
            code: "child_ownership_boundary_unavailable",
            event_id: None,
        });
    }
    deduplicate_hybrid_user_rows(&mut messages, legacy_user_rows, recorded_user_rows);
    let mut replacement_ids = HashMap::new();
    let mut next_fallback = 0;
    for message in &mut messages {
        if let Some(prefix) = message.fallback_prefix {
            let new_id = format!("{prefix}-{next_fallback}");
            replacement_ids.insert(message.id.clone(), new_id.clone());
            message.id = new_id;
            next_fallback += 1;
        }
    }
    let retained_refs: HashSet<_> = messages
        .iter()
        .flat_map(|message| {
            message_segments(message)
                .into_iter()
                .map(|segment| (message.id.clone(), segment))
        })
        .collect();
    for candidate in &mut protocol_candidates {
        if owned_boundary_line.is_some_and(|line| candidate.source_order.record < line as u64) {
            candidate.reader_event = None;
            continue;
        }
        if let Some(reference) = &mut candidate.reader_event {
            if let Some(new_id) = replacement_ids.get(&reference.message_id) {
                reference.message_id = new_id.clone();
            }
        }
        if candidate.reader_event.as_ref().is_some_and(|reference| {
            !retained_refs.contains(&(reference.message_id.clone(), reference.segment.as_str()))
        }) {
            candidate.reader_event = None;
        }
        if candidate
            .reader_event
            .as_ref()
            .is_some_and(|reference| reference.segment == "tool")
        {
            candidate.execution = execution
                .observations
                .remove(&(candidate.source_order.record as usize));
        }
    }
    observations.execution_observed = protocol_candidates
        .iter()
        .any(|event| event.execution.is_some());
    for relation in &mut relations {
        let RelationEntry::Coordination { observation } = relation else {
            continue;
        };
        if let Some(reference) = &mut observation.reader_event {
            if let Some(new_id) = replacement_ids.get(&reference.message_id) {
                reference.message_id = new_id.clone();
            }
            if !retained_refs.contains(&(reference.message_id.clone(), reference.segment.as_str()))
            {
                observation.reader_event = None;
            }
        }
    }
    let inherited_events = match (parent_id.as_ref(), primary_header_line, owned_boundary_line) {
        (Some(_), Some(primary), Some(boundary)) => {
            if let Some(decoded) = decoded {
                normalize_inherited_prefix(decoded, primary, boundary)
            } else {
                let prefix = codex_prefix(path, boundary)?;
                normalize_inherited_prefix(&prefix, primary, boundary)
            }
        }
        _ => Vec::new(),
    };
    let token_count = (parent_id.is_none() || owned_boundary_line.is_some())
        .then(|| codex_selected_token_count(&observations.usage, owned_boundary_line))
        .flatten();
    #[cfg(feature = "search-phase-probe")]
    {
        resource_probe.completed = true;
    }
    Ok(LoadedSession {
        id: expected_id.into(),
        cwd,
        created_at,
        updated_at,
        token_count,
        parent_id,
        agent_title,
        source_title,
        ownership_unavailable,
        owned_boundary_line,
        revision,
        messages,
        inherited_events,
        relations,
        spawn_activity,
        historical_targets,
        protocol_candidates,
        observations,
        protocol_parse_errors,
    })
}

fn codex_event_vocabulary(
    kind: &str,
    payload_type: Option<&str>,
    payload: &Value,
) -> (&'static str, String) {
    match (kind, payload_type) {
        ("", _) => ("source", "codex.unknown".into()),
        ("session_meta", _) => ("session", "session.meta".into()),
        ("response_item", Some("message")) => {
            let role = payload["role"].as_str().unwrap_or("unknown");
            ("message", format!("message.{role}"))
        }
        ("response_item", Some("reasoning")) => ("message", "message.reasoning".into()),
        ("response_item", Some("function_call" | "custom_tool_call")) => {
            ("tool", "tool.call".into())
        }
        ("response_item", Some("function_call_output" | "custom_tool_call_output")) => {
            ("tool", "tool.result".into())
        }
        ("event_msg", Some("user_message")) => ("message", "message.user".into()),
        ("event_msg", Some("agent_message")) => ("message", "message.assistant".into()),
        ("token_usage_record", _) => ("usage", "usage.recorded".into()),
        ("compacted", _) | ("event_msg", Some("context_compacted")) => {
            ("context", "context.compaction".into())
        }
        _ => ("source", format!("codex.{kind}")),
    }
}

#[cfg(test)]
fn codex_protocol_stream(path: &Path, scope: &str, session_id: &str) -> Result<EventStream> {
    codex_protocol_stream_with_sources(path, scope, session_id, None)
}

fn codex_protocol_stream_with_sources(
    path: &Path,
    scope: &str,
    session_id: &str,
    sources: Option<&CodexSources>,
) -> Result<EventStream> {
    let mut loaded = load_selected(path, scope, session_id, sources)?;
    if loaded.ownership_unavailable {
        return Err(CoreError::Unavailable(format!(
            "codex/{session_id}: copied parent history has no recorded child task boundary"
        )));
    }
    if !loaded.protocol_parse_errors.is_empty() {
        return Err(CoreError::Protocol(
            crate::protocol::ProtocolError::Invalid {
                diagnostics: loaded.protocol_parse_errors,
            },
        ));
    }
    if let Some(sources) = sources {
        codex_apply_child_revision(&mut loaded, sources);
        append_child_declarations(&mut loaded, sources, None);
    }
    finalize_events(
        SessionRef {
            provider: "codex".into(),
            session_id: session_id.into(),
        },
        scope.into(),
        loaded.revision,
        loaded.protocol_candidates,
    )
    .map_err(CoreError::Protocol)
}

#[cfg(test)]
fn codex_observation_snapshot(
    path: &Path,
    scope: &str,
    session_id: &str,
) -> Result<ObservationSnapshot> {
    Ok(codex_protocol_bundle(path, scope, session_id)?.into_observations())
}

#[cfg(test)]
fn codex_protocol_bundle(path: &Path, scope: &str, session_id: &str) -> Result<ProtocolBundle> {
    codex_protocol_bundle_with_sources(path, scope, session_id, None)
}

fn codex_protocol_bundle_with_sources(
    path: &Path,
    scope: &str,
    session_id: &str,
    sources: Option<&CodexSources>,
) -> Result<ProtocolBundle> {
    codex_protocol_bundle_with_sources_and_identities(path, scope, session_id, sources, None)
}

fn codex_protocol_bundle_with_sources_and_identities(
    path: &Path,
    scope: &str,
    session_id: &str,
    sources: Option<&CodexSources>,
    child_identities: Option<&SelectedChildIdentities>,
) -> Result<ProtocolBundle> {
    let mut loaded = load_selected(path, scope, session_id, sources)?;
    if loaded.ownership_unavailable {
        return Err(CoreError::Unavailable(format!(
            "codex/{session_id}: copied parent history has no recorded child task boundary"
        )));
    }
    if !loaded.protocol_parse_errors.is_empty() {
        return Err(CoreError::Protocol(
            crate::protocol::ProtocolError::Invalid {
                diagnostics: loaded.protocol_parse_errors,
            },
        ));
    }
    loaded.observations.facts.list_duration_range = codex_conversation_duration(&loaded.messages);
    if let Some(sources) = sources {
        resolve_spawn_children_with_identities(&mut loaded, sources, child_identities);
        for relation in &mut loaded.relations {
            let RelationEntry::Coordination { observation } = relation else {
                continue;
            };
            if observation.kind != "spawn" || observation.state != "started" {
                continue;
            }
            let Some(child) = observation.to_session_ref.as_ref() else {
                continue;
            };
            let verified = sources
                .get(&child.session_id)
                .and_then(|path| {
                    reader_parent_fact_from_path(path, &child.session_id)
                        .ok()
                        .flatten()
                })
                .is_some_and(|parent| {
                    parent.provider == "codex" && parent.session_id == session_id
                });
            if !verified {
                observation.to_session_ref = None;
            }
        }
    }
    let declarations = sources
        .map(|sources| append_child_declarations(&mut loaded, sources, child_identities))
        .unwrap_or_default();
    let event_times: HashMap<_, _> = loaded
        .protocol_candidates
        .iter()
        .map(|event| (event.id.clone(), event.timestamp))
        .collect();
    if let Some(sources) = sources {
        codex_apply_child_revision_with_identities(&mut loaded, sources, child_identities);
    }
    let stream = finalize_events(
        SessionRef {
            provider: "codex".into(),
            session_id: session_id.into(),
        },
        scope.into(),
        loaded.revision,
        loaded.protocol_candidates,
    )
    .map_err(CoreError::Protocol)?;
    let mut returned = HashMap::<&str, (&str, Option<i64>)>::new();
    for (relation_index, relation) in loaded.relations.iter().enumerate() {
        let RelationEntry::Coordination { observation } = relation else {
            continue;
        };
        if observation.kind == "result" && observation.state == "completed" {
            returned.entry(&observation.correlation_id).or_insert((
                observation.event_id.as_str(),
                if observation
                    .provenance
                    .source_type
                    .ends_with(":previous_status")
                {
                    None
                } else {
                    event_times.get(&observation.event_id).copied().flatten()
                },
            ));
        }
        loaded
            .observations
            .facts
            .coordination
            .push(CoordinationFact {
                id: format!("coordination:{}:{relation_index}", observation.event_id),
                kind: observation.kind.clone(),
                state: observation.state.clone(),
                correlation_id: observation.correlation_id.clone(),
                from_session_ref: observation.from_session_ref.clone(),
                to_session_ref: observation.to_session_ref.clone(),
                from_actor_path: observation.from_actor_path.clone(),
                to_actor_path: observation.to_actor_path.clone(),
                reader_event: observation.reader_event.clone(),
                evidence: Evidence {
                    event_id: observation.event_id.clone(),
                    provenance: Provenance {
                        fidelity: Fidelity::Recorded,
                        source_type: observation.provenance.source_type.clone(),
                        source_id: Some(observation.provenance.source_id.clone()),
                    },
                },
            });
    }
    let mut seen_spawns = HashSet::new();
    let mut seen_children = HashSet::new();
    for relation in &loaded.relations {
        let RelationEntry::Coordination { observation } = relation else {
            continue;
        };
        if observation.kind != "spawn" || observation.state != "requested" {
            continue;
        }
        let call_id = &observation.correlation_id;
        if !seen_spawns.insert(call_id.as_str()) {
            continue;
        }
        let start_event = observation.event_id.as_str();
        let start_time = event_times.get(start_event).copied().flatten();
        let terminal = returned.get(call_id.as_str()).copied();
        let failed = loaded.relations.iter().any(|relation| matches!(relation, RelationEntry::Coordination { observation } if observation.kind == "spawn" && observation.state == "failed" && observation.correlation_id == *call_id));
        if let Some(task) = loaded
            .observations
            .facts
            .tasks
            .iter_mut()
            .find(|task| task.id == *call_id)
        {
            if failed {
                task.status = RunStatus::Failed;
            } else if terminal.is_some() {
                task.status = RunStatus::Completed;
            }
        } else {
            loaded.observations.facts.tasks.push(TaskObservation {
                id: call_id.clone(),
                kind: "subagent-task".into(),
                status: if failed {
                    RunStatus::Failed
                } else if terminal.is_some() {
                    RunStatus::Completed
                } else {
                    RunStatus::Unknown
                },
                time_created: start_time,
                evidence: codex_relation_evidence(observation),
            });
        }
        let started = loaded.relations.iter().find_map(|relation| {
            let RelationEntry::Coordination {
                observation: candidate,
            } = relation
            else {
                return None;
            };
            (candidate.kind == "spawn"
                && candidate.state == "started"
                && candidate.correlation_id == *call_id
                && candidate.to_session_ref.is_some())
            .then_some(candidate)
        });
        let Some(started) = started else { continue };
        let child = started
            .to_session_ref
            .as_ref()
            .expect("verified child relation");
        if !seen_children.insert(child.session_id.clone()) {
            continue;
        }
        loaded
            .observations
            .facts
            .relationships
            .push(RelationshipObservation {
                id: format!("relationship:codex:spawn:{call_id}"),
                kind: "spawned".into(),
                from: SessionRef {
                    provider: "codex".into(),
                    session_id: session_id.into(),
                },
                to: child.clone(),
                correlation_id: Some(call_id.clone()),
                evidence: codex_verified_child_evidence(started),
            });
        // The child run is a separate source-backed fact; a session-turn is
        // never inferred from the spawn call.
        loaded
            .observations
            .facts
            .agent_runs
            .push(AgentRunObservation {
                id: format!("run:child:{}", child.session_id),
                kind: "subagent".into(),
                task_id: Some(call_id.clone()),
                turn_id: None,
                child_session_ref: Some(child.clone()),
                status: if terminal.is_some() {
                    RunStatus::Completed
                } else {
                    RunStatus::Unknown
                },
                pairing: if terminal.is_some() {
                    Pairing::Matched
                } else {
                    Pairing::Open
                },
                time_start: if started.to_actor_path.is_none() {
                    event_times.get(&started.event_id).copied().flatten()
                } else {
                    start_time
                },
                time_end: terminal.and_then(|(_, time)| time),
                evidence: codex_verified_child_evidence(if started.to_actor_path.is_none() {
                    started
                } else {
                    observation
                }),
                terminal_evidence: terminal.and_then(|(event_id, _)| {
                    loaded.relations.iter().find_map(|relation| {
                        let RelationEntry::Coordination {
                            observation: candidate,
                        } = relation
                        else {
                            return None;
                        };
                        (candidate.event_id == event_id).then(|| codex_relation_evidence(candidate))
                    })
                }),
            });
    }
    for (child, evidence) in declarations {
        if !seen_children.insert(child.session_id.clone()) {
            continue;
        }
        loaded
            .observations
            .facts
            .relationships
            .push(RelationshipObservation {
                id: format!("relationship:codex:declared:{}", child.session_id),
                kind: "spawned".into(),
                from: SessionRef {
                    provider: "codex".into(),
                    session_id: session_id.into(),
                },
                to: child.clone(),
                correlation_id: None,
                evidence: evidence.clone(),
            });
        loaded
            .observations
            .facts
            .agent_runs
            .push(AgentRunObservation {
                id: format!("run:child:{}", child.session_id),
                kind: "subagent".into(),
                task_id: None,
                turn_id: None,
                child_session_ref: Some(child),
                status: RunStatus::Unknown,
                pairing: Pairing::Unidentifiable,
                time_start: None,
                time_end: None,
                evidence,
                terminal_evidence: None,
            });
    }
    finalize_protocol_bundle(
        stream,
        loaded
            .observations
            .finish(session_id, loaded.owned_boundary_line),
    )
    .map_err(CoreError::Protocol)
}

#[derive(Debug)]
struct CodexUsageCandidate {
    index: usize,
    source_id: String,
    event_key: String,
    canonical_owner_matches_meta: bool,
    foreign_canonical_owner: bool,
    timestamp: Option<i64>,
    model: Option<String>,
    model_provider: Option<String>,
    response_id: Option<String>,
    turn_id: Option<String>,
    usage: Value,
    cumulative_usage: Option<Value>,
    source_type: &'static str,
}

fn codex_usage_payload(record: &Value) -> Option<&Value> {
    match (record["type"].as_str(), record["payload"]["type"].as_str()) {
        (Some("event_msg"), Some("token_count")) => record["payload"]["info"]["last_token_usage"]
            .is_object()
            .then_some(&record["payload"]["info"]["last_token_usage"]),
        (Some("token_usage_record"), _) => record["payload"]["usage"]
            .is_object()
            .then_some(&record["payload"]["usage"]),
        _ => None,
    }
}

fn codex_usage_tokens(usage: &Value, allow_zero: bool) -> Option<UsageTokenComponents> {
    let field =
        |first: &str, second: &str| usage[first].as_u64().or_else(|| usage[second].as_u64());
    let input_raw = field("input_tokens", "input");
    let cache_read = field("cached_input_tokens", "cache_read");
    let cache_write = field("cache_write_input_tokens", "cache_write").or_else(|| {
        // Native TokenUsage defaults omitted cache-write to zero; partial historical rows do not establish that schema.
        (usage.get("cache_write_input_tokens").is_none()
            && usage.get("cache_write").is_none()
            && [
                "input_tokens",
                "cached_input_tokens",
                "output_tokens",
                "reasoning_output_tokens",
                "total_tokens",
            ]
            .iter()
            .all(|name| usage[*name].as_u64().is_some()))
        .then_some(0)
    });
    let output_raw = field("output_tokens", "output");
    let reasoning_raw = field("reasoning_output_tokens", "reasoning");
    let recorded_total = field("total_tokens", "total");
    if !allow_zero
        && input_raw.unwrap_or(0) == 0
        && output_raw.unwrap_or(0) == 0
        && cache_read.unwrap_or(0) == 0
        && cache_write.unwrap_or(0) == 0
        && reasoning_raw.unwrap_or(0) == 0
        && recorded_total.unwrap_or(0) == 0
    {
        return None;
    }
    let input = input_raw
        .zip(cache_read)
        .zip(cache_write)
        .map(|((raw, read), write)| raw.saturating_sub(read).saturating_sub(write));
    let reasoning = reasoning_raw.map(|raw| raw.min(output_raw.unwrap_or(raw)));
    let output = output_raw
        .zip(reasoning)
        .map(|(raw, reasoning)| raw - reasoning);
    let total = recorded_total.or_else(|| input_raw?.checked_add(output_raw?));
    Some(UsageTokenComponents {
        input,
        cache_read,
        cache_write,
        output,
        reasoning,
        total,
    })
}

fn codex_observation_tokens(usage: &Value) -> UsageTokenComponents {
    let mut tokens = codex_usage_tokens(usage, true).expect("normalized Codex usage object");
    tokens.total = usage["total_tokens"]
        .as_u64()
        .or_else(|| usage["total"].as_u64());
    tokens
}

fn codex_selected_token_count(
    usage: &[CodexUsageCandidate],
    owned_boundary_line: Option<usize>,
) -> Option<u64> {
    let selected = codex_proved_usage(usage, owned_boundary_line);
    (!selected.is_empty())
        .then(|| {
            selected
                .iter()
                .try_fold(0u64, |total, (_, tokens)| total.checked_add(tokens.total?))
        })
        .flatten()
}

fn codex_proved_usage<'a>(
    usage: &'a [CodexUsageCandidate],
    owned_boundary_line: Option<usize>,
) -> Vec<(&'a CodexUsageCandidate, UsageTokenComponents)> {
    let owned = || {
        usage.iter().filter(|candidate| {
            owned_boundary_line.is_none_or(|boundary| candidate.index >= boundary)
                && !candidate.foreign_canonical_owner
        })
    };
    let mut request_tokens = HashMap::<String, UsageTokenComponents>::new();
    let mut conflicting_responses = HashSet::new();
    for candidate in owned() {
        if candidate.source_type != "codex.token_usage_record"
            || !candidate.canonical_owner_matches_meta
        {
            continue;
        }
        let (Some(response_id), Some(tokens)) = (
            candidate.response_id.as_ref(),
            codex_usage_tokens(&candidate.usage, false),
        ) else {
            continue;
        };
        if request_tokens
            .get(response_id)
            .is_some_and(|prior| prior != &tokens)
        {
            conflicting_responses.insert(response_id.clone());
        } else {
            request_tokens.insert(response_id.clone(), tokens);
        }
    }
    let mut selected_ids = HashSet::new();
    owned()
        .filter_map(|candidate| {
            let response_id = candidate.response_id.as_ref()?;
            if candidate.source_type != "codex.token_usage_record"
                || !candidate.canonical_owner_matches_meta
                || conflicting_responses.contains(response_id)
            {
                return None;
            }
            let tokens = codex_usage_tokens(&candidate.usage, false)?;
            if request_tokens.get(response_id) != Some(&tokens) || !selected_ids.insert(response_id)
            {
                return None;
            }
            Some((candidate, tokens))
        })
        .collect()
}

#[derive(Default, Debug)]
struct CodexObservations {
    facts: ObservationCandidates,
    lifecycles: Vec<RunObservation>,
    saw_primary_meta: bool,
    copied_parent_prefix_excluded: bool,
    execution_observed: bool,
    active_model: Option<String>,
    active_model_provider: Option<String>,
    usage_owner_id: Option<String>,
    usage: Vec<CodexUsageCandidate>,
}

impl CodexObservations {
    #[cfg(test)]
    fn observe(&mut self, record: &Value, index: usize, session_id: &str) {
        self.observe_positioned(
            record,
            index,
            session_id,
            &index.to_string(),
            &index.to_string(),
            record["timestamp"].as_str().and_then(timestamp_ms),
        );
    }

    fn observe_positioned(
        &mut self,
        record: &Value,
        index: usize,
        session_id: &str,
        source_id: &str,
        event_key: &str,
        timestamp: Option<i64>,
    ) {
        let kind = record["type"].as_str().unwrap_or("");
        let payload = &record["payload"];
        let payload_type = payload["type"].as_str().unwrap_or("");
        if kind == "event_msg"
            && payload_type == "token_count"
            && codex_usage_payload(record).is_none()
        {
            self.facts.diagnostics.push(Diagnostic {
                code: "codex_usage_payload_unavailable",
                event_id: Some(format!("event:codex:{event_key}")),
            });
        }
        if kind == "session_meta"
            && let Some(owner_id) =
                nonempty(&payload["id"]).or_else(|| nonempty(&payload["session_id"]))
            && self.usage_owner_id.as_deref() != Some(&owner_id)
        {
            self.active_model = None;
            self.active_model_provider = (owner_id == session_id)
                .then(|| nonempty(&payload["model_provider"]))
                .flatten();
            self.usage_owner_id = Some(owner_id);
        }
        if kind == "event_msg"
            && payload_type == "thread_settings_applied"
            && (payload["thread_id"].is_null()
                || payload["thread_id"].as_str() == self.usage_owner_id.as_deref())
        {
            if let Some(model) = nonempty(&payload["thread_settings"]["model"]) {
                self.active_model = Some(model);
                self.active_model_provider =
                    nonempty(&payload["thread_settings"]["model_provider_id"]);
            }
        }
        if let Some(usage) = codex_usage_payload(record) {
            let canonical_thread_id = (kind == "token_usage_record")
                .then(|| nonempty(&payload["thread_id"]))
                .flatten();
            self.usage.push(CodexUsageCandidate {
                index,
                source_id: source_id.into(),
                event_key: event_key.into(),
                canonical_owner_matches_meta: kind == "token_usage_record"
                    && canonical_thread_id.as_deref() == Some(session_id)
                    && canonical_thread_id == self.usage_owner_id,
                foreign_canonical_owner: canonical_thread_id
                    .as_deref()
                    .is_some_and(|owner| owner != session_id),
                timestamp,
                model: self.active_model.clone(),
                model_provider: self.active_model_provider.clone(),
                response_id: nonempty(&payload["response_id"])
                    .or_else(|| nonempty(&payload["info"]["response_id"])),
                turn_id: nonempty(&payload["turn_id"]),
                usage: usage.clone(),
                cumulative_usage: if kind == "token_usage_record" {
                    payload["thread_token_usage"]
                        .as_object()
                        .map(|_| payload["thread_token_usage"].clone())
                } else {
                    payload["info"]["total_token_usage"]
                        .as_object()
                        .map(|_| payload["info"]["total_token_usage"].clone())
                },
                source_type: if kind == "token_usage_record" {
                    "codex.token_usage_record"
                } else {
                    "codex.event_msg:token_count"
                },
            });
        }
        let evidence = || Evidence {
            event_id: format!("event:codex:{event_key}"),
            provenance: Provenance {
                fidelity: Fidelity::Recorded,
                source_type: if payload_type.is_empty() {
                    format!("codex.{kind}")
                } else {
                    format!("codex.{kind}:{payload_type}")
                },
                source_id: Some(source_id.into()),
            },
        };
        if kind == "session_meta" && !self.saw_primary_meta {
            self.saw_primary_meta = true;
            let spawn = &payload["source"]["subagent"]["thread_spawn"];
            let fork = nonempty(&payload["forked_from_id"]);
            let spawned_parent = nonempty(&spawn["parent_thread_id"]);
            let parent = spawned_parent
                .clone()
                .or_else(|| nonempty(&payload["parent_thread_id"]))
                .or_else(|| fork.clone());
            if let Some(parent) = parent {
                let spawned = spawned_parent.is_some() || payload["thread_source"] == "subagent";
                let relationship_kind = if fork.as_deref() == Some(&parent) {
                    "forked"
                } else if spawned {
                    "spawned"
                } else {
                    "parent"
                };
                let mut relation_evidence = evidence();
                if relationship_kind != "spawned" {
                    relation_evidence.provenance.fidelity = Fidelity::Derived;
                }
                self.facts.relationships.push(RelationshipObservation {
                    id: format!("relationship:codex:{index}"),
                    kind: relationship_kind.into(),
                    from: SessionRef {
                        provider: "codex".into(),
                        session_id: parent,
                    },
                    to: SessionRef {
                        provider: "codex".into(),
                        session_id: session_id.into(),
                    },
                    correlation_id: nonempty(&spawn["call_id"])
                        .or_else(|| nonempty(&spawn["parent_response_id"])),
                    evidence: relation_evidence,
                });
            }
        }
        if kind == "response_item" && payload_type == "agent_message" {
            let text = text_parts(&payload["content"]);
            let words = text.split_whitespace().collect::<Vec<_>>();
            if words.len() >= 3
                && words[0].eq_ignore_ascii_case("Message")
                && words[1].eq_ignore_ascii_case("Type:")
                && words[2].eq_ignore_ascii_case("NEW_TASK")
            {
                // A native task envelope is an assignment observation. Completion
                // and ownership require child/copy evidence not ported here.
                self.facts.tasks.push(TaskObservation {
                    id: nonempty(&payload["id"]).unwrap_or_else(|| format!("task-{index}")),
                    kind: "subagent-task".into(),
                    status: RunStatus::Unknown,
                    time_created: timestamp,
                    evidence: evidence(),
                });
            }
        }
        if kind == "event_msg"
            && matches!(
                payload_type,
                "task_started" | "task_complete" | "turn_aborted"
            )
        {
            let status = match payload_type {
                "task_complete" if payload["error"].is_object() => RunStatus::Failed,
                "task_complete" => RunStatus::Completed,
                "turn_aborted" => RunStatus::Cancelled,
                _ => RunStatus::Unknown,
            };
            self.lifecycles.push(RunObservation {
                id: format!("event:turn:{payload_type}:{index}"),
                kind: payload_type.into(),
                turn_id: nonempty(&payload["turn_id"]),
                run_id: None,
                pairing: Pairing::Unidentifiable,
                time_start: epoch_millis(&payload["started_at"]),
                time_end: epoch_millis(&payload["completed_at"]),
                timestamp,
                status,
                evidence: evidence(),
            });
        }
        let is_compaction = |value: &str| {
            value.eq_ignore_ascii_case("compacted")
                || value.eq_ignore_ascii_case("context_compacted")
                || value.eq_ignore_ascii_case("contextcompaction")
                || value.eq_ignore_ascii_case("compact")
        };
        if is_compaction(kind) || is_compaction(payload_type) {
            let source = if payload.is_object() { payload } else { record };
            self.facts.context_observations.push(ContextObservation {
                id: format!("context:codex:{index}"),
                kind: "compaction-record".into(),
                timestamp,
                trigger: None,
                pre_compact_tokens: None,
                window_id: nonempty(&source["window_id"]).or_else(|| nonempty(&source["windowId"])),
                previous_window_id: nonempty(&source["previous_window_id"])
                    .or_else(|| nonempty(&source["previousWindowId"])),
                first_window_id: nonempty(&source["first_window_id"])
                    .or_else(|| nonempty(&source["firstWindowId"])),
                summary_available: ["summary", "message", "summary_text"]
                    .iter()
                    .any(|key| nonempty(&source[*key]).is_some()),
                reader_event: None,
                evidence: evidence(),
            });
        }
    }

    fn finish(
        mut self,
        session_id: &str,
        owned_boundary_line: Option<usize>,
    ) -> ObservationCandidates {
        // The native v3 pairing key includes both turn ID and started_at.
        // Legacy terminals without started_at remain unidentifiable evidence.
        let mut keys = Vec::new();
        let mut starts = HashMap::<(String, i64), Vec<usize>>::new();
        let mut terminals = HashMap::<(String, i64), Vec<usize>>::new();
        for (index, observation) in self.lifecycles.iter().enumerate() {
            let (Some(turn), Some(start)) = (&observation.turn_id, observation.time_start) else {
                continue;
            };
            let key = (turn.clone(), start);
            if observation.kind == "task_started" {
                if !starts.contains_key(&key) {
                    keys.push(key.clone());
                }
                starts.entry(key).or_default().push(index);
            } else {
                terminals.entry(key).or_default().push(index);
            }
        }
        for key in &keys {
            let start_indices = &starts[key];
            let terminal_indices = terminals.get(key).map(Vec::as_slice).unwrap_or(&[]);
            let start = &self.lifecycles[start_indices[0]];
            let terminal = (start_indices.len() == 1 && terminal_indices.len() == 1)
                .then(|| &self.lifecycles[terminal_indices[0]]);
            let pairing = if start_indices.len() != 1 {
                Pairing::AmbiguousStart
            } else if terminal_indices.len() > 1 {
                Pairing::AmbiguousTerminal
            } else if terminal.is_some() {
                Pairing::Matched
            } else {
                Pairing::Open
            };
            self.facts.agent_runs.push(AgentRunObservation {
                id: format!("run:turn:{}:{}", key.0, key.1),
                kind: "session-turn".into(),
                task_id: None,
                turn_id: Some(key.0.clone()),
                child_session_ref: None,
                status: terminal.map_or(RunStatus::Unknown, |value| value.status),
                pairing,
                time_start: Some(key.1),
                time_end: terminal.and_then(|value| value.time_end),
                evidence: start.evidence.clone(),
                terminal_evidence: terminal.map(|value| value.evidence.clone()),
            });
        }
        for observation in &mut self.lifecycles {
            let (Some(turn), Some(start)) = (&observation.turn_id, observation.time_start) else {
                continue;
            };
            let key = (turn.clone(), start);
            let start_count = starts.get(&key).map_or(0, Vec::len);
            let terminal_count = terminals.get(&key).map_or(0, Vec::len);
            observation.pairing = if observation.kind == "task_started" {
                if start_count == 1 {
                    Pairing::UniqueStart
                } else {
                    Pairing::AmbiguousStart
                }
            } else if start_count == 0 {
                Pairing::OrphanTerminal
            } else if start_count == 1 && terminal_count == 1 {
                Pairing::Matched
            } else {
                Pairing::AmbiguousTerminal
            };
            if matches!(observation.pairing, Pairing::UniqueStart | Pairing::Matched) {
                observation.run_id = Some(format!("run:turn:{turn}:{start}"));
            }
        }
        self.facts.run_observations = self.lifecycles;
        let selected = codex_proved_usage(&self.usage, owned_boundary_line);
        let mut selected_indices = HashSet::new();
        for (candidate, tokens) in selected {
            selected_indices.insert(candidate.index);
            let source_id = candidate
                .response_id
                .clone()
                .expect("proved response identity");
            let run_id = candidate.turn_id.as_deref().and_then(|turn| {
                let mut runs = self
                    .facts
                    .agent_runs
                    .iter()
                    .filter(|run| run.turn_id.as_deref() == Some(turn));
                let run = runs.next()?;
                runs.next().is_none().then(|| run.id.clone())
            });
            self.facts.usage_records.push(UsageRecord {
                id: format!("usage:{session_id}:{source_id}"),
                scope: "request",
                session_ref: SessionRef {
                    provider: "codex".into(),
                    session_id: session_id.into(),
                },
                timestamp: candidate.timestamp,
                model: candidate.model.clone(),
                model_provider: candidate.model_provider.clone(),
                run_id,
                event_id: None,
                turn_id: candidate.turn_id.clone(),
                tokens,
                context_origin_slices: Vec::new(),
                provenance: Provenance {
                    fidelity: if candidate.model.is_some() {
                        Fidelity::Derived
                    } else {
                        Fidelity::Recorded
                    },
                    source_type: if candidate.model.is_some() {
                        format!("{}+thread_settings_applied", candidate.source_type)
                    } else {
                        candidate.source_type.into()
                    },
                    source_id: Some(source_id),
                },
            });
        }
        for candidate in &self.usage {
            if owned_boundary_line.is_some_and(|boundary| candidate.index < boundary)
                || candidate.foreign_canonical_owner
                || selected_indices.contains(&candidate.index)
            {
                continue;
            }
            self.facts.usage_observations.push(UsageObservation {
                id: format!("usage-observation:{session_id}:{}", candidate.event_key),
                session_ref: SessionRef {
                    provider: "codex".into(),
                    session_id: session_id.into(),
                },
                timestamp: candidate.timestamp,
                event_id: format!("event:codex:{}", candidate.event_key),
                tokens: codex_observation_tokens(&candidate.usage),
                cumulative_tokens: candidate
                    .cumulative_usage
                    .as_ref()
                    .map(codex_observation_tokens),
                provenance: Provenance {
                    fidelity: Fidelity::Recorded,
                    source_type: candidate.source_type.into(),
                    source_id: Some(candidate.source_id.clone()),
                },
            });
        }
        self.facts.coverage.insert("usage".into(), DomainCoverage {
            state: if self.facts.usage_records.is_empty()
                && self.facts.usage_observations.is_empty() {
                ObservationState::NotObserved
            } else {
                ObservationState::Observed
            },
            details: "Source-proved Codex response requests and separately retained unresolved usage occurrences after child ownership; cumulative turn and thread totals are excluded from request statistics.".into(),
        });
        for (domain, observed, details) in [
            (
                "tasks",
                !self.facts.tasks.is_empty(),
                "Native NEW_TASK assignments and recorded spawn_agent calls; only correlated FINAL_ANSWER delivery establishes spawn completion.",
            ),
            (
                "agentRuns",
                !self.facts.agent_runs.is_empty(),
                "Native session-turn lifecycles and verified direct child sessions; strict turn_id plus started_at pairing applies only to session turns.",
            ),
            (
                "relationships",
                !self.facts.relationships.is_empty(),
                "Primary session_meta parent, fork, and thread_spawn evidence plus direct children verified from spawn acknowledgement and child ownership.",
            ),
            (
                "context",
                !self.facts.context_observations.is_empty(),
                "Raw compaction observations and recorded window IDs only; paired-record deduplication, artifacts, content, and context transformations are unported.",
            ),
        ] {
            self.facts.coverage.insert(
                domain.into(),
                DomainCoverage {
                    state: if observed {
                        ObservationState::Observed
                    } else {
                        ObservationState::NotObserved
                    },
                    details: details.into(),
                },
            );
        }
        self.facts.coverage.insert("coordination".into(), DomainCoverage {
            state: if self.facts.coordination.is_empty() {
                ObservationState::Unknown
            } else {
                ObservationState::Observed
            },
            details: "Recorded spawn call, exact call_id acknowledgement, and matched FINAL_ANSWER delivery; direct canonical child links require verified child ownership.".into(),
        });
        self.facts.coverage.insert("ownership".into(), DomainCoverage {
            state: if self.copied_parent_prefix_excluded {
                ObservationState::Observed
            } else {
                ObservationState::Unknown
            },
            details: if self.copied_parent_prefix_excluded {
                "Recorded child task boundary excludes copied parent records from owned protocol events and observations."
            } else {
                "Copied parent history remains unclassified without a recorded child boundary."
            }.into(),
        });
        self.facts.coverage.insert("execution".into(), DomainCoverage {
            state: if self.execution_observed {
                ObservationState::Observed
            } else {
                ObservationState::Unknown
            },
            details: "Recorded outer async exec/wait and direct terminal process phases with exact call_id and handle correlation; no nested JavaScript execution inference.".into(),
        });
        for (domain, details) in [
            (
                "work",
                "Goals, task lifecycle, and work graph are unported.",
            ),
            (
                "sessionProtocolV2",
                "A validated partial Session Protocol v2 foundation is available; full domain parity remains open.",
            ),
            (
                "sessionProtocolV3",
                "These native observations are partial; a complete same-source Session Protocol v3 snapshot remains open.",
            ),
        ] {
            self.facts.coverage.insert(
                domain.into(),
                DomainCoverage {
                    state: ObservationState::Unknown,
                    details: details.into(),
                },
            );
        }
        self.facts
    }
}

fn nonempty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn final_answer_body(text: &str, author: &str) -> Option<String> {
    let mut lines = text.splitn(5, '\n');
    if lines.next()?.trim_end_matches('\r') != "Message Type: FINAL_ANSWER"
        || lines
            .next()?
            .trim_end_matches('\r')
            .strip_prefix("Task name: ")?
            .is_empty()
        || lines
            .next()?
            .trim_end_matches('\r')
            .strip_prefix("Sender: ")?
            != author
        || lines.next()?.trim_end_matches('\r') != "Payload:"
    {
        return None;
    }
    let body = lines.next()?;
    (!body.is_empty()).then(|| body.into())
}

fn codex_tool_event(session_id: &str, call_id: &str) -> EventRef {
    EventRef {
        provider: "codex".into(),
        session_id: session_id.into(),
        message_id: call_id.into(),
        segment: "tool".into(),
    }
}

fn codex_relation_evidence(observation: &CoordinationObservation) -> Evidence {
    Evidence {
        event_id: observation.event_id.clone(),
        provenance: Provenance {
            fidelity: Fidelity::Recorded,
            source_type: observation.provenance.source_type.clone(),
            source_id: Some(observation.provenance.source_id.clone()),
        },
    }
}

fn codex_verified_child_evidence(observation: &CoordinationObservation) -> Evidence {
    let mut evidence = codex_relation_evidence(observation);
    evidence.provenance.fidelity = Fidelity::Derived;
    evidence
        .provenance
        .source_type
        .push_str("+verified_child_header");
    evidence
}

fn historical_spawn_failure(output: &str) -> bool {
    matches!(
        output,
        "Full-history forked agents inherit the parent agent type, model, and reasoning effort; omit agent_type, model, and reasoning_effort, or spawn without a full-history fork."
            | "Provide either message or items, but not both"
    )
}

#[allow(clippy::too_many_arguments)]
fn historical_relation(
    relations: &mut Vec<RelationEntry>,
    targets: &mut HashMap<usize, String>,
    kind: &str,
    state: &str,
    correlation: &str,
    source_id: &str,
    event_key: &str,
    session_id: &str,
    reader_call: &str,
    target: Option<&str>,
    output: bool,
) {
    if let Some(target) = target {
        targets.insert(relations.len(), target.into());
    }
    let mut entry = codex_collaboration_relation(
        kind,
        state,
        correlation,
        source_id,
        event_key,
        session_id,
        None,
        None,
        Some(codex_tool_event(session_id, reader_call)),
    );
    let RelationEntry::Coordination { observation } = &mut entry else {
        unreachable!()
    };
    observation.provenance.source_type = if output {
        "codex.response_item:function_call_output"
    } else {
        "codex.response_item:function_call"
    }
    .into();
    relations.push(entry);
}

// Keep recorded arguments intact; adapter-owned presentation gives Reader
// short execution summaries and marks the recorded encrypted task token.
fn codex_tool_metadata(payload: &Value) -> Option<crate::ReaderToolMetadata> {
    let presentation = tool_presentation::tool_presentation(payload);
    let spawn = payload["name"] == "spawn_agent"
        && matches!(
            payload["namespace"].as_str(),
            Some("collaboration" | "multi_agent_v1")
        );
    if !spawn && presentation.summary.is_none() && presentation.directory.is_none() {
        return None;
    }
    let args = if spawn {
        Some(serde_json::from_str::<Value>(payload["arguments"].as_str()?).ok()?)
    } else {
        None
    };
    let launch = args.as_ref().and_then(codex_launch_request);
    let encrypted = args.as_ref().is_some_and(|args| {
        args["message"]
            .as_str()
            .is_some_and(|message| message.starts_with("gAAAAA"))
            || has_encrypted_content(&args["items"])
    });
    Some(crate::ReaderToolMetadata {
        summary: presentation.summary,
        directory: presentation.directory,
        task_name: args.as_ref().and_then(|args| nonempty(&args["task_name"])),
        model: launch.as_ref().and_then(|request| request.model.clone()),
        reasoning_effort: launch
            .as_ref()
            .and_then(|request| request.reasoning_effort.clone()),
        fork_turns: launch.and_then(|request| request.fork_turns),
        input_state: if encrypted {
            crate::ReaderToolInputState::Encrypted
        } else {
            crate::ReaderToolInputState::Recorded
        },
    })
}

fn codex_launch_request(args: &Value) -> Option<CollaborationLaunchRequest> {
    let request = CollaborationLaunchRequest {
        model: nonempty(&args["model"]),
        reasoning_effort: nonempty(&args["reasoning_effort"]),
        fork_turns: nonempty(&args["fork_turns"]),
    };
    (request.model.is_some() || request.reasoning_effort.is_some() || request.fork_turns.is_some())
        .then_some(request)
}

fn codex_collaboration_relation(
    kind: &str,
    state: &str,
    call_id: &str,
    source_id: &str,
    event_key: &str,
    session_id: &str,
    from_actor_path: Option<&str>,
    to_actor_path: Option<&str>,
    reader_event: Option<EventRef>,
) -> RelationEntry {
    RelationEntry::Coordination {
        observation: CoordinationObservation {
            kind: kind.into(),
            state: state.into(),
            correlation_id: call_id.into(),
            event_id: format!("event:codex:{event_key}"),
            from_session_ref: (kind != "result").then(|| SessionRef {
                provider: "codex".into(),
                session_id: session_id.into(),
            }),
            to_session_ref: (kind == "result").then(|| SessionRef {
                provider: "codex".into(),
                session_id: session_id.into(),
            }),
            from_participant: None,
            to_participant: None,
            message_excerpt: None,
            message_excerpt_truncated: None,
            launch_request: None,
            from_actor_path: from_actor_path.map(str::to_owned),
            to_actor_path: to_actor_path.map(str::to_owned),
            reader_event,
            provenance: RelationProvenance {
                fidelity: "recorded".into(),
                source_type: match (kind, state) {
                    ("spawn", "requested") => "codex.response_item:function_call",
                    ("spawn", "started") => "codex.response_item:function_call_output",
                    ("result", "completed") => "codex.response_item:agent_message:FINAL_ANSWER",
                    ("wait", "waiting") => "codex.response_item:function_call",
                    ("wait", "timed_out" | "returned") => {
                        "codex.response_item:function_call_output"
                    }
                    ("close" | "resume", "requested") | ("input", "sent") => {
                        "codex.response_item:function_call"
                    }
                    ("spawn", "failed")
                    | ("close", "closed")
                    | ("resume", "returned")
                    | ("input", "submitted") => "codex.response_item:function_call_output",
                    _ => unreachable!(
                        "Codex collaboration relation kind and state are provider owned"
                    ),
                }
                .into(),
                source_id: source_id.into(),
            },
        },
    }
}

fn epoch_millis(value: &Value) -> Option<i64> {
    let millis = value.as_f64()? * 1000.0;
    (millis.is_finite() && millis >= i64::MIN as f64 && millis < i64::MAX as f64)
        .then_some(millis as i64)
}

fn message_id(payload: &Value, prefix: &str, next: &mut usize) -> String {
    payload["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let id = format!("{prefix}-{}", *next);
            *next += 1;
            id
        })
}

fn normalize_user_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Clone)]
struct CodexExecutionCall {
    name: &'static str,
    record: usize,
    handle: Option<String>,
}

#[derive(Default)]
struct CodexExecutionTracker {
    calls: HashMap<String, CodexExecutionCall>,
    active_by_handle: HashMap<String, String>,
    wait_executions: HashMap<String, String>,
    process_starts: HashMap<String, (usize, Option<String>)>,
    active_processes: HashMap<String, String>,
    process_continuations: HashMap<String, (String, String)>,
    observations: HashMap<usize, ExecutionObservation>,
}

impl CodexExecutionTracker {
    fn add(
        &mut self,
        record: usize,
        id: &str,
        phase: ExecutionPhase,
        handle: &str,
        tool_name: &str,
    ) {
        self.observations.insert(
            record,
            ExecutionObservation {
                id: id.into(),
                kind: ExecutionKind::AsyncTool,
                phase,
                handle: handle.into(),
                tool_name: tool_name.into(),
                label: None,
            },
        );
    }

    fn add_process(
        &mut self,
        record: usize,
        id: &str,
        phase: ExecutionPhase,
        handle: &str,
        tool_name: &str,
        label: Option<String>,
    ) {
        self.observations.insert(
            record,
            ExecutionObservation {
                id: id.into(),
                kind: ExecutionKind::Process,
                phase,
                handle: handle.into(),
                tool_name: tool_name.into(),
                label,
            },
        );
    }

    fn observe_process(&mut self, payload: &Value, index: usize, call_id: &str) {
        let payload_type = payload["type"].as_str();
        if payload_type == Some("function_call") {
            if !payload["namespace"].is_null() && payload["namespace"] != "" {
                return;
            }
            if !matches!(
                payload["name"].as_str(),
                Some("exec_command" | "write_stdin")
            ) {
                return;
            }
            let Some(args) = payload["arguments"]
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .filter(Value::is_object)
            else {
                return;
            };
            if payload["name"] == "exec_command" {
                let label = args["cmd"]
                    .as_str()
                    .map(normalize_user_text)
                    .map(|cmd| cmd.chars().take(120).collect::<String>())
                    .filter(|cmd| !cmd.is_empty());
                self.process_starts.insert(call_id.into(), (index, label));
            } else if payload["name"] == "write_stdin" {
                let handle = args["session_id"].as_str().map(str::to_owned).or_else(|| {
                    args["session_id"]
                        .is_number()
                        .then(|| args["session_id"].to_string())
                });
                let Some(handle) = handle else { return };
                let Some(execution_id) = self.active_processes.get(&handle).cloned() else {
                    return;
                };
                if args.get("chars").is_some_and(|chars| !chars.is_string()) {
                    return;
                }
                let chars = args["chars"].as_str().unwrap_or("");
                let phase = if chars.contains('\u{0003}') {
                    ExecutionPhase::InterruptionRequested
                } else if chars.is_empty() {
                    ExecutionPhase::Polled
                } else {
                    ExecutionPhase::Input
                };
                self.process_continuations
                    .insert(call_id.into(), (execution_id.clone(), handle.clone()));
                self.add_process(index, &execution_id, phase, &handle, "write_stdin", None);
            }
            return;
        }
        if payload_type != Some("function_call_output")
            || (!self.process_starts.contains_key(call_id)
                && !self.process_continuations.contains_key(call_id))
        {
            return;
        }
        let header = codex_execution_first_header(&payload["output"]);
        let running = header.as_deref().and_then(codex_process_running_handle);
        if let Some((start_index, label)) = self.process_starts.get(call_id).cloned() {
            let Some(handle) =
                running.filter(|handle| !self.active_processes.contains_key(*handle))
            else {
                return;
            };
            self.add_process(
                start_index,
                call_id,
                ExecutionPhase::Started,
                handle,
                "exec_command",
                label,
            );
            self.add_process(
                index,
                call_id,
                ExecutionPhase::Yielded,
                handle,
                "exec_command",
                None,
            );
            self.active_processes.insert(handle.into(), call_id.into());
            self.process_starts.remove(call_id);
            return;
        }
        let Some((execution_id, handle)) = self.process_continuations.get(call_id).cloned() else {
            return;
        };
        if self.active_processes.get(&handle) != Some(&execution_id) {
            return;
        }
        let phase = if running == Some(handle.as_str()) {
            Some(ExecutionPhase::Yielded)
        } else {
            header
                .as_deref()
                .and_then(codex_process_exit_code)
                .map(|code| {
                    if code == 0 {
                        ExecutionPhase::Completed
                    } else {
                        ExecutionPhase::Failed
                    }
                })
        };
        if let Some(phase) = phase {
            self.add_process(index, &execution_id, phase, &handle, "write_stdin", None);
            self.process_continuations.remove(call_id);
            if matches!(phase, ExecutionPhase::Completed | ExecutionPhase::Failed) {
                self.active_processes.remove(&handle);
            }
        }
    }

    fn observe(&mut self, record: &Value, index: usize) {
        if record["type"] != "response_item" {
            return;
        }
        let payload = &record["payload"];
        let Some(call_id) = payload["call_id"].as_str().filter(|id| !id.is_empty()) else {
            return;
        };
        self.observe_process(payload, index, call_id);
        let payload_type = payload["type"].as_str();
        if matches!(payload_type, Some("custom_tool_call" | "function_call")) {
            if !payload["namespace"].is_null() && payload["namespace"] != "" {
                return;
            }
            if payload_type == Some("custom_tool_call") && payload["name"] == "exec" {
                self.calls.insert(
                    call_id.into(),
                    CodexExecutionCall {
                        name: "exec",
                        record: index,
                        handle: None,
                    },
                );
            } else if payload_type == Some("function_call") && payload["name"] == "wait" {
                let args = payload["arguments"]
                    .as_str()
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    .filter(Value::is_object);
                let handle = args
                    .as_ref()
                    .and_then(|args| {
                        args["cell_id"].as_str().map(str::to_owned).or_else(|| {
                            args["cell_id"]
                                .is_number()
                                .then(|| args["cell_id"].to_string())
                        })
                    })
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty());
                let Some(handle) = handle else { return };
                if let Some(execution_id) = self.active_by_handle.get(&handle).cloned() {
                    self.calls.insert(
                        call_id.into(),
                        CodexExecutionCall {
                            name: "wait",
                            record: index,
                            handle: Some(handle.clone()),
                        },
                    );
                    self.wait_executions
                        .insert(call_id.into(), execution_id.clone());
                    let phase = if args.as_ref().is_some_and(|args| args["terminate"] == true) {
                        ExecutionPhase::InterruptionRequested
                    } else {
                        ExecutionPhase::Polled
                    };
                    self.add(index, &execution_id, phase, &handle, "wait");
                }
            }
            return;
        }
        if !matches!(
            payload_type,
            Some("custom_tool_call_output" | "function_call_output")
        ) {
            return;
        }
        let Some(call) = self.calls.get(call_id).cloned() else {
            return;
        };
        let header = codex_execution_first_header(&payload["output"]);
        if call.name == "exec" && payload_type == Some("custom_tool_call_output") {
            let Some(handle) = header
                .as_deref()
                .and_then(codex_running_handle)
                .filter(|handle| !self.active_by_handle.contains_key(*handle))
            else {
                return;
            };
            self.add(
                call.record,
                call_id,
                ExecutionPhase::Started,
                &handle,
                "exec",
            );
            self.add(index, call_id, ExecutionPhase::Yielded, &handle, "exec");
            self.active_by_handle.insert(handle.into(), call_id.into());
            self.calls.remove(call_id);
        } else if call.name == "wait" && payload_type == Some("function_call_output") {
            let Some(handle) = call.handle else { return };
            let Some(execution_id) = self.wait_executions.get(call_id).cloned() else {
                return;
            };
            if self.active_by_handle.get(&handle) != Some(&execution_id) {
                return;
            }
            let phase = if header.as_deref().and_then(codex_running_handle).as_deref()
                == Some(handle.as_str())
            {
                Some(ExecutionPhase::Yielded)
            } else if header
                .as_deref()
                .is_some_and(|value| codex_terminal_header(value, "Script completed"))
            {
                Some(ExecutionPhase::Completed)
            } else if header
                .as_deref()
                .is_some_and(|value| codex_terminal_header(value, "Script failed"))
            {
                Some(ExecutionPhase::Failed)
            } else {
                None
            };
            if let Some(phase) = phase {
                self.add(index, &execution_id, phase, &handle, "wait");
                self.calls.remove(call_id);
                self.wait_executions.remove(call_id);
                if matches!(phase, ExecutionPhase::Completed | ExecutionPhase::Failed) {
                    self.active_by_handle.remove(&handle);
                }
            }
        }
    }
}

const EXECUTION_HEADER_MAX_BYTES: usize = 4096;

fn codex_execution_first_header(value: &Value) -> Option<Cow<'_, str>> {
    let first = if let Some(array) = value.as_array() {
        array.first()
    } else {
        let text = value.as_str()?;
        let bytes = text.as_bytes();
        let Some(mut index) = bytes
            .iter()
            .take(EXECUTION_HEADER_MAX_BYTES)
            .position(|byte| !byte.is_ascii_whitespace())
        else {
            return Some(Cow::Borrowed(text));
        };
        if bytes[index] != b'[' {
            return Some(Cow::Borrowed(text));
        }
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_whitespace)
            && index < EXECUTION_HEADER_MAX_BYTES
        {
            index += 1;
        }
        if bytes.get(index) != Some(&b'{') {
            return None;
        }
        let start = index;
        let mut depth = 0usize;
        let mut quoted = false;
        let mut escaped = false;
        for (offset, byte) in bytes[start..].iter().enumerate() {
            if quoted {
                if escaped {
                    escaped = false;
                } else if *byte == b'\\' {
                    escaped = true;
                } else if *byte == b'"' {
                    quoted = false;
                }
            } else if *byte == b'"' {
                quoted = true;
            } else if *byte == b'{' {
                depth += 1;
            } else if *byte == b'}' {
                depth -= 1;
                if depth == 0 {
                    let first: Value =
                        serde_json::from_str(&text[start..start + offset + 1]).ok()?;
                    let text = codex_execution_text_block(&first)?;
                    let header_end = text
                        .as_bytes()
                        .iter()
                        .take(EXECUTION_HEADER_MAX_BYTES)
                        .enumerate()
                        .filter_map(|(index, byte)| (*byte == b'\n').then_some(index))
                        .nth(2)?;
                    return Some(Cow::Owned(text[..=header_end].into()));
                }
            }
        }
        return None;
    }?;
    codex_execution_text_block(first).map(Cow::Borrowed)
}

fn codex_execution_text_block(value: &Value) -> Option<&str> {
    matches!(
        value["type"].as_str(),
        Some("input_text" | "output_text" | "text")
    )
    .then(|| value["text"].as_str())
    .flatten()
}

fn codex_header_lines(header: &str) -> Option<(&str, &str, &str)> {
    let (first, wall, output) = codex_bounded_three_lines(header)?;
    if !codex_valid_wall_time(wall, "Wall time ") || output != "Output:" {
        return None;
    }
    Some((first, wall, output))
}

fn codex_bounded_three_lines(header: &str) -> Option<(&str, &str, &str)> {
    let mut ends = header
        .as_bytes()
        .iter()
        .take(EXECUTION_HEADER_MAX_BYTES)
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b'\n').then_some(index));
    let first_end = ends.next()?;
    let wall_end = ends.next()?;
    let output_end = ends.next()?;
    let first = header[..first_end].trim_end_matches('\r');
    let wall = header[first_end + 1..wall_end].trim_end_matches('\r');
    let third = header[wall_end + 1..output_end].trim_end_matches('\r');
    Some((first, wall, third))
}

fn codex_valid_wall_time(wall: &str, prefix: &str) -> bool {
    let Some(time) = wall
        .strip_prefix(prefix)
        .and_then(|wall| wall.strip_suffix(" seconds"))
    else {
        return false;
    };
    let mut parts = time.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    !whole.is_empty()
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction
            .is_none_or(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && parts.next().is_none()
}

fn codex_process_running_handle(header: &str) -> Option<&str> {
    let (chunk, wall, status) = codex_bounded_three_lines(header)?;
    if chunk.strip_prefix("Chunk ID: ").is_none_or(str::is_empty)
        || !codex_valid_wall_time(wall, "Wall time: ")
    {
        return None;
    }
    let handle = status.strip_prefix("Process running with session ID ")?;
    (!handle.is_empty() && handle.bytes().all(|byte| byte.is_ascii_digit())).then_some(handle)
}

fn codex_process_exit_code(header: &str) -> Option<i64> {
    let (chunk, wall, status) = codex_bounded_three_lines(header)?;
    if chunk.strip_prefix("Chunk ID: ").is_none_or(str::is_empty)
        || !codex_valid_wall_time(wall, "Wall time: ")
    {
        return None;
    }
    let code = status.strip_prefix("Process exited with code ")?;
    let digits = code.strip_prefix('-').unwrap_or(code);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    code.parse().ok()
}

fn codex_running_handle(header: &str) -> Option<&str> {
    let (first, _, _) = codex_header_lines(header)?;
    first
        .strip_prefix("Script running with cell ID ")
        .map(str::trim)
        .filter(|handle| !handle.is_empty())
}

fn codex_terminal_header(header: &str, expected: &str) -> bool {
    codex_header_lines(header).is_some_and(|(first, _, _)| first == expected)
}

fn flat_title(text: &str) -> String {
    normalize_user_text(text).chars().take(120).collect()
}

fn question_reply_text(text: &str) -> Option<String> {
    let content = text
        .trim()
        .strip_prefix("<send_user_message_question_reply>")?
        .strip_suffix("</send_user_message_question_reply>")?
        .trim();
    let answers: Value = serde_json::from_str(content).ok()?;
    let rows = answers.as_array()?;
    if rows.is_empty()
        || rows.iter().any(|row| {
            !row["questionItemId"].is_string()
                || !row["question"].is_string()
                || !row["answer"].is_string()
        })
    {
        return None;
    }
    Some(
        rows.iter()
            .flat_map(|row| {
                [
                    row["question"].as_str().unwrap(),
                    row["answer"].as_str().unwrap(),
                ]
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
    )
}

fn is_task_envelope(payload: &Value) -> bool {
    text_parts(&payload["content"])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
        .starts_with("message type: new_task")
}

fn has_encrypted_content(value: &Value) -> bool {
    if value["type"] == "encrypted_content" {
        return true;
    }
    value
        .as_array()
        .is_some_and(|items| items.iter().any(has_encrypted_content))
        || value["content"]
            .as_array()
            .is_some_and(|items| items.iter().any(has_encrypted_content))
}

fn task_body(payload: &Value) -> (String, Option<String>) {
    let text = text_parts(&payload["content"])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let lower = text.to_ascii_lowercase();
    let task_name = lower.find("task name:").and_then(|index| {
        text[index + "task name:".len()..]
            .split_whitespace()
            .next()
            .map(str::to_owned)
    });
    if has_encrypted_content(&payload["content"]) {
        let prefix = task_name.as_ref().map_or_else(
            || "Subagent task".to_owned(),
            |name| format!("Subagent task: {name}"),
        );
        (
            format!(
                "{prefix}\n\nThe task body is encrypted in the Codex transcript and cannot be recovered locally."
            ),
            task_name,
        )
    } else {
        (text, task_name)
    }
}

fn deduplicate_hybrid_user_rows(
    messages: &mut Vec<Message>,
    legacy_rows: Vec<(String, usize, usize)>,
    recorded_rows: Vec<(String, usize, usize)>,
) {
    let recorded_texts: HashSet<_> = recorded_rows.into_iter().map(|(text, _, _)| text).collect();
    let duplicate_message_indices: HashSet<_> = legacy_rows
        .into_iter()
        .filter(|(text, _, _)| recorded_texts.contains(text))
        .map(|(_, _, message_index)| message_index)
        .collect();

    let mut message_index = 0usize;
    messages.retain(|_| {
        let keep = !duplicate_message_indices.contains(&message_index);
        message_index += 1;
        keep
    });
}

fn text_parts(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    let Some(parts) = value.as_array() else {
        return String::new();
    };
    let mut text = String::new();
    for part in parts {
        append_text_part(part, &mut text);
    }
    text
}

fn normalize_inherited_prefix(
    decoded: &[u8],
    primary_header_line: usize,
    boundary: usize,
) -> Vec<InheritedEvent> {
    #[cfg(test)]
    INHERITED_PARSE_COUNT.with(|count| count.set(count.get() + 1));
    let mut events = Vec::new();
    let mut tool_calls = HashMap::<String, usize>::new();
    let recorded_user_texts: HashSet<String> = decoded
        .split(|byte| *byte == b'\n')
        .enumerate()
        .take(boundary)
        .filter(|(line_index, _)| *line_index > primary_header_line)
        .filter_map(|(_, line)| serde_json::from_slice::<Value>(line).ok())
        .filter(|record| {
            record["type"] == "response_item"
                && record["payload"]["type"] == "message"
                && record["payload"]["role"] == "user"
                && record["payload"]["internal_chat_message_metadata_passthrough"]
                    ["content_item_kinds"]
                    .as_array()
                    .is_some_and(|kinds| kinds.iter().any(|kind| kind == "user.text"))
        })
        .map(|record| normalize_user_text(&text_parts(&record["payload"]["content"])))
        .filter(|text| !text.is_empty())
        .collect();
    for (line_index, line) in decoded
        .split(|byte| *byte == b'\n')
        .enumerate()
        .take(boundary)
    {
        if line_index <= primary_header_line {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let payload = &record["payload"];
        let timestamp = record["timestamp"].as_str().and_then(timestamp_ms);
        let fallback = || format!("inherited-{line_index}");
        match (record["type"].as_str(), payload["type"].as_str()) {
            (Some("response_item"), Some("message")) => {
                let body = text_parts(&payload["content"]);
                if body.is_empty() {
                    continue;
                }
                let source_role = payload["role"].as_str().unwrap_or("");
                let role = match source_role {
                    "assistant" => "assistant",
                    "user" if payload["internal_chat_message_metadata_passthrough"]["content_item_kinds"]
                        .as_array().is_some_and(|kinds| kinds.iter().any(|kind| kind == "user.text")) => "user",
                    "user" | "developer" | "system" => "system",
                    _ => continue,
                };
                push_inherited(
                    &mut events,
                    payload["id"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(fallback),
                    "message",
                    role,
                    timestamp,
                    body,
                    None,
                    String::new(),
                    String::new(),
                );
            }
            (Some("response_item"), Some("reasoning")) => {
                let body = text_parts(if payload["summary"].is_array() {
                    &payload["summary"]
                } else {
                    &payload["content"]
                });
                if body.is_empty() {
                    continue;
                }
                push_inherited(
                    &mut events,
                    payload["id"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(fallback),
                    "thinking",
                    "assistant",
                    timestamp,
                    body,
                    None,
                    String::new(),
                    String::new(),
                );
            }
            (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
                let call_id = payload["call_id"].as_str().map(str::to_owned);
                let message_id = call_id
                    .clone()
                    .or_else(|| payload["id"].as_str().map(str::to_owned))
                    .unwrap_or_else(fallback);
                let tool_name = payload["name"].as_str().map(str::to_owned);
                let input = text_value(&payload["arguments"])
                    .or_else(|| text_value(&payload["input"]))
                    .unwrap_or_default();
                let index = events.len();
                push_inherited(
                    &mut events,
                    message_id,
                    "tool",
                    "tool",
                    timestamp,
                    String::new(),
                    tool_name,
                    input,
                    String::new(),
                );
                if let Some(call_id) = call_id {
                    tool_calls.insert(call_id, index);
                }
            }
            (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
                if let Some(index) = payload["call_id"]
                    .as_str()
                    .and_then(|id| tool_calls.get(id))
                {
                    let output = text_value(&payload["output"]).unwrap_or_default();
                    events[*index].tool_output = output.clone();
                    events[*index].item.total_chars = output.encode_utf16().count();
                    events[*index].item.preview = format!(
                        "{}: {}",
                        events[*index].item.tool_name.as_deref().unwrap_or("tool"),
                        preview(&output)
                    );
                }
            }
            (Some("event_msg"), Some("user_message" | "agent_message")) => {
                let role = if payload["type"] == "user_message" {
                    "user"
                } else {
                    "assistant"
                };
                let body = payload["message"].as_str().unwrap_or("");
                if body.is_empty() {
                    continue;
                }
                if role == "user" && recorded_user_texts.contains(&normalize_user_text(body)) {
                    continue;
                }
                push_inherited(
                    &mut events,
                    payload["id"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(fallback),
                    "message",
                    role,
                    timestamp,
                    body.into(),
                    None,
                    String::new(),
                    String::new(),
                );
            }
            (Some("event_msg"), Some("agent_reasoning")) => {
                let body = payload["text"].as_str().unwrap_or("");
                if body.is_empty() {
                    continue;
                }
                push_inherited(
                    &mut events,
                    payload["id"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(fallback),
                    "thinking",
                    "assistant",
                    timestamp,
                    body.into(),
                    None,
                    String::new(),
                    String::new(),
                );
            }
            _ => {}
        }
    }
    events
}

fn push_inherited(
    events: &mut Vec<InheritedEvent>,
    message_id: String,
    segment: &str,
    role: &str,
    timestamp: Option<i64>,
    body: String,
    tool_name: Option<String>,
    tool_input: String,
    tool_output: String,
) {
    let description = if segment == "tool" {
        format!(
            "{}: {}",
            tool_name.as_deref().unwrap_or("tool"),
            preview(&tool_output)
        )
    } else {
        preview(&body)
    };
    events.push(InheritedEvent {
        item: InheritedItem {
            ordinal: events.len(),
            message_id,
            segment: segment.into(),
            role: role.into(),
            timestamp,
            preview: description,
            total_chars: body.encode_utf16().count(),
            tool_name,
        },
        body,
        tool_input,
        tool_output,
    });
}

fn codex_compaction_content(payload: &Value) -> String {
    let summary = ["message", "summary", "summary_text"]
        .iter()
        .find_map(|key| payload[*key].as_str().filter(|text| !text.is_empty()));
    let mut content = match summary {
        Some(summary) => format!("Recorded compaction summary\n\n{summary}"),
        None => "Compaction recorded. A readable summary was not recorded.".into(),
    };
    let mut readable = false;
    for (field, label) in [
        ("replacement_history", "Recorded replacement history"),
        ("guardian_history", "Recorded guardian history"),
    ] {
        let Some(history) = payload[field].as_array() else {
            continue;
        };
        let mut entries = Vec::new();
        for (index, entry) in history.iter().enumerate() {
            if entry["type"] == "message" {
                let text = text_parts(&entry["content"]);
                if !text.is_empty() {
                    let role = entry["role"].as_str().unwrap_or("message");
                    entries.push(format!("{}. {role}: {text}", index + 1));
                    readable = true;
                } else if has_encrypted_content(&entry["content"]) {
                    entries.push(format!("{}. Encrypted content unavailable.", index + 1));
                }
            } else if entry["type"] == "compaction" && entry["encrypted_content"].is_string() {
                entries.push(format!(
                    "{}. Encrypted compaction content unavailable.",
                    index + 1
                ));
            }
        }
        if !entries.is_empty() {
            content.push_str(&format!("\n\n{label}\n\n{}", entries.join("\n\n")));
        }
    }
    if summary.is_none() && !readable {
        content.push_str("\n\nNo readable retained context was recorded.");
    }
    content
}

fn append_text_part(part: &Value, text: &mut String) {
    if let Some(children) = part["content"].as_array() {
        for child in children {
            append_text_part(child, text);
        }
        return;
    }
    if matches!(
        part["type"].as_str(),
        Some("text" | "output_text" | "input_text" | "summary_text")
    ) {
        if let Some(value) = part["text"].as_str() {
            text.push_str(value);
        }
    }
}

fn text_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

fn rendered_message_count(messages: &[Message]) -> usize {
    rendered_message_count_with_agents(messages, true)
}

fn codex_conversation_duration(messages: &[Message]) -> Option<(i64, i64)> {
    let mut first = None;
    let mut last = None;
    for time in messages
        .iter()
        .filter(|message| message.role != "agent")
        .filter_map(|message| message.timestamp.as_deref().and_then(timestamp_ms))
        .filter(|time| *time > 0)
    {
        first = Some(first.map_or(time, |previous: i64| previous.min(time)));
        last = Some(last.map_or(time, |previous: i64| previous.max(time)));
    }
    first.zip(last)
}

fn rendered_message_count_with_agents(messages: &[Message], include_agents: bool) -> usize {
    let mut count = 0;
    let mut previous_group = None;
    let mut active_assistant = false;
    for message in messages
        .iter()
        .filter(|message| message.role != "context" && (include_agents || message.role != "agent"))
    {
        let groupable = matches!(message.role, "assistant" | "tool" | "agent");
        let grouped_with_previous = groupable && previous_group == Some(message.response_group);
        let implicit_tool_continuation = active_assistant && message.role == "tool";
        if !grouped_with_previous && !implicit_tool_continuation {
            count += 1;
        }
        active_assistant = groupable;
        previous_group = groupable.then_some(message.response_group);
    }
    count
}

fn summarize(session: &LoadedSession) -> SessionSummary {
    let first_user_title = session
        .source_title
        .clone()
        .or_else(|| {
            session
                .messages
                .iter()
                .find(|message| message.role == "user")
                .map(|message| flat_title(&message.body))
        })
        .filter(|text| !text.is_empty());
    let search_title = if session.parent_id.is_some() {
        session
            .agent_title
            .clone()
            .filter(|text| !text.is_empty())
            .or(first_user_title)
    } else {
        first_user_title
    };
    let title = search_title.clone().unwrap_or_else(|| session.id.clone());
    SessionSummary {
        session: SessionRef {
            provider: "codex".into(),
            session_id: session.id.clone(),
        },
        title,
        diagnostic: None,
        search_title,
        directory: session.cwd.clone(),
        created_at: session.created_at.as_deref().and_then(timestamp_ms),
        updated_at: session.updated_at.as_deref().and_then(timestamp_ms),
        message_count: rendered_message_count(&session.messages),
        conversation_message_count: Some(rendered_message_count_with_agents(
            &session.messages,
            false,
        )),
        token_count: session.token_count,
        duration_ms: codex_conversation_duration(&session.messages)
            .and_then(|(first, last)| (last > first).then_some(last - first)),
        summary_files: None,
        summary_additions: None,
        summary_deletions: None,
        parent: session.parent_id.as_ref().map(|session_id| SessionRef {
            provider: "codex".into(),
            session_id: session_id.clone(),
        }),
    }
}

fn timestamp_ms(value: &str) -> Option<i64> {
    value
        .parse::<jiff::Timestamp>()
        .ok()
        .map(jiff::Timestamp::as_millisecond)
}

fn project_items(session: &LoadedSession) -> Vec<ReaderItem> {
    let mut items = Vec::new();
    let mut assistant_owner = None::<EventRef>;
    for message in &session.messages {
        if matches!(message.role, "user" | "agent" | "context") {
            assistant_owner = None;
        }
        if message.role == "assistant" {
            assistant_owner = message_segments(message).first().map(|segment| EventRef {
                provider: "codex".into(),
                session_id: session.id.clone(),
                message_id: message.id.clone(),
                segment: (*segment).into(),
            });
        }
        for segment in message_segments(message) {
            let body = segment_content(message, segment);
            let preview = if segment == "tool" {
                format!(
                    "{}: {}",
                    message.tool_name.as_deref().unwrap_or("tool"),
                    preview(&message.tool_output)
                )
            } else {
                preview(body)
            };
            items.push(ReaderItem {
                ordinal: items.len(),
                owner: if segment == "tool" {
                    assistant_owner.clone()
                } else {
                    None
                },
                event: EventRef {
                    provider: "codex".into(),
                    session_id: session.id.clone(),
                    message_id: message.id.clone(),
                    segment: segment.into(),
                },
                role: message.role.into(),
                timestamp: message.timestamp.as_deref().and_then(timestamp_ms),
                preview,
                total_chars: body.encode_utf16().count(),
                tool_name: message.tool_name.clone(),
                tool_metadata: message.tool_metadata.clone(),
                presentation_phase: message.presentation_phase.map(str::to_owned),
                process_id: None,
                process_count: None,
                reply_metadata: None,
                owner_message_id: (segment == "tool")
                    .then(|| {
                        assistant_owner
                            .as_ref()
                            .map(|owner| owner.message_id.clone())
                    })
                    .flatten(),
                content_revisions: Default::default(),
            });
        }
    }
    items
}

fn message_segments(message: &Message) -> Vec<&'static str> {
    if message.role == "context" {
        return vec!["context"];
    }
    let mut segments = Vec::new();
    if !message.body.trim().is_empty() {
        segments.push("message");
    }
    if !message.thinking.is_empty() {
        segments.push("thinking");
    }
    if message.tool_name.is_some() {
        segments.push("tool");
    }
    segments
}

fn segment_content<'a>(message: &'a Message, segment: &str) -> &'a str {
    match segment {
        "message" => &message.body,
        "context" => &message.body,
        "thinking" => &message.thinking,
        "tool" => &message.tool_output,
        _ => "",
    }
}

fn preview(text: &str) -> String {
    text.chars().take(PREVIEW_CHARS).collect()
}

#[cfg(test)]
thread_local! {
    static HEADER_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static CHILD_IDENTITY_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
#[path = "../protocol/codex_snapshot_tests.rs"]
mod snapshot_tests;

#[cfg(test)]
mod codex_projection_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Seek, SeekFrom, Write};
    use std::time::{Duration, UNIX_EPOCH};

    fn transcript_path(root: &Path, name: impl AsRef<Path>) -> PathBuf {
        let directory = root.join("sessions");
        fs::create_dir_all(&directory).unwrap();
        directory.join(name)
    }

    #[test]
    fn stats_source_revision_is_ordered_and_independent_of_worker_count() {
        let directory = tempfile::tempdir().unwrap();
        let mut sources = BTreeMap::new();
        for (id, body) in [("c", b"last".as_slice()), ("a", b"first"), ("b", b"middle")] {
            let path = transcript_path(directory.path(), format!("{id}.jsonl"));
            fs::write(&path, body).unwrap();
            sources.insert(id.to_owned(), path);
        }
        let mut expected = Sha256::new();
        expected.update(b"codex-stats-usage-source-v10\0");
        for (id, path) in &sources {
            let path_bytes = path.to_string_lossy();
            let bytes = fs::read(path).unwrap();
            expected.update((id.len() as u64).to_le_bytes());
            expected.update(id.as_bytes());
            expected.update((path_bytes.len() as u64).to_le_bytes());
            expected.update(path_bytes.as_bytes());
            expected.update(Sha256::digest(&bytes));
            expected.update((bytes.len() as u64).to_le_bytes());
        }
        let expected = format!("{:x}", expected.finalize());
        for workers in [1, 2, 4] {
            assert_eq!(
                codex_usage_source_revision_with_workers(&sources, workers).unwrap(),
                expected,
                "worker count {workers}"
            );
        }
    }

    #[test]
    fn stats_source_revision_detects_rewrites_and_selected_identity_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = transcript_path(directory.path(), "source.jsonl");
        fs::write(&path, b"before").unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let mut sources = BTreeMap::from([("session-a".to_owned(), path.clone())]);
        let first = codex_usage_source_revision_with_workers(&sources, 2).unwrap();
        fs::write(&path, b"after!").unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), 6);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        assert_ne!(
            codex_usage_source_revision_with_workers(&sources, 4).unwrap(),
            first
        );
        let rewritten = codex_usage_source_revision_with_workers(&sources, 1).unwrap();
        sources.remove("session-a");
        sources.insert("session-b".into(), path.clone());
        assert_ne!(
            codex_usage_source_revision_with_workers(&sources, 2).unwrap(),
            rewritten
        );
        let renamed = transcript_path(directory.path(), "renamed.jsonl");
        fs::rename(&path, &renamed).unwrap();
        sources.insert("session-b".into(), renamed);
        assert_ne!(
            codex_usage_source_revision_with_workers(&sources, 2).unwrap(),
            rewritten
        );
    }

    #[test]
    fn stats_source_revision_returns_selected_path_on_read_error() {
        let directory = tempfile::tempdir().unwrap();
        let first_missing = transcript_path(directory.path(), "first-missing.jsonl");
        let second_missing = transcript_path(directory.path(), "second-missing.jsonl");
        let sources = BTreeMap::from([
            ("session-a".to_owned(), first_missing.clone()),
            ("session-b".to_owned(), second_missing),
        ]);
        assert!(matches!(
            codex_usage_source_revision_with_workers(&sources, 4),
            Err(CoreError::Io { path, .. }) if path == first_missing
        ));
    }

    #[test]
    fn stats_source_revision_stops_dispatching_after_early_read_error() {
        let directory = tempfile::tempdir().unwrap();
        let mut sources = BTreeMap::new();
        for index in 0..100 {
            sources.insert(
                format!("session-{index:03}"),
                transcript_path(directory.path(), format!("source-{index:03}.jsonl")),
            );
        }
        let reads = AtomicUsize::new(0);
        let digest_file = |path: &Path| {
            reads.fetch_add(1, Ordering::Relaxed);
            if path.file_name().unwrap() == "source-000.jsonl" {
                return codex_usage_file_digest(path);
            }
            Ok((0, Sha256::digest([]).into()))
        };
        assert!(matches!(
            codex_usage_source_revision_with_workers_using(&sources, 1, &digest_file),
            Err(CoreError::Io { path, .. }) if path == sources["session-000"]
        ));
        assert_eq!(reads.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn stats_batch_reads_selected_child_identities_once() {
        let directory = tempfile::tempdir().unwrap();
        let ids = [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            "44444444-4444-4444-8444-444444444444",
            "55555555-5555-4555-8555-555555555555",
            "66666666-6666-4666-8666-666666666666",
        ];
        for id in ids {
            let path = reader_source_path(directory.path(), id);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let payload = if id == ids[0] {
                serde_json::json!({"id": id})
            } else {
                serde_json::json!({
                    "id": id,
                    "parent_thread_id": ids[0],
                    "agent_path": "/root/worker"
                })
            };
            let header = serde_json::json!({
                "type": "session_meta",
                "timestamp": "2026-09-28T00:00:00Z",
                "payload": payload
            });
            let message = serde_json::json!({
                "type": "event_msg",
                "timestamp": "2026-09-28T00:00:01Z",
                "payload": {"type": "user_message", "message": "hello"}
            });
            fs::write(path, format!("{header}\n{message}\n")).unwrap();
        }
        let adapter = CodexAdapter {
            root: &directory.path().join("codex"),
            scope: "stats-child-identities",
        };
        let before = CHILD_IDENTITY_READS.with(std::cell::Cell::get);
        let batch = adapter.stats_observation_batch(None).unwrap().unwrap();
        for id in ids {
            batch.observations(id).unwrap();
        }
        batch.validate_source_revision().unwrap();
        let reads = CHILD_IDENTITY_READS.with(std::cell::Cell::get) - before;
        assert_eq!(
            reads,
            ids.len(),
            "six uncached Stats observations should read each selected child identity once"
        );
    }

    #[test]
    fn canonical_response_survives_equal_anonymous_legacy_without_cumulative_proof() {
        let request = serde_json::json!({
            "input_tokens": 10, "cached_input_tokens": 2,
            "cache_write_input_tokens": 0, "output_tokens": 3,
            "reasoning_output_tokens": 0, "total_tokens": 13
        });
        let rows = [
            serde_json::json!({"type":"session_meta","payload":{"id":"root"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"token_count",
                "info":{"last_token_usage":request}}}),
            serde_json::json!({"type":"token_usage_record","payload":{
                "thread_id":"root","response_id":"proved","usage":request}}),
        ];
        let mut observations = CodexObservations::default();
        for (index, row) in rows.iter().enumerate() {
            observations.observe(row, index, "root");
        }
        assert_eq!(
            codex_selected_token_count(&observations.usage, None),
            Some(13)
        );
        let facts = observations.finish("root", None);
        assert_eq!(facts.usage_records.len(), 1);
        assert_eq!(
            facts.usage_records[0].provenance.source_id.as_deref(),
            Some("proved")
        );
        assert_eq!(facts.usage_observations.len(), 1);
        assert_eq!(
            facts.usage_observations[0].provenance.source_id.as_deref(),
            Some("1")
        );
        assert_eq!(facts.usage_observations[0].cumulative_tokens, None);
    }

    #[test]
    fn conflicting_canonical_response_vectors_remain_unresolved() {
        let rows = [
            serde_json::json!({"type":"session_meta","payload":{"id":"root"}}),
            serde_json::json!({"type":"token_usage_record","payload":{
                "thread_id":"root","response_id":"same","usage":{"total_tokens":7}}}),
            serde_json::json!({"type":"token_usage_record","payload":{
                "thread_id":"root","response_id":"same","usage":{"total_tokens":9}}}),
        ];
        let mut observations = CodexObservations::default();
        for (index, row) in rows.iter().enumerate() {
            observations.observe(row, index, "root");
        }
        assert_eq!(codex_selected_token_count(&observations.usage, None), None);
        let facts = observations.finish("root", None);
        assert!(facts.usage_records.is_empty());
        assert_eq!(facts.usage_observations.len(), 2);
    }

    #[test]
    fn malformed_first_duplicate_cannot_borrow_later_response_tokens() {
        let rows = [
            serde_json::json!({"type":"session_meta","payload":{"id":"root"}}),
            serde_json::json!({"timestamp":"2026-09-29T00:00:01Z",
                "type":"token_usage_record","payload":{
                "thread_id":"root","response_id":"same","usage":{}}}),
            serde_json::json!({"timestamp":"2026-09-29T00:00:02Z",
                "type":"token_usage_record","payload":{
                "thread_id":"root","response_id":"same","usage":{"total_tokens":7}}}),
        ];
        let mut observations = CodexObservations::default();
        for (index, row) in rows.iter().enumerate() {
            observations.observe(row, index, "root");
        }
        assert_eq!(
            codex_selected_token_count(&observations.usage, None),
            Some(7)
        );
        let facts = observations.finish("root", None);
        assert_eq!(facts.usage_records.len(), 1);
        assert_eq!(
            facts.usage_records[0].timestamp,
            timestamp_ms("2026-09-29T00:00:02Z")
        );
        assert_eq!(facts.usage_records[0].tokens.total, Some(7));
        assert_eq!(facts.usage_observations.len(), 1);
        assert_eq!(
            facts.usage_observations[0].provenance.source_id.as_deref(),
            Some("1")
        );
    }

    #[test]
    fn one_canonical_user_does_not_use_an_earlier_native_mirror_for_duration() {
        let directory = tempfile::tempdir().unwrap();
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let path = transcript_path(directory.path(), format!("rollout-{id}.jsonl"));
        let rows = [
            serde_json::json!({
                "timestamp": "2026-09-28T00:00:00.000Z",
                "type": "session_meta",
                "payload": { "id": id }
            }),
            serde_json::json!({
                "timestamp": "2026-09-28T00:00:01.935Z",
                "type": "event_msg",
                "payload": { "type": "user_message", "message": "One request." }
            }),
            serde_json::json!({
                "timestamp": "2026-09-28T00:00:02.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "One request." }],
                    "internal_chat_message_metadata_passthrough": {
                        "content_item_kinds": ["user.text"]
                    }
                }
            }),
        ];
        fs::write(
            &path,
            rows.into_iter()
                .map(|row| row.to_string())
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let loaded = load_codex(&path, "single-point-mirror", id).unwrap();
        assert_eq!(loaded.messages.len(), 1);
        let canonical = timestamp_ms(loaded.messages[0].timestamp.as_deref().unwrap()).unwrap();
        assert_eq!(
            codex_conversation_duration(&loaded.messages),
            Some((canonical, canonical))
        );
        assert_eq!(
            codex_protocol_bundle(&path, "single-point-mirror", id)
                .unwrap()
                .list_stats()
                .duration_ms,
            None
        );
    }

    #[test]
    #[ignore = "requires the selected frozen Codex root with recorded child returns"]
    fn frozen_private_library_count_attributes_added_agent_results() {
        let path = PathBuf::from(std::env::var("CODEX_PRIVATE_SOURCE").unwrap());
        let id = read_header(&path).unwrap().unwrap().0;
        let session = load_codex(&path, "private-library-count", &id).unwrap();
        let without_agent_results: Vec<_> = session
            .messages
            .iter()
            .filter(|message| message.role != "agent")
            .cloned()
            .collect();
        assert_eq!(rendered_message_count(&without_agent_results), 317);
        assert_eq!(rendered_message_count(&session.messages), 351);
        assert_eq!(session.token_count, Some(295_276_811));
    }

    fn reader_fixture_bytes(session_id: &str, assistant_count: usize, final_body: &str) -> Vec<u8> {
        let mut rows = vec![
            serde_json::json!({"type":"session_meta","payload":{"id":session_id}}),
            serde_json::json!({
                "type":"response_item",
                "payload":{
                    "type":"message",
                    "role":"user",
                    "id":"reader-user",
                    "content":[{"type":"input_text","text":"Read the recorded response."}],
                    "internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text"]}
                }
            }),
            serde_json::json!({
                "type":"response_item",
                "payload":{
                    "type":"function_call",
                    "call_id":"reader-spawn",
                    "name":"spawn_agent",
                    "namespace":"collaboration",
                    "arguments":"{}"
                }
            }),
        ];
        for index in 0..assistant_count {
            rows.push(serde_json::json!({
                "type":"response_item",
                "payload":{
                    "type":"message",
                    "role":"assistant",
                    "id":format!("reader-assistant-{index}"),
                    "content":[{"type":"output_text","text":if index + 1 == assistant_count { final_body } else { "Recorded assistant turn." }}]
                }
            }));
        }
        let source = rows
            .into_iter()
            .map(|row| row.to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        source.into_bytes()
    }

    fn reader_core(root: &Path) -> crate::Core {
        crate::Core::new(crate::SourceConfig {
            codex_dir: root.join("codex"),
            opencode_db: root.join("opencode.db"),
            claude_dir: root.join("claude"),
            pi_dir: root.join("pi"),
            dsh_dir: root.join("dsh"),
            meta_dir: root.join("meta"),
            index_dir: root.join("index"),
            cache_dir: root.join("cache"),
        })
        .unwrap()
    }

    fn reader_source_path(root: &Path, session_id: &str) -> PathBuf {
        root.join("codex")
            .join("sessions")
            .join(format!("rollout-{session_id}.jsonl"))
    }

    fn write_reader_source(
        path: &Path,
        session_id: &str,
        assistant_count: usize,
        final_body: &str,
    ) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            reader_fixture_bytes(session_id, assistant_count, final_body),
        )
        .unwrap();
    }

    #[test]
    fn resume_metadata_reads_current_canonical_header_without_loading_body() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let id = "abababab-abab-4bab-8bab-abababababab";
        let path = reader_source_path(directory.path(), id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let header = serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":r"D:\work space\project"}});
        fs::write(
            &path,
            format!("{header}\n{}", "{\"type\":\"unfinished ".repeat(100_000)),
        )
        .unwrap();
        let core = reader_core(directory.path());
        CODEX_NORMALIZATION_COUNT.with(|count| count.set(0));
        let body_reads = std::rc::Rc::new(std::cell::Cell::new(0));
        let reads = body_reads.clone();
        CODEX_STREAM_READ_HOOK
            .with(|hook| *hook.borrow_mut() = Some(Box::new(move |_| reads.set(reads.get() + 1))));
        let initial = core.resume_spec("codex", id);
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"more active body bytes")
            .unwrap();
        let appended = core.resume_spec("codex", id);
        CODEX_STREAM_READ_HOOK.with(|hook| *hook.borrow_mut() = None);
        let (command, cwd) = initial.unwrap();
        assert_eq!(cwd.as_deref(), Some(r"D:\work space\project"));
        let command = command.unwrap().command;
        assert_eq!(command.executable, "codex");
        assert_eq!(command.args, ["resume", "{sessionId}"]);
        assert_eq!(appended.unwrap().1, cwd);
        assert_eq!(CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get), 0);
        assert_eq!(body_reads.get(), 0);
        assert!(matches!(
            core.resume_spec("codex", "../wrong"),
            Err(CoreError::InvalidInput(_))
        ));
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            core.resume_spec("codex", id),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn resume_metadata_rejects_same_stat_identity_change_and_ambiguous_selection() {
        let directory = tempfile::tempdir().unwrap();
        let id = "abababab-abab-4bab-8bab-abababababab";
        let other = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
        let path = reader_source_path(directory.path(), id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = format!(
            "{}\n",
            serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":"/canonical"}})
        );
        fs::write(&path, &bytes).unwrap();
        let core = reader_core(directory.path());
        assert_eq!(
            core.resume_spec("codex", id).unwrap().1.as_deref(),
            Some("/canonical")
        );
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, bytes.replace(id, other)).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(mtime))
            .unwrap();
        let changed = core.resume_spec("codex", id);
        assert!(
            matches!(changed, Err(CoreError::NotFound { .. })),
            "{changed:?}"
        );
        fs::write(&path, &bytes).unwrap();
        fs::write(path.with_file_name("rollout-duplicate.jsonl"), &bytes).unwrap();
        assert!(core.resume_spec("codex", id).is_err());
        let missing_root = tempfile::tempdir().unwrap();
        let unavailable = reader_core(missing_root.path());
        assert!(matches!(
            unavailable.resume_spec("codex", id),
            Err(CoreError::Unavailable(_))
        ));
    }

    #[test]
    fn parent_dependency_tracks_owned_boundary_not_later_child_execution() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let parent = "abababab-abab-4bab-8bab-abababababab";
        let child = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
        let parent_path = reader_source_path(directory.path(), parent);
        let child_path = reader_source_path(directory.path(), child);
        write_reader_source(&parent_path, parent, 1, "parent answer");
        let header = serde_json::json!({"type":"session_meta","payload":{"id":child,"parent_thread_id":parent,"agent_path":"/root/worker","source":{"subagent":{"thread_spawn":{"parent_thread_id":parent}}}}});
        let inherited = serde_json::json!({"type":"session_meta","payload":{"id":parent}});
        let task = serde_json::json!({"type":"response_item","payload":{"type":"agent_message","content":[{"type":"text","text":"Message Type: NEW_TASK\nTask name: /root/worker"}]}});
        fs::write(&child_path, format!("{header}\n{inherited}\n")).unwrap();
        let root = directory.path().join("codex");
        let adapter = CodexAdapter {
            root: &root,
            scope: "parent-boundary",
        };
        let missing = adapter.reader_revision(parent).unwrap().unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&child_path)
            .unwrap()
            .write_all(format!("{task}\n").as_bytes())
            .unwrap();
        let established = adapter.reader_revision(parent).unwrap().unwrap();
        assert_ne!(missing.revision, established.revision);
        let child_before = adapter.reader_revision(child).unwrap().unwrap();
        fs::OpenOptions::new().append(true).open(&child_path).unwrap().write_all(b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"later child body\"}}\n").unwrap();
        let appended = adapter.reader_revision(parent).unwrap().unwrap();
        assert_eq!(established.revision, appended.revision);
        assert_ne!(
            child_before.revision,
            adapter.reader_revision(child).unwrap().unwrap().revision
        );
        assert_eq!(
            reader_parent_fact_from_path(&child_path, child)
                .unwrap()
                .unwrap()
                .session_id,
            parent
        );
        let bytes = fs::read_to_string(&child_path).unwrap();
        let modified = fs::metadata(&child_path).unwrap().modified().unwrap();
        fs::write(&child_path, bytes.replace("NEW_TASK", "NEW_TASS")).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&child_path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_ne!(
            appended.revision,
            adapter.reader_revision(parent).unwrap().unwrap().revision
        );
        assert!(reader_parent_fact_from_path(&child_path, child).is_err());
        fs::remove_file(&child_path).unwrap();
        assert_ne!(
            appended.revision,
            adapter.reader_revision(parent).unwrap().unwrap().revision
        );
    }

    #[test]
    fn reader_capture_accepts_append_and_excludes_unfinished_tail() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let id = "abababab-abab-4bab-8bab-abababababab";
        let path = reader_source_path(directory.path(), id);
        write_reader_source(&path, id, 100, "captured answer");
        let core = reader_core(directory.path());
        let hook_path = path.clone();
        let appended = std::rc::Rc::new(std::cell::Cell::new(false));
        let flag = appended.clone();
        CODEX_STREAM_READ_HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(move |read_count| {
            if read_count == 2 && !flag.replace(true) {
                let mut file = fs::OpenOptions::new().append(true).open(&hook_path).unwrap();
                writeln!(file, "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"appended after capture\"}}}}").unwrap();
                write!(file, "{{\"type\":").unwrap();
            }
        })));
        let first = core.reader_bootstrap("codex", id);
        CODEX_STREAM_READ_HOOK.with(|hook| *hook.borrow_mut() = None);
        assert!(appended.get());
        let first = first.unwrap();
        assert!(
            !first.segments[0]
                .items
                .iter()
                .any(|item| item.preview.contains("appended after"))
        );
        let refreshed = core.reader_bootstrap("codex", id).unwrap();
        assert!(refreshed.total_items > first.total_items);
        assert_ne!(refreshed.revision, first.revision);
        let normalizations = CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get);
        assert_eq!(
            core.reader_bootstrap("codex", id).unwrap().revision,
            refreshed.revision
        );
        assert_eq!(
            CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get),
            normalizations,
            "an unchanged incomplete tail must reuse its complete-record projection"
        );
    }

    #[test]
    fn reader_capture_rejects_truncation_and_removal_during_read() {
        for remove in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let id = "abababab-abab-4bab-8bab-abababababab";
            let path = reader_source_path(directory.path(), id);
            write_reader_source(&path, id, 100, "captured answer");
            let core = reader_core(directory.path());
            let changed = std::rc::Rc::new(std::cell::Cell::new(false));
            let flag = changed.clone();
            CODEX_STREAM_READ_HOOK.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move |read_count| {
                    if read_count == 2 && !flag.replace(true) {
                        if remove {
                            fs::remove_file(&path).unwrap();
                        } else {
                            fs::OpenOptions::new()
                                .write(true)
                                .open(&path)
                                .unwrap()
                                .set_len(0)
                                .unwrap();
                        }
                    }
                }))
            });
            let result = core.reader_bootstrap("codex", id);
            CODEX_STREAM_READ_HOOK.with(|hook| *hook.borrow_mut() = None);
            assert!(changed.get());
            assert!(result.is_err(), "{result:?}");
        }
    }

    #[test]
    fn reader_execution_pages_are_captured_and_revision_bound() {
        let directory = tempfile::tempdir().unwrap();
        let id = "abababab-abab-4bab-8bab-abababababab";
        let path = reader_source_path(directory.path(), id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let rows = [
            serde_json::json!({"type":"session_meta","payload":{"id":id}}),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"a"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"a","output":"Script running with cell ID 65\nWall time 1 seconds\nOutput:\n"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","name":"wait","call_id":"b","arguments":"{\"cell_id\":\"65\"}"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"b","output":"Script completed\nWall time 1 seconds\nOutput:\n"}}),
        ];
        let bytes = rows
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&path, &bytes).unwrap();
        let core = reader_core(directory.path());
        let bootstrap = core.reader_bootstrap("codex", id).unwrap();
        let expected = core
            .protocol_event_stream("codex", id)
            .unwrap()
            .execution_events()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(expected.len(), 4);
        fs::remove_file(&path).unwrap();
        let first = core
            .reader_executions("codex", id, &bootstrap.revision, None, 2)
            .unwrap();
        let second = core
            .reader_executions(
                "codex",
                id,
                &bootstrap.revision,
                first.next_cursor.as_deref(),
                2,
            )
            .unwrap();
        let captured = first
            .events
            .into_iter()
            .chain(second.events)
            .collect::<Vec<_>>();
        assert_eq!(
            serde_json::to_value(captured).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        assert!(second.next_cursor.is_none());
        fs::write(&path, bytes.replace("65", "69")).unwrap();
        let new = core.reader_bootstrap("codex", id).unwrap();
        assert_ne!(new.revision, bootstrap.revision);
        assert!(matches!(
            core.reader_executions("codex", id, &bootstrap.revision, None, 2),
            Err(CoreError::SourceChanged)
        ));
        assert!(matches!(
            core.reader_executions("codex", id, &new.revision, first.next_cursor.as_deref(), 2),
            Err(CoreError::SourceChanged)
        ));
    }

    #[test]
    fn plain_codex_rewrite_during_stream_cannot_publish_mixed_rows() {
        let directory = tempfile::tempdir().unwrap();
        let id = "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a";
        let path = reader_source_path(directory.path(), id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let source = |early: &str, late: &str| {
            let rows = [
                serde_json::json!({"type":"session_meta","payload":{"id":id}}),
                serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":early}]}}),
                serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"x".repeat(16_384)}]}}),
                serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":late}]}}),
            ];
            format!(
                "{}\n",
                rows.into_iter()
                    .map(|row| row.to_string())
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let old = source("early OLD", "late OLD");
        let new = source("early NEW", "late NEW");
        assert_eq!(old.len(), new.len());
        let fixed_mtime = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let core = reader_core(directory.path());
        for operation in 0..3 {
            fs::write(&path, &old).unwrap();
            let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_times(fs::FileTimes::new().set_modified(fixed_mtime))
                .unwrap();
            let path_for_hook = path.clone();
            let replacement = new.clone();
            let rewrote = std::rc::Rc::new(std::cell::Cell::new(false));
            let rewrote_in_hook = rewrote.clone();
            CODEX_STREAM_READ_HOOK.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move |read_count| {
                    if read_count == 2 && !rewrote_in_hook.get() {
                        let mut file = fs::OpenOptions::new()
                            .write(true)
                            .open(&path_for_hook)
                            .unwrap();
                        file.seek(SeekFrom::Start(0)).unwrap();
                        file.write_all(replacement.as_bytes()).unwrap();
                        file.set_times(fs::FileTimes::new().set_modified(fixed_mtime))
                            .unwrap();
                        rewrote_in_hook.set(true);
                    }
                }));
            });
            let result = match operation {
                0 => core.session_get("codex", id, 10, None).map(|_| ()),
                1 => core
                    .session_timeline("codex", id, crate::TimelineFilters::default(), 10, None)
                    .map(|_| ()),
                _ => core.reader_bootstrap("codex", id).map(|_| ()),
            };
            CODEX_STREAM_READ_HOOK.with(|hook| *hook.borrow_mut() = None);
            assert!(
                rewrote.get(),
                "operation {operation} did not cross the stream refill"
            );
            assert!(
                matches!(result, Err(CoreError::SourceChanged)),
                "operation {operation} returned {result:?}"
            );
            assert_eq!(fs::metadata(&path).unwrap().len(), old.len() as u64);
            assert_eq!(
                fs::metadata(&path).unwrap().modified().unwrap(),
                fixed_mtime
            );
        }
    }

    fn spawn_resolution_fixture(
        root: &Path,
        parent: &str,
        actor: &str,
        activity_child: Option<&str>,
        children: &[(&str, &str, &str)],
    ) -> Option<String> {
        let mut rows = vec![serde_json::json!({"type":"session_meta","payload":{"id":parent}})];
        rows.push(serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"spawn-1","name":"spawn_agent","namespace":"collaboration","arguments":"{}"}}));
        if let Some(child) = activity_child {
            rows.push(serde_json::json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"SubAgentActivity","kind":"started","id":"spawn-1","agent_thread_id":child}}}));
        }
        rows.push(serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"spawn-1","output":serde_json::json!({"task_name":actor}).to_string()}}));
        fs::write(
            transcript_path(root, "parent.jsonl"),
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        for (id, child_parent, child_actor) in children {
            fs::write(transcript_path(root, format!("child-{id}.jsonl")), serde_json::json!({"type":"session_meta","payload":{"id":id,"parent_thread_id":child_parent,"agent_path":child_actor}}).to_string() + "\n").unwrap();
        }
        let snapshot = CodexAdapter {
            root,
            scope: "spawn-resolution-test",
        }
        .load(parent)
        .unwrap();
        snapshot
            .relations
            .iter()
            .find_map(|entry| {
                let RelationEntry::Coordination { observation } = entry else {
                    return None;
                };
                (observation.kind == "spawn" && observation.state == "started").then(|| {
                    observation
                        .to_session_ref
                        .as_ref()
                        .map(|reference| reference.session_id.clone())
                })
            })
            .unwrap()
    }

    #[test]
    fn spawn_resolution_requires_exact_direct_child_identity() {
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let first = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let second = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let actor = "/root/child";
        let missing = tempfile::tempdir().unwrap();
        assert_eq!(
            spawn_resolution_fixture(missing.path(), parent, actor, Some(first), &[]),
            None
        );
        let wrong_parent = tempfile::tempdir().unwrap();
        assert_eq!(
            spawn_resolution_fixture(
                wrong_parent.path(),
                parent,
                actor,
                Some(first),
                &[(first, second, actor)]
            ),
            None
        );
        let wrong_actor = tempfile::tempdir().unwrap();
        assert_eq!(
            spawn_resolution_fixture(
                wrong_actor.path(),
                parent,
                actor,
                Some(first),
                &[(first, parent, "/root/other")]
            ),
            None
        );
        let ambiguous_alias = tempfile::tempdir().unwrap();
        assert_eq!(
            spawn_resolution_fixture(
                ambiguous_alias.path(),
                parent,
                actor,
                None,
                &[(first, parent, actor), (second, parent, actor)]
            ),
            None
        );
        let exact_activity = tempfile::tempdir().unwrap();
        assert_eq!(
            spawn_resolution_fixture(
                exact_activity.path(),
                parent,
                actor,
                Some(first),
                &[(first, parent, actor), (second, parent, actor)]
            ),
            Some(first.into())
        );
    }

    #[test]
    fn historical_codex_dispatch_and_header_runs() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/codex-historical");
        let adapter = CodexAdapter {
            root: &root,
            scope: "historical-public",
        };
        let doc = serde_json::to_value(
            adapter
                .protocol_bundle("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
                .unwrap()
                .document(3)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(doc["tasks"].as_array().unwrap().len(), 8);
        assert_eq!(doc["agentRuns"].as_array().unwrap().len(), 3);
        assert_eq!(
            doc["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|t| t["status"] == "failed")
                .count(),
            4
        );
        let runs = doc["agentRuns"].as_array().unwrap();
        let first = runs.iter().find(|r| r["taskId"] == "spawn-a").unwrap();
        assert_eq!(first["terminalEvidence"]["eventId"], "event:codex:10");
        assert_eq!(first["timeStart"], 1783641602000_i64);
        let header = runs.iter().find(|r| r["taskId"].is_null()).unwrap();
        assert_eq!(header["status"], "unknown");
        assert_eq!(header["pairing"], "unidentifiable");
        assert!(header["timeStart"].is_null() && header["timeEnd"].is_null());
        let facts = doc["coordination"].as_array().unwrap();
        assert_eq!(
            facts
                .iter()
                .map(|c| c["id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            facts.len()
        );
        assert!(
            facts
                .iter()
                .any(|c| c["kind"] == "input" && c["state"] == "submitted")
        );
        let timed_out = facts
            .iter()
            .filter(|c| c["kind"] == "wait" && c["state"] == "timed_out")
            .collect::<Vec<_>>();
        assert_eq!(timed_out.len(), 2);
        assert_eq!(
            timed_out
                .iter()
                .map(|c| c["toSessionRef"]["sessionId"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            2
        );
        assert!(
            facts
                .iter()
                .filter(|c| c["kind"] == "result")
                .all(|c| c["fromSessionRef"]["provider"] == "codex"
                    && c["toSessionRef"]["sessionId"] == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        );
    }

    #[test]
    fn historical_codex_selected_headers_and_dependency_revision() {
        let directory = tempfile::tempdir().unwrap();
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/codex-historical/sessions");
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let mut sources = BTreeMap::new();
        for entry in fs::read_dir(fixture).unwrap() {
            let entry = entry.unwrap();
            let path = transcript_path(directory.path(), entry.file_name());
            fs::copy(entry.path(), &path).unwrap();
            let id = read_primary_meta(&path).unwrap().unwrap()["payload"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
            sources.insert(id, path);
        }
        let sources = CodexSources::from(sources);
        let parent_path = &sources[parent];
        let document = |sources: &CodexSources, identities: Option<&SelectedChildIdentities>| {
            serde_json::to_value(
                codex_protocol_bundle_with_sources_and_identities(
                    parent_path,
                    "historical-dependency",
                    parent,
                    Some(sources),
                    identities,
                )
                .unwrap()
                .document(3)
                .unwrap(),
            )
            .unwrap()
        };
        let before = document(&sources, None);
        let without_child = CodexSources::from(
            sources
                .iter()
                .filter(|(id, _)| id.as_str() != child)
                .map(|(id, path)| (id.clone(), path.clone()))
                .collect::<BTreeMap<_, _>>(),
        );
        let absent = document(&without_child, None);
        assert_eq!(absent["agentRuns"].as_array().unwrap().len(), 2);
        assert_ne!(
            absent["revision"], before["revision"],
            "child removal/addition invalidates the parent revision"
        );
        assert_eq!(
            before,
            document(&sources, Some(&selected_child_identities(&sources)))
        );
        let stream = codex_protocol_stream_with_sources(
            parent_path,
            "historical-dependency",
            parent,
            Some(&sources),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(
                stream
                    .events(crate::protocol::EventQuery::default())
                    .unwrap()
                    .events
            )
            .unwrap(),
            before["events"]
        );
        assert_eq!(stream.revision(), before["revision"].as_str().unwrap());
        let events = before["events"].as_array().unwrap();
        let raw = events
            .iter()
            .filter(|e| e["provenance"]["fidelity"] == "recorded")
            .collect::<Vec<_>>();
        for (ordinal, event) in raw.iter().enumerate() {
            assert_eq!(event["id"], format!("event:codex:{ordinal}"));
            assert_eq!(event["sourceOrder"]["record"], ordinal);
        }
        for event in events
            .iter()
            .filter(|e| e["kind"] == "codex.child_thread_declared")
        {
            assert_eq!(event["provenance"]["fidelity"], "derived");
            assert!(
                event["timestamp"].is_null()
                    && event["readerEvent"].is_null()
                    && event["execution"].is_null()
            );
            assert!(
                event["provenance"]["sourceId"]
                    .as_str()
                    .unwrap()
                    .contains(":0:")
            );
        }
        let wrong_parent = serde_json::json!({"type":"session_meta","payload":{"id":child,"parent_thread_id":"other","source":{"subagent":{"thread_spawn":{"parent_thread_id":"other"}}}}});
        fs::write(&sources[child], wrong_parent.to_string() + "\n").unwrap();
        let after = document(&sources, None);
        assert_ne!(before["revision"], after["revision"]);
        assert_eq!(after["agentRuns"].as_array().unwrap().len(), 2);
        assert_eq!(
            after,
            document(&sources, Some(&selected_child_identities(&sources)))
        );
        fs::write(&sources[child], serde_json::json!({"type":"session_meta","payload":{"id":"mismatched","parent_thread_id":parent,"source":{"subagent":{"thread_spawn":{"parent_thread_id":parent}}}}}).to_string()+"\n").unwrap();
        assert_eq!(
            document(&sources, None)["agentRuns"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn historical_codex_header_only_requires_explicit_spawn_declaration() {
        let directory = tempfile::tempdir().unwrap();
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let root_path = transcript_path(directory.path(), "parent.jsonl");
        fs::write(
            &root_path,
            serde_json::json!({"type":"session_meta","payload":{"id":parent}}).to_string() + "\n",
        )
        .unwrap();
        let mut sources = BTreeMap::from([(parent.into(), root_path.clone())]);
        for index in 0..5 {
            let id = format!("bbbbbbbb-bbbb-4bbb-8bbb-{index:012}");
            let path = transcript_path(directory.path(), format!("child-{index}.jsonl"));
            let row = serde_json::json!({"type":"session_meta","payload":{"id":id,"session_id":parent,"parent_thread_id":parent,"source":{"subagent":{"thread_spawn":{"parent_thread_id":parent}}}}});
            fs::write(&path, row.to_string() + "\n").unwrap();
            sources.insert(id, path);
        }
        for (id, payload) in [
            (
                "parent-only",
                serde_json::json!({"id":"parent-only","parent_thread_id":parent}),
            ),
            (
                "fork",
                serde_json::json!({"id":"fork","forked_from_id":parent}),
            ),
            (
                "conflict",
                serde_json::json!({"id":"conflict","parent_thread_id":parent,"source":{"subagent":{"thread_spawn":{"parent_thread_id":"other"}}}}),
            ),
        ] {
            let path = transcript_path(directory.path(), format!("{id}.jsonl"));
            fs::write(
                &path,
                serde_json::json!({"type":"session_meta","payload":payload}).to_string() + "\n",
            )
            .unwrap();
            sources.insert(id.into(), path);
        }
        let unavailable_path = transcript_path(directory.path(), "copied-unavailable.jsonl");
        fs::write(&unavailable_path, serde_json::json!({"type":"session_meta","payload":{"id":"copied-unavailable","parent_thread_id":parent,"source":{"subagent":{"thread_spawn":{"parent_thread_id":parent}}}}}).to_string()+"\n"+&serde_json::json!({"type":"session_meta","payload":{"id":parent}}).to_string()+"\n").unwrap();
        sources.insert("copied-unavailable".into(), unavailable_path);
        let sources = CodexSources::from(sources);
        let doc = serde_json::to_value(
            codex_protocol_bundle_with_sources(&root_path, "header-only", parent, Some(&sources))
                .unwrap()
                .document(3)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(doc["tasks"].as_array().unwrap().len(), 0);
        assert_eq!(doc["coordination"].as_array().unwrap().len(), 0);
        assert_eq!(doc["agentRuns"].as_array().unwrap().len(), 5);
        for run in doc["agentRuns"].as_array().unwrap() {
            assert_eq!(run["status"], "unknown");
            assert_eq!(run["pairing"], "unidentifiable");
            for key in [
                "taskId",
                "turnId",
                "timeStart",
                "timeEnd",
                "terminalEvidence",
            ] {
                assert!(run[key].is_null());
            }
        }
    }

    #[test]
    fn historical_codex_output_shapes_do_not_invent_terminal_or_acceptance() {
        let directory = tempfile::tempdir().unwrap();
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let mut rows: Vec<Value> = include_str!("../../../../fixtures/codex-historical/sessions/rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl").lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        for row in &mut rows {
            let call = row["payload"]["call_id"].as_str().unwrap_or("");
            if row["payload"]["type"] == "function_call_output" {
                let replacement = match call {
                    "wait-done" | "wait-followup" => Some(
                        serde_json::json!({"status":{"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb":{"completed":null}},"timed_out":false}),
                    ),
                    "resume-a" => Some(serde_json::json!({"status":null})),
                    "input-a" => Some(serde_json::json!({"submission_id":null})),
                    "close-b" => Some(serde_json::json!({"previous_status":{"completed":17}})),
                    _ => None,
                };
                if let Some(value) = replacement {
                    row["payload"]["output"] = value.to_string().into();
                }
            }
        }
        let path = transcript_path(directory.path(), "parent.jsonl");
        fs::write(
            &path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let doc = serde_json::to_value(
            codex_protocol_bundle(&path, "invalid-historical-output", parent)
                .unwrap()
                .document(3)
                .unwrap(),
        )
        .unwrap();
        assert!(
            !doc["coordination"]
                .as_array()
                .unwrap()
                .iter()
                .any(|fact| fact["kind"] == "result"
                    || fact["state"] == "submitted"
                    || fact["state"] == "closed"
                    || (fact["kind"] == "resume" && fact["state"] == "returned"))
        );
        assert_eq!(
            doc["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|task| task["status"] == "failed")
                .count(),
            4
        );
        assert_eq!(
            doc["agentRuns"].as_array().unwrap().len(),
            0,
            "successful unresolved acknowledgments are not canonical child runs"
        );
    }

    #[test]
    fn protocol_spawn_requires_recorded_return_and_verified_child() {
        let directory = tempfile::tempdir().unwrap();
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let parent_path = transcript_path(directory.path(), "parent.jsonl");
        let child_path = transcript_path(directory.path(), "child.jsonl");
        let rows = vec![
            serde_json::json!({"type":"session_meta","timestamp":"2026-09-28T00:00:00Z","payload":{"id":parent,"agent_path":"/root"}}),
            serde_json::json!({"type":"response_item","timestamp":"2026-09-28T00:00:01Z","payload":{"type":"function_call","call_id":"spawn-1","name":"spawn_agent","namespace":"collaboration","arguments":"{\"task_name\":\"reviewer\"}"}}),
            serde_json::json!({"type":"response_item","timestamp":"2026-09-28T00:00:02Z","payload":{"type":"function_call_output","call_id":"spawn-1","output":"{\"task_name\":\"/root/reviewer\"}"}}),
            serde_json::json!({"type":"response_item","timestamp":"2026-09-28T00:00:03Z","payload":{"type":"agent_message","id":"spawn-1","content":[{"type":"text","text":"Message Type: NEW_TASK\nTask name: /root/reviewer"}]}}),
        ];
        let write_rows = |rows: &[Value]| {
            fs::write(
                &parent_path,
                rows.iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\n",
            )
            .unwrap();
        };
        write_rows(&rows);
        fs::write(&child_path, serde_json::json!({"type":"session_meta","timestamp":"2026-09-28T00:00:02Z","payload":{"id":child,"parent_thread_id":parent,"agent_path":"/root/reviewer"}}).to_string() + "\n").unwrap();
        let sources = CodexSources::from(BTreeMap::from([
            (parent.into(), parent_path.clone()),
            (child.into(), child_path),
        ]));
        let open = serde_json::to_value(
            codex_protocol_bundle_with_sources(&parent_path, "spawn-facts", parent, Some(&sources))
                .unwrap()
                .document(3)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            open["tasks"].as_array().unwrap().len(),
            1,
            "same-ID NEW_TASK and spawn are one task"
        );
        assert_eq!(
            open["tasks"][0]["status"], "unknown",
            "ACK is not completion"
        );
        assert_eq!(open["agentRuns"].as_array().unwrap().len(), 1);
        assert_eq!(open["agentRuns"][0]["kind"], "subagent");
        assert_eq!(open["agentRuns"][0]["turnId"], Value::Null);
        assert_eq!(open["agentRuns"][0]["childSessionRef"]["sessionId"], child);
        assert_eq!(open["agentRuns"][0]["status"], "unknown");
        assert_eq!(open["agentRuns"][0]["pairing"], "open");
        let selected_child_identities = selected_child_identities(&sources);
        let batched = serde_json::to_value(
            codex_protocol_bundle_with_sources_and_identities(
                &parent_path,
                "spawn-facts",
                parent,
                Some(&sources),
                Some(&selected_child_identities),
            )
            .unwrap()
            .document(3)
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            batched, open,
            "cached child identities preserve run binding and revision"
        );
        let mut returned = rows;
        returned.push(serde_json::json!({"type":"response_item","timestamp":"2026-09-28T00:00:08Z","payload":{"type":"agent_message","author":"/root/reviewer","recipient":"/root","content":[{"type":"text","text":"Message Type: FINAL_ANSWER\nTask name: reviewer\nSender: /root/reviewer\nPayload:\nDone."}]}}));
        write_rows(&returned);
        let complete = serde_json::to_value(
            codex_protocol_bundle_with_sources(&parent_path, "spawn-facts", parent, Some(&sources))
                .unwrap()
                .document(3)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(complete["tasks"][0]["status"], "completed");
        assert_eq!(complete["agentRuns"][0]["status"], "completed");
        assert_eq!(
            complete["agentRuns"][0]["terminalEvidence"]["eventId"],
            "event:codex:4"
        );
        assert_eq!(complete["relationships"].as_array().unwrap().len(), 1);
        assert_eq!(complete["relationships"][0]["to"]["sessionId"], child);
    }

    #[test]
    fn protocol_child_ownership_changes_revision_and_run_binding() {
        let directory = tempfile::tempdir().unwrap();
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let parent_path = transcript_path(directory.path(), "parent.jsonl");
        let child_path = transcript_path(directory.path(), "child.jsonl");
        let parent_rows = [
            serde_json::json!({"type":"session_meta","payload":{"id":parent}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"spawn-1","name":"spawn_agent","namespace":"collaboration","arguments":"{}"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"spawn-1","output":"{\"task_name\":\"/root/reviewer\"}"}}),
        ];
        fs::write(
            &parent_path,
            parent_rows
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let header = serde_json::json!({"type":"session_meta","timestamp":"2026-09-28T00:00:02Z","payload":{"id":child,"parent_thread_id":parent,"agent_path":"/root/reviewer"}});
        let copied = serde_json::json!({"type":"session_meta","payload":{"id":parent}});
        fs::write(&child_path, format!("{header}\n{copied}\n")).unwrap();
        let sources = CodexSources::from(BTreeMap::from([
            (parent.into(), parent_path.clone()),
            (child.into(), child_path.clone()),
        ]));
        let before = serde_json::to_value(
            codex_protocol_bundle_with_sources(
                &parent_path,
                "child-ownership",
                parent,
                Some(&sources),
            )
            .unwrap()
            .document(3)
            .unwrap(),
        )
        .unwrap();
        assert!(before["agentRuns"].as_array().unwrap().is_empty());
        assert_eq!(before["tasks"].as_array().unwrap().len(), 1);
        let owned_task = serde_json::json!({"type":"response_item","payload":{"type":"agent_message","id":"owned-task","content":[{"type":"text","text":"Message Type: NEW_TASK\nTask name: /root/reviewer"}]}});
        fs::write(&child_path, format!("{header}\n{copied}\n{owned_task}\n")).unwrap();
        assert_eq!(
            reader_parent_fact_from_path(&child_path, child)
                .unwrap()
                .unwrap()
                .session_id,
            parent
        );
        let after = serde_json::to_value(
            codex_protocol_bundle_with_sources(
                &parent_path,
                "child-ownership",
                parent,
                Some(&sources),
            )
            .unwrap()
            .document(3)
            .unwrap(),
        )
        .unwrap();
        assert_ne!(before["revision"], after["revision"]);
        assert_eq!(
            after["agentRuns"][0]["childSessionRef"]["sessionId"], child,
            "{after}"
        );
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "child-ownership",
        };
        let stamp = adapter.reader_revision(parent).unwrap().unwrap();
        assert_eq!(stamp.revision, after["revision"]);
        assert_eq!(
            adapter.reader_capture(parent).unwrap().snapshot.revision,
            stamp.revision
        );
        assert_eq!(
            adapter.protocol_event_stream(parent).unwrap().revision(),
            stamp.revision
        );
        let original = fs::read_to_string(&child_path).unwrap();
        let changed = original.replace("/root/reviewer", "/root/reviewee");
        assert_eq!(original.len(), changed.len());
        let mtime = fs::metadata(&child_path).unwrap().modified().unwrap();
        fs::write(&child_path, changed).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&child_path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(mtime))
            .unwrap();
        let revised = adapter.reader_revision(parent).unwrap().unwrap();
        assert_ne!(revised.revision, stamp.revision);
        let rebuilt = serde_json::to_value(
            adapter
                .protocol_bundle(parent)
                .unwrap()
                .document(3)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(rebuilt["revision"], revised.revision);
        assert!(rebuilt["agentRuns"].as_array().unwrap().is_empty());
    }

    #[test]
    fn outer_execution_requires_matched_returns_and_preserves_interruption_request() {
        let mut tracker = CodexExecutionTracker::default();
        let rows = [
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"outer","name":"exec","input":"session_id: 777"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"wrong","output":"Script running with cell ID 65\nWall time 2 seconds\nOutput:\n"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"outer","output":"Script running with cell ID 65\nWall time bad seconds\nOutput:\n"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"outer","output":"Script running with cell ID 65\nWall time 2 seconds\nOutput:\n"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"interrupt","name":"wait","arguments":"{\"cell_id\":\"65\",\"terminate\":true}"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"interrupt","output":"Script running with cell ID 65\nWall time 1 seconds\nOutput:\n"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"finish","name":"wait","arguments":"{\"cell_id\":65}"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"finish","output":"Script completed\nWall time 1 seconds\nOutput:\nDone"}}),
        ];
        for (index, row) in rows.iter().enumerate().take(3) {
            tracker.observe(row, index);
        }
        assert!(
            tracker.observations.is_empty(),
            "a call and malformed or unmatched returns do not start execution"
        );
        for (index, row) in rows.iter().enumerate().skip(3) {
            tracker.observe(row, index);
        }
        let phases = [0, 3, 4, 5, 6, 7]
            .into_iter()
            .map(|index| tracker.observations.get(&index).map(|event| event.phase))
            .collect::<Vec<_>>();
        assert_eq!(
            phases,
            [
                Some(ExecutionPhase::Started),
                Some(ExecutionPhase::Yielded),
                Some(ExecutionPhase::InterruptionRequested),
                Some(ExecutionPhase::Yielded),
                Some(ExecutionPhase::Polled),
                Some(ExecutionPhase::Completed),
            ]
        );
        assert!(
            tracker
                .observations
                .values()
                .all(|event| event.id == "outer" && event.handle == "65")
        );
    }

    #[test]
    fn execution_ignores_nonouter_namespace_and_malformed_call_identity() {
        let mut tracker = CodexExecutionTracker::default();
        let rows = [
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":7,"name":"exec"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"7","output":"Script running with cell ID 65\nWall time 1 seconds\nOutput:\n"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"nested","name":"exec","namespace":"functions"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"nested","output":"Script running with cell ID 777\nWall time 1 seconds\nOutput:\n"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"wait","name":"wait","arguments":"{\"cell_id\":\"65\"}"}}),
        ];
        for (index, row) in rows.iter().enumerate() {
            tracker.observe(row, index);
        }
        assert!(tracker.observations.is_empty());
    }

    #[test]
    fn execution_reads_only_first_stringified_output_block() {
        let first = serde_json::json!({"type":"input_text","text":"Script running with cell ID 65\nWall time 1 seconds\nOutput:\n"});
        let output = format!("[{first},{{malformed remaining output");
        assert_eq!(
            codex_execution_first_header(&Value::String(output))
                .as_deref()
                .and_then(codex_running_handle),
            Some("65".into())
        );
        let second = serde_json::json!({"type":"input_text","text":"Script running with cell ID 777\nWall time 1 seconds\nOutput:\n"});
        let output = format!("[{{\"type\":\"other\",\"text\":\"ignored\"}},{second}]");
        assert!(codex_execution_first_header(&Value::String(output)).is_none());
    }

    #[test]
    fn execution_tracks_interleaved_handles_overlapping_waits_and_reuse() {
        let exec = |id: &str| serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":id}});
        let yield_output = |id: &str, handle: &str| serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":id,"output":format!("Script running with cell ID {handle}\nWall time 1 seconds\nOutput:\n")}});
        let wait = |id: &str, handle: &str, terminate: bool| serde_json::json!({"type":"response_item","payload":{"type":"function_call","name":"wait","call_id":id,"arguments":serde_json::json!({"cell_id":handle,"terminate":terminate}).to_string()}});
        let wait_output = |id: &str, header: &str| serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":id,"output":header}});
        let rows = [
            exec("a"),
            yield_output("a", "65"),
            exec("b"),
            yield_output("b", "69"),
            wait("a1", "65", false),
            wait("a2", "65", false),
            wait("b1", "69", false),
            wait_output(
                "a1",
                "Script running with cell ID 65\nWall time 1 seconds\nOutput:\n",
            ),
            wait_output("b1", "Script failed\nWall time 1 seconds\nOutput:\n"),
            wait_output("a2", "Script completed\nWall time 1 seconds\nOutput:\n"),
            exec("c"),
            yield_output("c", "65"),
            wait("c1", "65", true),
            wait_output("c1", "Script completed\nWall time 1 seconds\nOutput:\n"),
        ];
        let mut tracker = CodexExecutionTracker::default();
        for (index, row) in rows.iter().enumerate() {
            tracker.observe(row, index);
        }
        let phases = (0..rows.len())
            .filter_map(|index| tracker.observations.get(&index))
            .map(|event| (event.id.as_str(), event.phase, event.handle.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            phases,
            [
                ("a", ExecutionPhase::Started, "65"),
                ("a", ExecutionPhase::Yielded, "65"),
                ("b", ExecutionPhase::Started, "69"),
                ("b", ExecutionPhase::Yielded, "69"),
                ("a", ExecutionPhase::Polled, "65"),
                ("a", ExecutionPhase::Polled, "65"),
                ("b", ExecutionPhase::Polled, "69"),
                ("a", ExecutionPhase::Yielded, "65"),
                ("b", ExecutionPhase::Failed, "69"),
                ("a", ExecutionPhase::Completed, "65"),
                ("c", ExecutionPhase::Started, "65"),
                ("c", ExecutionPhase::Yielded, "65"),
                ("c", ExecutionPhase::InterruptionRequested, "65"),
                ("c", ExecutionPhase::Completed, "65"),
            ]
        );
        assert!(tracker.calls.is_empty());
        assert!(tracker.wait_executions.is_empty());
        assert!(tracker.active_by_handle.is_empty());
    }

    #[test]
    fn plain_execution_header_inspects_only_bounded_prefix() {
        let mut large = String::from("Script completed\nWall time 1 seconds\nOutput:\n");
        large.push_str(&"x".repeat(2_000_000));
        let value = Value::String(large);
        let header = codex_execution_first_header(&value).unwrap();
        assert!(matches!(header, Cow::Borrowed(_)));
        assert!(codex_terminal_header(&header, "Script completed"));
        let malformed = format!(
            "{}Script completed\nWall time 1 seconds\nOutput:\n",
            " ".repeat(EXECUTION_HEADER_MAX_BYTES)
        );
        assert!(!codex_terminal_header(&malformed, "Script completed"));
        let block = serde_json::json!({"type":"input_text","text":format!("Script completed\nWall time 1 seconds\nOutput:\n{}", "x".repeat(2_000_000))});
        let serialized = Value::String(format!("[{block}]"));
        let header = codex_execution_first_header(&serialized).unwrap();
        assert!(matches!(header, Cow::Owned(_)));
        assert!(header.len() < EXECUTION_HEADER_MAX_BYTES);
        assert!(codex_terminal_header(&header, "Script completed"));
    }

    #[test]
    fn direct_process_interleaving_reuse_and_outer_cell_collision_keep_identity() {
        let process_call = |id: &str, cmd: &str| serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":id,"name":"exec_command","arguments":serde_json::json!({"cmd":cmd}).to_string()}});
        let stdin_call = |id: &str, handle: i64, chars: &str| serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":id,"name":"write_stdin","arguments":serde_json::json!({"session_id":handle,"chars":chars}).to_string()}});
        let output = |id: &str, text: String| serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":id,"output":text}});
        let running = |handle: i64| {
            format!(
                "Chunk ID: chunk\nWall time: 1.25 seconds\nProcess running with session ID {handle}\nOutput:\n"
            )
        };
        let exited = |code: i64| {
            format!(
                "Chunk ID: chunk\nWall time: 0.0 seconds\nProcess exited with code {code}\nOutput:\n"
            )
        };
        let rows = [
            process_call("a", "npm   run build"),
            output("a", running(65)),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"outer","name":"exec"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"outer","output":"Script running with cell ID 65\nWall time 1 seconds\nOutput:\n"}}),
            process_call("b", "second"),
            output("b", running(69)),
            stdin_call("a-poll", 65, ""),
            output("a-poll", running(65)),
            stdin_call("b-input", 69, "yes\n"),
            output("b-input", exited(1)),
            stdin_call("a-stop", 65, "\u{0003}"),
            output("a-stop", exited(0)),
            process_call("c", "reused"),
            output("c", running(65)),
        ];
        let mut tracker = CodexExecutionTracker::default();
        for (index, row) in rows.iter().enumerate() {
            tracker.observe(row, index);
        }
        let process = (0..rows.len())
            .filter_map(|index| tracker.observations.get(&index))
            .filter(|event| event.kind == ExecutionKind::Process)
            .map(|event| (event.id.as_str(), event.phase, event.handle.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            process,
            [
                ("a", ExecutionPhase::Started, "65"),
                ("a", ExecutionPhase::Yielded, "65"),
                ("b", ExecutionPhase::Started, "69"),
                ("b", ExecutionPhase::Yielded, "69"),
                ("a", ExecutionPhase::Polled, "65"),
                ("a", ExecutionPhase::Yielded, "65"),
                ("b", ExecutionPhase::Input, "69"),
                ("b", ExecutionPhase::Failed, "69"),
                ("a", ExecutionPhase::InterruptionRequested, "65"),
                ("a", ExecutionPhase::Completed, "65"),
                ("c", ExecutionPhase::Started, "65"),
                ("c", ExecutionPhase::Yielded, "65"),
            ]
        );
        assert_eq!(
            tracker.observations[&0].label.as_deref(),
            Some("npm run build")
        );
        assert_eq!(tracker.observations[&2].kind, ExecutionKind::AsyncTool);
        assert_eq!(tracker.observations[&3].handle, "65");
        assert_eq!(
            tracker.active_processes.get("65").map(String::as_str),
            Some("c")
        );
        assert_eq!(
            tracker.active_by_handle.get("65").map(String::as_str),
            Some("outer")
        );
        assert!(tracker.process_starts.is_empty());
        assert!(tracker.process_continuations.is_empty());
    }

    #[test]
    fn direct_process_requires_exact_headers_and_call_ids() {
        let rows = [
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"start","name":"exec_command","arguments":"{\"cmd\":\"run\"}"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"wrong","output":"Chunk ID: a\nWall time: 1 seconds\nProcess running with session ID 65\n"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"start","output":"Chunk ID: a\nWall time: invalid seconds\nProcess running with session ID 65\n"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"start","output":"Chunk ID: a\nWall time: 1 seconds\nProcess exited with code 0\n"}}),
        ];
        let mut tracker = CodexExecutionTracker::default();
        for (index, row) in rows.iter().enumerate() {
            tracker.observe(row, index);
        }
        assert!(tracker.observations.is_empty());
    }

    #[test]
    #[ignore = "requires explicitly selected frozen private Codex execution manifest"]
    fn frozen_outer_execution_has_four_phases_without_source_mutation() {
        let manifest_path = std::env::var("CODEX_EXECUTION_MANIFEST")
            .expect("selected execution manifest is required");
        let manifest: Value = serde_json::from_slice(&fs::read(manifest_path).unwrap())
            .expect("selected execution manifest must be JSON");
        let path = PathBuf::from(manifest["frozen"].as_str().expect("frozen source path"));
        let source_before = fs::read(&path).expect("selected frozen source must be readable");
        let source_hash = format!("{:x}", Sha256::digest(&source_before));
        assert_eq!(source_hash, manifest["sha256"].as_str().unwrap());
        let first: Value =
            serde_json::from_slice(source_before.split(|byte| *byte == b'\n').next().unwrap())
                .expect("selected source starts with valid metadata");
        let id = first["payload"]["id"]
            .as_str()
            .expect("selected source has canonical id");
        let bundle = codex_protocol_bundle(&path, "frozen-execution", id)
            .unwrap_or_else(|_| panic!("selected frozen execution protocol failed"));
        let document = bundle.document(3).expect("validated v3 document");
        let serialized = serde_json::to_value(document).unwrap();
        let events = serialized["events"].as_array().unwrap();
        let phases = events
            .iter()
            .filter_map(|event| event["execution"]["phase"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(phases, ["started", "yielded", "polled", "completed"]);
        assert_eq!(serialized["coverage"]["execution"]["state"], "observed");
        assert!(
            events
                .iter()
                .filter(|event| !event["execution"].is_null())
                .all(|event| event["readerEvent"]["segment"] == "tool")
        );
        assert_eq!(fs::read(&path).unwrap(), source_before);
    }

    #[test]
    #[ignore = "requires explicitly selected real Codex title source"]
    fn recorded_native_title_real_source_is_read_only() {
        let root = PathBuf::from(std::env::var("CODEX_NATIVE_TITLE_ROOT").unwrap());
        let path = PathBuf::from(std::env::var("CODEX_NATIVE_TITLE_SOURCE").unwrap());
        let expected = std::env::var("CODEX_NATIVE_TITLE_EXPECTED").unwrap();
        let source_before = fs::read(&path).unwrap();
        let index_before = fs::read(root.join("session_index.jsonl")).unwrap();
        let id = read_header(&path).unwrap().unwrap().0;
        let adapter = CodexAdapter {
            root: &root,
            scope: "selected-real-native-title",
        };
        let snapshot = adapter.load(&id).unwrap();
        assert_eq!(snapshot.summary.title, expected);
        assert_eq!(fs::read(&path).unwrap(), source_before);
        assert_eq!(
            fs::read(root.join("session_index.jsonl")).unwrap(),
            index_before
        );
    }

    #[test]
    fn recorded_native_titles_refresh_library_and_reader_without_changing_transcripts() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let codex_root = root.join("codex");
        let id = "native-title-fixture";
        let path = transcript_path(&codex_root, format!("rollout-{id}.jsonl"));
        let request =
            "会话 codex://threads/recorded-reference\n\n说有问题: investigate the recorded failure";
        let rows = [
            serde_json::json!({"type":"session_meta", "payload":{"id":id}}),
            serde_json::json!({"type":"event_msg", "payload":{"type":"user_message", "message":request}}),
        ];
        fs::write(
            &path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let before = fs::read(&path).unwrap();
        let index_path = codex_root.join("session_index.jsonl");
        let native_row = |name: &str, time: &str| {
            serde_json::json!({"id":id,"thread_name":name,"updated_at":time}).to_string()
        };
        fs::write(
            &index_path,
            native_row("恢复本机 Shell 执行环境", "2026-10-08T16:55:52Z"),
        )
        .unwrap();
        let core = crate::Core::new(crate::SourceConfig {
            codex_dir: codex_root.clone(),
            opencode_db: root.join("opencode.db"),
            claude_dir: root.join("claude"),
            pi_dir: root.join("pi"),
            dsh_dir: root.join("dsh"),
            meta_dir: root.join("meta"),
            index_dir: root.join("index"),
            cache_dir: root.join("cache"),
        })
        .unwrap();
        assert_eq!(
            core.sessions("codex").unwrap()[0].title,
            "恢复本机 Shell 执行环境"
        );
        let initial = core.reader_bootstrap("codex", id).unwrap();
        assert_eq!(initial.session.title, "恢复本机 Shell 执行环境");
        assert_eq!(initial.segments[0].items[0].preview, request);
        fs::write(
            &index_path,
            [
                native_row("Updated native title", "2026-10-09T16:55:52Z"),
                native_row("Older row appended later", "2026-10-08T16:55:52Z"),
            ]
            .join("\n"),
        )
        .unwrap();
        let native_before = fs::read(&index_path).unwrap();
        assert_eq!(
            core.sessions("codex").unwrap()[0].title,
            "Updated native title"
        );
        let updated = core.reader_bootstrap("codex", id).unwrap();
        assert_eq!(updated.session.title, "Updated native title");
        assert_eq!(
            updated.revision, initial.revision,
            "native title does not replace transcript identity or content revision"
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(fs::read(&index_path).unwrap(), native_before);
        fs::write(&index_path, "invalid native title row").unwrap();
        assert_eq!(
            core.sessions("codex").unwrap()[0].title,
            flat_title(request)
        );
        assert_eq!(
            core.reader_bootstrap("codex", id).unwrap().session.title,
            flat_title(request)
        );
        let adapter = CodexAdapter {
            root: &codex_root,
            scope: "native-title-fixture",
        };
        assert_eq!(
            adapter.storage_diagnostic().unwrap()["code"],
            "codex_native_title_index_invalid"
        );
        fs::remove_file(&index_path).unwrap();
        assert!(adapter.storage_diagnostic().is_none());
        assert_eq!(
            core.sessions("codex").unwrap()[0].title,
            flat_title(request)
        );
    }

    #[test]
    fn reader_summary_duration_uses_recorded_conversation_timestamps() {
        let directory = tempfile::tempdir().unwrap();
        let id = "duration-fixture";
        let path = transcript_path(directory.path(), format!("rollout-{id}.jsonl"));
        let rows = [
            serde_json::json!({"type":"session_meta", "timestamp":"2026-09-27T00:00:00Z", "payload":{"id":id}}),
            serde_json::json!({"type":"event_msg", "timestamp":"2026-09-27T00:00:02Z", "payload":{"type":"user_message", "message":"Read the source."}}),
            serde_json::json!({"type":"response_item", "timestamp":"2026-09-27T00:00:07Z", "payload":{"type":"message", "role":"assistant", "content":[{"type":"output_text","text":"Read completed."}]}}),
            serde_json::json!({"type":"turn_context", "timestamp":"2026-09-27T01:00:00Z", "payload":{"model":"fixture"}}),
        ];
        fs::write(
            &path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let before = fs::read(&path).unwrap();
        let summary = codex_snapshot(&path, "duration-fixture", id)
            .unwrap()
            .summary;
        assert_eq!(summary.duration_ms, Some(5_000));
        assert_eq!(
            codex_protocol_bundle(&path, "duration-fixture", id)
                .unwrap()
                .list_stats()
                .duration_ms,
            summary.duration_ms
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::write(
            &path,
            rows[..2]
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        assert_eq!(
            codex_snapshot(&path, "single-point-duration", id)
                .unwrap()
                .summary
                .duration_ms,
            None
        );
    }

    #[test]
    fn reader_tool_metadata_preserves_recorded_input_and_normalizes_spawn_fields() {
        let directory = tempfile::tempdir().unwrap();
        let id = "99999999-9999-4999-8999-999999999999";
        let path = transcript_path(directory.path(), format!("rollout-{id}.jsonl"));
        let fixture = include_str!(
            "../../../../fixtures/codex-collaboration/sessions/2026/09/27/rollout-2026-09-27T00-00-00-99999999-9999-4999-8999-999999999999.jsonl"
        );
        for namespace in ["collaboration", "multi_agent_v1"] {
            for message in [
                "gAAAAA_fixture_encrypted_task",
                "Read the source and return findings.",
            ] {
                let args = serde_json::json!({
                    "task_name": "reviewer", "message": message,
                    "model": "gpt-6-luna", "reasoning_effort": "max", "fork_turns": "none"
                })
                .to_string();
                let rows = fixture
                    .lines()
                    .map(|line| {
                        let mut row: Value = serde_json::from_str(line).unwrap();
                        if row["payload"]["name"] == "spawn_agent" {
                            row["payload"]["namespace"] = namespace.into();
                            row["payload"]["arguments"] = args.clone().into();
                        }
                        row.to_string()
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                fs::write(&path, &rows).unwrap();
                let snapshot = codex_snapshot(&path, "reader-tool-metadata", id).unwrap();
                let tool = snapshot
                    .events
                    .iter()
                    .find(|event| event.item.tool_name.as_deref() == Some("spawn_agent"))
                    .unwrap();
                let metadata = serde_json::to_value(&tool.item.tool_metadata).unwrap();
                assert_eq!(
                    metadata,
                    serde_json::json!({
                        "summary":null, "directory":null, "taskName": "reviewer", "model": "gpt-6-luna", "reasoningEffort": "max", "forkTurns": "none",
                        "inputState": if message.starts_with("gAAAAA") { "encrypted" } else { "recorded" }
                    })
                );
                assert_eq!(
                    tool.tool_input, args,
                    "raw field preserves its recorded bytes"
                );
                assert_eq!(
                    fs::read_to_string(&path).unwrap(),
                    rows,
                    "Reader never mutates provider records"
                );
                assert!(
                    snapshot
                        .events
                        .iter()
                        .filter(|event| event.item.tool_name.is_none())
                        .all(|event| event.item.tool_metadata.is_none())
                );
            }
        }
        let payload = serde_json::json!({"name":"spawn_agent", "namespace":"functions", "arguments":"{\"task_name\":\"unrelated\"}"});
        assert!(
            codex_tool_metadata(&payload).is_none(),
            "a same-named non-collaboration tool is ordinary input"
        );
        let payload = serde_json::json!({"name":"spawn_agent", "namespace":"collaboration", "arguments":"{}"});
        let metadata = serde_json::to_value(codex_tool_metadata(&payload)).unwrap();
        assert!(metadata["model"].is_null());
        assert!(
            metadata["forkTurns"].is_null(),
            "omitted context does not imply a default"
        );
    }

    #[test]
    fn collaboration_spawn_request_retains_only_explicit_launch_options() {
        let directory = tempfile::tempdir().unwrap();
        let id = "99999999-9999-4999-8999-999999999999";
        let path = transcript_path(directory.path(), format!("rollout-{id}.jsonl"));
        let fixture = include_str!(
            "../../../../fixtures/codex-collaboration/sessions/2026/09/27/rollout-2026-09-27T00-00-00-99999999-9999-4999-8999-999999999999.jsonl"
        );
        for namespace in ["collaboration", "multi_agent_v1"] {
            let rows: Vec<Value> =
                fixture
                    .lines()
                    .map(|line| {
                        let mut row: Value = serde_json::from_str(line).unwrap();
                        if row["payload"]["name"] == "spawn_agent" {
                            row["payload"]["namespace"] = namespace.into();
                            row["payload"]["arguments"] = serde_json::json!({
                        "task_name": "reviewer", "message": "encrypted task is opaque",
                        "model": "gpt-6-luna", "reasoning_effort": "max", "fork_turns": "none"
                    }).to_string().into();
                        }
                        row
                    })
                    .collect();
            fs::write(
                &path,
                rows.iter()
                    .map(|row| row.to_string())
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
            .unwrap();
            let snapshot = codex_snapshot(&path, "public-request-options", id).unwrap();
            let serialized = serde_json::to_value(&snapshot.relations).unwrap();
            let observations = serialized.as_array().unwrap();
            let requested = observations
                .iter()
                .find(|row| {
                    row["observation"]["kind"] == "spawn"
                        && row["observation"]["state"] == "requested"
                })
                .unwrap();
            assert_eq!(
                requested["observation"]["launchRequest"],
                serde_json::json!({
                    "model": "gpt-6-luna", "reasoningEffort": "max", "forkTurns": "none"
                })
            );
            assert!(
                observations
                    .iter()
                    .filter(|row| row["observation"]["state"] != "requested")
                    .all(|row| row["observation"].get("launchRequest").is_none())
            );
            assert!(
                snapshot
                    .events
                    .iter()
                    .all(|event| event.item.reply_metadata.is_none())
            );
        }
        fs::write(&path, fixture).unwrap();
        let snapshot = codex_snapshot(&path, "public-request-options-absent", id).unwrap();
        let serialized = serde_json::to_value(&snapshot.relations).unwrap();
        assert!(
            serialized
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["observation"].get("launchRequest").is_none())
        );
    }

    #[test]
    fn collaboration_ack_and_final_answer_follow_recorded_actor_path() {
        let directory = tempfile::tempdir().unwrap();
        let id = "99999999-9999-4999-8999-999999999999";
        let path = transcript_path(directory.path(), format!("rollout-{id}.jsonl"));
        fs::write(
            &path,
            include_str!("../../../../fixtures/codex-collaboration/sessions/2026/09/27/rollout-2026-09-27T00-00-00-99999999-9999-4999-8999-999999999999.jsonl"),
        )
        .unwrap();
        let snapshot = codex_snapshot(&path, "public-collaboration", id).unwrap();
        let relations = serde_json::to_value(&snapshot.relations).unwrap();
        let observations = relations.as_array().unwrap();
        assert!(observations.iter().any(|row| {
            row["observation"]["state"] == "started"
                && row["observation"]["correlationId"] == "spawn-1"
                && row["observation"]["toActorPath"] == "/root/reviewer"
                && row["observation"]["eventId"] == "event:codex:4"
                && row["observation"]["toSessionRef"].is_null()
        }));
        assert!(observations.iter().any(|row| {
            row["observation"]["state"] == "completed"
                && row["observation"]["fromActorPath"] == "/root/reviewer"
                && row["observation"]["toActorPath"] == "/root"
                && row["observation"]["eventId"] == "event:codex:7"
                && row["observation"]["fromSessionRef"].is_null()
                && row["observation"]["toSessionRef"]["sessionId"] == id
                && row["observation"]["provenance"]["sourceType"]
                    == "codex.response_item:agent_message:FINAL_ANSWER"
        }));
        assert!(
            !observations
                .iter()
                .any(|row| { row["observation"]["toActorPath"] == "/root/decoy" })
        );
        let waits = observations
            .iter()
            .filter(|row| row["observation"]["kind"] == "wait")
            .collect::<Vec<_>>();
        assert_eq!(waits.len(), 2);
        assert_eq!(waits[1]["observation"]["state"], "timed_out");
        assert_eq!(waits[1]["observation"]["eventId"], "event:codex:6");
        assert!(waits.iter().all(|row| {
            row["observation"]["toActorPath"].is_null()
                && row["observation"]["toSessionRef"].is_null()
        }));
        let answer = snapshot
            .events
            .iter()
            .find(|row| row.body.contains("actionable issue"))
            .unwrap();
        assert_eq!(answer.item.role, "agent");
        assert_eq!(answer.item.owner, None);
        assert_eq!(answer.item.event.message_id, "agent-result");
        assert_eq!(answer.body, "  The review found one actionable issue.\n");
        assert!(
            !snapshot
                .events
                .iter()
                .any(|row| row.body.contains("outgoing envelope"))
        );
        let stream = codex_protocol_stream(&path, "public-collaboration", id).unwrap();
        for (source, call_id) in [(2, "spawn-1"), (4, "spawn-1"), (5, "wait-1"), (6, "wait-1")] {
            let relation = observations
                .iter()
                .find(|row| row["observation"]["eventId"] == format!("event:codex:{source}"))
                .unwrap();
            let reference = &relation["observation"]["readerEvent"];
            assert_eq!(reference["messageId"], call_id);
            assert_eq!(reference["segment"], "tool");
            assert_eq!(
                serde_json::to_value(
                    stream
                        .event_detail(&format!("event:codex:{source}"))
                        .unwrap()
                        .event
                        .reader_event
                        .unwrap()
                )
                .unwrap(),
                *reference
            );
        }
        assert_eq!(
            stream
                .event_detail("event:codex:7")
                .unwrap()
                .event
                .reader_event
                .as_ref(),
            Some(&answer.item.event)
        );
        let v3 = serde_json::to_value(
            codex_protocol_bundle(&path, "public-collaboration", id)
                .unwrap()
                .document(3)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(v3["coordination"].as_array().unwrap().len(), 5);
        assert_eq!(v3["coordination"][1]["toActorPath"], "/root/reviewer");
        assert_eq!(
            v3["coordination"][4]["evidence"]["eventId"],
            "event:codex:7"
        );
        assert_eq!(v3["coverage"]["coordination"]["state"], "observed");
    }

    #[test]
    #[ignore = "requires explicitly selected frozen private Codex source"]
    fn frozen_private_collaboration_links_ack_and_final_answer_without_source_change() {
        let path = PathBuf::from(std::env::var("CODEX_PRIVATE_SOURCE").unwrap());
        let before = fs::read(&path).unwrap();
        let id = read_header(&path).unwrap().unwrap().0;
        let snapshot = codex_snapshot(&path, "private-collaboration", &id).unwrap();
        let relations = serde_json::to_value(&snapshot.relations).unwrap();
        let rows = relations.as_array().unwrap();
        let ack = rows
            .iter()
            .find(|row| row["observation"]["eventId"] == "event:codex:466")
            .unwrap();
        let result = rows
            .iter()
            .find(|row| row["observation"]["eventId"] == "event:codex:615")
            .unwrap();
        assert_eq!(ack["observation"]["state"], "started");
        assert_eq!(result["observation"]["state"], "completed");
        for source in [463, 466, 608, 612] {
            let relation = rows
                .iter()
                .find(|row| row["observation"]["eventId"] == format!("event:codex:{source}"))
                .unwrap();
            assert_eq!(relation["observation"]["readerEvent"]["segment"], "tool");
        }
        assert_eq!(
            ack["observation"]["toActorPath"],
            result["observation"]["fromActorPath"]
        );
        assert_eq!(
            ack["observation"]["correlationId"],
            result["observation"]["correlationId"]
        );
        let wait = rows
            .iter()
            .find(|row| row["observation"]["eventId"] == "event:codex:612")
            .unwrap();
        assert_eq!(wait["observation"]["kind"], "wait");
        assert_eq!(wait["observation"]["state"], "returned");
        assert!(wait["observation"]["toActorPath"].is_null());
        assert!(wait["observation"]["toSessionRef"].is_null());
        let answer = snapshot
            .events
            .iter()
            .find(|row| {
                serde_json::to_value(&row.item.event).unwrap()
                    == result["observation"]["readerEvent"]
            })
            .unwrap();
        assert_eq!(answer.item.role, "agent");
        assert_eq!(answer.item.owner, None);
        assert!(!answer.body.is_empty());
        let protocol = serde_json::to_value(
            codex_protocol_bundle(&path, "private-collaboration", &id)
                .unwrap()
                .document(3)
                .unwrap(),
        )
        .unwrap();
        assert!(
            protocol["coordination"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| {
                    row["evidence"]["eventId"] == "event:codex:615"
                        && row["readerEvent"] == result["observation"]["readerEvent"]
                })
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn archived_transcript_root_is_available_without_active_sessions() {
        let directory = tempfile::tempdir().unwrap();
        let archived = directory.path().join("archived_sessions");
        fs::create_dir_all(&archived).unwrap();
        fs::write(
            archived.join("rollout-archived.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"archived\"}}\n",
        )
        .unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "archived-only",
        };
        assert!(adapter.available());
        assert_eq!(
            adapter.load("archived").unwrap().summary.session.session_id,
            "archived"
        );
    }

    #[test]
    fn transcript_roots_exclude_codex_home_artifacts_and_preserve_owned_identity_gate() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for relative in [
            "sessions/2026/10/09",
            "archived_sessions",
            "visualizations/sample",
            ".tmp/plugin",
        ] {
            fs::create_dir_all(root.join(relative)).unwrap();
        }
        let source =
            |id: &str| format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n");
        let active = root.join("sessions/2026/10/09/rollout-active.jsonl");
        let archived = root.join("archived_sessions/rollout-archived.jsonl");
        fs::write(&active, source("active")).unwrap();
        fs::write(&archived, source("archived")).unwrap();
        fs::write(
            root.join("visualizations/sample/rollout-copy.jsonl"),
            source("active"),
        )
        .unwrap();
        fs::write(root.join("session_index.jsonl"), serde_json::json!({
            "id":"active", "thread_name":"Recorded active title", "updated_at":"2026-10-09T00:00:00Z"
        }).to_string()).unwrap();
        for relative in [
            "transcription-history.jsonl",
            "visualizations/sample/data.jsonl",
            ".tmp/plugin/responses.jsonl",
        ] {
            fs::write(root.join(relative), "{\"type\":\"non_transcript\"}\n").unwrap();
        }
        let adapter = CodexAdapter {
            root,
            scope: "transcript-roots",
        };
        assert_eq!(
            adapter.codex_files().unwrap(),
            [archived.clone(), active.clone()]
        );
        assert!(adapter.storage_diagnostic().is_none());
        assert_eq!(adapter.inventory().unwrap().unwrap().len(), 2);
        assert_eq!(
            adapter.load("active").unwrap().summary.session.session_id,
            "active"
        );
        assert_eq!(
            adapter.load("archived").unwrap().summary.session.session_id,
            "archived"
        );
        fs::write(
            root.join("archived_sessions/rollout-corrupt.jsonl"),
            "{invalid header}\n",
        )
        .unwrap();
        assert_eq!(
            adapter.storage_diagnostic().unwrap()["unresolvedFileCount"],
            1
        );
        assert!(matches!(adapter.load("active"),
            Err(CoreError::Protocol(ProtocolError::Unavailable { diagnostic }))
                if diagnostic == UNRESOLVED_SOURCE_DIAGNOSTIC));
        assert_eq!(fs::read_to_string(active).unwrap(), source("active"));
        assert_eq!(fs::read_to_string(archived).unwrap(), source("archived"));
    }

    #[test]
    fn inventory_rechecks_headers_and_refreshes_changed_sources() {
        let directory = tempfile::tempdir().unwrap();
        let first = transcript_path(directory.path(), "rollout-first.jsonl");
        let second = transcript_path(directory.path(), "rollout-second.jsonl");
        let source =
            |id: &str| format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n");
        fs::write(&first, source("first")).unwrap();
        fs::write(&second, source("second")).unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "cache-test",
        };
        let before = HEADER_READS.with(|count| count.get());
        assert_eq!(adapter.inventory().unwrap().unwrap().len(), 2);
        let after_first = HEADER_READS.with(|count| count.get());
        assert_eq!(after_first - before, 2);
        assert_eq!(adapter.inventory().unwrap().unwrap().len(), 2);
        assert_eq!(HEADER_READS.with(|count| count.get()), after_first + 2);
        fs::write(&second, source("third-longer")).unwrap();
        let inventory = adapter.inventory().unwrap().unwrap();
        assert_eq!(
            inventory
                .iter()
                .map(|entry| entry.session_id.as_str())
                .collect::<Vec<_>>(),
            ["first", "third-longer"]
        );
        assert_eq!(HEADER_READS.with(|count| count.get()), after_first + 4);
        fs::OpenOptions::new()
            .append(true)
            .open(&first)
            .unwrap()
            .write_all(b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"appended\"}}\n")
            .unwrap();
        assert_eq!(adapter.inventory().unwrap().unwrap().len(), 2);
        assert_eq!(HEADER_READS.with(|count| count.get()), after_first + 6);
        fs::remove_file(&first).unwrap();
        assert_eq!(
            adapter
                .inventory()
                .unwrap()
                .unwrap()
                .iter()
                .map(|entry| entry.session_id.as_str())
                .collect::<Vec<_>>(),
            ["third-longer"]
        );
    }

    #[test]
    fn inventory_validation_rejects_a_second_source_added_after_capture_started() {
        let directory = tempfile::tempdir().unwrap();
        let first = transcript_path(directory.path(), "rollout-first.jsonl");
        let second = transcript_path(directory.path(), "rollout-second.jsonl");
        let source = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"same\"}}\n";
        fs::write(&first, source).unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "collision-race",
        };
        let incoming = adapter
            .inventory()
            .unwrap()
            .unwrap()
            .into_iter()
            .map(|entry| (entry.session_id.clone(), entry))
            .collect();
        fs::write(&second, source).unwrap();
        assert!(matches!(
            adapter.validate_inventory(&incoming),
            Err(CoreError::SourceChanged)
        ));
        let collided = adapter.inventory().unwrap().unwrap();
        assert_eq!(collided.len(), 1);
        assert!(collided[0].signature.starts_with("collision:"));
    }

    #[test]
    fn forced_exact_index_capture_reuses_only_unchanged_singletons() {
        let directory = tempfile::tempdir().unwrap();
        let left = transcript_path(directory.path(), "left.jsonl");
        let right = transcript_path(directory.path(), "right.jsonl");
        let source = |id: &str, text: &str| {
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"{text}\"}}}}\n"
            )
        };
        fs::write(&left, source("left-id", "before")).unwrap();
        fs::write(&right, source("rght-id", "stable")).unwrap();
        let index = directory.path().join("index");
        CODEX_NORMALIZATION_COUNT.with(|count| count.set(0));
        {
            let adapter = CodexAdapter {
                root: directory.path(),
                scope: "exact-reuse",
            };
            crate::index::refresh(&index, adapter.scope, "codex", &adapter).unwrap();
        }
        assert_eq!(CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get), 2);
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "exact-reuse",
        };
        let unchanged = crate::index::rebuild(&index, adapter.scope, "codex", &adapter).unwrap();
        assert_eq!(unchanged.revision, "codex:2");
        assert_eq!(CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get), 2);
        let modified = fs::metadata(&left).unwrap().modified().unwrap();
        let original_signature = SourceEntry::new("left-id".into(), left.clone())
            .unwrap()
            .signature;
        fs::write(&left, source("left-id", "after!")).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&left)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(
            SourceEntry::new("left-id".into(), left.clone())
                .unwrap()
                .signature,
            original_signature
        );
        let changed = crate::index::rebuild(&index, adapter.scope, "codex", &adapter).unwrap();
        assert_eq!(CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get), 3);
        assert_eq!(
            changed
                .rows
                .iter()
                .find(|row| row.session.session_id == "left-id")
                .unwrap()
                .title,
            "after!"
        );
        let modified = fs::metadata(&left).unwrap().modified().unwrap();
        fs::write(&left, source("neww-id", "after!")).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&left)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let renamed = crate::index::rebuild(&index, adapter.scope, "codex", &adapter).unwrap();
        assert_eq!(CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get), 4);
        assert_eq!(renamed.rows.len(), 2);
        assert!(
            renamed
                .rows
                .iter()
                .any(|row| row.session.session_id == "neww-id")
        );
        assert!(
            !renamed
                .rows
                .iter()
                .any(|row| row.session.session_id == "left-id")
        );
        let entry = adapter
            .inventory()
            .unwrap()
            .unwrap()
            .into_iter()
            .find(|entry| entry.session_id == "neww-id")
            .unwrap();
        assert_eq!(
            adapter.index_capture_revision(&entry).unwrap().unwrap(),
            adapter.capture(&entry).unwrap().revision
        );
        fs::remove_file(&left).unwrap();
        let before_delete = CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get);
        let deleted = crate::index::rebuild(&index, adapter.scope, "codex", &adapter).unwrap();
        assert_eq!(deleted.rows.len(), 1);
        assert_eq!(deleted.rows[0].session.session_id, "rght-id");
        assert_eq!(
            CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get),
            before_delete
        );
    }

    #[test]
    fn inventory_rechecks_canonical_id_after_same_stat_header_rewrite() {
        let left = tempfile::tempdir().unwrap();
        let right = tempfile::tempdir().unwrap();
        let filename = "rollout-shared.jsonl";
        let left_path = transcript_path(left.path(), filename);
        let right_path = transcript_path(right.path(), filename);
        let source =
            |id: &str| format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n");
        fs::write(&left_path, source("left-id")).unwrap();
        fs::write(&right_path, source("right-id")).unwrap();
        let left_adapter = CodexAdapter {
            root: left.path(),
            scope: "left",
        };
        let right_adapter = CodexAdapter {
            root: right.path(),
            scope: "right",
        };
        let left_entry = left_adapter.inventory().unwrap().unwrap().remove(0);
        assert_eq!(left_entry.session_id, "left-id");
        assert_eq!(
            right_adapter.inventory().unwrap().unwrap()[0].session_id,
            "right-id"
        );

        let modified = fs::metadata(&left_path).unwrap().modified().unwrap();
        fs::write(&left_path, source("neww-id")).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&left_path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(
            SourceEntry::new("left-id".into(), left_path)
                .unwrap()
                .signature,
            left_entry.signature
        );
        let reassigned = left_adapter.inventory().unwrap().unwrap().remove(0);
        assert_eq!(reassigned.session_id, "neww-id");
        assert_eq!(
            left_adapter
                .capture(&reassigned)
                .unwrap()
                .summary
                .session
                .session_id,
            "neww-id"
        );
        assert_eq!(
            right_adapter.inventory().unwrap().unwrap()[0].session_id,
            "right-id"
        );
    }

    #[test]
    fn unresolved_source_signature_stays_diagnostic_when_content_cannot_be_read() {
        let directory = tempfile::tempdir().unwrap();
        let path = transcript_path(directory.path(), "unreadable.jsonl");
        let inaccessible = CodexAdapter::unresolved_signature(&[path.clone()]).unwrap();
        fs::write(&path, b"{invalid header}\n").unwrap();
        let readable = CodexAdapter::unresolved_signature(&[path]).unwrap();
        assert_ne!(inaccessible, readable);
    }

    #[test]
    fn explicit_rebuild_recovers_canonical_id_after_same_stat_header_rewrite() {
        let directory = tempfile::tempdir().unwrap();
        let path = transcript_path(directory.path(), "rollout.jsonl");
        let source = |id: &str| {
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"hello\"}}}}\n"
            )
        };
        fs::write(&path, source("old-id")).unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "same-stat-rebuild",
        };
        let index = directory.path().join("index");
        let first = crate::index::refresh(&index, adapter.scope, "codex", &adapter)
            .unwrap()
            .unwrap();
        assert_eq!(first.rows[0].session.session_id, "old-id");
        let previous = fs::metadata(&path).unwrap().modified().unwrap();
        let signature = adapter.inventory().unwrap().unwrap()[0].signature.clone();
        fs::write(&path, source("new-id")).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(previous))
            .unwrap();
        assert_eq!(
            adapter.inventory().unwrap().unwrap()[0].signature,
            signature
        );

        let rebuilt = crate::index::rebuild(&index, adapter.scope, "codex", &adapter).unwrap();
        assert_eq!(rebuilt.rows.len(), 1);
        assert_eq!(rebuilt.rows[0].session.session_id, "new-id");
        assert_ne!(rebuilt.revision, first.revision);
        assert_eq!(
            adapter.inventory().unwrap().unwrap()[0].session_id,
            "new-id"
        );
        assert!(adapter.load("new-id").is_ok());
        assert!(matches!(
            adapter.load("old-id"),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    #[ignore = "requires frozen private Codex inventory"]
    fn bench_frozen_inventory() {
        let root = PathBuf::from(std::env::var("CODEX_BENCH_ROOT").unwrap());
        let adapter = CodexAdapter {
            root: &root,
            scope: "frozen-bench",
        };
        assert_eq!(adapter.codex_files().unwrap().len(), 840);
        let started = std::time::Instant::now();
        for _ in 0..35 {
            assert_eq!(adapter.inventory().unwrap().unwrap().len(), 837);
        }
        eprintln!("Codex 35 inventories: {:?}", started.elapsed());
    }

    #[test]
    fn recorded_compaction_is_one_source_ordered_reader_checkpoint_with_readable_content() {
        let source = include_str!(
            "../../../../fixtures/codex-compaction/sessions/2026/09/26/rollout-2026-09-26T00-00-00-55555555-5555-4555-8555-555555555555.jsonl"
        );
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join("rollout-55555555-5555-4555-8555-555555555555.jsonl");
        fs::write(&path, source).unwrap();
        let id = "55555555-5555-4555-8555-555555555555";
        let snapshot = codex_snapshot(&path, "compact-fixture", id).unwrap();
        assert_eq!(snapshot.summary.message_count, 4);
        let checkpoints: Vec<_> = snapshot
            .events
            .iter()
            .filter(|event| event.item.event.segment == "context")
            .collect();
        assert_eq!(checkpoints.len(), 1);
        assert_eq!(checkpoints[0].item.ordinal, 2);
        assert_eq!(checkpoints[0].item.event.message_id, "compaction-3");
        assert!(checkpoints[0].body.contains("Recorded summary ends."));
        assert!(checkpoints[0].body.contains("Last retained answer."));
        assert!(!checkpoints[0].body.contains("secret-ciphertext"));
        let stream = codex_protocol_stream(&path, "compact-fixture", id).unwrap();
        let page = stream
            .events(crate::protocol::EventQuery {
                category: Some("context".into()),
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.events[0].source_order.record, 3);
        assert_eq!(page.events[0].kind, "context.compaction");
        assert_eq!(
            page.events[0].reader_event.as_ref(),
            Some(&checkpoints[0].item.event)
        );
    }

    #[test]
    #[ignore = "requires explicitly selected frozen private Codex source"]
    fn frozen_private_compactions_keep_raw_positions_and_unavailable_summaries() {
        let path = PathBuf::from(std::env::var("CODEX_PRIVATE_SOURCE").unwrap());
        let source = fs::read_to_string(&path).unwrap();
        let raw_positions: Vec<_> = source
            .lines()
            .enumerate()
            .filter_map(|(index, line)| {
                let row: Value = serde_json::from_str(line).ok()?;
                (row["type"] == "compacted").then_some(index)
            })
            .collect();
        assert!(!raw_positions.is_empty());
        let id = read_header(&path).unwrap().unwrap().0;
        let snapshot = codex_snapshot(&path, "frozen-private-compaction", &id).unwrap();
        let checkpoints: Vec<_> = snapshot
            .events
            .iter()
            .filter(|event| event.item.event.segment == "context")
            .collect();
        assert_eq!(checkpoints.len(), raw_positions.len());
        let stream = codex_protocol_stream(&path, "frozen-private-compaction", &id).unwrap();
        for (position, checkpoint) in raw_positions.iter().zip(checkpoints) {
            assert_eq!(
                checkpoint.item.event.message_id,
                format!("compaction-{position}")
            );
            assert!(
                checkpoint
                    .body
                    .contains("A readable summary was not recorded.")
            );
            assert!(checkpoint.body.contains("Recorded replacement history"));
            let detail = stream
                .event_detail(&format!("event:codex:{position}"))
                .unwrap();
            assert_eq!(detail.event.source_order.record, *position as u64);
            assert_eq!(
                detail.event.reader_event.as_ref(),
                Some(&checkpoint.item.event)
            );
        }
    }

    #[test]
    fn child_reader_owns_encrypted_task_and_excludes_copied_parent_prefix() {
        let directory = tempfile::tempdir().unwrap();
        let session_id = "55555555-5555-4555-8555-555555555555";
        let path = transcript_path(directory.path(), format!("rollout-{session_id}.jsonl"));
        let source = include_str!("../../../../fixtures/codex-owned-search.jsonl");
        fs::write(&path, source).unwrap();
        let snapshot = codex_snapshot(&path, "owned-search", session_id).unwrap();
        assert_eq!(snapshot.summary.title, "/root/search_fixture");
        assert_eq!(
            snapshot.summary.search_title.as_deref(),
            Some("/root/search_fixture")
        );
        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.events[0].item.role, "user");
        assert_eq!(snapshot.events[0].item.event.message_id, "amsg-child-task");
        assert_eq!(
            snapshot.events[0].body,
            "Subagent task: /root/search_fixture\n\nThe task body is encrypted in the Codex transcript and cannot be recovered locally."
        );
        assert_eq!(snapshot.events[1].item.event.message_id, "owned-reply");
        assert_eq!(snapshot.events[1].body, "Owned reply says 中文.");
        let protocol = codex_protocol_stream(&path, "owned-search", session_id).unwrap();
        let raw = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(
            raw.events
                .iter()
                .map(|event| event.source_order.record)
                .collect::<Vec<_>>(),
            [0, 3, 4, 5]
        );
        assert!(protocol.event_detail("event:codex:2").is_none());
        let v3 = serde_json::to_value(
            codex_protocol_bundle(&path, "owned-search", session_id)
                .unwrap()
                .document(3)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(v3["tasks"].as_array().unwrap().len(), 2);
        assert!(
            v3["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["sourceOrder"]["record"].as_u64().unwrap() != 2)
        );
    }

    #[test]
    fn copied_parent_lifecycle_does_not_become_child_protocol_work() {
        let directory = tempfile::tempdir().unwrap();
        let id = "55555555-5555-4555-8555-555555555555";
        let path = transcript_path(directory.path(), format!("rollout-{id}.jsonl"));
        let source = include_str!("../../../../fixtures/codex-owned-search.jsonl");
        let mut lines = source.lines().collect::<Vec<_>>();
        lines.insert(3, r#"{"type":"event_msg","timestamp":"2026-09-27T00:00:00.300Z","payload":{"type":"task_started","turn_id":"copied-parent-turn","started_at":1}}"#);
        fs::write(&path, lines.join("\n") + "\n").unwrap();
        let stream = codex_protocol_stream(&path, "owned-lifecycle", id).unwrap();
        assert_eq!(
            stream
                .events(crate::protocol::EventQuery::default())
                .unwrap()
                .events
                .iter()
                .map(|event| event.source_order.record)
                .collect::<Vec<_>>(),
            [0, 4, 5, 6]
        );
        assert!(stream.event_detail("event:codex:3").is_none());
        let v3 = serde_json::to_value(
            codex_protocol_bundle(&path, "owned-lifecycle", id)
                .unwrap()
                .document(3)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(v3["tasks"].as_array().unwrap().len(), 2);
        assert!(v3["agentRuns"].as_array().unwrap().is_empty());
        assert_eq!(v3["coverage"]["ownership"]["state"], "observed");
    }

    #[test]
    #[ignore = "requires explicitly selected frozen private inherited Codex manifest"]
    fn frozen_child_protocol_excludes_recorded_copied_parent_prefix() {
        let manifest_path = PathBuf::from(std::env::var("CODEX_INHERITED_MANIFEST").unwrap());
        let manifest: Value = serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
        let path = PathBuf::from(manifest["frozen"].as_str().unwrap());
        let id = manifest["sessionId"].as_str().unwrap();
        let boundary = manifest["boundaryRecord"].as_u64().unwrap();
        let before = fs::read(&path).unwrap();
        let stream = codex_protocol_stream(&path, "private-owned-child", id).unwrap();
        let page = stream
            .events(crate::protocol::EventQuery {
                limit: 200,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.events[0].source_order.record, 0);
        assert!(
            page.events
                .iter()
                .skip(1)
                .all(|event| event.source_order.record >= boundary)
        );
        assert!(
            stream
                .event_detail(&format!("event:codex:{}", boundary - 1))
                .is_none()
        );
        let observations = serde_json::to_value(
            codex_observation_snapshot(&path, "private-owned-child", id).unwrap(),
        )
        .unwrap();
        for domain in [
            "tasks",
            "agentRuns",
            "runObservations",
            "contextObservations",
        ] {
            assert!(observations[domain].as_array().unwrap().iter().all(|fact| {
                fact["evidence"]["eventId"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("event:codex:")
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
                    >= boundary
            }));
        }
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn child_without_task_boundary_reports_uncertain_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let session_id = "55555555-5555-4555-8555-555555555555";
        let path = transcript_path(directory.path(), format!("rollout-{session_id}.jsonl"));
        let source = include_str!("../../../../fixtures/codex-owned-search.jsonl");
        let without_task = source
            .lines()
            .filter(|line| !line.contains("\"agent_message\""))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, without_task).unwrap();
        let loaded = load_codex(&path, "unknown-ownership", session_id).unwrap();
        assert!(
            loaded
                .observations
                .facts
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == "child_ownership_boundary_unavailable" })
        );
        assert_eq!(loaded.messages[0].id, "inherited-assistant");
        assert!(matches!(
            codex_snapshot(&path, "unknown-ownership", session_id),
            Err(CoreError::Protocol(ProtocolError::Unavailable { diagnostic }))
                if diagnostic == format!("child_ownership_boundary_unavailable: codex/{session_id}")
        ));
        assert!(matches!(
            codex_protocol_stream(&path, "unknown-ownership", session_id),
            Err(CoreError::Unavailable(_))
        ));
        assert!(matches!(
            codex_protocol_bundle(&path, "unknown-ownership", session_id),
            Err(CoreError::Unavailable(_))
        ));
        let root = directory.path();
        let core = crate::Core::new(crate::SourceConfig {
            codex_dir: root.into(),
            opencode_db: root.join("absent-opencode.db"),
            claude_dir: root.join("absent-claude"),
            pi_dir: root.join("absent-pi"),
            dsh_dir: root.join("absent-dsh"),
            meta_dir: root.join("meta"),
            index_dir: root.join("index"),
            cache_dir: root.join("cache"),
        })
        .unwrap();
        let search = core
            .session_search(crate::search::SearchQuery {
                query: "Inherited 中文".into(),
                providers: Some(vec!["codex".into()]),
                fields: Some(vec!["user".into(), "assistant".into()]),
                lineage: None,
                updated_after: None,
                updated_before: None,
                directory: None,
                cursor: None,
                limit: None,
            })
            .unwrap();
        assert_eq!(search["matches"].as_array().unwrap().len(), 0);
        assert_eq!(search["diagnostics"][0]["provider"], "codex");
        // The boundary-unavailable child stays a catalog row with a session
        // diagnostic instead of failing the whole provider's search.
        assert_eq!(search["diagnostics"][0]["status"], "partial");
        assert_eq!(
            search["diagnostics"][0]["sourceDiagnostics"][0]["code"],
            CHILD_OWNERSHIP_BOUNDARY_DIAGNOSTIC
        );
        assert_eq!(
            search["diagnostics"][0]["sourceDiagnostics"][0]["affectedSessions"],
            1
        );
    }

    #[test]
    fn public_positive_source_keeps_first_owned_ids_and_progressive_reasoning() {
        let directory = tempfile::tempdir().unwrap();
        let session_id = "positive";
        let path = transcript_path(directory.path(), "rollout-positive.jsonl");
        fs::write(
            &path,
            include_str!("../../../../../test/fixtures/v3-search-source/positive.jsonl"),
        )
        .unwrap();
        let snapshot = codex_snapshot(&path, "positive-source", session_id).unwrap();
        let ids = snapshot
            .events
            .iter()
            .map(|row| row.item.event.message_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "recorded-user",
                "reasoning-0",
                "agent-message-1",
                "tool-2",
                "msg-3"
            ]
        );
        assert_eq!(snapshot.events[1].body, "think more");
        assert_eq!(snapshot.events[1].item.event.segment, "thinking");
        assert_eq!(snapshot.events[2].body, "The answer");
        assert_eq!(snapshot.events[4].body, "option\n\nyes");
    }

    #[test]
    fn session_without_user_title_uses_canonical_id() {
        let directory = tempfile::tempdir().unwrap();
        let session_id = "77777777-7777-4777-8777-777777777777";
        let path = transcript_path(directory.path(), format!("rollout-{session_id}.jsonl"));
        fs::write(&path, format!(
            "{{\"type\":\"session_meta\",\"timestamp\":\"2026-09-27T00:00:00.000Z\",\"payload\":{{\"id\":\"{session_id}\"}}}}\n{{\"type\":\"response_item\",\"timestamp\":\"2026-09-27T00:00:01.000Z\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"id\":\"reply\",\"content\":[{{\"type\":\"output_text\",\"text\":\"Only answer\"}}]}}}}\n"
        )).unwrap();
        let summary = codex_snapshot(&path, "missing-title", session_id)
            .unwrap()
            .summary;
        assert_eq!(summary.title, session_id);
        assert_eq!(summary.search_title, None);
    }

    #[test]
    fn question_reply_search_text_uses_readable_fields_and_keeps_recorded_title() {
        let directory = tempfile::tempdir().unwrap();
        let session_id = "88888888-8888-4888-8888-888888888888";
        let path = transcript_path(directory.path(), format!("rollout-{session_id}.jsonl"));
        fs::write(
            &path,
            include_str!("../../../../fixtures/codex-question-reply-search.jsonl"),
        )
        .unwrap();
        let snapshot = codex_snapshot(&path, "question-reply", session_id).unwrap();
        assert_eq!(
            snapshot.events[0].body,
            "Which 中文 mode?\n\nBoth 中 options"
        );
        assert!(
            snapshot
                .summary
                .title
                .starts_with("<send_user_message_question_reply>")
        );
        assert_eq!(snapshot.events[0].item.event.message_id, "question-reply");
    }

    #[test]
    fn duplicate_canonical_id_has_catalog_diagnostic_and_unavailable_reader() {
        let directory = tempfile::tempdir().unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        let first = transcript_path(
            directory.path(),
            format!("rollout-2026-09-27T00-00-00-{id}.jsonl"),
        );
        let later = transcript_path(
            directory.path(),
            format!("rollout-2026-09-27T00-00-00-{id}_window.jsonl"),
        );
        let header = format!(
            r#"{{"type":"session_meta","timestamp":"2026-09-27T00:00:00.000Z","payload":{{"id":"{id}","cwd":"/synthetic/codex"}}}}"#
        );
        fs::write(&first, format!("{header}\n{{\"type\":\"event_msg\",\"timestamp\":\"2026-09-27T00:00:01.000Z\",\"payload\":{{\"type\":\"user_message\",\"message\":\"first segment\"}}}}\n")).unwrap();
        fs::write(&later, format!("{header}\n{{\"type\":\"event_msg\",\"timestamp\":\"2026-09-27T00:00:02.000Z\",\"payload\":{{\"type\":\"user_message\",\"message\":\"later segment\"}}}}\n")).unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "duplicate-codex",
        };
        let inventory = adapter.inventory().unwrap().unwrap();
        assert_eq!(inventory.len(), 1);
        assert_eq!(inventory[0].path, later);
        assert!(inventory[0].signature.starts_with("collision:"));
        assert_eq!(adapter.index_capture_revision(&inventory[0]).unwrap(), None);
        let captured = adapter.capture(&inventory[0]).unwrap();
        assert_eq!(
            captured.summary.diagnostic.as_deref(),
            Some(MULTIPLE_SOURCE_DIAGNOSTIC)
        );
        assert_eq!(captured.summary.token_count, None);
        assert!(captured.events.is_empty());
        assert!(!adapter.reader_sources().unwrap().contains_key(id));
        assert!(matches!(
            adapter.load(id),
            Err(CoreError::Protocol(ProtocolError::Unavailable { .. }))
        ));
    }

    #[test]
    fn inherited_hybrid_user_rows_keep_recorded_user_text_once() {
        let rows = [
            r#"{"type":"session_meta","payload":{"id":"child"}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"same  request"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","id":"recorded-user","content":[{"type":"input_text","text":"same request"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text"]}}}"#,
            r#"{"type":"event_msg","payload":{"type":"user_message","message":"other request"}}"#,
        ];
        let source = rows.join("\n") + "\n";
        let inherited = normalize_inherited_prefix(source.as_bytes(), 0, rows.len());
        assert_eq!(
            inherited
                .iter()
                .map(|event| (event.item.message_id.as_str(), event.body.as_str()))
                .collect::<Vec<_>>(),
            [
                ("recorded-user", "same request"),
                ("inherited-3", "other request")
            ]
        );
    }

    #[test]
    fn inherited_projection_reuses_exact_source_and_reparses_rewrites_or_new_selection() {
        let directory = tempfile::tempdir().unwrap();
        let id = "codex-inherited-public-child";
        let first_path = transcript_path(directory.path(), "a-child.jsonl");
        let second_path = transcript_path(directory.path(), "z-child.jsonl");
        let original = include_str!(
            "../../../../fixtures/codex-inherited/sessions/2026/09/27/rollout-public-child.jsonl"
        );
        fs::write(&first_path, original).unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "inherited-cache-test",
        };
        INHERITED_PARSE_COUNT.with(|count| count.set(0));

        let first = adapter.inherited_context(id).unwrap().unwrap();
        let repeated = adapter.inherited_context(id).unwrap().unwrap();
        assert_eq!(repeated.revision, first.revision);
        assert_eq!(first.events.len(), 51);
        assert_eq!(
            INHERITED_PARSE_COUNT.with(std::cell::Cell::get),
            1,
            "identical selected bytes must reuse the inherited projection"
        );

        let rewritten = original.replacen(
            "Inherited body for shared ID.",
            "Changed__ body for shared ID.",
            1,
        );
        assert_eq!(rewritten.len(), original.len());
        let original_modified = fs::metadata(&first_path).unwrap().modified().unwrap();
        fs::write(&first_path, &rewritten).unwrap();
        fs::File::options()
            .write(true)
            .open(&first_path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original_modified))
            .unwrap();
        let changed = adapter.inherited_context(id).unwrap().unwrap();
        assert_ne!(changed.revision, first.revision);
        assert_eq!(INHERITED_PARSE_COUNT.with(std::cell::Cell::get), 2);
        assert!(
            changed
                .events
                .iter()
                .any(|event| event.body.contains("Changed__ body"))
        );

        fs::write(&second_path, original).unwrap();
        assert!(matches!(
            adapter.inherited_context(id),
            Err(CoreError::Protocol(ProtocolError::Unavailable { .. }))
        ));
        fs::remove_file(&first_path).unwrap();
        let selected = adapter.inherited_context(id).unwrap().unwrap();
        assert_ne!(
            selected.revision, first.revision,
            "selected source path is revision identity"
        );
        assert_eq!(INHERITED_PARSE_COUNT.with(std::cell::Cell::get), 3);
        assert!(
            selected
                .events
                .iter()
                .any(|event| event.body.contains("Inherited body for shared ID."))
        );

        let another_scope = CodexAdapter {
            root: directory.path(),
            scope: "inherited-cache-other-scope",
        }
        .inherited_context(id)
        .unwrap()
        .unwrap();
        assert_ne!(another_scope.revision, selected.revision);
        assert_eq!(INHERITED_PARSE_COUNT.with(std::cell::Cell::get), 4);
    }

    #[test]
    fn inherited_revision_matches_reader_and_tracks_child_dependencies() {
        let directory = tempfile::tempdir().unwrap();
        let id = "codex-inherited-public-child";
        let path = transcript_path(directory.path(), "child.jsonl");
        fs::write(
            &path,
            include_str!(
                "../../../../fixtures/codex-inherited/sessions/2026/09/27/rollout-public-child.jsonl"
            ),
        )
        .unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "inherited-reader-revision-test",
        };
        INHERITED_PARSE_COUNT.with(|count| count.set(0));
        let first = adapter.inherited_context(id).unwrap().unwrap();
        assert_eq!(
            first.revision,
            adapter.reader_revision(id).unwrap().unwrap().revision
        );
        assert_eq!(
            first.revision,
            adapter.reader_capture(id).unwrap().snapshot.revision
        );
        let parse_count = INHERITED_PARSE_COUNT.with(std::cell::Cell::get);

        let nested_path = transcript_path(directory.path(), "nested.jsonl");
        fs::write(
            nested_path,
            format!(
                "{{\"type\":\"session_meta\",\"timestamp\":\"2026-09-27T00:00:01.000Z\",\"payload\":{{\"id\":\"nested-child\",\"parent_thread_id\":\"{id}\",\"agent_path\":\"/root/nested\",\"cwd\":\"/synthetic/codex\"}}}}\n"
            ),
        )
        .unwrap();
        let revised = adapter.inherited_context(id).unwrap().unwrap();
        assert_ne!(revised.revision, first.revision);
        assert_eq!(
            revised.revision,
            adapter.reader_revision(id).unwrap().unwrap().revision
        );
        assert!(std::sync::Arc::ptr_eq(&revised.events, &first.events));
        assert_eq!(
            INHERITED_PARSE_COUNT.with(std::cell::Cell::get),
            parse_count
        );
    }

    #[test]
    fn hybrid_user_rows_skip_all_legacy_copies_of_recorded_user_text() {
        let directory = tempfile::tempdir().unwrap();
        let session_id = "88888888-8888-4888-8888-888888888888";
        let path = transcript_path(directory.path(), format!("rollout-{session_id}.jsonl"));
        let rows = [
            r#"{"type":"session_meta","timestamp":"2026-09-27T00:00:00.000Z","payload":{"id":"88888888-8888-4888-8888-888888888888","cwd":"/synthetic/codex"}}"#,
            r#"{"type":"event_msg","timestamp":"2026-09-27T00:00:01.000Z","payload":{"type":"user_message","message":"same request"}}"#,
            r#"{"type":"response_item","timestamp":"2026-09-27T00:00:01.500Z","payload":{"type":"message","role":"assistant","id":"assistant-before","content":[{"type":"output_text","text":"First response."}]}}"#,
            r#"{"type":"response_item","timestamp":"2026-09-27T00:00:02.000Z","payload":{"type":"message","role":"user","id":"msg-hybrid-canonical","content":[{"type":"input_text","text":"same request"}],"internal_chat_message_metadata_passthrough":{"turn_id":"turn-hybrid","content_item_kinds":["user.text"]}}}"#,
            r#"{"type":"event_msg","timestamp":"2026-09-27T00:00:03.000Z","payload":{"type":"user_message","message":"same  \n request"}}"#,
            r#"{"type":"response_item","timestamp":"2026-09-27T00:00:04.000Z","payload":{"type":"message","role":"assistant","id":"assistant-1","content":[{"type":"output_text","text":"Done."}]}}"#,
            r#"{"type":"event_msg","timestamp":"2026-09-27T00:00:05.000Z","payload":{"type":"user_message","message":"same request"}}"#,
        ];
        fs::write(&path, rows.join("\n") + "\n").unwrap();
        let source_before = fs::read(&path).unwrap();

        let snapshot = CodexAdapter {
            root: directory.path(),
            scope: "synthetic-codex-scope",
        }
        .load(session_id)
        .unwrap();

        let users = snapshot
            .events
            .iter()
            .filter(|event| event.item.role == "user")
            .collect::<Vec<_>>();
        assert_eq!(snapshot.summary.message_count, 3);
        assert_eq!(
            users
                .iter()
                .map(|event| event.item.event.message_id.as_str())
                .collect::<Vec<_>>(),
            ["msg-hybrid-canonical"]
        );
        assert_eq!(
            users
                .iter()
                .map(|event| event.body.as_str())
                .collect::<Vec<_>>(),
            ["same request"]
        );
        assert_eq!(fs::read(&path).unwrap(), source_before);

        let protocol = CodexAdapter {
            root: directory.path(),
            scope: "synthetic-codex-scope",
        }
        .protocol_event_stream(session_id)
        .unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(page.revision, snapshot.revision);
        assert_eq!(page.coverage, crate::protocol::Coverage::Partial);
        assert_eq!(page.events.len(), rows.len());
        assert_eq!(page.events[3].source_order.record, 3);
        assert_eq!(
            page.events[3].provenance.source_type,
            "codex.response_item:message"
        );
        assert_eq!(page.events[3].provenance.source_id.as_deref(), Some("3"));
        assert_eq!(
            page.events[3].reader_event.as_ref().unwrap().message_id,
            "msg-hybrid-canonical"
        );
        assert!(page.events[4].reader_event.is_none());
        assert_eq!(
            page.events[4].provenance.source_type,
            "codex.event_msg:user_message"
        );
        assert_eq!(fs::read(&path).unwrap(), source_before);
    }

    #[test]
    fn compressed_codex_protocol_uses_selected_source_and_reader_revision() {
        let directory = tempfile::tempdir().unwrap();
        let id = "44444444-4444-4444-8444-444444444444";
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "../../fixtures/codex/sessions/2026/09/26/rollout-2026-09-26T00-00-00-{id}.jsonl"
        ));
        let raw = fs::read(source).unwrap();
        let plain = transcript_path(directory.path(), format!("rollout-{id}.jsonl"));
        let compressed = transcript_path(directory.path(), format!("rollout-{id}.jsonl.zst"));
        fs::write(&plain, &raw).unwrap();
        fs::write(
            &compressed,
            zstd::stream::encode_all(raw.as_slice(), 0).unwrap(),
        )
        .unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "compressed-codex",
        };

        assert_eq!(adapter.inventory().unwrap().unwrap()[0].path, plain);

        let plain_stream = adapter.protocol_event_stream(id).unwrap();
        let plain_revision = plain_stream
            .events(crate::protocol::EventQuery::default())
            .unwrap()
            .revision
            .to_owned();
        assert_eq!(plain_revision, adapter.load(id).unwrap().revision);
        assert_eq!(
            plain_stream
                .events(crate::protocol::EventQuery::default())
                .unwrap()
                .events
                .len(),
            7
        );
        fs::remove_file(&plain).unwrap();

        assert_eq!(adapter.inventory().unwrap().unwrap()[0].path, compressed);
        assert_eq!(
            adapter
                .index_capture_revision(&adapter.inventory().unwrap().unwrap()[0])
                .unwrap(),
            None
        );

        let compressed_before = fs::read(&compressed).unwrap();
        let compressed_stream = adapter.protocol_event_stream(id).unwrap();
        let page = compressed_stream
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_ne!(page.revision, plain_revision);
        assert_eq!(page.revision, adapter.load(id).unwrap().revision);
        assert_eq!(page.events.len(), 7);
        assert_eq!(
            page.events[4].reader_event.as_ref().unwrap().message_id,
            "tool-call-1"
        );
        assert_eq!(
            page.events[5].provenance.source_type,
            "codex.response_item:function_call_output"
        );
        assert_eq!(fs::read(&compressed).unwrap(), compressed_before);
    }

    #[test]
    fn corrupted_compressed_codex_source_reports_a_parse_error() {
        let directory = tempfile::tempdir().unwrap();
        let id = "44444444-4444-4444-8444-444444444444";
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "../../fixtures/codex/sessions/2026/09/26/rollout-2026-09-26T00-00-00-{id}.jsonl"
        ));
        let mut compressed =
            zstd::stream::encode_all(fs::read(source).unwrap().as_slice(), 0).unwrap();
        compressed.truncate(compressed.len() - 5);
        let path = transcript_path(directory.path(), format!("rollout-{id}.jsonl.zst"));
        fs::write(&path, compressed).unwrap();
        match load_codex(&path, "corrupt-compressed-codex", id) {
            Err(CoreError::Parse { .. }) => {}
            Err(error) => panic!("unexpected source error: {error:?}"),
            Ok(loaded) => panic!(
                "truncated compressed source returned {} messages",
                loaded.messages.len()
            ),
        }
    }

    #[test]
    fn valid_json_without_native_type_is_protocol_invalid() {
        let directory = tempfile::tempdir().unwrap();
        let id = "55555555-5555-4555-8555-555555555555";
        let path = transcript_path(directory.path(), format!("rollout-{id}.jsonl"));
        fs::write(&path, format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n{{\"payload\":{{\"type\":\"message\"}}}}\n"
        )).unwrap();
        let adapter = CodexAdapter {
            root: directory.path(),
            scope: "invalid-protocol",
        };
        assert!(adapter.load(id).is_ok());
        let Err(CoreError::Protocol(crate::protocol::ProtocolError::Invalid { diagnostics })) =
            adapter.protocol_event_stream(id)
        else {
            panic!("expected protocol-invalid source");
        };
        assert!(
            diagnostics
                .iter()
                .any(|item| item.code == "missing_provenance_source")
        );
    }

    #[test]
    fn reader_bootstrap_relations_segments_and_content_normalize_codex_once() {
        let directory = tempfile::tempdir().unwrap();
        let id = "66666666-6666-4666-8666-666666666666";
        let path = reader_source_path(directory.path(), id);
        write_reader_source(&path, id, 32, "reader body marker");
        let core = reader_core(directory.path());
        CODEX_NORMALIZATION_COUNT.with(|count| count.set(0));

        let bootstrap = core.reader_bootstrap("codex", id).unwrap();
        let canonical = crate::SessionRef {
            provider: "codex".into(),
            session_id: id.into(),
        };
        assert_eq!(bootstrap.session.session, canonical);
        assert!(bootstrap.segments[0].next_cursor.is_some());

        let relation_cursor = bootstrap.relations.first_cursor.as_deref().unwrap();
        let relations = core.reader_relations("codex", id, relation_cursor).unwrap();
        assert_eq!(relations.session, canonical);
        assert_eq!(relations.revision, bootstrap.revision);
        assert_eq!(relations.entries.len(), 1);
        assert!(matches!(
            &relations.entries[0],
            RelationEntry::Coordination { observation }
                if observation.correlation_id == "reader-spawn"
                    && observation.from_session_ref.as_ref() == Some(&canonical)
        ));

        let segment_cursor = bootstrap.segments[0].next_cursor.as_deref().unwrap();
        let segment_page = core.reader_segments("codex", id, segment_cursor).unwrap();
        assert_eq!(segment_page.session, canonical);
        assert_eq!(segment_page.revision, bootstrap.revision);
        let item = segment_page
            .page
            .items
            .iter()
            .find(|item| item.event.message_id == "reader-assistant-31")
            .unwrap();
        assert_eq!(item.event.provider, "codex");
        assert_eq!(item.event.session_id, id);
        assert_eq!(item.event.segment, "message");

        let content = core
            .reader_content(
                "codex",
                id,
                crate::ContentQuery {
                    message_id: item.event.message_id.clone(),
                    segment: item.event.segment.clone(),
                    field: "body".into(),
                    offset: 0,
                    max_chars: 100,
                    revision: bootstrap.revision,
                    content_revision: None,
                },
            )
            .unwrap();
        assert_eq!(content.text, "reader body marker");

        let normalizations = CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get);
        assert_eq!(
            normalizations, 1,
            "unchanged Codex source should be normalized once across Reader bootstrap, relations, segments, and content"
        );
    }

    #[test]
    fn reader_model_child_process_probe() {
        let Ok(root) = std::env::var("AGENTSESSION_READER_PROBE_ROOT") else {
            return;
        };
        let output = std::env::var("AGENTSESSION_READER_PROBE_OUTPUT").unwrap();
        let id = "88888888-8888-4888-8888-888888888888";
        let core = reader_core(Path::new(&root));
        CODEX_NORMALIZATION_COUNT.with(|count| count.set(0));
        let bootstrap = core.reader_bootstrap("codex", id).unwrap();
        let relations = core
            .reader_relations(
                "codex",
                id,
                bootstrap.relations.first_cursor.as_deref().unwrap(),
            )
            .unwrap();
        let segment = core
            .reader_segments(
                "codex",
                id,
                bootstrap.segments[0].next_cursor.as_deref().unwrap(),
            )
            .unwrap();
        let item = segment.page.items.last().unwrap();
        let content = core
            .reader_content(
                "codex",
                id,
                crate::ContentQuery {
                    message_id: item.event.message_id.clone(),
                    segment: item.event.segment.clone(),
                    field: "body".into(),
                    offset: 0,
                    max_chars: 100,
                    revision: bootstrap.revision.clone(),
                    content_revision: None,
                },
            )
            .unwrap();
        let search = core
            .reader_search(
                "codex",
                id,
                crate::ReaderSearchQuery {
                    q: "durable reader marker".into(),
                    revision: bootstrap.revision.clone(),
                    limit: Some(1),
                    cursor: None,
                },
            )
            .unwrap();
        fs::write(
            output,
            serde_json::to_vec(&serde_json::json!({
                "revision": bootstrap.revision,
                "totalItems": bootstrap.total_items,
                "relationCount": relations.entries.len(),
                "pageStart": segment.page.start_ordinal,
                "content": content.text,
                "searchMatch": search.matches.iter().map(|hit| serde_json::json!({
                    "event": hit.event, "owner": hit.owner, "ordinal": hit.ordinal,
                    "field": hit.field, "offset": hit.offset, "length": hit.match_length,
                    "excerpt": hit.excerpt, "excerptStart": hit.excerpt_start,
                    "totalChars": hit.total_chars,
                })).collect::<Vec<_>>(),
                "searchNextCursor": search.next_cursor,
                "normalizations": CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get),
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn reader_model_reuses_normalization_in_a_new_process() {
        let directory = tempfile::tempdir().unwrap();
        let id = "88888888-8888-4888-8888-888888888888";
        write_reader_source(
            &reader_source_path(directory.path(), id),
            id,
            32,
            "durable reader marker",
        );
        let executable = std::env::current_exe().unwrap();
        let run = |name: &str| {
            let output = directory.path().join(name);
            let result = std::process::Command::new(&executable)
                .arg("--exact")
                .arg("providers::codex::tests::reader_model_child_process_probe")
                .env("AGENTSESSION_READER_PROBE_ROOT", directory.path())
                .env("AGENTSESSION_READER_PROBE_OUTPUT", &output)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            serde_json::from_slice::<serde_json::Value>(&fs::read(output).unwrap()).unwrap()
        };
        let first = run("first.json");
        let second = run("second.json");
        assert_eq!(first["normalizations"], 1);
        assert_eq!(second["normalizations"], 0);
        assert_eq!(first["revision"], second["revision"]);
        assert_eq!(first["totalItems"], second["totalItems"]);
        assert_eq!(first["relationCount"], second["relationCount"]);
        assert_eq!(second["content"], "durable reader marker");
        assert_eq!(second["pageStart"], 32);
        assert_eq!(first["searchMatch"], second["searchMatch"]);
        assert_eq!(
            second["searchMatch"][0]["event"]["messageId"],
            "reader-assistant-31"
        );
        assert_eq!(second["searchMatch"][0]["field"], "body");
        assert_eq!(second["searchMatch"][0]["offset"], 0);
        assert_eq!(second["searchMatch"][0]["length"], 21);
        assert_eq!(second["searchMatch"][0]["excerpt"], "durable reader marker");
        assert!(second["searchNextCursor"].is_null());
    }

    #[test]
    fn reader_model_content_chunks_reassemble_exact_utf16_text() {
        let directory = tempfile::tempdir().unwrap();
        let id = "99999999-9999-4999-8999-999999999999";
        let body = "汉😀line\n".repeat(14_000);
        write_reader_source(&reader_source_path(directory.path(), id), id, 1, &body);
        let core = reader_core(directory.path());
        let bootstrap = core.reader_bootstrap("codex", id).unwrap();
        let item = bootstrap.segments[0].items.last().unwrap();
        let mut offset = 0;
        let mut reassembled = String::new();
        loop {
            let page = core
                .reader_content(
                    "codex",
                    id,
                    crate::ContentQuery {
                        message_id: item.event.message_id.clone(),
                        segment: item.event.segment.clone(),
                        field: "body".into(),
                        offset,
                        max_chars: 1001,
                        revision: bootstrap.revision.clone(),
                        content_revision: None,
                    },
                )
                .unwrap();
            assert_eq!(page.total_chars, body.encode_utf16().count());
            reassembled.push_str(&page.text);
            match page.next_offset {
                Some(next) => {
                    assert!(next > offset);
                    offset = next;
                }
                None => break,
            }
        }
        assert_eq!(reassembled, body);
    }

    #[test]
    fn reader_search_crosses_content_chunks_with_exact_offsets_and_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let id = "10101010-1010-4010-8010-101010101010";
        let body = format!("{}İx 🙂needle NEEDLE", "a".repeat(4094));
        write_reader_source(&reader_source_path(directory.path(), id), id, 1, &body);
        let core = reader_core(directory.path());
        CODEX_NORMALIZATION_COUNT.with(|count| count.set(0));
        let revision = core.reader_bootstrap("codex", id).unwrap().revision;
        let first = core
            .reader_search(
                "codex",
                id,
                crate::ReaderSearchQuery {
                    q: "needle".into(),
                    revision: revision.clone(),
                    limit: Some(1),
                    cursor: None,
                },
            )
            .unwrap();
        assert_eq!(first.matches.len(), 1);
        let hit = &first.matches[0];
        assert_eq!(hit.event.message_id, "reader-assistant-0");
        assert_eq!(hit.field, "body");
        assert_eq!(hit.offset, 4099);
        assert_eq!(hit.match_length, 6);
        assert_eq!(hit.total_chars, body.encode_utf16().count());
        assert!(hit.excerpt.contains("🙂needle NEEDLE"));
        assert_eq!(
            core.reader_content(
                "codex",
                id,
                crate::ContentQuery {
                    message_id: hit.event.message_id.clone(),
                    segment: hit.event.segment.clone(),
                    field: hit.field.into(),
                    offset: hit.offset,
                    max_chars: hit.match_length,
                    revision: revision.clone(),
                    content_revision: None,
                }
            )
            .unwrap()
            .text,
            "needle"
        );
        let second = core
            .reader_search(
                "codex",
                id,
                crate::ReaderSearchQuery {
                    q: "needle".into(),
                    revision: revision.clone(),
                    limit: Some(1),
                    cursor: first.next_cursor,
                },
            )
            .unwrap();
        assert_eq!(second.matches.len(), 1);
        assert_eq!(second.matches[0].offset, 4106);
        assert_eq!(second.next_cursor, None);
        let expanded = core
            .reader_search(
                "codex",
                id,
                crate::ReaderSearchQuery {
                    q: "İx".into(),
                    revision: revision.clone(),
                    limit: Some(1),
                    cursor: None,
                },
            )
            .unwrap();
        assert_eq!(expanded.matches[0].offset, 4094);
        assert_eq!(expanded.matches[0].match_length, 2);
        let astral = core
            .reader_search(
                "codex",
                id,
                crate::ReaderSearchQuery {
                    q: "🙂needle".into(),
                    revision,
                    limit: Some(1),
                    cursor: None,
                },
            )
            .unwrap();
        assert_eq!(astral.matches[0].offset, 4097);
        assert_eq!(astral.matches[0].match_length, 8);
        assert_eq!(CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get), 1);
    }

    #[test]
    fn reader_model_rebuilds_orphan_rows_after_interrupted_publication() {
        let directory = tempfile::tempdir().unwrap();
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        write_reader_source(
            &reader_source_path(directory.path(), id),
            id,
            2,
            "after crash",
        );
        let core = reader_core(directory.path());
        let first = core.reader_bootstrap("codex", id).unwrap();
        let db_path = directory
            .path()
            .join("cache")
            .join(format!("reader-{}.sqlite", core.source_scope()));
        let db = rusqlite::Connection::open(db_path).unwrap();
        db.execute(
            "DELETE FROM reader_session WHERE provider='codex' AND session_id=?1",
            [id],
        )
        .unwrap();
        db.execute(
            "DELETE FROM reader_item WHERE provider='codex' AND session_id=?1 AND ordinal>0",
            [id],
        )
        .unwrap();
        drop(db);
        let rebuilt = core.reader_bootstrap("codex", id).unwrap();
        assert_eq!(rebuilt.revision, first.revision);
        assert_eq!(rebuilt.total_items, first.total_items);
        assert_eq!(
            rebuilt.segments[0].items.len(),
            first.segments[0].items.len()
        );
    }

    #[test]
    fn reader_process_projection_rebuilds_old_rows_without_changing_source_revision() {
        let directory = tempfile::tempdir().unwrap();
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let source = reader_source_path(directory.path(), id);
        write_reader_source(&source, id, 2, "same source");
        let before = fs::read(&source).unwrap();
        let core = reader_core(directory.path());
        let first = core.reader_bootstrap("codex", id).unwrap();
        let db_path = directory
            .path()
            .join("cache")
            .join(format!("reader-{}.sqlite", core.source_scope()));
        let db = rusqlite::Connection::open(&db_path).unwrap();
        db.execute(
            "UPDATE reader_session SET projection=1 WHERE provider='codex' AND session_id=?1",
            [id],
        )
        .unwrap();
        db.execute(
            "UPDATE reader_item SET item_json='{}' WHERE provider='codex' AND session_id=?1",
            [id],
        )
        .unwrap();
        drop(db);
        let rebuilt = core.reader_bootstrap("codex", id).unwrap();
        assert_eq!(rebuilt.revision, first.revision);
        assert_eq!(rebuilt.total_items, first.total_items);
        assert_eq!(fs::read(&source).unwrap(), before);
        let db = rusqlite::Connection::open(db_path).unwrap();
        let projection: i64 = db
            .query_row(
                "SELECT projection FROM reader_session WHERE provider='codex' AND session_id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(projection, 10);
        let row: String = db
            .query_row(
                "SELECT item_json FROM reader_item WHERE provider='codex' AND session_id=?1 AND ordinal=0",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(row.contains("\"processId\""));
        assert!(row.contains("\"processCount\""));
    }

    #[test]
    fn reader_model_invalidates_parent_cursor_after_child_header_rewrite() {
        let directory = tempfile::tempdir().unwrap();
        let codex = directory.path().join("codex");
        fs::create_dir_all(codex.join("sessions")).unwrap();
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let actor = "/root/child";
        assert_eq!(
            spawn_resolution_fixture(
                &codex,
                parent,
                actor,
                Some(child),
                &[(child, parent, actor)]
            ),
            Some(child.into())
        );
        let child_path = transcript_path(&codex, format!("child-{child}.jsonl"));
        let original = fs::read(&child_path).unwrap();
        let original_mtime = fs::metadata(&child_path).unwrap().modified().unwrap();
        let parent_path = transcript_path(&codex, "parent.jsonl");
        let parent_before = fs::read(&parent_path).unwrap();
        let core = reader_core(directory.path());
        CODEX_NORMALIZATION_COUNT.with(|count| count.set(0));
        let first = core.reader_bootstrap("codex", parent).unwrap();
        assert_eq!(
            CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get),
            1,
            "child parent verification should read its primary header without normalizing the child body"
        );
        let cursor = first.relations.first_cursor.as_deref().unwrap();
        let page = core.reader_relations("codex", parent, cursor).unwrap();
        assert!(page.entries.iter().any(|entry| matches!(entry,
            RelationEntry::Coordination { observation }
                if observation.to_session_ref.as_ref().is_some_and(|reference| reference.session_id == child))));
        let search = core
            .reader_search(
                "codex",
                parent,
                crate::ReaderSearchQuery {
                    q: "o".into(),
                    revision: first.revision.clone(),
                    limit: Some(1),
                    cursor: None,
                },
            )
            .unwrap();
        let search_cursor = search
            .next_cursor
            .expect("repeated source-owned search hits");

        let changed = original.iter().copied().collect::<Vec<_>>();
        let changed = String::from_utf8(changed).unwrap().replace(parent, other);
        assert_eq!(changed.len(), original.len());
        fs::write(&child_path, changed).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&child_path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(original_mtime))
            .unwrap();
        assert_eq!(
            core.reader_relations("codex", parent, cursor)
                .unwrap()
                .revision,
            first.revision
        );
        assert!(matches!(
            core.reader_search(
                "codex",
                parent,
                crate::ReaderSearchQuery {
                    q: "o".into(),
                    revision: first.revision.clone(),
                    limit: Some(1),
                    cursor: Some(search_cursor),
                }
            ),
            Err(crate::CoreError::SourceChanged)
        ));
        let rebuilt = core.reader_bootstrap("codex", parent).unwrap();
        assert!(matches!(
            core.reader_relations("codex", parent, cursor),
            Err(crate::CoreError::SourceChanged)
        ));
        assert_ne!(rebuilt.revision, first.revision);
        let page = core
            .reader_relations(
                "codex",
                parent,
                rebuilt.relations.first_cursor.as_deref().unwrap(),
            )
            .unwrap();
        assert!(!page.entries.iter().any(|entry| matches!(entry,
            RelationEntry::Coordination { observation }
                if observation.to_session_ref.as_ref().is_some_and(|reference| reference.session_id == child))));
        assert_eq!(fs::read(&parent_path).unwrap(), parent_before);
    }

    #[test]
    fn reader_model_reuses_unrelated_revision_but_blocks_unknown_sibling_identity() {
        let directory = tempfile::tempdir().unwrap();
        let parent = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        let sibling = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        write_reader_source(
            &reader_source_path(directory.path(), parent),
            parent,
            2,
            "parent body",
        );
        let sibling_path = reader_source_path(directory.path(), sibling);
        write_reader_source(&sibling_path, sibling, 1, "sibling body");
        let core = reader_core(directory.path());
        let first = core.reader_bootstrap("codex", parent).unwrap();
        CODEX_NORMALIZATION_COUNT.with(|count| count.set(0));
        write_reader_source(&sibling_path, sibling, 2, "changed unrelated body");
        let again = core.reader_bootstrap("codex", parent).unwrap();
        assert_eq!(again.revision, first.revision);
        assert_eq!(CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get), 0);
        fs::write(&sibling_path, b"invalid sibling header\n").unwrap();
        assert!(matches!(core.reader_bootstrap("codex", parent),
            Err(crate::CoreError::Protocol(ProtocolError::Unavailable { diagnostic }))
                if diagnostic == UNRESOLVED_SOURCE_DIAGNOSTIC));
        assert_eq!(CODEX_NORMALIZATION_COUNT.with(std::cell::Cell::get), 0);
    }

    #[test]
    fn reader_model_does_not_verify_copied_parent_child_without_task_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let codex = directory.path().join("codex");
        fs::create_dir_all(codex.join("sessions")).unwrap();
        let parent = "12121212-1212-4212-8212-121212121212";
        let child = "34343434-3434-4434-8434-343434343434";
        let actor = "/root/child";
        spawn_resolution_fixture(
            &codex,
            parent,
            actor,
            Some(child),
            &[(child, parent, actor)],
        );
        let child_path = transcript_path(&codex, format!("child-{child}.jsonl"));
        let header: Value =
            serde_json::from_str(&fs::read_to_string(&child_path).unwrap()).unwrap();
        let mut source = serde_json::json!({"type":"session_meta",
            "timestamp":"2026-09-27T00:00:00.000Z", "payload":header["payload"]})
        .to_string()
            + "\n";
        source.push_str(
            &serde_json::json!({"type":"session_meta","payload":{"id":parent}}).to_string(),
        );
        source.push('\n');
        fs::write(&child_path, source).unwrap();
        let core = reader_core(directory.path());
        let bootstrap = core.reader_bootstrap("codex", parent).unwrap();
        let page = core
            .reader_relations(
                "codex",
                parent,
                bootstrap.relations.first_cursor.as_deref().unwrap(),
            )
            .unwrap();
        assert!(
            page.child_placements
                .iter()
                .any(|placement| placement.child.session_id == child
                    && placement.diagnostic.as_deref() == Some("child_parent_unverified")
                    && placement.after_event.is_none())
        );
    }

    #[test]
    fn reader_model_invalidates_copied_child_task_boundary_rewrite() {
        let directory = tempfile::tempdir().unwrap();
        let codex = directory.path().join("codex");
        fs::create_dir_all(codex.join("sessions")).unwrap();
        let parent = "56565656-5656-4565-8565-565656565656";
        let child = "78787878-7878-4787-8787-787878787878";
        let actor = "/root/child";
        spawn_resolution_fixture(
            &codex,
            parent,
            actor,
            Some(child),
            &[(child, parent, actor)],
        );
        let child_path = transcript_path(&codex, format!("child-{child}.jsonl"));
        let header: Value =
            serde_json::from_str(&fs::read_to_string(&child_path).unwrap()).unwrap();
        let mut source = serde_json::json!({"type":"session_meta",
            "timestamp":"2026-09-27T00:00:00.000Z", "payload":header["payload"]})
        .to_string()
            + "\n";
        source.push_str(
            &serde_json::json!({"type":"session_meta","payload":{"id":parent}}).to_string(),
        );
        source.push('\n');
        source.push_str(&serde_json::json!({"type":"response_item","payload":{
            "type":"agent_message","id":"task","content":[{"type":"text","text":"Message Type: NEW_TASK\nPayload: work"}]
        }}).to_string());
        source.push('\n');
        fs::write(&child_path, &source).unwrap();
        let mtime = fs::metadata(&child_path).unwrap().modified().unwrap();
        let core = reader_core(directory.path());
        let first = core.reader_bootstrap("codex", parent).unwrap();
        let cursor = first.relations.first_cursor.as_deref().unwrap();
        let before = core.reader_relations("codex", parent, cursor).unwrap();
        assert!(
            before
                .child_placements
                .iter()
                .any(|placement| placement.child.session_id == child
                    && placement.diagnostic.as_deref() != Some("child_parent_unverified"))
        );
        let changed = source.replace("NEW_TASK", "NEW_TASS");
        assert_eq!(changed.len(), source.len());
        fs::write(&child_path, changed).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&child_path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(mtime))
            .unwrap();
        assert_eq!(
            core.reader_relations("codex", parent, cursor)
                .unwrap()
                .revision,
            first.revision
        );
        let rebuilt = core.reader_bootstrap("codex", parent).unwrap();
        assert!(matches!(
            core.reader_relations("codex", parent, cursor),
            Err(crate::CoreError::SourceChanged)
        ));
        let after = core
            .reader_relations(
                "codex",
                parent,
                rebuilt.relations.first_cursor.as_deref().unwrap(),
            )
            .unwrap();
        assert!(
            after
                .child_placements
                .iter()
                .any(|placement| placement.child.session_id == child
                    && placement.diagnostic.as_deref() == Some("child_parent_unverified"))
        );
    }

    #[test]
    fn reader_cursor_rejects_same_size_same_mtime_codex_source_rewrite() {
        let directory = tempfile::tempdir().unwrap();
        let id = "77777777-7777-4777-8777-777777777777";
        let path = reader_source_path(directory.path(), id);
        write_reader_source(&path, id, 1, "answer one");
        let fixed_mtime = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(fixed_mtime))
            .unwrap();
        let before = fs::metadata(&path).unwrap();
        let before_len = before.len();
        let before_mtime = before.modified().unwrap();

        let core = reader_core(directory.path());
        let bootstrap = core.reader_bootstrap("codex", id).unwrap();
        let cursor = bootstrap.relations.first_cursor.unwrap();

        let replacement = reader_fixture_bytes(id, 1, "answer two");
        assert_eq!(replacement.len() as u64, before_len);
        fs::write(&path, replacement).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(fixed_mtime))
            .unwrap();
        let after = fs::metadata(&path).unwrap();
        assert_eq!(after.len(), before_len);
        assert_eq!(after.modified().unwrap(), before_mtime);

        assert_eq!(
            core.reader_relations("codex", id, &cursor)
                .unwrap()
                .revision,
            bootstrap.revision
        );
        let refreshed = core.reader_bootstrap("codex", id).unwrap();
        assert_ne!(refreshed.revision, bootstrap.revision);
        assert!(matches!(
            core.reader_relations("codex", id, &cursor),
            Err(crate::CoreError::SourceChanged)
        ));
    }

    #[test]
    #[ignore = "requires explicitly selected frozen private corpus"]
    fn frozen_private_source_protocol_matches_reader_revision() {
        let path = std::env::var("CODEX_PRIVATE_SOURCE").unwrap();
        let path = Path::new(&path);
        let id = read_header(path).unwrap().unwrap().0;
        let bytes_before = fs::read(path).unwrap();
        let snapshot = codex_snapshot(path, "private-read-only", &id).unwrap();
        let protocol = codex_protocol_stream(path, "private-read-only", &id).unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(page.revision, snapshot.revision);
        assert_eq!(page.coverage, crate::protocol::Coverage::Partial);
        assert!(page.events.len() > 1);
        assert_eq!(page.events[0].source_order.record, 0);
        assert_eq!(page.events[0].provenance.source_type, "codex.session_meta");
        let reader_refs: HashSet<_> = snapshot
            .events
            .iter()
            .map(|event| {
                (
                    event.item.event.message_id.as_str(),
                    event.item.event.segment.as_str(),
                )
            })
            .collect();
        let mut count = 0usize;
        let mut cursor = None;
        let mut prior = None;
        loop {
            let page = protocol
                .events(crate::protocol::EventQuery {
                    limit: 200,
                    cursor,
                    ..Default::default()
                })
                .unwrap();
            for event in &page.events {
                if let Some(previous) = prior {
                    assert!(event.source_order.record > previous);
                }
                prior = Some(event.source_order.record);
                assert_eq!(event.provenance.fidelity, Fidelity::Recorded);
                if let Some(reference) = &event.reader_event {
                    assert!(
                        reader_refs
                            .contains(&(reference.message_id.as_str(), reference.segment.as_str()))
                    );
                }
            }
            count += page.events.len();
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(fs::read(path).unwrap(), bytes_before);
        eprintln!(
            "Codex private protocol_events={count} reader_items={}",
            snapshot.events.len()
        );
    }
}
