//! Provider-owned storage boundary for shared projections.
mod claude_code;
mod codex;
mod codex_memory;
pub use codex_memory::{MemoryArtifacts, MemoryContent};
#[cfg(test)]
pub(crate) fn reader_probe_counts() -> (usize, usize) {
    codex::reader_probe_counts()
}
#[cfg(test)]
pub(crate) fn codex_inventory_walks() -> usize {
    codex::inventory_walks()
}
mod deepseek_harness;
mod opencode;
mod paths;
mod pi;
use crate::protocol::{
    EventStream, ObservationSnapshot, ProtocolBundle, ProtocolError, Provenance,
};
use crate::{
    CapabilityDescriptor, ContentPage, CoreError, InheritedItem, ReaderItem, RelationEntry, Result,
    SessionRef, SessionSummary, SourceConfig, SystemPromptEvidence,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const PROTOCOL_CAPABILITY_DOMAINS: [&str; 6] = [
    "sessionEvents",
    "sessionRelationships",
    "tasks",
    "agentRuns",
    "contextArtifacts",
    "branches",
];

pub struct ProviderDefaultPaths {
    pub codex_dir: PathBuf,
    pub opencode_db: PathBuf,
    pub claude_dir: PathBuf,
    pub pi_dir: PathBuf,
    pub dsh_dir: PathBuf,
}

impl ProviderDefaultPaths {
    pub fn discover(home: &std::path::Path) -> Self {
        Self {
            codex_dir: codex::default_data_path(home),
            opencode_db: opencode::default_data_path(home),
            claude_dir: claude_code::default_data_path(home),
            pi_dir: pi::default_data_path(home),
            dsh_dir: deepseek_harness::default_data_path(home),
        }
    }
}

pub(crate) type ProtocolCapabilities = BTreeMap<String, CapabilityDescriptor>;

pub(crate) fn protocol_capability_map(
    supported: &[(&'static str, &'static str)],
) -> ProtocolCapabilities {
    PROTOCOL_CAPABILITY_DOMAINS
        .iter()
        .map(|domain| {
            let descriptor = supported
                .iter()
                .find_map(|(supported_domain, provenance)| {
                    (*supported_domain == *domain).then_some(*provenance)
                })
                .map(|provenance| CapabilityDescriptor {
                    support: "partial",
                    provenance,
                    details: Some(match *domain {
                        "sessionEvents" => "Provider source events projected into the session timeline",
                        "sessionRelationships" => "Provider lineage and child links projected into session relationships",
                        "tasks" => "Provider task or dispatch evidence projected into task records",
                        "agentRuns" => "Provider run and child-session evidence projected into agent runs",
                        "contextArtifacts" => "Provider compaction and memory evidence projected into context artifacts",
                        "branches" => "Provider branch lineage projected into branch records",
                        _ => unreachable!("fixed protocol capability domain"),
                    }),
                })
                .unwrap_or(CapabilityDescriptor {
                    support: "none",
                    provenance: "unknown",
                    details: None,
                });
            ((*domain).into(), descriptor)
        })
        .collect()
}

#[derive(Clone)]
pub(crate) struct SourceEntry {
    pub session_id: String,
    pub path: PathBuf,
    pub signature: String,
}

impl SourceEntry {
    pub fn new(session_id: String, path: PathBuf) -> Result<Self> {
        let metadata = fs::metadata(&path).map_err(|source| CoreError::Io {
            path: path.clone(),
            source,
        })?;
        Self::from_metadata(session_id, path, &metadata)
    }
    pub fn from_metadata(
        session_id: String,
        path: PathBuf,
        metadata: &fs::Metadata,
    ) -> Result<Self> {
        let modified = metadata.modified().map_err(|source| CoreError::Io {
            path: path.clone(),
            source,
        })?;
        let mut hasher = Sha256::new();
        hasher.update(path.to_string_lossy().as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(format!("{modified:?}").as_bytes());
        hasher.update(format!("{:?}", metadata.created().ok()).as_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            hasher.update(metadata.dev().to_le_bytes());
            hasher.update(metadata.ino().to_le_bytes());
        }
        Ok(Self {
            session_id,
            path,
            signature: format!("{:x}", hasher.finalize()),
        })
    }
}
#[derive(Debug)]
pub(crate) struct NormalizedEvent {
    pub item: ReaderItem,
    pub body: String,
    pub tool_input: String,
    pub tool_output: String,
    pub tool_status: Option<String>,
}

pub(crate) fn reply_metadata(
    model: Option<String>,
    model_provider: Option<String>,
    model_provenance: Provenance,
    request_usage: Option<&crate::protocol::UsageRecord>,
) -> Option<crate::ReaderReplyMetadata> {
    let has_model = model.is_some() || model_provider.is_some();
    (has_model || request_usage.is_some()).then(|| crate::ReaderReplyMetadata {
        model,
        model_provider,
        model_provenance: has_model.then_some(model_provenance),
        request_usage: request_usage.map(crate::ReaderRequestUsage::from),
    })
}
#[derive(Debug)]
pub(crate) struct SessionSnapshot {
    pub summary: SessionSummary,
    pub revision: String,
    pub events: Vec<NormalizedEvent>,
    pub relations: Vec<RelationEntry>,
}
#[derive(PartialEq, Eq)]
pub(crate) struct ReaderStamp {
    pub revision: String,
    pub dependencies: String,
}
pub(crate) struct ReaderCapture {
    /// A provider-validated capture boundary; later appends do not invalidate it.
    pub stamp: Option<ReaderStamp>,
    pub parent_facts: Option<std::collections::HashMap<SessionRef, Option<Option<SessionRef>>>>,
    pub snapshot: SessionSnapshot,
    /// Outer None asks the core for its existing protocol path. Some(None)
    /// records that the provider attempted capture but has no valid stream.
    pub protocol_stream: Option<Option<EventStream>>,
}
#[derive(Debug)]
pub(crate) struct InheritedEvent {
    pub item: InheritedItem,
    pub body: String,
    pub tool_input: String,
    pub tool_output: String,
}
#[derive(Clone)]
pub(crate) struct InheritedContextSnapshot {
    pub revision: String,
    pub source_session: Option<SessionRef>,
    pub events: std::sync::Arc<[InheritedEvent]>,
}
pub(crate) trait StatsObservationBatch {
    fn observations(&self, session_id: &str) -> Result<ObservationSnapshot>;
    fn validate_source_revision(&self) -> Result<()>;
}
pub(crate) struct InventoryObservation {
    pub entries: Option<Vec<SourceEntry>>,
    pub source_uncertainty: Option<(&'static str, usize)>,
}
/// One provider-owned catalog observation and its publication receipts.
pub(crate) struct IndexObservationBatch<'a> {
    pub inventory: InventoryObservation,
    pub capture: Box<dyn IndexCaptureBatch + 'a>,
}
pub(crate) trait IndexCaptureBatch {
    /// Register an unchanged row against this request's opening observation.
    /// `force` requires an exact content probe before reusing normalization.
    fn reuse(&mut self, entry: &SourceEntry, revision: &str, force: bool) -> Result<bool>;
    fn capture(&mut self, entry: &SourceEntry) -> Result<SessionSnapshot>;
    /// Verify this batch's captured and reused rows before atomic publication.
    fn validate(&self) -> Result<()>;
}
pub(crate) trait ProviderAdapter {
    fn team_messages(&self, _session_id: &str) -> Result<crate::TeamMessageInventory> {
        Err(CoreError::Unavailable(
            "native team messages are unavailable for this provider".into(),
        ))
    }
    fn team_message_read(
        &self,
        _session_id: &str,
        _source_id: &str,
        _message_id: &str,
        _revision: &str,
        _offset: usize,
        _max_chars: usize,
    ) -> Result<ContentPage> {
        Err(CoreError::Unavailable(
            "native team messages are unavailable for this provider".into(),
        ))
    }
    fn team_message_content(
        &self,
        _session_id: &str,
        _sequence: u64,
        _message_id: &str,
        _revision: &str,
        _offset: usize,
        _max_chars: usize,
    ) -> Result<ContentPage> {
        Err(CoreError::Unavailable(
            "native team messages are unavailable for this provider".into(),
        ))
    }
    fn storage_diagnostic(&self) -> Option<serde_json::Value> {
        None
    }
    fn source_uncertainty(&self) -> Result<Option<(&'static str, usize)>> {
        Ok(None)
    }
    /// Source-owned project identity for statistics; absent when a provider has no such field.
    fn stats_project_ids(&self) -> Result<Option<BTreeMap<String, String>>> {
        Ok(None)
    }
    /// Exact revision of all source bytes that may affect recorded usage.
    /// None keeps statistics on the uncached protocol path.
    fn stats_usage_source_revision(&self) -> Result<Option<String>> {
        Ok(None)
    }
    fn stats_observation_batch(
        &self,
        _source_revision: Option<&str>,
    ) -> Result<Option<Box<dyn StatsObservationBatch + '_>>> {
        Ok(None)
    }
    fn memory_artifacts(&self, _session_id: &str) -> Result<MemoryArtifacts> {
        Err(CoreError::Unavailable(
            "memory artifacts are unavailable for this provider".into(),
        ))
    }
    fn memory_content(
        &self,
        _session_id: &str,
        _id: &str,
        _revision: &str,
        _offset: usize,
        _max_chars: usize,
    ) -> Result<MemoryContent> {
        Err(CoreError::Unavailable(
            "memory artifacts are unavailable for this provider".into(),
        ))
    }
    fn resume_command(&self) -> Option<crate::DefaultResumeCommand> {
        None
    }
    /// Current provider-owned working directory for a structured resume command.
    fn resume_directory(&self, session_id: &str) -> Result<Option<String>> {
        Ok(self.load(session_id)?.summary.directory)
    }
    fn available(&self) -> bool;
    fn unavailable_diagnostic(&self) -> &'static str;
    fn list(&self) -> Result<Vec<SessionSummary>>;
    fn load(&self, session_id: &str) -> Result<SessionSnapshot>;
    fn system_prompt_evidence(&self, session_id: &str) -> Result<SystemPromptEvidence> {
        let summary = self.load(session_id)?.summary;
        Ok(SystemPromptEvidence::new(&summary, "local-evidence"))
    }
    /// Navigation may serve an explicitly requested published Reader revision.
    fn reader_snapshot_navigation(&self) -> bool {
        false
    }
    /// Exact selected-source revision for durable Reader reuse. Providers
    /// without this hook keep the source-backed Reader path.
    fn reader_revision(&self, _session_id: &str) -> Result<Option<ReaderStamp>> {
        Ok(None)
    }
    fn list_stats_revision(&self, session_id: &str) -> Result<Option<ReaderStamp>> {
        self.reader_revision(session_id)
    }
    fn reader_load(&self, session_id: &str) -> Result<SessionSnapshot> {
        self.load(session_id)
    }
    fn reader_capture(&self, session_id: &str) -> Result<ReaderCapture> {
        Ok(ReaderCapture {
            stamp: None,
            parent_facts: None,
            snapshot: self.reader_load(session_id)?,
            protocol_stream: None,
        })
    }
    fn reader_parent_fact(&self, session_id: &str) -> Result<Option<crate::SessionRef>> {
        Ok(self.reader_load(session_id)?.summary.parent)
    }
    fn reader_parent_facts(
        &self,
        ids: &[String],
    ) -> BTreeMap<String, Option<Option<crate::SessionRef>>> {
        ids.iter()
            .map(|id| (id.clone(), self.reader_parent_fact(id).ok()))
            .collect()
    }
    fn inherited_context(&self, _session_id: &str) -> Result<Option<InheritedContextSnapshot>> {
        Ok(None)
    }
    fn protocol_capabilities(&self) -> ProtocolCapabilities {
        protocol_capability_map(&[])
    }
    fn legacy_content_title_first(&self) -> Result<bool> {
        Ok(false)
    }
    fn protocol_event_stream(&self, _session_id: &str) -> Result<EventStream> {
        Err(CoreError::Protocol(ProtocolError::Unavailable {
            diagnostic: "provider has no native protocol event builder".into(),
        }))
    }
    fn protocol_observations(&self, _session_id: &str) -> Result<ObservationSnapshot> {
        Err(CoreError::Protocol(ProtocolError::Unavailable {
            diagnostic: "provider has no native protocol observation builder".into(),
        }))
    }
    fn protocol_bundle(&self, _session_id: &str) -> Result<ProtocolBundle> {
        Err(CoreError::Protocol(ProtocolError::Unavailable {
            diagnostic: "provider has no finalized Session Protocol foundation".into(),
        }))
    }
    fn supports_index(&self) -> bool {
        false
    }
    /// None means this provider has not implemented durable capture yet.
    fn inventory(&self) -> Result<Option<Vec<SourceEntry>>> {
        Ok(None)
    }
    fn inventory_for_rebuild(&self) -> Result<Option<Vec<SourceEntry>>> {
        self.inventory()
    }
    fn inventory_observation(&self, rebuild: bool) -> Result<InventoryObservation> {
        Ok(InventoryObservation {
            entries: if rebuild {
                self.inventory_for_rebuild()?
            } else {
                self.inventory()?
            },
            source_uncertainty: self.source_uncertainty()?,
        })
    }
    fn index_capture_batch(&self, _rebuild: bool) -> Result<Option<IndexObservationBatch<'_>>> {
        Ok(None)
    }
    fn capture(&self, entry: &SourceEntry) -> Result<SessionSnapshot> {
        self.load(&entry.session_id)
    }
    /// Capture for catalog publication, followed by `validate_inventory`.
    /// The default preserves the selected entry's post-capture signature check.
    /// Providers may combine that check with their final inventory verification.
    fn capture_for_index(&self, entry: &SourceEntry) -> Result<SessionSnapshot> {
        let snapshot = self.capture(entry)?;
        if self.source_signature(entry)? != entry.signature {
            return Err(CoreError::SourceChanged);
        }
        Ok(snapshot)
    }
    /// A fresh exact source revision equal to `capture(entry).revision`.
    /// None keeps capture mandatory; this excludes dependencies not covered by the probe.
    fn index_capture_revision(&self, _entry: &SourceEntry) -> Result<Option<String>> {
        Ok(None)
    }
    fn source_signature(&self, entry: &SourceEntry) -> Result<String> {
        SourceEntry::new(entry.session_id.clone(), entry.path.clone())
            .map(|source| source.signature)
    }
    fn validate_inventory(&self, _incoming: &BTreeMap<String, SourceEntry>) -> Result<()> {
        Ok(())
    }
}
pub(crate) fn adapter<'a>(
    config: &'a SourceConfig,
    scope: &'a str,
    provider: &str,
) -> Result<Box<dyn ProviderAdapter + 'a>> {
    match provider {
        "claude-code" => Ok(Box::new(claude_code::ClaudeAdapter {
            root: &config.claude_dir,
            scope,
        })),
        "codex" => Ok(Box::new(codex::CodexAdapter {
            root: &config.codex_dir,
            scope,
        })),
        "deepseek-harness" => Ok(Box::new(deepseek_harness::DshAdapter {
            root: &config.dsh_dir,
            scope,
        })),
        "opencode" => Ok(Box::new(opencode::OpenCodeAdapter {
            path: &config.opencode_db,
            scope,
        })),
        "pi" => Ok(Box::new(pi::PiAdapter {
            root: &config.pi_dir,
            scope,
        })),
        _ => Err(CoreError::Unavailable(provider.into())),
    }
}

#[cfg(test)]
mod resume_tests {
    use super::*;
    #[test]
    fn provider_defaults_preserve_source_supported_commands() {
        let empty = PathBuf::new();
        let config = SourceConfig {
            codex_dir: empty.clone(),
            opencode_db: empty.clone(),
            claude_dir: empty.clone(),
            pi_dir: empty.clone(),
            dsh_dir: empty.clone(),
            meta_dir: empty.clone(),
            index_dir: empty.clone(),
            cache_dir: empty,
        };
        for (provider, executable, argument) in [
            ("codex", "codex", "resume"),
            ("opencode", "opencode", "--session"),
            ("claude-code", "claude", "--resume"),
            ("pi", "pi", "--session"),
        ] {
            let command = adapter(&config, "test", provider)
                .unwrap()
                .resume_command()
                .unwrap();
            assert_eq!(command.command.executable, executable);
            assert_eq!(command.command.args, [argument, "{sessionId}"]);
        }
        assert!(
            adapter(&config, "test", "deepseek-harness")
                .unwrap()
                .resume_command()
                .is_none()
        );
    }
}
