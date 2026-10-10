//! Source-backed facts for the AgentSession 3.0 transports.
//!
//! Provider adapters own source decoding and normalized facts. A scope-isolated
//! derived catalog accelerates lists while Reader continuations remain bound
//! to the adapter's exact source revision.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use thiserror::Error;

const PROVIDERS: [&str; 5] = ["opencode", "claude-code", "codex", "pi", "deepseek-harness"];
mod collation;
mod context;
mod index;
mod library;
mod list_stats;
mod meta;
pub mod protocol;
mod providers;
mod reader_model;
mod search;
mod search_index;
mod stats;
mod stats_cost;
mod system_prompts;
pub use context::SessionContext;
pub use index::ReindexResult;
pub use library::{
    LibraryChildrenPage, LibraryChildrenQuery, LibraryNode, LibraryPage, LibraryQuery,
    list_range_cutoff,
};
pub use meta::ViewerMeta;
pub use providers::{MemoryArtifacts, MemoryContent, ProviderDefaultPaths};
use providers::{NormalizedEvent, SessionSnapshot};
pub use search::SearchQuery;
pub use stats::{StatsQuery, StatsReport};
pub use stats_cost::{CostEstimate, TokenPricingDocument, TokenPricingEntry};
pub use system_prompts::SystemPromptEvidence;

#[derive(Clone, Debug)]
pub struct SourceConfig {
    pub codex_dir: PathBuf,
    pub opencode_db: PathBuf,
    pub claude_dir: PathBuf,
    pub pi_dir: PathBuf,
    pub dsh_dir: PathBuf,
    pub meta_dir: PathBuf,
    pub index_dir: PathBuf,
    pub cache_dir: PathBuf,
}

#[derive(Clone, Debug)]
pub struct Core {
    config: SourceConfig,
    source_scope: String,
    library_collation: std::sync::Arc<collation::LibraryCollation>,
}

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("provider {0} is unavailable in this slice")]
    Unavailable(String),
    #[error("session {provider}/{session_id} was not found")]
    NotFound {
        provider: String,
        session_id: String,
    },
    #[error("event {0} was not found")]
    EventNotFound(String),
    #[error("source changed since the supplied Reader revision")]
    SourceChanged,
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("invalid Reader cursor")]
    InvalidCursor,
    #[error("source I/O at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid provider source at {path}: {reason}")]
    Parse { path: PathBuf, reason: String },
    #[error("derived catalog storage: {0}")]
    Storage(String),
    #[error(transparent)]
    Protocol(#[from] protocol::ProtocolError),
}

pub type Result<T> = std::result::Result<T, CoreError>;

#[rustfmt::skip]
fn provider_icon(id: &str) -> &'static str {
    match id {
        "opencode" => r##"<svg width="16" height="16" viewBox="0 0 240 300" fill="none"><path d="M180 240H60V120H180V240Z" fill="currentColor" opacity="0.5"/><path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="currentColor"/></svg>"##,
        "claude-code" => r##"<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="m4.714 15.956 4.717-2.647.08-.231-.08-.128h-.23l-.79-.048-2.695-.073-2.338-.097-2.265-.122-.57-.121-.535-.704.055-.352.48-.322.686.061 1.518.103 2.277.158 1.651.097 2.447.255h.389l.054-.158-.134-.097-.103-.097-2.386-1.7-2.55-1.688-1.336-.971-.722-.492-.365-.461-.158-1.008.656-.722.88.06.225.061.892.686 1.907 1.475 2.489 1.834.365.303.145-.103.019-.073-.164-.273-1.354-2.447-1.445-2.489-.644-1.032-.17-.62c-.06-.254-.103-.467-.103-.728L6.287.134 6.7 0l.996.134.419.364.619 1.415 1.002 2.228 1.554 3.03.455.898.243.832.091.255h.158v-.146l.128-1.706.236-2.095.231-2.695.079-.76.376-.91.747-.492.583.28.48.685-.067.444-.285 1.852-.559 2.902-.364 1.943h.212l.243-.243.984-1.305 1.651-2.064.729-.82.85-.905.546-.431h1.032l.76 1.13-.34 1.165-1.063 1.348-.88 1.141-1.263 1.7-.79 1.36.073.11.189-.019 2.853-.607 1.542-.28 1.84-.315.832.388.09.395-.327.807-1.967.486-2.307.461-3.437.814-.042.03.048.061 1.549.146.661.036h1.621l3.018.225.789.522.474.637-.08.486-1.214.62-1.64-.389-3.824-.911-1.312-.328h-.182v.11l1.093 1.068 2.004 1.81 2.507 2.331.128.577-.322.455-.34-.048-2.204-1.657-.85-.747-1.925-1.621h-.127v.17l.443.65 2.344 3.521.121 1.081-.17.352-.607.212-.668-.121-1.372-1.925-1.554-2.228-1.141-1.943-.14.08-.674 7.255-.316.37-.728.28-.607-.462-.322-.747.322-1.475.389-1.925.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.433 1.967-2.18 2.945-1.724 1.846-.413.164-.716-.37.067-.662.4-.589 2.387-3.036 1.439-1.882.929-1.087-.006-.158h-.055l-6.338 4.117-1.13.145-.485-.455.06-.747.231-.243 1.906-1.311z"/></svg>"##,
        "codex" => r##"<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073M13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.085a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365L12 9.25l2.414 1.375v2.75L12 14.75l-2.414-1.375z"/></svg>"##,
        "pi" => r##"<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M8 7v10"/><path d="M16 7v8c0 1.5.7 2 2 2"/></svg>"##,
        "deepseek-harness" => r##"<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5.5h10.5a3 3 0 0 1 3 3V18.5H8.5a3 3 0 0 1-3-3Z"/><path d="M8 10h7M8 14h5"/><path d="m17.5 4 .5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5Z"/></svg>"##,
        _ => unreachable!("registered provider icon"),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub available: bool,
    pub manageable: bool,
    pub storage_diagnostic: Option<serde_json::Value>,
    pub protocol_capabilities: BTreeMap<String, CapabilityDescriptor>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CapabilityDescriptor {
    pub support: &'static str,
    pub provenance: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub provider: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResumeCommandSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
}

/// Provider-owned installation evidence, separate from user command configuration.
#[derive(Debug, Clone, Copy)]
pub struct NpmResumeEntry {
    pub package: &'static str,
    pub bin: &'static str,
}

#[derive(Debug, Clone)]
pub struct DefaultResumeCommand {
    pub command: ResumeCommandSpec,
    pub npm: Option<NpmResumeEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session: SessionRef,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    #[serde(skip)]
    pub search_title: Option<String>,
    pub directory: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub message_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_message_count: Option<usize>,
    pub token_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_files: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_additions: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_deletions: Option<i64>,
    pub parent: Option<SessionRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct EventRef {
    pub provider: String,
    pub session_id: String,
    pub message_id: String,
    pub segment: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub event: EventRef,
    pub timestamp: Option<i64>,
    pub role: String,
    pub tool_name: Option<String>,
    pub status: Option<String>,
    pub preview: String,
    pub untrusted_content: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct TimelineFilters {
    pub segments: Option<Vec<String>>,
    pub roles: Option<Vec<String>>,
    pub tool_names: Option<Vec<String>>,
    pub statuses: Option<Vec<String>>,
    pub query: Option<String>,
}

fn normalized_timeline_filters(mut filters: TimelineFilters) -> Result<TimelineFilters> {
    fn normalize(
        values: &mut Option<Vec<String>>,
        field: &str,
        max_items: usize,
        max_chars: usize,
        allowed: &[&str],
    ) -> Result<()> {
        if let Some(items) = values {
            if items.len() > max_items {
                return Err(CoreError::InvalidInput(format!(
                    "{field} exceeds its item limit"
                )));
            }
            for item in items.iter_mut() {
                *item = item.trim().to_owned();
                if item.is_empty()
                    || item.chars().count() > max_chars
                    || !allowed.is_empty() && !allowed.contains(&item.as_str())
                {
                    return Err(CoreError::InvalidInput(format!(
                        "{field} has an invalid value"
                    )));
                }
            }
            items.sort();
            items.dedup();
        }
        Ok(())
    }
    normalize(
        &mut filters.segments,
        "segments",
        4,
        8,
        &["message", "thinking", "tool", "context"],
    )?;
    normalize(
        &mut filters.roles,
        "roles",
        4,
        9,
        &["user", "assistant", "system", "tool"],
    )?;
    normalize(&mut filters.tool_names, "toolNames", 50, 200, &[])?;
    normalize(
        &mut filters.statuses,
        "statuses",
        3,
        9,
        &["error", "completed", "unknown"],
    )?;
    if let Some(query) = filters.query.as_mut() {
        *query = query.trim().to_owned();
        if query.is_empty() || query.encode_utf16().count() > 500 {
            return Err(CoreError::InvalidInput(
                "query must contain between 1 and 500 characters".into(),
            ));
        }
    }
    filters
        .segments
        .get_or_insert_with(|| vec!["message".into(), "tool".into()])
        .sort();
    Ok(filters)
}

fn timeline_matches(text: &str, query: &str) -> bool {
    let lower = text.to_lowercase();
    query
        .to_lowercase()
        .split_whitespace()
        .all(|term| lower.contains(term))
}

fn bounded_preview(text: &str, max_chars: usize) -> String {
    if text.encode_utf16().count() <= max_chars {
        return text.to_owned();
    }
    let mut preview = String::new();
    let mut units = 0;
    for character in text.chars() {
        if units + character.len_utf16() > max_chars {
            break;
        }
        preview.push(character);
        units += character.len_utf16();
    }
    preview.push('…');
    preview
}

fn timeline_snippet(text: &str, query: &str) -> String {
    let lower = text.to_lowercase();
    let lower_query = query.to_lowercase();
    let first = lower_query.split_whitespace().next().unwrap_or("");
    let byte_index = lower.find(first).unwrap_or(0);
    let chars_before = lower[..byte_index].chars().count();
    let start = chars_before.saturating_sub(40);
    let chars: Vec<_> = text.chars().collect();
    let start = start.min(chars.len().saturating_sub(1));
    let end = (start + 158).min(chars.len());
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.extend(chars[start..end].iter());
    if end < chars.len() {
        snippet.push('…');
    }
    bounded_preview(&snippet, 160)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePage {
    pub events: Vec<TimelineEvent>,
    pub next_cursor: Option<String>,
    pub truncated: bool,
    pub untrusted_content: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderRequestUsage {
    pub record_id: String,
    pub tokens: protocol::UsageTokenComponents,
    pub provenance: protocol::Provenance,
}

impl From<&protocol::UsageRecord> for ReaderRequestUsage {
    fn from(record: &protocol::UsageRecord) -> Self {
        Self {
            record_id: record.id.clone(),
            tokens: record.tokens.clone(),
            provenance: record.provenance.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderReplyMetadata {
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub model_provenance: Option<protocol::Provenance>,
    pub request_usage: Option<ReaderRequestUsage>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReaderToolInputState {
    Recorded,
    Encrypted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderToolMetadata {
    pub summary: Option<String>,
    pub directory: Option<String>,
    pub task_name: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fork_turns: Option<String>,
    pub input_state: ReaderToolInputState,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderItem {
    pub ordinal: usize,
    pub owner: Option<EventRef>,
    pub event: EventRef,
    pub role: String,
    pub timestamp: Option<i64>,
    pub preview: String,
    pub total_chars: usize,
    #[serde(default)]
    pub content_revisions: BTreeMap<String, String>,
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_metadata: Option<ReaderToolMetadata>,
    pub owner_message_id: Option<String>,
    #[serde(default)]
    pub presentation_phase: Option<String>,
    #[serde(default)]
    pub process_id: Option<usize>,
    #[serde(default)]
    pub process_count: Option<usize>,
    pub reply_metadata: Option<ReaderReplyMetadata>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritedItem {
    pub ordinal: usize,
    pub message_id: String,
    pub segment: String,
    pub role: String,
    pub timestamp: Option<i64>,
    pub preview: String,
    pub total_chars: usize,
    pub tool_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritedContextPage {
    pub session: SessionRef,
    pub revision: String,
    pub scope: &'static str,
    pub source_session: Option<SessionRef>,
    pub total_items: usize,
    pub items: Vec<InheritedItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritedContentPage {
    pub revision: String,
    #[serde(flatten)]
    pub content: ContentPage,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderSegment {
    pub id: String,
    pub page_id: String,
    pub start_ordinal: usize,
    pub items: Vec<ReaderItem>,
    pub owner_context: Option<ReaderItem>,
    pub previous_cursor: Option<String>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderBootstrap {
    pub session: SessionSummary,
    pub revision: String,
    pub segments: Vec<ReaderSegment>,
    pub total_items: usize,
    pub toc: ReaderTocPage,
    pub relations: RelationSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_location: Option<ReaderLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opening_toc: Option<ReaderTocPage>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationSummary {
    pub task_count: usize,
    pub observation_count: usize,
    pub first_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationProvenance {
    pub fidelity: String,
    pub source_type: String,
    pub source_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelationParticipantKind {
    Member,
    Sender,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationParticipant {
    pub id: String,
    pub kind: RelationParticipantKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub provenance: RelationProvenance,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationTask {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_participant: Option<RelationParticipant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader_event: Option<EventRef>,
    pub provenance: RelationProvenance,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationLaunchRequest {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fork_turns: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationObservation {
    pub kind: String,
    pub state: String,
    pub correlation_id: String,
    pub event_id: String,
    pub from_session_ref: Option<SessionRef>,
    pub to_session_ref: Option<SessionRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_participant: Option<RelationParticipant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_participant: Option<RelationParticipant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_excerpt_truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_request: Option<CollaborationLaunchRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_actor_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_actor_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader_event: Option<EventRef>,
    pub provenance: RelationProvenance,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RelationEntry {
    Task {
        task: RelationTask,
    },
    Coordination {
        observation: CoordinationObservation,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderRelationsPage {
    pub session: SessionRef,
    pub revision: String,
    pub entries: Vec<RelationEntry>,
    pub child_placements: Vec<ReaderChildPlacement>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderChildPlacement {
    pub child: SessionRef,
    pub after_event: Option<EventRef>,
    pub source_event_id: String,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderChildLocation {
    pub session: SessionRef,
    pub revision: String,
    pub placement: Option<ReaderChildPlacement>,
    pub location: Option<ReaderLocation>,
    pub diagnostic: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderTocEntry {
    pub event: EventRef,
    pub ordinal: usize,
    pub owner: Option<EventRef>,
    pub role: String,
    pub label: String,
    pub process_id: Option<usize>,
    pub process_count: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderTocPage {
    pub entries: Vec<ReaderTocEntry>,
    pub previous_cursor: Option<String>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderPageResponse {
    pub session: SessionRef,
    pub revision: String,
    pub page: ReaderSegment,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderExecutionPage {
    pub session: SessionRef,
    pub revision: String,
    pub coverage: protocol::Coverage,
    pub events: Vec<protocol::ProtocolEvent>,
    pub next_cursor: Option<String>,
    pub scanned_events: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderTocResponse {
    pub session: SessionRef,
    pub revision: String,
    pub toc: ReaderTocPage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderLocateQuery {
    pub revision: String,
    pub source_revision: Option<String>,
    pub message_id: Option<String>,
    pub segment: Option<String>,
    pub edge: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderBootstrapQuery {
    pub message_id: Option<String>,
    pub segment: Option<String>,
    pub revision: Option<String>,
}

impl ReaderBootstrapQuery {
    fn validate(&self) -> Result<()> {
        if self.message_id.is_none() && self.segment.is_none() && self.revision.is_none() {
            return Ok(());
        }
        if !self
            .message_id
            .as_ref()
            .is_some_and(|id| !id.is_empty() && id.len() <= 4096 && !id.contains('\0'))
            || !self.segment.as_ref().is_some_and(|segment| {
                !segment.is_empty() && segment.len() <= 64 && !segment.contains('\0')
            })
            || self.revision.as_ref().is_some_and(|revision| {
                revision.is_empty() || revision.len() > 256 || revision.contains('\0')
            })
        {
            return Err(CoreError::InvalidInput(
                "bootstrap target requires messageId and segment, with an optional revision".into(),
            ));
        }
        Ok(())
    }

    fn location_query(self, revision: &str) -> Option<ReaderLocateQuery> {
        self.message_id.map(|message_id| ReaderLocateQuery {
            source_revision: None,
            revision: self.revision.unwrap_or_else(|| revision.into()),
            message_id: Some(message_id),
            segment: self.segment,
            edge: None,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderLocation {
    pub session: SessionRef,
    pub revision: String,
    pub event: EventRef,
    pub ordinal: usize,
    pub owner: Option<EventRef>,
    pub page_cursor: String,
    pub toc_cursor: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderSearchQuery {
    pub q: String,
    pub revision: String,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderSearchMatch {
    pub event: EventRef,
    pub owner: Option<EventRef>,
    pub ordinal: usize,
    pub field: &'static str,
    pub offset: usize,
    pub match_length: usize,
    pub excerpt: String,
    pub excerpt_start: usize,
    pub total_chars: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderSearchPage {
    pub session: SessionRef,
    pub revision: String,
    pub scope: &'static str,
    pub coverage: &'static str,
    pub matches: Vec<ReaderSearchMatch>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReaderSearchCursor {
    version: u8,
    kind: String,
    scope: String,
    session: SessionRef,
    revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dependency: Option<String>,
    query: String,
    event_index: usize,
    field_index: usize,
    lower_byte_offset: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReaderCursor {
    version: u8,
    kind: String,
    scope: String,
    session: SessionRef,
    revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dependency: Option<String>,
    projection: u8,
    position: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InheritedCursor {
    version: u8,
    kind: String,
    scope: String,
    session: SessionRef,
    revision: String,
    limit: usize,
    position: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentQuery {
    pub message_id: String,
    pub segment: String,
    pub field: String,
    pub offset: usize,
    pub max_chars: usize,
    pub revision: String,
    pub content_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessageContentQuery {
    pub sequence: u64,
    pub message_id: String,
    pub offset: usize,
    pub max_chars: usize,
    pub revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamMessageRef {
    pub provider: String,
    pub session_id: String,
    pub source_id: String,
    pub message_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessageSummary {
    pub message: TeamMessageRef,
    pub from: Option<SessionRef>,
    pub to: Option<SessionRef>,
    pub from_participant: Option<RelationParticipant>,
    pub to_participant: Option<RelationParticipant>,
    pub excerpt: Option<String>,
    pub excerpt_truncated: bool,
    pub provenance: RelationProvenance,
    pub read_arguments: TeamMessageReadArguments,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessageReadArguments {
    pub action: &'static str,
    pub message: TeamMessageRef,
    pub revision: String,
}

#[derive(Clone, Debug)]
pub struct TeamMessageInventory {
    pub revision: String,
    pub messages: Vec<TeamMessageSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessagesPage {
    pub session: SessionRef,
    pub revision: String,
    pub messages: Vec<TeamMessageSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TeamMessagesCursor {
    version: u8,
    kind: String,
    scope: String,
    session: SessionRef,
    revision: String,
    offset: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InheritedContentQuery {
    pub ordinal: usize,
    pub message_id: String,
    pub segment: String,
    pub field: String,
    pub offset: usize,
    pub max_chars: usize,
    pub revision: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentPage {
    pub text: String,
    pub offset: usize,
    pub total_chars: usize,
    pub next_offset: Option<usize>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDetail {
    pub event: EventRef,
    pub revision: String,
    pub role: String,
    pub timestamp: Option<i64>,
    pub untrusted_content: bool,
    pub content: Option<ContentPage>,
    pub tool_name: Option<String>,
    pub status: Option<String>,
    pub tool_input: Option<ContentPage>,
    pub tool_output: Option<ContentPage>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct EventReadOptions {
    pub include_thinking: bool,
    pub include_tool_input: bool,
    pub include_tool_output: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGet {
    #[serde(flatten)]
    pub summary: SessionSummary,
    pub first_message: Option<TimelineEvent>,
    pub last_message: Option<TimelineEvent>,
    pub role_counts: BTreeMap<String, usize>,
    pub tool_names: Vec<ToolFacet>,
    pub tool_names_truncated: bool,
    pub children: Vec<SessionSummary>,
    pub children_next_cursor: Option<String>,
    pub children_truncated: bool,
    pub untrusted_content: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFacet {
    pub tool_name: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowseQuery {
    pub level: String,
    pub providers: Option<Vec<String>>,
    pub directory: Option<String>,
    pub title: Option<String>,
    #[serde(default, deserialize_with = "browse_parent")]
    pub parent: Option<Option<SessionRef>>,
    pub updated_after: Option<f64>,
    pub updated_before: Option<f64>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

fn browse_parent<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Option<SessionRef>>, D::Error> {
    Option::<SessionRef>::deserialize(deserializer).map(Some)
}

fn browse_revision<T: Serialize>(candidates: &T) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(candidates).expect("browse candidate serialization"))
    )
}

pub fn normalize_project_path(value: &str) -> String {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return normalized;
    }
    let normalized = if normalized
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("/mnt/"))
    {
        let rest = &normalized[5..];
        let mut parts = rest.splitn(2, '/');
        let drive = parts.next().unwrap_or_default();
        if drive.len() == 1 && drive.as_bytes()[0].is_ascii_alphabetic() {
            format!("{}:/{}", drive, parts.next().unwrap_or_default())
        } else {
            normalized
        }
    } else {
        normalized
    };
    let trimmed = normalized.trim_end_matches('/');
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        if trimmed.len() == 2 {
            format!("{}:/", trimmed[..1].to_lowercase())
        } else {
            trimmed.to_lowercase()
        }
    } else {
        trimmed.into()
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowseCursor {
    version: u8,
    kind: String,
    scope: String,
    filters: String,
    revision: String,
    offset: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChildCursor {
    version: u8,
    kind: String,
    scope: String,
    parent: SessionRef,
    revision: String,
    offset: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimelineCursor {
    version: u8,
    kind: String,
    scope: String,
    session: SessionRef,
    revision: String,
    filters: String,
    offset: usize,
}

fn validate_artifact_session_id(session_id: &str) -> Result<()> {
    if session_id.is_empty()
        || session_id.len() > 200
        || session_id
            .chars()
            .any(|value| matches!(value, '/' | '\\' | '\0'))
    {
        return Err(CoreError::InvalidInput(
            "invalid canonical session ID".into(),
        ));
    }
    Ok(())
}

impl Core {
    pub fn reader_artifacts(&self, provider: &str, session_id: &str) -> Result<MemoryArtifacts> {
        validate_artifact_session_id(session_id)?;
        providers::adapter(&self.config, &self.source_scope, provider)?.memory_artifacts(session_id)
    }

    pub fn reader_artifact_content(
        &self,
        provider: &str,
        session_id: &str,
        id: &str,
        revision: &str,
        offset: usize,
        max_chars: usize,
    ) -> Result<MemoryContent> {
        validate_artifact_session_id(session_id)?;
        providers::adapter(&self.config, &self.source_scope, provider)?
            .memory_content(session_id, id, revision, offset, max_chars)
    }
    pub fn new(config: SourceConfig) -> Result<Self> {
        let config = config.normalized()?;
        let mut hasher = Sha256::new();
        for path in [
            &config.codex_dir,
            &config.opencode_db,
            &config.claude_dir,
            &config.pi_dir,
            &config.dsh_dir,
        ] {
            hasher.update(path.to_string_lossy().as_bytes());
            hasher.update([0]);
        }
        Ok(Self {
            config,
            source_scope: format!("{:x}", hasher.finalize()),
            library_collation: std::sync::Arc::new(collation::LibraryCollation::system()?),
        })
    }

    pub fn source_scope(&self) -> &str {
        &self.source_scope
    }

    pub fn reindex(&self) -> Vec<ReindexResult> {
        PROVIDERS
            .iter()
            .map(|provider| {
                let adapter = match providers::adapter(&self.config, &self.source_scope, provider) {
                    Ok(adapter) => adapter,
                    Err(error) => {
                        return ReindexResult {
                            provider: (*provider).into(),
                            status: "error",
                            revision: None,
                            session_count: None,
                            diagnostic: Some(error.to_string()),
                        };
                    }
                };
                if !adapter.available() {
                    return ReindexResult {
                        provider: (*provider).into(),
                        status: "unavailable",
                        revision: None,
                        session_count: None,
                        diagnostic: Some(adapter.unavailable_diagnostic().into()),
                    };
                }
                match index::rebuild(
                    &self.config.index_dir,
                    &self.source_scope,
                    provider,
                    adapter.as_ref(),
                ) {
                    Ok(catalog) => ReindexResult {
                        provider: (*provider).into(),
                        status: "rebuilt",
                        revision: Some(catalog.revision),
                        session_count: Some(catalog.rows.len()),
                        diagnostic: None,
                    },
                    Err(error) => ReindexResult {
                        provider: (*provider).into(),
                        status: "error",
                        revision: None,
                        session_count: None,
                        diagnostic: Some(error.to_string()),
                    },
                }
            })
            .collect()
    }

    pub fn providers(&self) -> Vec<ProviderStatus> {
        PROVIDERS
            .iter()
            .map(|id| {
                let adapter = providers::adapter(&self.config, &self.source_scope, id).ok();
                let available = adapter.as_ref().is_some_and(|adapter| adapter.available());
                ProviderStatus {
                    id: (*id).into(),
                    name: match *id {
                        "opencode" => "OpenCode",
                        "claude-code" => "Claude Code",
                        "codex" => "Codex CLI",
                        "pi" => "Pi",
                        _ => "DeepSeek Harness",
                    }
                    .into(),
                    icon: provider_icon(id).into(),
                    available,
                    manageable: true,
                    storage_diagnostic: adapter
                        .as_ref()
                        .and_then(|adapter| adapter.storage_diagnostic()),
                    protocol_capabilities: adapter
                        .as_ref()
                        .map(|adapter| adapter.protocol_capabilities())
                        .unwrap_or_default(),
                }
            })
            .collect()
    }

    fn indexed_sessions(&self, provider: &str) -> Result<(Vec<SessionSummary>, String)> {
        self.indexed_sessions_inner(
            provider,
            #[cfg(feature = "search-phase-probe")]
            None,
        )
        .map(|(rows, revision, _)| (rows, revision))
    }

    #[cfg(feature = "search-phase-probe")]
    fn indexed_sessions_with_probe(
        &self,
        provider: &str,
        probe: &mut search::SearchPhaseProbe,
    ) -> Result<(Vec<SessionSummary>, String, Option<(&'static str, usize)>)> {
        self.indexed_sessions_inner(provider, Some(probe))
    }

    #[cfg(not(feature = "search-phase-probe"))]
    fn indexed_sessions_for_search(
        &self,
        provider: &str,
    ) -> Result<(Vec<SessionSummary>, String, Option<(&'static str, usize)>)> {
        self.indexed_sessions_inner(provider)
    }

    fn indexed_sessions_inner(
        &self,
        provider: &str,
        #[cfg(feature = "search-phase-probe")] probe: Option<&mut search::SearchPhaseProbe>,
    ) -> Result<(Vec<SessionSummary>, String, Option<(&'static str, usize)>)> {
        let adapter = providers::adapter(&self.config, &self.source_scope, provider)?;
        if !adapter.available() {
            return Err(CoreError::Unavailable(provider.into()));
        }
        #[cfg(feature = "search-phase-probe")]
        let published = if let Some(probe) = probe {
            index::refresh_with_probe(
                &self.config.index_dir,
                &self.source_scope,
                provider,
                adapter.as_ref(),
                probe,
            )?
        } else {
            index::refresh(
                &self.config.index_dir,
                &self.source_scope,
                provider,
                adapter.as_ref(),
            )?
        };
        #[cfg(not(feature = "search-phase-probe"))]
        let published = index::refresh(
            &self.config.index_dir,
            &self.source_scope,
            provider,
            adapter.as_ref(),
        )?;
        let (mut rows, revision, uncertainty) = match published {
            Some(catalog) => (catalog.rows, catalog.revision, catalog.source_uncertainty),
            None => {
                let rows = adapter.list()?;
                let revision = browse_revision(&rows);
                (rows, revision, adapter.source_uncertainty()?)
            }
        };
        rows.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.session.session_id.cmp(&b.session.session_id))
        });
        Ok((rows, revision, uncertainty))
    }

    pub fn sessions(&self, provider: &str) -> Result<Vec<SessionSummary>> {
        self.indexed_sessions(provider).map(|(rows, _)| rows)
    }

    pub fn system_prompt_evidence(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<SystemPromptEvidence> {
        let adapter = providers::adapter(&self.config, &self.source_scope, provider)?;
        if !adapter.available() {
            return Err(CoreError::Unavailable(provider.into()));
        }
        adapter.system_prompt_evidence(session_id)
    }

    pub fn session_browse(&self, query: BrowseQuery) -> Result<serde_json::Value> {
        if !matches!(query.level.as_str(), "providers" | "projects" | "sessions") {
            return Err(CoreError::InvalidInput(
                "level must be providers, projects, or sessions".into(),
            ));
        }
        if query.level == "providers"
            && (query.directory.is_some()
                || query.title.is_some()
                || query.parent.is_some()
                || query.updated_after.is_some()
                || query.updated_before.is_some()
                || query.cursor.is_some()
                || query.limit.is_some())
        {
            return Err(CoreError::InvalidInput(
                "filters and pagination are not supported at the providers level".into(),
            ));
        }
        if query.level == "projects" && (query.title.is_some() || query.parent.is_some()) {
            return Err(CoreError::InvalidInput(
                "title and parent are not supported at the projects level".into(),
            ));
        }
        let selected = query
            .providers
            .clone()
            .unwrap_or_else(|| PROVIDERS.iter().map(|id| (*id).into()).collect());
        if selected.len() > PROVIDERS.len()
            || selected.iter().any(|id| !PROVIDERS.contains(&id.as_str()))
        {
            return Err(CoreError::InvalidInput(
                "providers must contain registered provider IDs".into(),
            ));
        }
        let limit = query.limit.unwrap_or(20);
        if limit == 0 || limit > 100 {
            return Err(CoreError::InvalidInput(
                "limit must be between 1 and 100".into(),
            ));
        }
        if let Some(directory) = &query.directory {
            if directory.encode_utf16().count() > 4000
                || (directory != "" && directory.trim().is_empty())
            {
                return Err(CoreError::InvalidInput(
                    "directory must be a recorded project path or empty string".into(),
                ));
            }
        }
        let title = query.title.as_deref().map(str::trim);
        if let Some(title) = title {
            if title.is_empty() || title.encode_utf16().count() > 500 {
                return Err(CoreError::InvalidInput(
                    "title must be a nonempty query of at most 500 characters".into(),
                ));
            }
        }
        if query.updated_after.is_some_and(|time| !time.is_finite())
            || query.updated_before.is_some_and(|time| !time.is_finite())
            || query
                .updated_after
                .zip(query.updated_before)
                .is_some_and(|(after, before)| after > before)
        {
            return Err(CoreError::InvalidInput("invalid updated time range".into()));
        }
        if let Some(Some(parent)) = &query.parent {
            if !PROVIDERS.contains(&parent.provider.as_str())
                || parent.session_id.trim().is_empty()
                || parent.session_id.encode_utf16().count() > 1000
            {
                return Err(CoreError::InvalidInput(
                    "invalid parent session reference".into(),
                ));
            }
        }
        let statuses = self.providers();
        let diagnostics: Vec<_> = selected.iter().map(|id| {
            let status = statuses.iter().find(|row| row.id == *id);
            let available = status.is_some_and(|row| row.available);
            let source_diagnostics = status
                .and_then(|row| row.storage_diagnostic.as_ref())
                .and_then(|value| value.get("sourceDiagnostics"));
            serde_json::json!({
                "provider": id,
                "status": if !available { "unavailable" } else if source_diagnostics.is_some() { "partial" } else { "ok" },
                "sourceDiagnostics": source_diagnostics
            })
        }).collect();
        if query.level == "providers" {
            let providers: Vec<_> = selected
                .iter()
                .map(|id| {
                    serde_json::json!({
                        "provider": id,
                        "available": statuses.iter().any(|row| row.id == *id && row.available)
                    })
                })
                .collect();
            return Ok(
                serde_json::json!({ "level": "providers", "providers": providers,
                "diagnostics": diagnostics, "nextCursor": null, "truncated": false,
                "untrustedContent": true }),
            );
        }
        let directory = query.directory.as_deref().map(normalize_project_path);
        let mut rows = Vec::new();
        let mut provider_revisions = Vec::new();
        let mut enumerated = BTreeSet::new();
        for id in &selected {
            if enumerated.insert(id) && statuses.iter().any(|row| row.id == *id && row.available) {
                let (sessions, revision) = self.indexed_sessions(id)?;
                rows.extend(sessions);
                provider_revisions.push((id, revision));
            }
        }
        rows.sort_by(|a, b| {
            a.session
                .provider
                .cmp(&b.session.provider)
                .then_with(|| a.session.session_id.cmp(&b.session.session_id))
        });
        let catalog_revision = browse_revision(&(&provider_revisions, &rows));
        rows.retain(|row| {
            let time = row.updated_at.map(|value| value as f64);
            (query
                .updated_after
                .is_none_or(|after| time.is_some_and(|time| time >= after)))
                && (query
                    .updated_before
                    .is_none_or(|before| time.is_some_and(|time| time <= before)))
                && directory.as_ref().is_none_or(|directory| {
                    normalize_project_path(row.directory.as_deref().unwrap_or("")) == *directory
                })
        });
        let filter_hash = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    &query.level,
                    &selected,
                    &directory,
                    &title,
                    &query.parent,
                    query.updated_after,
                    query.updated_before
                ))
                .expect("browse filter serialization")
            )
        );
        if query.level == "projects" {
            let mut counts = BTreeMap::<(String, String), usize>::new();
            for row in &rows {
                *counts
                    .entry((
                        row.session.provider.clone(),
                        normalize_project_path(row.directory.as_deref().unwrap_or("")),
                    ))
                    .or_default() += 1;
            }
            let candidates: Vec<_> = counts.into_iter().map(|((provider, directory), indexed_count)|
                serde_json::json!({"provider": provider, "directory": directory, "indexedCount": indexed_count})).collect();
            let revision = browse_revision(&(&catalog_revision, &candidates));
            let offset = self.browse_offset(
                query.cursor.as_deref(),
                &filter_hash,
                &revision,
                candidates.len(),
            )?;
            let end = offset.saturating_add(limit).min(candidates.len());
            let next_cursor =
                self.browse_next_cursor(end, candidates.len(), &filter_hash, &revision);
            return Ok(
                serde_json::json!({"level": "projects", "projects": &candidates[offset..end],
                "diagnostics": diagnostics, "truncated": next_cursor.is_some(), "nextCursor": next_cursor,
                "untrustedContent": true}),
            );
        }
        rows.retain(|row| {
            title.is_none_or(|title| {
                let lowered = row.title.to_lowercase();
                title
                    .split_whitespace()
                    .all(|term| lowered.contains(&term.to_lowercase()))
            }) && match &query.parent {
                None => true,
                Some(None) => row.parent.is_none(),
                Some(Some(parent)) => row.parent.as_ref() == Some(parent),
            }
        });
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| b.created_at.cmp(&a.created_at))
                .then_with(|| a.session.provider.cmp(&b.session.provider))
                .then_with(|| a.session.session_id.cmp(&b.session.session_id))
        });
        let revision = browse_revision(&(&catalog_revision, &rows));
        let offset =
            self.browse_offset(query.cursor.as_deref(), &filter_hash, &revision, rows.len())?;
        let end = offset.saturating_add(limit).min(rows.len());
        let sessions = &rows[offset..end];
        let next_cursor = self.browse_next_cursor(end, rows.len(), &filter_hash, &revision);
        Ok(
            serde_json::json!({"level": "sessions", "sessions": sessions,
            "diagnostics": diagnostics, "truncated": next_cursor.is_some(), "nextCursor": next_cursor,
            "untrustedContent": true}),
        )
    }

    fn browse_offset(
        &self,
        token: Option<&str>,
        filters: &str,
        revision: &str,
        len: usize,
    ) -> Result<usize> {
        let Some(token) = token else { return Ok(0) };
        if token.is_empty() || token.len() > 4000 {
            return Err(CoreError::InvalidCursor);
        }
        let cursor: BrowseCursor =
            serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
        if cursor.version != 1
            || cursor.kind != "session_browse"
            || cursor.scope != self.source_scope
            || cursor.filters != filters
            || cursor.offset > len
        {
            return Err(CoreError::InvalidCursor);
        }
        if cursor.revision != revision {
            return Err(CoreError::SourceChanged);
        }
        Ok(cursor.offset)
    }

    fn browse_next_cursor(
        &self,
        end: usize,
        len: usize,
        filters: &str,
        revision: &str,
    ) -> Option<String> {
        (end < len).then(|| {
            serde_json::to_string(&BrowseCursor {
                version: 1,
                kind: "session_browse".into(),
                scope: self.source_scope.clone(),
                filters: filters.into(),
                revision: revision.into(),
                offset: end,
            })
            .expect("browse cursor serialization")
        })
    }

    pub fn resume_spec(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<(Option<DefaultResumeCommand>, Option<String>)> {
        let adapter = providers::adapter(&self.config, &self.source_scope, provider)?;
        if !adapter.available() {
            return Err(CoreError::Unavailable(provider.into()));
        }
        validate_artifact_session_id(session_id)?;
        Ok((
            adapter.resume_command(),
            adapter.resume_directory(session_id)?,
        ))
    }

    pub fn reader_bootstrap(&self, provider: &str, session_id: &str) -> Result<ReaderBootstrap> {
        self.reader_bootstrap_at(provider, session_id, ReaderBootstrapQuery::default())
    }

    pub fn reader_bootstrap_at(
        &self,
        provider: &str,
        session_id: &str,
        query: ReaderBootstrapQuery,
    ) -> Result<ReaderBootstrap> {
        query.validate()?;
        if let Some(model) = reader_model::ReaderModel::open(self, provider, session_id)? {
            return model.bootstrap_at(query);
        }
        let session = self.load_session(provider, session_id)?;
        let session_summary = session.summary.clone();
        let items = project_items(&session);
        let task_count = session
            .relations
            .iter()
            .filter(|entry| matches!(entry, RelationEntry::Task { .. }))
            .count();
        let observation_count = session.relations.len() - task_count;
        let mut bootstrap = ReaderBootstrap {
            session: session_summary,
            revision: session.revision.clone(),
            segments: vec![self.reader_page(&session, &items, 0)],
            total_items: items.len(),
            toc: self.toc_page(&session, &items, 0),
            relations: RelationSummary {
                task_count,
                observation_count,
                first_cursor: (!session.relations.is_empty())
                    .then(|| self.cursor(&session, "relations", 0)),
            },
            target_location: None,
            opening_toc: None,
        };
        if let Some(query) = query.location_query(&session.revision) {
            let location = self.locate_session(&session, query)?;
            let page_start = location.ordinal / 32 * 32;
            let toc_start = location.ordinal / 64 * 64;
            if page_start > 0 {
                bootstrap
                    .segments
                    .push(self.reader_page(&session, &items, page_start));
            }
            if toc_start > 0 {
                bootstrap.opening_toc = Some(std::mem::replace(
                    &mut bootstrap.toc,
                    self.toc_page(&session, &items, toc_start),
                ));
            }
            bootstrap.target_location = Some(location);
        }
        Ok(bootstrap)
    }

    pub fn reader_executions(
        &self,
        provider: &str,
        session_id: &str,
        revision: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ReaderExecutionPage> {
        if !(1..=200).contains(&limit) {
            return Err(CoreError::InvalidInput(
                "limit must be between 1 and 200".into(),
            ));
        }
        if let Some(model) = reader_model::ReaderModel::open_navigation(self, provider, session_id)?
        {
            return model.executions(revision, cursor, limit);
        }
        let stream = self.protocol_event_stream(provider, session_id)?;
        if stream.revision() != revision {
            return Err(CoreError::SourceChanged);
        }
        let page = stream.events(protocol::EventQuery {
            category: Some("tool".into()),
            kind: None,
            execution_only: true,
            limit,
            cursor: cursor.map(str::to_owned),
        })?;
        Ok(ReaderExecutionPage {
            session: page.session.clone(),
            revision: page.revision.into(),
            coverage: page.coverage,
            events: page.events.into_iter().cloned().collect(),
            next_cursor: page.next_cursor,
            scanned_events: page.scanned_events,
        })
    }

    pub fn reader_relations(
        &self,
        provider: &str,
        session_id: &str,
        cursor: &str,
    ) -> Result<ReaderRelationsPage> {
        if let Some(model) = reader_model::ReaderModel::open_navigation(self, provider, session_id)?
        {
            let start = model.check_cursor(provider, session_id, "relations", cursor)?;
            return model.relations(start);
        }
        let (session, start) = self.read_cursor(provider, session_id, "relations", cursor)?;
        if start % 32 != 0 || start >= session.relations.len() {
            return Err(CoreError::InvalidCursor);
        }
        let end = (start + 32).min(session.relations.len());
        let entries = session.relations[start..end].to_vec();
        let child_placements = self.reader_child_placements(&session, &entries);
        Ok(ReaderRelationsPage {
            session: Self::reader_ref(&session),
            revision: session.revision.clone(),
            entries,
            child_placements,
            next_cursor: (end < session.relations.len())
                .then(|| self.cursor(&session, "relations", end)),
        })
    }

    pub fn reader_child_location(
        &self,
        provider: &str,
        session_id: &str,
        revision: &str,
        child: &SessionRef,
    ) -> Result<ReaderChildLocation> {
        if let Some(model) = reader_model::ReaderModel::open_navigation(self, provider, session_id)?
        {
            return model.child_location(revision, child);
        }
        let session = self.load_session(provider, session_id)?;
        if session.revision != revision {
            return Err(CoreError::SourceChanged);
        }
        let placement = self
            .reader_child_placements(&session, &session.relations)
            .into_iter()
            .find(|placement| &placement.child == child);
        let location = placement
            .as_ref()
            .and_then(|row| row.after_event.as_ref())
            .map(|event| {
                self.locate_session(
                    &session,
                    ReaderLocateQuery {
                        source_revision: None,
                        revision: revision.into(),
                        message_id: Some(event.message_id.clone()),
                        segment: Some(event.segment.clone()),
                        edge: None,
                    },
                )
            })
            .transpose()?;
        let diagnostic = placement.as_ref().map_or_else(
            || Some("child_placement_unavailable".into()),
            |row| row.diagnostic.clone(),
        );
        Ok(ReaderChildLocation {
            session: Self::reader_ref(&session),
            revision: session.revision.clone(),
            placement,
            location,
            diagnostic,
        })
    }

    fn reader_child_placements(
        &self,
        session: &SessionSnapshot,
        entries: &[RelationEntry],
    ) -> Vec<ReaderChildPlacement> {
        let mut placements = Vec::new();
        for entry in entries {
            let RelationEntry::Coordination { observation } = entry else {
                continue;
            };
            if observation.from_session_ref.as_ref() != Some(&session.summary.session) {
                continue;
            }
            if !matches!(observation.state.as_str(), "requested" | "started") {
                continue;
            }
            let Some(child) = observation.to_session_ref.as_ref() else {
                continue;
            };
            if child == &session.summary.session
                || placements
                    .iter()
                    .any(|placement: &ReaderChildPlacement| placement.child == *child)
            {
                continue;
            }
            let parent = match self.load_session(&child.provider, &child.session_id) {
                Ok(snapshot) => snapshot.summary.parent,
                Err(_) => {
                    placements.push(ReaderChildPlacement {
                        child: child.clone(),
                        after_event: None,
                        source_event_id: observation.event_id.clone(),
                        diagnostic: Some("child_parent_unverified".into()),
                    });
                    continue;
                }
            };
            if parent.as_ref() != Some(&session.summary.session) {
                continue;
            }
            placements.push(ReaderChildPlacement {
                child: child.clone(),
                after_event: None,
                source_event_id: observation.event_id.clone(),
                diagnostic: Some("source_anchor_unavailable".into()),
            });
        }
        if placements.is_empty() {
            return placements;
        }
        let Ok(stream) = self.protocol_event_stream(
            &session.summary.session.provider,
            &session.summary.session.session_id,
        ) else {
            return placements;
        };
        if stream.revision() != session.revision {
            return placements;
        }
        let mut targets = Vec::new();
        for placement in &placements {
            targets.push(
                (placement.diagnostic.as_deref() != Some("child_parent_unverified"))
                    .then(|| stream.event_detail(&placement.source_event_id))
                    .flatten()
                    .map(|detail| detail.event.source_order),
            );
        }
        let mut last_reader: Option<EventRef> = None;
        let exact_source_anchors: HashMap<String, EventRef> = entries
            .iter()
            .filter_map(|entry| {
                let RelationEntry::Coordination { observation } = entry else {
                    return None;
                };
                observation
                    .reader_event
                    .as_ref()
                    .map(|reference| (observation.event_id.clone(), reference.clone()))
            })
            .collect();
        let reader_anchors: HashMap<EventRef, EventRef> = session
            .events
            .iter()
            .map(|event| {
                (
                    event.item.event.clone(),
                    event
                        .item
                        .owner
                        .clone()
                        .unwrap_or_else(|| event.item.event.clone()),
                )
            })
            .collect();
        let mut cursor = None;
        loop {
            let Ok(page) = stream.events(protocol::EventQuery {
                limit: 200,
                cursor,
                ..Default::default()
            }) else {
                break;
            };
            for event in page.events {
                for (placement, target) in placements.iter_mut().zip(&targets) {
                    if target.is_some_and(|target| event.source_order == target) {
                        let exact = exact_source_anchors
                            .get(&placement.source_event_id)
                            .filter(|reference| event.reader_event.as_ref() == Some(*reference))
                            .filter(|reference| reader_anchors.contains_key(*reference));
                        let anchor =
                            if exact_source_anchors.contains_key(&placement.source_event_id) {
                                exact
                            } else {
                                last_reader.as_ref()
                            };
                        if let Some(anchor) = anchor {
                            placement.after_event = Some(anchor.clone());
                            placement.diagnostic = None;
                        }
                    }
                }
                if let Some(reference) = &event.reader_event {
                    if let Some(anchor) = reader_anchors.get(reference) {
                        last_reader = Some(anchor.clone());
                    }
                }
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        placements
    }

    fn reader_ref(session: &SessionSnapshot) -> SessionRef {
        session.summary.session.clone()
    }

    fn cursor(&self, session: &SessionSnapshot, kind: &str, position: usize) -> String {
        let cursor = ReaderCursor {
            version: 1,
            kind: kind.into(),
            scope: self.source_scope.clone(),
            session: Self::reader_ref(session),
            revision: session.revision.clone(),
            dependency: None,
            projection: 1,
            position,
        };
        // JSON is percent-encoded by the transport; callers treat it as opaque.
        serde_json::to_string(&cursor).expect("Reader cursor serialization")
    }

    fn read_cursor(
        &self,
        provider: &str,
        session_id: &str,
        kind: &str,
        token: &str,
    ) -> Result<(SessionSnapshot, usize)> {
        if token.len() > 4096 {
            return Err(CoreError::InvalidCursor);
        }
        let cursor: ReaderCursor =
            serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
        if cursor.version != 1
            || cursor.projection != 1
            || cursor.kind != kind
            || cursor.scope != self.source_scope
            || cursor.session.provider != provider
            || cursor.session.session_id != session_id
        {
            return Err(CoreError::InvalidCursor);
        }
        let session = self.load_session(provider, session_id)?;
        if cursor.revision != session.revision {
            return Err(CoreError::SourceChanged);
        }
        Ok((session, cursor.position))
    }

    fn reader_page(
        &self,
        session: &SessionSnapshot,
        items: &[ReaderItem],
        start: usize,
    ) -> ReaderSegment {
        let end = (start + 32).min(items.len());
        let owner_context = items
            .get(start)
            .and_then(|item| item.owner.as_ref())
            .and_then(|owner| items[..start].iter().find(|item| &item.event == owner))
            .cloned();
        ReaderSegment {
            id: format!("page-{start}"),
            page_id: format!("page-{start}"),
            start_ordinal: start,
            items: items[start..end].to_vec(),
            owner_context,
            previous_cursor: (start > 0)
                .then(|| self.cursor(session, "segments", start.saturating_sub(32))),
            next_cursor: (end < items.len()).then(|| self.cursor(session, "segments", end)),
        }
    }

    fn toc_page(
        &self,
        session: &SessionSnapshot,
        items: &[ReaderItem],
        start: usize,
    ) -> ReaderTocPage {
        let end = (start + 64).min(items.len());
        ReaderTocPage {
            entries: items[start..end]
                .iter()
                .map(|item| ReaderTocEntry {
                    event: item.event.clone(),
                    ordinal: item.ordinal,
                    owner: item.owner.clone(),
                    role: item.role.clone(),
                    label: item.preview.chars().take(80).collect(),
                    process_id: item.process_id,
                    process_count: item.process_count,
                })
                .collect(),
            previous_cursor: (start > 0)
                .then(|| self.cursor(session, "toc", start.saturating_sub(64))),
            next_cursor: (end < items.len()).then(|| self.cursor(session, "toc", end)),
        }
    }

    pub fn reader_segments(
        &self,
        provider: &str,
        session_id: &str,
        cursor: &str,
    ) -> Result<ReaderPageResponse> {
        if let Some(model) = reader_model::ReaderModel::open_navigation(self, provider, session_id)?
        {
            let start = model.check_cursor(provider, session_id, "segments", cursor)?;
            return model.segments(start);
        }
        let (session, start) = self.read_cursor(provider, session_id, "segments", cursor)?;
        let items = project_items(&session);
        if start % 32 != 0 || start >= items.len().max(1) {
            return Err(CoreError::InvalidCursor);
        }
        Ok(ReaderPageResponse {
            session: Self::reader_ref(&session),
            revision: session.revision.clone(),
            page: self.reader_page(&session, &items, start),
        })
    }

    pub fn reader_toc(
        &self,
        provider: &str,
        session_id: &str,
        cursor: &str,
    ) -> Result<ReaderTocResponse> {
        if let Some(model) = reader_model::ReaderModel::open_navigation(self, provider, session_id)?
        {
            let start = model.check_cursor(provider, session_id, "toc", cursor)?;
            return model.toc(start);
        }
        let (session, start) = self.read_cursor(provider, session_id, "toc", cursor)?;
        let items = project_items(&session);
        if start % 64 != 0 || start >= items.len().max(1) {
            return Err(CoreError::InvalidCursor);
        }
        Ok(ReaderTocResponse {
            session: Self::reader_ref(&session),
            revision: session.revision.clone(),
            toc: self.toc_page(&session, &items, start),
        })
    }

    pub fn reader_locate(
        &self,
        provider: &str,
        session_id: &str,
        mut query: ReaderLocateQuery,
    ) -> Result<ReaderLocation> {
        let source_revision = query.source_revision.take();
        if let Some(expected) = &source_revision
            && self.protocol_event_stream(provider, session_id)?.revision() != expected
        {
            return Err(CoreError::SourceChanged);
        }
        let model = if source_revision.is_some() {
            // Runtime links require both current source evidence and the Reader
            // generation the caller displays. Their revision domains may differ.
            reader_model::ReaderModel::open(self, provider, session_id)?
        } else {
            reader_model::ReaderModel::open_navigation(self, provider, session_id)?
        };
        let location = if let Some(model) = model {
            model.locate(query)?
        } else {
            let session = self.load_session(provider, session_id)?;
            self.locate_session(&session, query)?
        };
        if let Some(expected) = &source_revision
            && self.protocol_event_stream(provider, session_id)?.revision() != expected
        {
            return Err(CoreError::SourceChanged);
        }
        Ok(location)
    }

    fn locate_session(
        &self,
        session: &SessionSnapshot,
        query: ReaderLocateQuery,
    ) -> Result<ReaderLocation> {
        if session.revision != query.revision {
            return Err(CoreError::SourceChanged);
        }
        let items = project_items(session);
        let item = match (
            query.edge.as_deref(),
            query.message_id.as_deref(),
            query.segment.as_deref(),
        ) {
            (Some("end"), None, None) => items.last(),
            (None, Some(message_id), Some(segment)) => items
                .iter()
                .find(|item| item.event.message_id == message_id && item.event.segment == segment),
            _ => {
                return Err(CoreError::InvalidInput(
                    "supply edge=end or messageId and segment".into(),
                ));
            }
        }
        .ok_or_else(|| {
            CoreError::EventNotFound(query.message_id.unwrap_or_else(|| "end".into()))
        })?;
        Ok(ReaderLocation {
            session: Self::reader_ref(&session),
            revision: session.revision.clone(),
            event: item.event.clone(),
            ordinal: item.ordinal,
            owner: item.owner.clone(),
            page_cursor: self.cursor(&session, "segments", item.ordinal / 32 * 32),
            toc_cursor: self.cursor(&session, "toc", item.ordinal / 64 * 64),
        })
    }

    pub fn reader_content(
        &self,
        provider: &str,
        session_id: &str,
        query: ContentQuery,
    ) -> Result<ContentPage> {
        if let Some(model) =
            reader_model::ReaderModel::open_content_snapshot(self, provider, session_id, &query)?
        {
            return model.content(provider, session_id, query);
        }
        if let Some(model) = reader_model::ReaderModel::open(self, provider, session_id)? {
            return model.content(provider, session_id, query);
        }
        let session = self.load_session(provider, session_id)?;
        if query.content_revision.is_none() && session.revision != query.revision {
            return Err(CoreError::SourceChanged);
        }
        let event = EventRef {
            provider: provider.into(),
            session_id: session_id.into(),
            message_id: query.message_id,
            segment: query.segment,
        };
        let (message, body) = locate_content(&session, &event)?;
        let content = match (event.segment.as_str(), query.field.as_str()) {
            ("message" | "thinking" | "context", "body") => body,
            ("tool", "toolInput") => &message.tool_input,
            ("tool", "toolOutput") => &message.tool_output,
            _ => {
                return Err(CoreError::InvalidInput(
                    "unsupported content field for event segment".into(),
                ));
            }
        };
        if query.content_revision.as_ref().is_some_and(|revision| {
            *revision != format!("{:x}", Sha256::digest(content.as_bytes()))
        }) {
            return Err(CoreError::SourceChanged);
        }
        page_text(content, query.offset, query.max_chars)
    }

    pub fn reader_team_message_content(
        &self,
        provider: &str,
        session_id: &str,
        query: TeamMessageContentQuery,
    ) -> Result<ContentPage> {
        providers::adapter(&self.config, &self.source_scope, provider)?.team_message_content(
            session_id,
            query.sequence,
            &query.message_id,
            &query.revision,
            query.offset,
            query.max_chars,
        )
    }

    pub fn session_team_messages(
        &self,
        session: &SessionRef,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<TeamMessagesPage> {
        if limit == 0 || limit > 100 {
            return Err(CoreError::InvalidInput(
                "limit must be between 1 and 100".into(),
            ));
        }
        validate_artifact_session_id(&session.session_id)?;
        let inventory = providers::adapter(&self.config, &self.source_scope, &session.provider)?
            .team_messages(&session.session_id)?;
        let offset = if let Some(token) = cursor {
            if token.is_empty() || token.len() > 4000 {
                return Err(CoreError::InvalidCursor);
            }
            let saved: TeamMessagesCursor =
                serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
            if saved.version != 1
                || saved.kind != "session_team_messages"
                || saved.scope != self.source_scope
                || saved.session != *session
            {
                return Err(CoreError::InvalidCursor);
            }
            if saved.revision != inventory.revision {
                return Err(CoreError::SourceChanged);
            }
            if saved.offset >= inventory.messages.len() {
                return Err(CoreError::InvalidCursor);
            }
            saved.offset
        } else {
            0
        };
        let end = offset.saturating_add(limit).min(inventory.messages.len());
        let next_cursor = (end < inventory.messages.len()).then(|| {
            serde_json::to_string(&TeamMessagesCursor {
                version: 1,
                kind: "session_team_messages".into(),
                scope: self.source_scope.clone(),
                session: session.clone(),
                revision: inventory.revision.clone(),
                offset: end,
            })
            .expect("team message cursor serialization")
        });
        Ok(TeamMessagesPage {
            session: session.clone(),
            revision: inventory.revision,
            messages: inventory.messages[offset..end].to_vec(),
            next_cursor,
        })
    }

    pub fn session_team_message_read(
        &self,
        message: &TeamMessageRef,
        revision: &str,
        offset: usize,
        max_chars: usize,
    ) -> Result<ContentPage> {
        validate_artifact_session_id(&message.session_id)?;
        if message.source_id.is_empty()
            || message.source_id.len() > 1000
            || message.message_id.is_empty()
            || message.message_id.len() > 1000
            || revision.is_empty()
            || max_chars == 0
            || max_chars > 20_000
        {
            return Err(CoreError::InvalidInput(
                "invalid team message read arguments".into(),
            ));
        }
        providers::adapter(&self.config, &self.source_scope, &message.provider)?.team_message_read(
            &message.session_id,
            &message.source_id,
            &message.message_id,
            revision,
            offset,
            max_chars,
        )
    }

    pub fn reader_inherited_context(
        &self,
        provider: &str,
        session_id: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<Option<InheritedContextPage>> {
        if !(1..=100).contains(&limit) {
            return Err(CoreError::InvalidInput(
                "limit must be between 1 and 100".into(),
            ));
        }
        let saved = if let Some(token) = cursor {
            if token.len() > 4096 {
                return Err(CoreError::InvalidCursor);
            }
            let saved: InheritedCursor =
                serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
            if saved.version != 1
                || saved.kind != "inherited-context"
                || saved.scope != self.source_scope
                || saved.session.provider != provider
                || saved.session.session_id != session_id
                || saved.limit != limit
            {
                return Err(CoreError::InvalidCursor);
            }
            Some(saved)
        } else {
            None
        };
        let Some(snapshot) = providers::adapter(&self.config, &self.source_scope, provider)?
            .inherited_context(session_id)?
        else {
            return Ok(None);
        };
        if saved
            .as_ref()
            .is_some_and(|saved| saved.revision != snapshot.revision)
        {
            return Err(CoreError::SourceChanged);
        }
        let start = saved.as_ref().map_or(0, |saved| saved.position);
        if start > 0 && (start % limit != 0 || start >= snapshot.events.len()) {
            return Err(CoreError::InvalidCursor);
        }
        let end = (start + limit).min(snapshot.events.len());
        let session = SessionRef {
            provider: provider.into(),
            session_id: session_id.into(),
        };
        let next_cursor = (end < snapshot.events.len()).then(|| {
            serde_json::to_string(&InheritedCursor {
                version: 1,
                kind: "inherited-context".into(),
                scope: self.source_scope.clone(),
                session: session.clone(),
                revision: snapshot.revision.clone(),
                limit,
                position: end,
            })
            .expect("inherited cursor serialization")
        });
        Ok(Some(InheritedContextPage {
            session,
            revision: snapshot.revision,
            scope: "inherited-context",
            source_session: snapshot.source_session,
            total_items: snapshot.events.len(),
            items: snapshot.events[start..end]
                .iter()
                .map(|event| event.item.clone())
                .collect(),
            next_cursor,
        }))
    }

    pub fn reader_inherited_content(
        &self,
        provider: &str,
        session_id: &str,
        query: InheritedContentQuery,
    ) -> Result<InheritedContentPage> {
        let snapshot = providers::adapter(&self.config, &self.source_scope, provider)?
            .inherited_context(session_id)?
            .ok_or_else(|| CoreError::Unavailable("inherited context is unavailable".into()))?;
        if snapshot.revision != query.revision {
            return Err(CoreError::SourceChanged);
        }
        let event = snapshot
            .events
            .get(query.ordinal)
            .filter(|event| {
                event.item.message_id == query.message_id && event.item.segment == query.segment
            })
            .ok_or_else(|| CoreError::EventNotFound(query.message_id.clone()))?;
        let content = match (query.segment.as_str(), query.field.as_str()) {
            ("message" | "thinking" | "context", "body") => &event.body,
            ("tool", "toolInput") => &event.tool_input,
            ("tool", "toolOutput") => &event.tool_output,
            _ => {
                return Err(CoreError::InvalidInput(
                    "unsupported inherited content field".into(),
                ));
            }
        };
        Ok(InheritedContentPage {
            revision: snapshot.revision,
            content: page_text(content, query.offset, query.max_chars)?,
        })
    }

    pub fn reader_search(
        &self,
        provider: &str,
        session_id: &str,
        query: ReaderSearchQuery,
    ) -> Result<ReaderSearchPage> {
        let needle = query.q.trim();
        if needle.is_empty() || needle.encode_utf16().count() > 500 {
            return Err(CoreError::InvalidInput(
                "q must contain between 1 and 500 UTF-16 units after trimming".into(),
            ));
        }
        let limit = query.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) {
            return Err(CoreError::InvalidInput(
                "limit must be between 1 and 100".into(),
            ));
        }
        if let Some(model) = reader_model::ReaderModel::open(self, provider, session_id)? {
            return model.search(needle, &query.revision, limit, query.cursor.as_deref());
        }
        let session = self.load_session(provider, session_id)?;
        if session.revision != query.revision {
            return Err(CoreError::SourceChanged);
        }
        let session_ref = Self::reader_ref(&session);
        let (start_event, start_field, start_offset) = if let Some(token) = query.cursor.as_deref()
        {
            if token.len() > 8192 {
                return Err(CoreError::InvalidCursor);
            }
            let cursor: ReaderSearchCursor =
                serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
            if cursor.version != 1
                || cursor.kind != "reader.search"
                || cursor.scope != self.source_scope
                || cursor.session != session_ref
                || cursor.dependency.is_some()
                || cursor.query != needle
                || cursor.event_index >= session.events.len()
                || cursor.field_index
                    >= reader_search_fields(&session.events[cursor.event_index]).len()
            {
                return Err(CoreError::InvalidCursor);
            }
            if cursor.revision != session.revision {
                return Err(CoreError::SourceChanged);
            }
            (
                cursor.event_index,
                cursor.field_index,
                cursor.lower_byte_offset,
            )
        } else {
            (0, 0, 0)
        };
        let lower_needle = needle.to_lowercase();
        let mut matches = Vec::with_capacity(limit);
        for event_index in start_event..session.events.len() {
            let entry = &session.events[event_index];
            let fields = reader_search_fields(entry);
            let first_field = if event_index == start_event {
                start_field
            } else {
                0
            };
            for (field_index, (field, content)) in fields.iter().enumerate().skip(first_field) {
                let lower_content = content.to_lowercase();
                let mut from = if event_index == start_event && field_index == start_field {
                    start_offset
                } else {
                    0
                };
                if !lower_content.is_char_boundary(from) {
                    return Err(CoreError::InvalidCursor);
                }
                let mut ranges = Vec::new();
                let mut next_match = None;
                while let Some(relative) = lower_content[from..].find(&lower_needle) {
                    let start = from + relative;
                    let end = start + lower_needle.len();
                    if matches.len() + ranges.len() == limit {
                        next_match = Some(start);
                        break;
                    }
                    ranges.push((start, end));
                    from = end;
                }
                if !ranges.is_empty() {
                    let total_chars = content.encode_utf16().count();
                    for (offset, match_length, start_byte, end_byte) in
                        reader_search_original_spans(content, &ranges)?
                    {
                        let (excerpt_start, excerpt) =
                            reader_search_excerpt(content, start_byte, end_byte, offset);
                        matches.push(ReaderSearchMatch {
                            event: entry.item.event.clone(),
                            owner: entry.item.owner.clone(),
                            ordinal: entry.item.ordinal,
                            field,
                            offset,
                            match_length,
                            excerpt,
                            excerpt_start,
                            total_chars,
                        });
                    }
                }
                if let Some(lower_byte_offset) = next_match {
                    let cursor = ReaderSearchCursor {
                        version: 1,
                        kind: "reader.search".into(),
                        scope: self.source_scope.clone(),
                        session: session_ref.clone(),
                        revision: session.revision.clone(),
                        dependency: None,
                        query: needle.into(),
                        event_index,
                        field_index,
                        lower_byte_offset,
                    };
                    return Ok(ReaderSearchPage {
                        session: session_ref,
                        revision: session.revision,
                        scope: "owned",
                        coverage: "complete-owned-content",
                        matches,
                        next_cursor: Some(
                            serde_json::to_string(&cursor)
                                .expect("Reader search cursor serialization"),
                        ),
                    });
                }
            }
        }
        Ok(ReaderSearchPage {
            session: session_ref,
            revision: session.revision.clone(),
            scope: "owned",
            coverage: "complete-owned-content",
            matches,
            next_cursor: None,
        })
    }

    pub fn session_get(
        &self,
        provider: &str,
        session_id: &str,
        child_limit: usize,
        child_cursor: Option<&str>,
    ) -> Result<SessionGet> {
        if child_limit == 0 || child_limit > 100 {
            return Err(CoreError::InvalidInput(
                "childLimit must be between 1 and 100".into(),
            ));
        }
        let session = self.load_session(provider, session_id)?;
        let parent = session.summary.session.clone();
        let candidates: Vec<_> = self
            .sessions(provider)?
            .into_iter()
            .filter(|row| row.parent.as_ref() == Some(&parent))
            .collect();
        let revision = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&candidates).expect("session summary serialization"))
        );
        let offset = if let Some(token) = child_cursor {
            if token.len() > 4000 {
                return Err(CoreError::InvalidCursor);
            }
            let cursor: ChildCursor =
                serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
            if cursor.version != 1
                || cursor.kind != "session_get.children"
                || cursor.scope != self.source_scope
                || cursor.parent != parent
                || cursor.offset > candidates.len()
            {
                return Err(CoreError::InvalidCursor);
            }
            if cursor.revision != revision {
                return Err(CoreError::SourceChanged);
            }
            cursor.offset
        } else {
            0
        };
        let end = offset.saturating_add(child_limit).min(candidates.len());
        let mut children = Vec::new();
        for candidate in &candidates[offset..end] {
            let child = match self.load_session(provider, &candidate.session.session_id) {
                Ok(child) => child,
                Err(CoreError::NotFound { .. }) => continue,
                Err(error) => return Err(error),
            };
            if child.summary.session == candidate.session
                && child.summary.parent.as_ref() == Some(&parent)
            {
                children.push(child.summary);
            }
        }
        let children_next_cursor = (end < candidates.len()).then(|| {
            serde_json::to_string(&ChildCursor {
                version: 1,
                kind: "session_get.children".into(),
                scope: self.source_scope.clone(),
                parent,
                revision,
                offset: end,
            })
            .expect("child cursor serialization")
        });
        let events = project_timeline(&session);
        let mut role_counts = BTreeMap::from([
            ("user".into(), 0),
            ("assistant".into(), 0),
            ("system".into(), 0),
            ("tool".into(), 0),
        ]);
        let mut seen_messages = BTreeSet::new();
        let mut tool_counts = BTreeMap::<String, usize>::new();
        for event in &events {
            if event.role == "context" {
                continue;
            }
            if seen_messages.insert(&event.event.message_id) {
                let counted_role = if event.role == "agent" {
                    "assistant"
                } else {
                    event.role.as_str()
                };
                *role_counts
                    .get_mut(counted_role)
                    .expect("provider-normalized role") += 1;
                if event.event.segment == "tool" || event.tool_name.is_some() {
                    *tool_counts
                        .entry(event.tool_name.clone().unwrap_or_else(|| "tool".into()))
                        .or_default() += 1;
                }
            }
        }
        let mut tool_names: Vec<_> = tool_counts
            .into_iter()
            .map(|(tool_name, count)| ToolFacet { tool_name, count })
            .collect();
        tool_names.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.tool_name.cmp(&b.tool_name))
        });
        let tool_names_truncated = tool_names.len() > 50;
        tool_names.truncate(50);
        let mut message_events = session
            .events
            .iter()
            .filter(|event| event.item.event.segment == "message")
            .map(project_message_preview)
            .filter(|event| !event.preview.trim().is_empty());
        let first_message = message_events.next();
        let last_message = message_events.next_back().or_else(|| first_message.clone());
        Ok(SessionGet {
            summary: session.summary.clone(),
            first_message,
            last_message,
            role_counts,
            tool_names,
            tool_names_truncated,
            children,
            children_truncated: children_next_cursor.is_some(),
            children_next_cursor,
            untrusted_content: true,
        })
    }

    pub fn timeline(&self, provider: &str, session_id: &str) -> Result<Vec<TimelineEvent>> {
        let session = self.load_session(provider, session_id)?;
        Ok(project_timeline(&session))
    }

    pub fn session_timeline(
        &self,
        provider: &str,
        session_id: &str,
        filters: TimelineFilters,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<TimelinePage> {
        if limit == 0 || limit > 200 {
            return Err(CoreError::InvalidInput(
                "limit must be between 1 and 200".into(),
            ));
        }
        let filters = normalized_timeline_filters(filters)?;
        let filter_identity = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&filters).expect("normalized timeline filters serialize")
            )
        );
        let reference = SessionRef {
            provider: provider.into(),
            session_id: session_id.into(),
        };
        let saved = if let Some(token) = cursor {
            if token.is_empty() || token.len() > 4000 {
                return Err(CoreError::InvalidCursor);
            }
            let saved: TimelineCursor =
                serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
            if saved.version != 1
                || saved.kind != "session_timeline"
                || saved.scope != self.source_scope
                || saved.session != reference
                || saved.filters != filter_identity
            {
                return Err(CoreError::InvalidCursor);
            }
            Some(saved)
        } else {
            None
        };
        let session = self
            .load_session(provider, session_id)
            .map_err(|error| match error {
                CoreError::NotFound { .. } if saved.is_some() => CoreError::SourceChanged,
                error => error,
            })?;
        if saved
            .as_ref()
            .is_some_and(|cursor| cursor.revision != session.revision)
        {
            return Err(CoreError::SourceChanged);
        }
        let offset = saved.map_or(0, |cursor| cursor.offset);
        let events: Vec<_> = session
            .events
            .iter()
            .filter_map(|entry| {
                let segment = entry.item.event.segment.as_str();
                if !filters
                    .segments
                    .as_ref()
                    .expect("default segments applied")
                    .iter()
                    .any(|value| value == segment)
                    || segment == "message" && entry.body.trim().is_empty()
                    || filters.roles.as_ref().is_some_and(|roles| {
                        !roles.contains(&entry.item.role)
                            && !(entry.item.role == "agent"
                                && roles.iter().any(|role| role == "assistant"))
                    })
                {
                    return None;
                }
                let tool_name = (segment == "tool").then(|| {
                    entry
                        .item
                        .tool_name
                        .clone()
                        .unwrap_or_else(|| "tool".into())
                });
                if filters.tool_names.as_ref().is_some_and(|names| {
                    !tool_name.as_ref().is_some_and(|name| names.contains(name))
                }) {
                    return None;
                }
                let status = (segment == "tool").then(|| {
                    entry
                        .tool_status
                        .clone()
                        .unwrap_or_else(|| "unknown".into())
                });
                if filters.statuses.as_ref().is_some_and(|statuses| {
                    !status
                        .as_ref()
                        .is_some_and(|value| statuses.contains(value))
                }) {
                    return None;
                }
                let search_text = if segment == "tool" {
                    tool_name.as_deref().unwrap_or("tool")
                } else {
                    &entry.body
                };
                if filters
                    .query
                    .as_ref()
                    .is_some_and(|query| !timeline_matches(search_text, query))
                {
                    return None;
                }
                let preview = if segment == "tool" {
                    bounded_preview(
                        &format!(
                            "{} ({})",
                            search_text,
                            status.as_deref().unwrap_or("unknown")
                        ),
                        240,
                    )
                } else if let Some(query) = &filters.query {
                    timeline_snippet(search_text, query)
                } else {
                    bounded_preview(search_text, 240)
                };
                Some(TimelineEvent {
                    event: entry.item.event.clone(),
                    timestamp: entry.item.timestamp,
                    role: entry.item.role.clone(),
                    tool_name,
                    status,
                    preview,
                    untrusted_content: true,
                })
            })
            .collect();
        if offset > events.len() {
            return Err(CoreError::InvalidCursor);
        }
        let end = offset.saturating_add(limit).min(events.len());
        let truncated = end < events.len();
        let next_cursor = truncated.then(|| {
            serde_json::to_string(&TimelineCursor {
                version: 1,
                kind: "session_timeline".into(),
                scope: self.source_scope.clone(),
                session: reference,
                revision: session.revision,
                filters: filter_identity,
                offset: end,
            })
            .expect("timeline cursor serialization")
        });
        Ok(TimelinePage {
            events: events[offset..end].to_vec(),
            next_cursor,
            truncated,
            untrusted_content: true,
        })
    }

    pub fn get_event(
        &self,
        event: &EventRef,
        offset: usize,
        max_chars: usize,
    ) -> Result<EventDetail> {
        self.get_event_with_options(event, offset, max_chars, EventReadOptions::default())
    }

    pub fn get_event_with_options(
        &self,
        event: &EventRef,
        offset: usize,
        max_chars: usize,
        options: EventReadOptions,
    ) -> Result<EventDetail> {
        self.get_event_with_revision(event, offset, max_chars, options, None)
    }

    pub fn get_event_with_revision(
        &self,
        event: &EventRef,
        offset: usize,
        max_chars: usize,
        options: EventReadOptions,
        expected_revision: Option<&str>,
    ) -> Result<EventDetail> {
        let session = self.load_session(&event.provider, &event.session_id)?;
        if expected_revision.is_some_and(|revision| revision != session.revision.as_str()) {
            return Err(CoreError::SourceChanged);
        }
        let (message, content) = locate_content(&session, event)?;
        if event.segment == "thinking" && !options.include_thinking {
            return Err(CoreError::InvalidInput(
                "includeThinking is required for thinking content".into(),
            ));
        }
        let tool_input = (event.segment == "tool" && options.include_tool_input)
            .then(|| page_text(&message.tool_input, offset, max_chars))
            .transpose()?;
        let tool_output = (event.segment == "tool" && options.include_tool_output)
            .then(|| page_text(&message.tool_output, offset, max_chars))
            .transpose()?;
        let content = (event.segment != "tool")
            .then(|| page_text(content, offset, max_chars))
            .transpose()?;
        Ok(EventDetail {
            event: event.clone(),
            revision: session.revision.clone(),
            role: message.item.role.clone(),
            timestamp: message.item.timestamp,
            untrusted_content: true,
            content,
            tool_name: message.item.tool_name.clone(),
            status: (event.segment == "tool").then(|| {
                message
                    .tool_status
                    .clone()
                    .unwrap_or_else(|| "unknown".into())
            }),
            tool_input,
            tool_output,
        })
    }

    pub fn protocol_event_stream(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<protocol::EventStream> {
        let adapter = providers::adapter(&self.config, &self.source_scope, provider)?;
        if !adapter.available() {
            return Err(CoreError::Unavailable(provider.into()));
        }
        if session_id.is_empty()
            || session_id.len() > 200
            || session_id.chars().any(|c| matches!(c, '/' | '\\' | '\0'))
        {
            return Err(CoreError::InvalidInput(
                "invalid canonical session ID".into(),
            ));
        }
        adapter.protocol_event_stream(session_id)
    }

    pub fn protocol_event_detail(
        &self,
        provider: &str,
        session_id: &str,
        event_id: &str,
        revision: &str,
    ) -> Result<protocol::EventDetail> {
        let stream = self.protocol_event_stream(provider, session_id)?;
        if stream.revision() != revision {
            return Err(CoreError::SourceChanged);
        }
        stream
            .event_detail(event_id)
            .ok_or_else(|| CoreError::EventNotFound(event_id.into()))
    }

    pub fn protocol_observations(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<protocol::ObservationSnapshot> {
        let adapter = providers::adapter(&self.config, &self.source_scope, provider)?;
        if !adapter.available() {
            return Err(CoreError::Unavailable(provider.into()));
        }
        if session_id.is_empty()
            || session_id.len() > 200
            || session_id.chars().any(|c| matches!(c, '/' | '\\' | '\0'))
        {
            return Err(CoreError::InvalidInput(
                "invalid canonical session ID".into(),
            ));
        }
        adapter.protocol_observations(session_id)
    }

    pub fn legacy_content_title_first(&self, provider: &str) -> Result<bool> {
        providers::adapter(&self.config, &self.source_scope, provider)?.legacy_content_title_first()
    }

    fn protocol_adapter(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<Box<dyn providers::ProviderAdapter + '_>> {
        let adapter = providers::adapter(&self.config, &self.source_scope, provider)?;
        if !adapter.available() {
            return Err(CoreError::Unavailable(provider.into()));
        }
        if session_id.is_empty()
            || session_id.len() > 200
            || session_id.chars().any(|c| matches!(c, '/' | '\\' | '\0'))
        {
            return Err(CoreError::InvalidInput(
                "invalid canonical session ID".into(),
            ));
        }
        Ok(adapter)
    }

    fn protocol_bundle(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<protocol::ProtocolBundle> {
        self.protocol_adapter(provider, session_id)?
            .protocol_bundle(session_id)
    }

    pub fn protocol_document(
        &self,
        provider: &str,
        session_id: &str,
        version: u8,
    ) -> Result<protocol::ProtocolDocument> {
        self.protocol_bundle(provider, session_id)?
            .document(version)
            .map_err(CoreError::Protocol)
    }

    pub fn protocol_work_page(
        &self,
        provider: &str,
        session_id: &str,
        query: protocol::WorkQuery,
    ) -> Result<protocol::WorkPage> {
        self.protocol_bundle(provider, session_id)?
            .work(query)
            .map_err(CoreError::Protocol)
    }

    pub fn protocol_runtime_summary(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<protocol::RuntimeSummary> {
        Ok(self.protocol_bundle(provider, session_id)?.summary())
    }

    pub fn protocol_runtime_graph(
        &self,
        provider: &str,
        session_id: &str,
        query: protocol::GraphQuery,
    ) -> Result<protocol::RuntimeGraph> {
        self.protocol_bundle(provider, session_id)?
            .graph(query)
            .map_err(CoreError::Protocol)
    }

    pub fn protocol_runtime_domain(
        &self,
        provider: &str,
        session_id: &str,
        domain: protocol::RuntimeDomain,
        query: protocol::DomainQuery,
    ) -> Result<protocol::DomainPage> {
        self.protocol_bundle(provider, session_id)?
            .domain_page(domain, query)
            .map_err(CoreError::Protocol)
    }

    fn load_session(&self, provider: &str, session_id: &str) -> Result<SessionSnapshot> {
        let adapter = providers::adapter(&self.config, &self.source_scope, provider)?;
        if !adapter.available() {
            return Err(CoreError::Unavailable(provider.into()));
        }
        if session_id.is_empty()
            || session_id.len() > 200
            || session_id.chars().any(|c| matches!(c, '/' | '\\' | '\0'))
        {
            return Err(CoreError::InvalidInput(
                "invalid canonical session ID".into(),
            ));
        }
        adapter.load(session_id)
    }
}

impl SourceConfig {
    fn normalized(self) -> Result<Self> {
        Ok(Self {
            codex_dir: absolute(&self.codex_dir)?,
            opencode_db: absolute(&self.opencode_db)?,
            claude_dir: absolute(&self.claude_dir)?,
            pi_dir: absolute(&self.pi_dir)?,
            dsh_dir: absolute(&self.dsh_dir)?,
            meta_dir: absolute(&self.meta_dir)?,
            index_dir: absolute(&self.index_dir)?,
            cache_dir: absolute(&self.cache_dir)?,
        })
    }
}

fn absolute(path: &Path) -> Result<PathBuf> {
    std::path::absolute(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })
}

fn reader_search_fields(event: &NormalizedEvent) -> Vec<(&'static str, &str)> {
    match event.item.event.segment.as_str() {
        "message" | "thinking" | "context" => vec![("body", &event.body)],
        "tool" => vec![
            ("toolInput", &event.tool_input),
            ("toolOutput", &event.tool_output),
        ],
        _ => Vec::new(),
    }
}

fn reader_search_original_spans(
    text: &str,
    ranges: &[(usize, usize)],
) -> Result<Vec<(usize, usize, usize, usize)>> {
    let mut spans = Vec::with_capacity(ranges.len());
    let mut next = 0;
    let mut lower_byte = 0;
    let mut source_units = 0;
    let mut start = None;
    for (source_byte, character) in text.char_indices() {
        let lower_end = lower_byte + character.to_lowercase().map(char::len_utf8).sum::<usize>();
        while next < ranges.len() && ranges[next].0 < lower_end {
            let (start_units, start_byte) = *start.get_or_insert((source_units, source_byte));
            if ranges[next].1 > lower_end {
                break;
            }
            let end_byte = source_byte + character.len_utf8();
            spans.push((
                start_units,
                source_units + character.len_utf16() - start_units,
                start_byte,
                end_byte,
            ));
            start = None;
            next += 1;
        }
        lower_byte = lower_end;
        source_units += character.len_utf16();
        if next == ranges.len() {
            break;
        }
    }
    if next != ranges.len() {
        return Err(CoreError::InvalidInput(
            "search match could not be mapped to source text".into(),
        ));
    }
    Ok(spans)
}

fn reader_search_excerpt(
    text: &str,
    match_start_byte: usize,
    match_end_byte: usize,
    match_offset: usize,
) -> (usize, String) {
    let mut start_byte = match_start_byte;
    let mut before_units = 0;
    for (byte, character) in text[..match_start_byte].char_indices().rev() {
        if before_units + character.len_utf16() > 96 {
            break;
        }
        start_byte = byte;
        before_units += character.len_utf16();
    }
    let mut end_byte = match_end_byte;
    let mut after_units = 0;
    for character in text[match_end_byte..].chars() {
        if after_units + character.len_utf16() > 96 {
            break;
        }
        end_byte += character.len_utf8();
        after_units += character.len_utf16();
    }
    (
        match_offset - before_units,
        text[start_byte..end_byte].into(),
    )
}

fn project_items(session: &SessionSnapshot) -> Vec<ReaderItem> {
    let boundaries = session
        .relations
        .iter()
        .filter_map(|relation| {
            let RelationEntry::Coordination { observation } = relation else {
                return None;
            };
            (observation.kind == "spawn"
                || observation.kind == "result"
                || observation.state == "completed")
                .then_some(observation.reader_event.as_ref())
                .flatten()
                .cloned()
        })
        .collect();
    reader_model::project_process_items(session, &boundaries)
}

fn project_timeline(session: &SessionSnapshot) -> Vec<TimelineEvent> {
    session
        .events
        .iter()
        .map(|entry| {
            let tool = entry.item.event.segment == "tool";
            let tool_name = tool.then(|| {
                entry
                    .item
                    .tool_name
                    .clone()
                    .unwrap_or_else(|| "tool".into())
            });
            let status = tool.then(|| {
                entry
                    .tool_status
                    .clone()
                    .unwrap_or_else(|| "unknown".into())
            });
            let preview = if tool {
                bounded_preview(
                    &format!(
                        "{} ({})",
                        tool_name.as_deref().unwrap_or("tool"),
                        status.as_deref().unwrap_or("unknown")
                    ),
                    240,
                )
            } else {
                bounded_preview(&entry.body, 240)
            };
            TimelineEvent {
                event: entry.item.event.clone(),
                timestamp: entry.item.timestamp,
                role: entry.item.role.clone(),
                tool_name,
                status,
                preview,
                untrusted_content: true,
            }
        })
        .collect()
}

fn project_message_preview(entry: &NormalizedEvent) -> TimelineEvent {
    TimelineEvent {
        event: entry.item.event.clone(),
        timestamp: entry.item.timestamp,
        role: entry.item.role.clone(),
        tool_name: entry.item.tool_name.clone(),
        status: None,
        preview: bounded_preview(&entry.body, 240),
        untrusted_content: true,
    }
}

fn locate_content<'a>(
    session: &'a SessionSnapshot,
    event: &EventRef,
) -> Result<(&'a NormalizedEvent, &'a str)> {
    let entry = session
        .events
        .iter()
        .find(|entry| &entry.item.event == event)
        .ok_or_else(|| CoreError::EventNotFound(event.message_id.clone()))?;
    Ok((entry, &entry.body))
}

pub(crate) fn page_text(text: &str, offset: usize, max_chars: usize) -> Result<ContentPage> {
    if max_chars == 0 || max_chars > 100_000 {
        return Err(CoreError::InvalidInput(
            "maxChars must be between 1 and 100000".into(),
        ));
    }
    let total = text.encode_utf16().count();
    if offset > total {
        return Err(CoreError::InvalidInput(
            "offset exceeds content length".into(),
        ));
    }
    let mut start_byte = None;
    let mut end_byte = text.len();
    let mut units = 0usize;
    let mut next = total;
    for (byte, character) in text.char_indices() {
        if units == offset {
            start_byte = Some(byte);
        }
        if units < offset && units + character.len_utf16() > offset {
            return Err(CoreError::InvalidInput(
                "offset splits a UTF-16 character".into(),
            ));
        }
        if units >= offset && units + character.len_utf16() - offset > max_chars {
            if units == offset {
                return Err(CoreError::InvalidInput(
                    "maxChars is too small for the next UTF-16 character".into(),
                ));
            }
            end_byte = byte;
            next = units;
            break;
        }
        units += character.len_utf16();
    }
    let start_byte = start_byte.unwrap_or(text.len());
    let next_offset = (next < total).then_some(next);
    Ok(ContentPage {
        text: text[start_byte..end_byte].into(),
        offset,
        total_chars: total,
        next_offset,
        truncated: next_offset.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn config(root: &Path) -> SourceConfig {
        SourceConfig {
            codex_dir: root.to_path_buf(),
            opencode_db: root.join("opencode.db"),
            claude_dir: root.join("claude"),
            pi_dir: root.join("pi"),
            dsh_dir: root.join("dsh"),
            meta_dir: root.join("meta"),
            index_dir: root.join("index"),
            cache_dir: root.join("cache"),
        }
    }

    #[test]
    fn project_path_normalizes_absolute_drive_paths_without_aliasing_drive_relative_paths() {
        assert_eq!(normalize_project_path(r"D:"), "D:");
        assert_eq!(normalize_project_path(r"D:relative"), "D:relative");
        assert_eq!(normalize_project_path(r"D:\"), "d:/");
        assert_eq!(
            normalize_project_path(r"D:\Work\Project"),
            "d:/work/project"
        );
        assert_eq!(
            normalize_project_path("/mnt/d/Work/Project"),
            "d:/work/project"
        );
    }

    fn write_session(root: &Path, body: &str) {
        fs::create_dir_all(root.join("sessions")).unwrap();
        fs::write(root.join("sessions/rollout-test.jsonl"), format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"test-id\"}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"id\":\"assistant-1\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":{}}}]}}}}\n",
            serde_json::to_string(body).unwrap()
        )).unwrap();
    }

    fn runtime_locate_fixture(root: &Path, output: &str, extra_call: bool, partial: bool) {
        let mut rows = vec![
            serde_json::json!({"type":"session_meta","payload":{"id":"runtime-locate"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"same-call","name":"exec_command","arguments":"{}"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"same-call","output":output}}),
        ];
        if extra_call {
            rows.push(serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"new-call","name":"exec_command","arguments":"{}"}}));
        }
        let mut text = rows
            .iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>();
        if partial {
            text.push_str("{\"type\":");
        }
        fs::create_dir_all(root.join("sessions")).unwrap();
        fs::write(root.join("sessions/runtime-locate.jsonl"), text).unwrap();
    }

    fn runtime_locate_query(reader: &str, source: Option<&str>, id: &str) -> ReaderLocateQuery {
        ReaderLocateQuery {
            revision: reader.into(),
            source_revision: source.map(str::to_owned),
            message_id: Some(id.into()),
            segment: Some("tool".into()),
            edge: None,
        }
    }

    #[test]
    fn runtime_locate_rejects_same_call_id_rewritten_since_reader_capture() {
        let root = tempdir().unwrap();
        runtime_locate_fixture(root.path(), "old output", false, false);
        let core = Core::new(config(root.path())).unwrap();
        let first = core.reader_bootstrap("codex", "runtime-locate").unwrap();
        runtime_locate_fixture(root.path(), "new output", false, false);
        let current_source = core
            .protocol_event_stream("codex", "runtime-locate")
            .unwrap()
            .revision()
            .to_owned();
        // Ordinary Reader navigation remains a request for its published snapshot.
        core.reader_locate(
            "codex",
            "runtime-locate",
            runtime_locate_query(&first.revision, None, "same-call"),
        )
        .unwrap();
        assert!(matches!(
            core.reader_locate(
                "codex",
                "runtime-locate",
                runtime_locate_query(&first.revision, Some(&current_source), "same-call")
            ),
            Err(CoreError::SourceChanged)
        ));
        let reopened = core.reader_bootstrap("codex", "runtime-locate").unwrap();
        assert_ne!(reopened.revision, first.revision);
        let location = core
            .reader_locate(
                "codex",
                "runtime-locate",
                runtime_locate_query(&reopened.revision, Some(&current_source), "same-call"),
            )
            .unwrap();
        let item = &reopened.segments[0].items[location.ordinal];
        let content = core
            .reader_content(
                "codex",
                "runtime-locate",
                ContentQuery {
                    revision: reopened.revision,
                    content_revision: Some(item.content_revisions["toolOutput"].clone()),
                    message_id: "same-call".into(),
                    segment: "tool".into(),
                    field: "toolOutput".into(),
                    offset: 0,
                    max_chars: 100,
                },
            )
            .unwrap();
        assert_eq!(content.text, "new output");
    }

    #[test]
    fn runtime_locate_accepts_distinct_complete_prefix_and_strict_source_revisions() {
        let root = tempdir().unwrap();
        runtime_locate_fixture(root.path(), "recorded output", false, true);
        let core = Core::new(config(root.path())).unwrap();
        let reader = core.reader_bootstrap("codex", "runtime-locate").unwrap();
        let source = core
            .protocol_event_stream("codex", "runtime-locate")
            .unwrap()
            .revision()
            .to_owned();
        assert_ne!(reader.revision, source);
        let location = core
            .reader_locate(
                "codex",
                "runtime-locate",
                runtime_locate_query(&reader.revision, Some(&source), "same-call"),
            )
            .unwrap();
        assert_eq!(location.revision, reader.revision);
        assert_eq!(location.event.message_id, "same-call");
    }

    #[test]
    fn runtime_locate_requires_reopening_reader_for_a_new_runtime_event() {
        let root = tempdir().unwrap();
        runtime_locate_fixture(root.path(), "recorded output", false, false);
        let core = Core::new(config(root.path())).unwrap();
        let reader = core.reader_bootstrap("codex", "runtime-locate").unwrap();
        let old_source = core
            .protocol_event_stream("codex", "runtime-locate")
            .unwrap()
            .revision()
            .to_owned();
        runtime_locate_fixture(root.path(), "recorded output", true, false);
        let current = core
            .protocol_event_stream("codex", "runtime-locate")
            .unwrap()
            .revision()
            .to_owned();
        assert!(matches!(
            core.reader_locate(
                "codex",
                "runtime-locate",
                runtime_locate_query(&reader.revision, Some(&old_source), "same-call")
            ),
            Err(CoreError::SourceChanged)
        ));
        assert!(matches!(
            core.reader_locate(
                "codex",
                "runtime-locate",
                runtime_locate_query(&reader.revision, Some(&current), "new-call")
            ),
            Err(CoreError::SourceChanged)
        ));
        let reopened = core.reader_bootstrap("codex", "runtime-locate").unwrap();
        let location = core
            .reader_locate(
                "codex",
                "runtime-locate",
                runtime_locate_query(&reopened.revision, Some(&current), "new-call"),
            )
            .unwrap();
        assert_eq!(location.event.message_id, "new-call");
    }

    #[test]
    fn targeted_bootstrap_keeps_one_revision_bounded_pages_owner_and_viewer_title() {
        let root = tempdir().unwrap();
        let mut records = vec![
            serde_json::json!({"type":"session_meta","payload":{"id":"target-root"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","id":"owner","role":"assistant","content":[{"type":"output_text","text":"Opening reply."}]}}),
        ];
        records.extend((0..75).map(|n| serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":format!("tool-{n}"),"name":"read","arguments":"{}"}})));
        fs::create_dir_all(root.path().join("sessions")).unwrap();
        fs::write(
            root.path().join("sessions/target.jsonl"),
            records
                .iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let core = Core::new(config(root.path())).unwrap();
        let opening = core.reader_bootstrap("codex", "target-root").unwrap();
        core.viewer_mutate("codex", "target-root", "rename", Some("Viewer title"))
            .unwrap();
        let page = core
            .viewer_reader_bootstrap_at(
                "codex",
                "target-root",
                ReaderBootstrapQuery {
                    message_id: Some("tool-70".into()),
                    segment: Some("tool".into()),
                    revision: Some(opening.revision.clone()),
                },
            )
            .unwrap();
        assert_eq!(page.session.title, "Viewer title");
        assert_eq!(page.revision, opening.revision);
        let target = page.target_location.as_ref().unwrap();
        assert_eq!(target.revision, page.revision);
        assert_eq!(target.session, page.session.session);
        assert_eq!(target.owner.as_ref().unwrap().message_id, "owner");
        assert_eq!(
            page.segments
                .iter()
                .map(|segment| segment.start_ordinal)
                .collect::<Vec<_>>(),
            vec![0, 64]
        );
        assert!(
            page.segments
                .iter()
                .all(|segment| segment.items.len() <= 32)
        );
        assert_eq!(
            page.segments[1]
                .owner_context
                .as_ref()
                .unwrap()
                .event
                .message_id,
            "owner"
        );
        assert_eq!(page.toc.entries[0].ordinal, 64);
        assert_eq!(page.opening_toc.as_ref().unwrap().entries[0].ordinal, 0);
        let stored = core
            .reader_segments("codex", "target-root", &target.page_cursor)
            .unwrap();
        assert_eq!(stored.revision, page.revision);
        assert_eq!(
            serde_json::to_value(stored.page).unwrap(),
            serde_json::to_value(&page.segments[1]).unwrap()
        );
        assert!(opening.target_location.is_none() && opening.opening_toc.is_none());
    }

    #[test]
    fn targeted_bootstrap_generic_snapshot_and_errors_keep_canonical_revision() {
        let root = tempdir().unwrap();
        let sources = config(root.path());
        fs::create_dir_all(sources.pi_dir.join("sessions/project")).unwrap();
        let mut records = vec![
            serde_json::json!({"type":"session","version":3,"id":"target-pi","cwd":"/public/fixture"}),
        ];
        records.extend((0..75).map(|n| serde_json::json!({"type":"message","id":format!("reply-{n}"),"parentId":if n>0 {Some(format!("reply-{}",n-1))} else {None},"message":{"role":"assistant","content":[{"type":"text","text":format!("Reply {n}.")}]}})));
        let source = sources.pi_dir.join("sessions/project/pi.jsonl");
        fs::write(
            &source,
            records
                .iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let core = Core::new(sources).unwrap();
        let query = ReaderBootstrapQuery {
            message_id: Some("reply-70".into()),
            segment: Some("message".into()),
            revision: None,
        };
        let page = core
            .reader_bootstrap_at("pi", "target-pi", query.clone())
            .unwrap();
        assert_eq!(page.segments.len(), 2);
        assert_eq!(
            page.target_location.as_ref().unwrap().revision,
            page.revision
        );
        let opening = core
            .reader_bootstrap_at(
                "pi",
                "target-pi",
                ReaderBootstrapQuery {
                    message_id: Some("reply-0".into()),
                    ..query.clone()
                },
            )
            .unwrap();
        assert_eq!(opening.segments.len(), 1);
        assert!(opening.opening_toc.is_none());
        assert!(matches!(
            core.reader_bootstrap_at(
                "pi",
                "target-pi",
                ReaderBootstrapQuery {
                    message_id: None,
                    ..query.clone()
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            core.reader_bootstrap_at(
                "pi",
                "target-pi",
                ReaderBootstrapQuery {
                    message_id: Some("missing".into()),
                    ..query.clone()
                }
            ),
            Err(CoreError::EventNotFound(_))
        ));
        records.push(serde_json::json!({"type":"message","id":"fresh","parentId":"reply-74","message":{"role":"assistant","content":[{"type":"text","text":"Fresh."}]}}));
        fs::write(
            &source,
            records
                .iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        assert!(matches!(
            core.reader_bootstrap_at(
                "pi",
                "target-pi",
                ReaderBootstrapQuery {
                    revision: Some(page.revision),
                    ..query
                }
            ),
            Err(CoreError::SourceChanged)
        ));
    }

    #[test]
    fn child_insertion_stays_unavailable_without_exact_source_event() {
        let root = tempdir().unwrap();
        let mut sources = config(root.path());
        sources.dsh_dir =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/deepseek-harness");
        let core = Core::new(sources).unwrap();
        let session = core
            .load_session("deepseek-harness", "dsh-v3-s2-root")
            .unwrap();
        let mut entries = session.relations.clone();
        let entry = entries
            .iter_mut()
            .find(|entry| matches!(entry, RelationEntry::Coordination { observation }
                if observation.to_session_ref.as_ref().is_some_and(|child| child.session_id == "dsh-v3-s2-alpha")
                    && observation.state == "requested"))
            .unwrap();
        let RelationEntry::Coordination { observation } = entry else {
            unreachable!()
        };
        observation.event_id = "missing-source-event".into();
        let placement = core.reader_child_placements(&session, &[entry.clone()]);
        assert_eq!(placement.len(), 1);
        assert!(placement[0].after_event.is_none());
        assert_eq!(
            placement[0].diagnostic.as_deref(),
            Some("source_anchor_unavailable")
        );
    }

    #[test]
    fn explicit_child_reader_anchor_never_falls_back_to_an_earlier_event() {
        let root = tempdir().unwrap();
        let mut sources = config(root.path());
        sources.codex_dir =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/codex-three-level");
        let core = Core::new(sources).unwrap();
        let session = core
            .load_session("codex", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            .unwrap();
        let mut entry = session
            .relations
            .iter()
            .find(|entry| {
                matches!(entry, RelationEntry::Coordination { observation }
                if observation.kind == "spawn" && observation.state == "started"
                    && observation.to_session_ref.as_ref().is_some_and(|child|
                        child.session_id == "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))
            })
            .unwrap()
            .clone();
        let wrong_anchor = session
            .events
            .iter()
            .find(|event| event.item.role == "user")
            .unwrap()
            .item
            .event
            .clone();
        let RelationEntry::Coordination { observation } = &mut entry else {
            unreachable!()
        };
        observation.reader_event = Some(wrong_anchor);
        let placement = core.reader_child_placements(&session, &[entry]);
        assert_eq!(placement.len(), 1);
        assert!(placement[0].after_event.is_none());
        assert_eq!(
            placement[0].diagnostic.as_deref(),
            Some("source_anchor_unavailable")
        );
    }

    #[test]
    fn utf16_pages_preserve_emoji_and_exact_continuation() {
        let text = "Hello 🙂 from Rust";
        let first = page_text(text, 0, 8).unwrap();
        assert_eq!(first.text, "Hello 🙂");
        assert_eq!(first.next_offset, Some(8));
        let second = page_text(text, 8, 100).unwrap();
        assert_eq!(format!("{}{}", first.text, second.text), text);
        assert_eq!(
            page_text(text, 7, 8).unwrap_err().to_string(),
            "invalid input: offset splits a UTF-16 character"
        );
        assert!(page_text(text, 6, 1).is_err());
    }

    #[test]
    fn canonical_id_scope_and_revision_track_actual_source() {
        let left = tempdir().unwrap();
        let right = tempdir().unwrap();
        write_session(left.path(), "left source answer");
        write_session(right.path(), "right source answer");
        let left_core = Core::new(config(left.path())).unwrap();
        let right_core = Core::new(config(right.path())).unwrap();
        let first = left_core.reader_bootstrap("codex", "test-id").unwrap();
        let other = right_core.reader_bootstrap("codex", "test-id").unwrap();
        assert_eq!(first.session.session, other.session.session);
        assert_ne!(left_core.source_scope(), right_core.source_scope());
        assert_ne!(first.revision, other.revision);
        write_session(left.path(), "left revised answer");
        assert!(matches!(
            left_core.reader_content(
                "codex",
                "test-id",
                ContentQuery {
                    content_revision: None,
                    message_id: "assistant-1".into(),
                    segment: "message".into(),
                    field: "body".into(),
                    offset: 0,
                    max_chars: 100,
                    revision: first.revision,
                }
            ),
            Err(CoreError::SourceChanged)
        ));
    }

    #[test]
    fn plain_jsonl_takes_precedence_over_compressed_copy() {
        let root = tempdir().unwrap();
        write_session(root.path(), "plain answer");
        let path = root.path().join("sessions/rollout-test.jsonl");
        let compressed_source = fs::read_to_string(&path)
            .unwrap()
            .replace("plain answer", "compressed answer");
        fs::write(
            root.path().join("sessions/rollout-test.jsonl.zst"),
            zstd::stream::encode_all(compressed_source.as_bytes(), 0).unwrap(),
        )
        .unwrap();
        let core = Core::new(config(root.path())).unwrap();
        assert_eq!(core.sessions("codex").unwrap().len(), 1);
        let event = core
            .get_event(
                &EventRef {
                    provider: "codex".into(),
                    session_id: "test-id".into(),
                    message_id: "assistant-1".into(),
                    segment: "message".into(),
                },
                0,
                100,
            )
            .unwrap();
        assert_eq!(event.content.unwrap().text, "plain answer");
    }

    #[test]
    fn timeline_tool_preview_excludes_tool_payload() {
        let dsh = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/deepseek-harness");
        let mut source = config(&dsh);
        source.dsh_dir = dsh;
        let core = Core::new(source).unwrap();
        let events = core.timeline("deepseek-harness", "dsh-v3-s2-root").unwrap();
        let tools: Vec<_> = events
            .iter()
            .filter(|event| event.event.segment == "tool")
            .collect();
        assert!(!tools.is_empty());
        assert!(
            tools
                .iter()
                .all(|event| !event.preview.contains("SYNTHETIC-MARKER-OK"))
        );
        assert!(tools.iter().all(|event| event.status.is_some()));
    }

    #[test]
    fn fixture_tool_and_message_facts_reach_all_projections() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/codex");
        let core = Core::new(config(&root)).unwrap();
        let id = "44444444-4444-4444-8444-444444444444";
        let bootstrap = core.reader_bootstrap("codex", id).unwrap();
        assert_eq!(bootstrap.session.session.session_id, id);
        assert!(
            bootstrap.segments[0]
                .items
                .iter()
                .any(|item| item.event.message_id == "user-1")
        );
        assert!(
            bootstrap.segments[0]
                .items
                .iter()
                .any(|item| item.event.message_id == "tool-call-1")
        );
        let event = core
            .get_event(
                &EventRef {
                    provider: "codex".into(),
                    session_id: id.into(),
                    message_id: "assistant-1".into(),
                    segment: "message".into(),
                },
                0,
                8,
            )
            .unwrap();
        assert_eq!(event.content.as_ref().unwrap().text, "Hello 🙂");
        assert_eq!(event.content.unwrap().next_offset, Some(8));
        assert!(core.timeline("codex", id).unwrap().len() >= 3);
        let tool = EventRef {
            provider: "codex".into(),
            session_id: id.into(),
            message_id: "tool-call-1".into(),
            segment: "tool".into(),
        };
        let metadata = core.get_event(&tool, 0, 100).unwrap();
        assert!(
            metadata.content.is_none()
                && metadata.tool_input.is_none()
                && metadata.tool_output.is_none()
        );
        let detail = core
            .get_event_with_options(
                &tool,
                0,
                100,
                EventReadOptions {
                    include_tool_input: true,
                    include_tool_output: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            detail.tool_input.unwrap().text,
            "{\"path\":\"/synthetic/example.txt\"}"
        );
        assert_eq!(detail.tool_output.unwrap().text, "{\"ok\":true}");
    }

    #[test]
    fn dsh_relation_cursor_is_bounded_and_bound_to_kind_scope_session_revision() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/deepseek-harness");
        let left = tempdir().unwrap();
        let right = tempdir().unwrap();
        let mut left_config = config(left.path());
        left_config.dsh_dir = fixture.clone();
        let mut right_config = config(right.path());
        right_config.dsh_dir = fixture;
        let left_core = Core::new(left_config).unwrap();
        let right_core = Core::new(right_config).unwrap();
        let id = "dsh-v3-s2-root";
        let bootstrap = left_core.reader_bootstrap("deepseek-harness", id).unwrap();
        assert_eq!(bootstrap.relations.task_count, 4);
        assert_eq!(bootstrap.relations.observation_count, 12);
        let cursor = bootstrap.relations.first_cursor.unwrap();
        let page = left_core
            .reader_relations("deepseek-harness", id, &cursor)
            .unwrap();
        assert_eq!(page.entries.len(), 16);
        assert!(page.next_cursor.is_none());
        for row in serde_json::to_value(&page.entries)
            .unwrap()
            .as_array()
            .unwrap()
        {
            if row["type"] == "coordination" {
                assert!(row["observation"].get("fromActorPath").is_none());
                assert!(row["observation"].get("toActorPath").is_none());
                assert!(row["observation"].get("readerEvent").is_none());
            }
        }
        assert!(matches!(
            left_core.reader_segments("deepseek-harness", id, &cursor),
            Err(CoreError::InvalidCursor)
        ));
        assert!(matches!(
            left_core.reader_relations("deepseek-harness", "dsh-v3-s2-alpha", &cursor),
            Err(CoreError::InvalidCursor)
        ));
        assert!(matches!(
            right_core.reader_relations("deepseek-harness", id, &cursor),
            Err(CoreError::InvalidCursor)
        ));
        let mut stale: serde_json::Value = serde_json::from_str(&cursor).unwrap();
        stale["revision"] = "stale".into();
        assert!(matches!(
            left_core.reader_relations("deepseek-harness", id, &stale.to_string()),
            Err(CoreError::SourceChanged)
        ));
    }

    /// Read-only private corpus smoke. Inputs come from the local frozen
    /// manifest; output deliberately contains no transcript text or paths.
    #[test]
    #[ignore]
    fn frozen_codex_source_smoke() {
        let root = std::env::var("AGENTSESSION_V3_FROZEN_CODEX_ROOT").unwrap();
        let session_id = std::env::var("AGENTSESSION_V3_FROZEN_CODEX_SESSION_ID").unwrap();
        let core = Core::new(config(Path::new(&root))).unwrap();
        let list = core.sessions("codex").unwrap();
        let bootstrap = core.reader_bootstrap("codex", &session_id).unwrap();
        let timeline = core.timeline("codex", &session_id).unwrap();
        let selected = timeline
            .iter()
            .rev()
            .find(|entry| entry.role == "assistant" && entry.event.segment == "message")
            .unwrap();
        let mut hasher = Sha256::new();
        let mut selected_units = 0usize;
        let mut offset = 0;
        loop {
            let page = core
                .get_event(&selected.event, offset, 4_000)
                .unwrap()
                .content
                .unwrap();
            selected_units += page.text.encode_utf16().count();
            hasher.update(page.text.as_bytes());
            match page.next_offset {
                Some(next) => offset = next,
                None => break,
            }
        }
        println!(
            "sessions={} messages={} events={} selected_utf16_units={} selected_sha256={:x} revision={}",
            list.len(),
            bootstrap.session.message_count,
            timeline.len(),
            selected_units,
            hasher.finalize(),
            bootstrap.revision
        );
    }
}
