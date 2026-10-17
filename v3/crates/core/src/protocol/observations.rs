//! Validated native observations. This schema is deliberately distinct from
//! The validated Session Protocol v2 foundation and same-source v3 upgrade remain partial.
use super::{Diagnostic, EventStream, ProtocolError, ProtocolEvent, Provenance, SourceOrder};
use crate::{EventRef, SessionRef};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

#[cfg(test)]
#[path = "observations_tests.rs"]
mod tests;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub event_id: String,
    pub provenance: Provenance,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObservationState {
    Observed,
    NotObserved,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
pub struct DomainCoverage {
    pub state: ObservationState,
    pub details: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Unknown,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Pairing {
    Matched,
    Open,
    UniqueStart,
    AmbiguousStart,
    AmbiguousTerminal,
    Unidentifiable,
    OrphanTerminal,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskObservation {
    pub id: String,
    pub kind: String,
    pub status: RunStatus,
    pub time_created: Option<i64>,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunObservation {
    pub id: String,
    pub kind: String,
    pub task_id: Option<String>,
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_ref: Option<SessionRef>,
    pub status: RunStatus,
    pub pairing: Pairing,
    pub time_start: Option<i64>,
    pub time_end: Option<i64>,
    pub evidence: Evidence,
    pub terminal_evidence: Option<Evidence>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunObservation {
    pub id: String,
    pub kind: String,
    pub turn_id: Option<String>,
    pub run_id: Option<String>,
    pub pairing: Pairing,
    pub time_start: Option<i64>,
    pub time_end: Option<i64>,
    pub timestamp: Option<i64>,
    pub status: RunStatus,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipObservation {
    pub id: String,
    pub kind: String,
    pub from: SessionRef,
    pub to: SessionRef,
    pub correlation_id: Option<String>,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchObservation {
    pub id: String,
    pub fork_entry_id: Option<String>,
    pub fork_event_id: Option<String>,
    pub head_entry_id: String,
    pub head_event_id: String,
    pub selected: bool,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextObservation {
    pub id: String,
    pub kind: String,
    pub timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_compact_tokens: Option<u64>,
    pub window_id: Option<String>,
    pub previous_window_id: Option<String>,
    pub first_window_id: Option<String>,
    pub summary_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader_event: Option<EventRef>,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextVersion {
    pub id: String,
    pub session_id: String,
    pub sequence: usize,
    pub parent_version_ids: Vec<String>,
    pub artifact_ids: Vec<String>,
    pub created_at: Option<i64>,
    pub reader_event: Option<EventRef>,
    pub provenance: Provenance,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedFrom {
    pub source_id: String,
    pub event_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowedRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextTransformation {
    pub id: String,
    pub session_id: String,
    pub kind: &'static str,
    pub source_version_ids: Vec<String>,
    pub source_artifact_ids: Vec<String>,
    pub result_artifact_ids: Vec<String>,
    pub result_version_id: String,
    pub event_id: String,
    pub run_id: Option<String>,
    pub turn_id: Option<String>,
    pub timestamp: Option<i64>,
    pub retained_from: Option<RetainedFrom>,
    pub retained_tail_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadowed_range: Option<ShadowedRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadowed_seqs: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadowed_token_count: Option<u64>,
    pub provenance: Provenance,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProductionEvidence {
    pub provenance: Provenance,
    pub started_at: Option<i64>,
    pub completed_at: i64,
    pub input_updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextArtifact {
    pub id: String,
    pub session_id: String,
    pub kind: &'static str,
    pub scope: &'static str,
    pub origin: &'static str,
    pub content_access: &'static str,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub source_path: String,
    pub producer_run_id: Option<String>,
    pub lineage_id: String,
    pub source_session_ids: Vec<String>,
    pub hash: String,
    pub redacted: bool,
    pub provenance: Provenance,
    pub time_created: i64,
    pub content_source_time: i64,
    pub production_evidence: Option<MemoryProductionEvidence>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextArtifactSourceState {
    pub state: &'static str,
    pub code: Option<&'static str>,
    pub source_path: String,
    pub provenance: Provenance,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinationFact {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub correlation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_session_ref: Option<SessionRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_session_ref: Option<SessionRef>,
    pub from_actor_path: Option<String>,
    pub to_actor_path: Option<String>,
    pub reader_event: Option<EventRef>,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokenComponents {
    pub input: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
    pub output: Option<u64>,
    pub reasoning: Option<u64>,
    pub total: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: String,
    pub scope: &'static str,
    pub session_ref: SessionRef,
    pub timestamp: Option<i64>,
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    pub run_id: Option<String>,
    pub event_id: Option<String>,
    pub turn_id: Option<String>,
    pub tokens: UsageTokenComponents,
    pub context_origin_slices: Vec<()>,
    pub provenance: Provenance,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageObservation {
    pub id: String,
    pub session_ref: SessionRef,
    pub timestamp: Option<i64>,
    pub event_id: String,
    pub tokens: UsageTokenComponents,
    pub cumulative_tokens: Option<UsageTokenComponents>,
    /// Provider-proved additive consumption, without claiming request identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumption_tokens: Option<UsageTokenComponents>,
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    pub provenance: Provenance,
}

/// Builder input contains only normalized facts; provider vocabulary never
/// enters the shared validator. Each fact retains its exact raw-event anchor.
#[derive(Default, Debug)]
pub struct ObservationCandidates {
    pub list_duration_range: Option<(i64, i64)>,
    pub tasks: Vec<TaskObservation>,
    pub agent_runs: Vec<AgentRunObservation>,
    pub run_observations: Vec<RunObservation>,
    pub relationships: Vec<RelationshipObservation>,
    pub branches: Vec<BranchObservation>,
    pub context_observations: Vec<ContextObservation>,
    pub context_versions: Vec<ContextVersion>,
    pub context_transformations: Vec<ContextTransformation>,
    pub context_artifacts: Vec<ContextArtifact>,
    pub context_artifact_source_state: Option<ContextArtifactSourceState>,
    pub coordination: Vec<CoordinationFact>,
    pub usage_records: Vec<UsageRecord>,
    pub usage_observations: Vec<UsageObservation>,
    pub coverage: BTreeMap<String, DomainCoverage>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Serialize)]
struct ObservationValidation {
    status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationSnapshot {
    schema: &'static str,
    session: SessionRef,
    revision: String,
    completeness: &'static str,
    validation: ObservationValidation,
    source_record_count: usize,
    #[serde(skip)]
    list_duration_range: Option<(i64, i64)>,
    coverage: BTreeMap<String, DomainCoverage>,
    diagnostics: Vec<Diagnostic>,
    tasks: Vec<TaskObservation>,
    agent_runs: Vec<AgentRunObservation>,
    run_observations: Vec<RunObservation>,
    relationships: Vec<RelationshipObservation>,
    branches: Vec<BranchObservation>,
    context_observations: Vec<ContextObservation>,
    context_versions: Vec<ContextVersion>,
    context_transformations: Vec<ContextTransformation>,
    context_artifacts: Vec<ContextArtifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_artifact_source_state: Option<ContextArtifactSourceState>,
    coordination: Vec<CoordinationFact>,
    #[serde(skip_serializing)]
    usage_records: Vec<UsageRecord>,
    usage_observations: Vec<UsageObservation>,
}

impl ObservationSnapshot {
    pub fn usage_records(&self) -> &[UsageRecord] {
        &self.usage_records
    }

    pub fn usage_observations(&self) -> &[UsageObservation] {
        &self.usage_observations
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolFacts {
    session: SessionRef,
    revision: String,
    events: Vec<ProtocolEvent>,
    tasks: Vec<TaskObservation>,
    agent_runs: Vec<AgentRunObservation>,
    relationships: Vec<RelationshipObservation>,
    context_artifacts: Vec<ContextArtifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_artifact_source_state: Option<ContextArtifactSourceState>,
    branches: Vec<BranchObservation>,
}

#[derive(Debug, Serialize)]
struct ProtocolValidation {
    ok: bool,
    completeness: &'static str,
    errors: Vec<Diagnostic>,
    warnings: Vec<Diagnostic>,
}

#[derive(Debug, Serialize)]
pub struct SessionProtocolV2 {
    version: u8,
    #[serde(flatten)]
    facts: ProtocolFacts,
    completeness: &'static str,
    validation: ProtocolValidation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProtocolV3 {
    version: u8,
    #[serde(flatten)]
    facts: ProtocolFacts,
    completeness: &'static str,
    validation: ProtocolValidation,
    goals: Vec<()>,
    actors: Vec<()>,
    coordination: Vec<CoordinationFact>,
    context_versions: Vec<ContextVersion>,
    context_transformations: Vec<ContextTransformation>,
    usage_records: Vec<UsageRecord>,
    usage_observations: Vec<UsageObservation>,
    coverage: BTreeMap<String, DomainCoverage>,
    upgrade: ProtocolUpgrade,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolUpgrade {
    from_version: u8,
    strategy: &'static str,
    preserves_v2_facts: bool,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ProtocolDocument {
    V2(SessionProtocolV2),
    V3(SessionProtocolV3),
}

pub struct ProtocolBundle {
    stream: EventStream,
    observations: ObservationSnapshot,
}

#[derive(Clone, Debug)]
pub struct ProtocolListStats {
    pub revision: String,
    pub compactions: Option<usize>,
    pub last_compaction_at: Option<i64>,
    pub task_count: Option<usize>,
    pub agent_run_count: Option<usize>,
    pub subagent_run_count: Option<usize>,
    pub background_run_count: Option<usize>,
    pub active_statuses: Option<Vec<&'static str>>,
    pub context_artifact_count: Option<usize>,
    pub memory_count: Option<usize>,
    pub duration_ms: Option<i64>,
}

pub fn finalize_protocol_bundle(
    stream: EventStream,
    input: ObservationCandidates,
) -> Result<ProtocolBundle, ProtocolError> {
    let observations = finalize_observations(&stream, input)?;
    Ok(ProtocolBundle {
        stream,
        observations,
    })
}

impl ProtocolBundle {
    pub fn list_stats(&self) -> ProtocolListStats {
        let context_absent = self
            .observations
            .coverage
            .get("context")
            .is_some_and(|coverage| coverage.state == ObservationState::NotObserved);
        let work_coverage = self.work_coverage();
        let work_known = work_coverage.state != ObservationState::Unknown;
        let compactions: Vec<_> = self
            .stream
            .events
            .iter()
            .filter(|event| event.kind == "context.compaction")
            .collect();
        let mut first = None;
        let mut last = None;
        for time in self
            .stream
            .events
            .iter()
            .filter(|event| {
                matches!(
                    event.category.as_str(),
                    "message" | "tool" | "task" | "run" | "context" | "control" | "team"
                ) && !matches!(event.kind.as_str(), "message.system" | "message.developer")
            })
            .filter_map(|event| event.timestamp)
            .filter(|time| *time > 0)
        {
            first = Some(first.map_or(time, |previous: i64| previous.min(time)));
            last = Some(last.map_or(time, |previous: i64| previous.max(time)));
        }
        let runs = &self.observations.agent_runs;
        let delegated_runs: Vec<_> = runs
            .iter()
            .filter(|run| run.kind != "session-turn")
            .collect();
        let mode_unknown = delegated_runs
            .iter()
            .any(|run| run.kind != "subagent" && run.kind != "background");
        let artifacts = &self.observations.context_artifacts;
        let duration = self.observations.list_duration_range.or(first.zip(last));
        ProtocolListStats {
            revision: self.stream.revision().into(),
            compactions: (!compactions.is_empty() || context_absent).then_some(compactions.len()),
            last_compaction_at: compactions.iter().filter_map(|event| event.timestamp).max(),
            task_count: work_known.then_some(self.observations.tasks.len()),
            agent_run_count: work_known.then_some(delegated_runs.len()),
            subagent_run_count: (work_known && !mode_unknown).then_some(
                delegated_runs
                    .iter()
                    .filter(|run| run.kind == "subagent")
                    .count(),
            ),
            background_run_count: (work_known && !mode_unknown).then_some(
                delegated_runs
                    .iter()
                    .filter(|run| run.kind == "background")
                    .count(),
            ),
            active_statuses: work_known.then(Vec::new),
            context_artifact_count: (!artifacts.is_empty() || context_absent)
                .then_some(artifacts.len()),
            memory_count: (!artifacts.is_empty() || context_absent).then_some(
                artifacts
                    .iter()
                    .filter(|artifact| artifact.kind == "memory")
                    .count(),
            ),
            duration_ms: duration.and_then(|(first, last)| (last > first).then_some(last - first)),
        }
    }

    pub fn set_context_artifacts(
        &mut self,
        artifacts: Vec<ContextArtifact>,
        source_state: ContextArtifactSourceState,
    ) {
        self.observations.context_artifacts = artifacts;
        self.observations.context_artifact_source_state = Some(source_state);
    }
    pub fn into_observations(self) -> ObservationSnapshot {
        self.observations
    }

    fn work_coverage(&self) -> DomainCoverage {
        if let Some(coverage) = self.observations.coverage.get("work") {
            if coverage.state != ObservationState::Unknown {
                return coverage.clone();
            }
        }
        if !self.observations.tasks.is_empty()
            || !self.observations.agent_runs.is_empty()
            || !self.observations.run_observations.is_empty()
        {
            DomainCoverage {
                state: ObservationState::Observed,
                details: "Recorded work facts are partial; unprojected activity remains unknown."
                    .into(),
            }
        } else {
            self.observations
                .coverage
                .get("work")
                .cloned()
                .unwrap_or(DomainCoverage {
                    state: ObservationState::Unknown,
                    details: "Work coverage is not declared by this provider.".into(),
                })
        }
    }

    pub fn document(&self, version: u8) -> Result<ProtocolDocument, ProtocolError> {
        let facts = ProtocolFacts {
            session: self.stream.session.clone(),
            revision: self.stream.revision.clone(),
            events: self.stream.events.clone(),
            tasks: self.observations.tasks.clone(),
            agent_runs: self.observations.agent_runs.clone(),
            relationships: self.observations.relationships.clone(),
            context_artifacts: self.observations.context_artifacts.clone(),
            context_artifact_source_state: self.observations.context_artifact_source_state.clone(),
            branches: self.observations.branches.clone(),
        };
        let validation = || ProtocolValidation {
            ok: true,
            completeness: "partial",
            errors: vec![],
            warnings: self
                .observations
                .diagnostics
                .iter()
                .filter(|item| !item.code.starts_with("session_protocol_"))
                .cloned()
                .collect(),
        };
        match version {
            2 => Ok(ProtocolDocument::V2(SessionProtocolV2 {
                version,
                facts,
                completeness: "partial",
                validation: validation(),
            })),
            3 => {
                let mut coverage = self.observations.coverage.clone();
                for domain in ["sessionProtocolV2", "sessionProtocolV3"] {
                    coverage.insert(domain.into(), DomainCoverage {
                        state: ObservationState::Observed,
                        details: "Validated same-source foundation; unrecorded domains remain unknown.".into(),
                    });
                }
                coverage.insert("work".into(), self.work_coverage());
                Ok(ProtocolDocument::V3(SessionProtocolV3 {
                    version,
                    facts,
                    completeness: "partial",
                    validation: validation(),
                    goals: vec![],
                    actors: vec![],
                    coordination: self.observations.coordination.clone(),
                    context_versions: self.observations.context_versions.clone(),
                    context_transformations: self.observations.context_transformations.clone(),
                    usage_records: self.observations.usage_records.clone(),
                    usage_observations: self.observations.usage_observations.clone(),
                    coverage,
                    upgrade: ProtocolUpgrade {
                        from_version: 2,
                        strategy: "v2-to-v3",
                        preserves_v2_facts: true,
                    },
                }))
            }
            _ => Err(ProtocolError::InvalidQuery {
                diagnostic: "version must be 2 or 3".into(),
            }),
        }
    }

    pub fn work(&self, query: WorkQuery) -> Result<WorkPage, ProtocolError> {
        if !(1..=200).contains(&query.limit) {
            return Err(ProtocolError::InvalidQuery {
                diagnostic: "limit must be between 1 and 200".into(),
            });
        }
        let events: HashMap<_, _> = self
            .stream
            .events
            .iter()
            .map(|event| (event.id.as_str(), event))
            .collect();
        let mut entries = Vec::new();
        for task in &self.observations.tasks {
            entries.push(WorkEntry::from_task(task, &events));
        }
        for run in &self.observations.agent_runs {
            entries.push(WorkEntry::from_run(run, &events));
        }
        for observation in &self.observations.run_observations {
            entries.push(WorkEntry::from_lifecycle(observation, &events));
        }
        entries.sort_by_key(|entry| (entry.source_order, entry.type_order()));
        let identity = serde_json::to_vec(&(
            &self.stream.scope,
            &self.stream.session,
            &self.stream.revision,
            &query.kind,
            &query.status,
        ))
        .expect("work cursor tuple serialization");
        let fingerprint = format!("{:x}", Sha256::digest(identity));
        let start = match query.cursor {
            None => 0,
            Some(cursor) => {
                let (hash, offset) = cursor.split_once(':').ok_or(ProtocolError::InvalidCursor)?;
                let offset = offset
                    .parse::<usize>()
                    .map_err(|_| ProtocolError::InvalidCursor)?;
                if hash != fingerprint || offset == 0 || offset >= entries.len() {
                    return Err(ProtocolError::InvalidCursor);
                }
                offset
            }
        };
        let mut selected = Vec::with_capacity(query.limit);
        let mut end = start;
        for entry in entries.into_iter().skip(start).take(1024) {
            end += 1;
            if query.kind.as_ref().is_none_or(|value| value == &entry.kind)
                && query
                    .status
                    .as_ref()
                    .is_none_or(|value| value == entry.status.as_str())
            {
                selected.push(entry);
                if selected.len() == query.limit {
                    break;
                }
            }
        }
        let total = self.observations.tasks.len()
            + self.observations.agent_runs.len()
            + self.observations.run_observations.len();
        Ok(WorkPage {
            session: self.stream.session.clone(),
            revision: self.stream.revision.clone(),
            coverage: "partial",
            domain_coverage: self.work_coverage(),
            entries: selected,
            next_cursor: (end < total).then(|| format!("{fingerprint}:{end}")),
            scanned_entries: end - start,
        })
    }

    pub fn summary(&self) -> RuntimeSummary {
        let mut categories = BTreeMap::new();
        for event in &self.stream.events {
            *categories.entry(event.category.clone()).or_insert(0) += 1;
        }
        let mut coverage = self.observations.coverage.clone();
        coverage.insert("work".into(), self.work_coverage());
        for domain in ["execution", "coordination", "context", "usage", "ownership"] {
            coverage
                .entry(domain.into())
                .or_insert_with(|| DomainCoverage {
                    state: ObservationState::Unknown,
                    details: format!("{domain} coverage is not declared by this provider."),
                });
        }
        RuntimeSummary {
            session: self.stream.session.clone(),
            revision: self.stream.revision.clone(),
            completeness: "partial",
            validation: ProtocolValidation {
                ok: true,
                completeness: "partial",
                errors: vec![],
                warnings: self
                    .observations
                    .diagnostics
                    .iter()
                    .filter(|item| !item.code.starts_with("session_protocol_"))
                    .cloned()
                    .collect(),
            },
            counts: RuntimeCounts {
                events: self.stream.events.len(),
                relationships: self.observations.relationships.len(),
                tasks: self.observations.tasks.len(),
                agent_runs: self.observations.agent_runs.len(),
                branches: self.observations.branches.len(),
                context_artifacts: self.observations.context_artifacts.len(),
                coordination: self.observations.coordination.len(),
                usage_records: self.observations.usage_records.len(),
                usage_observations: self.observations.usage_observations.len(),
            },
            categories,
            coverage,
        }
    }

    pub fn graph(&self, query: GraphQuery) -> Result<RuntimeGraph, ProtocolError> {
        if !(1..=200).contains(&query.max_nodes) {
            return Err(ProtocolError::InvalidQuery {
                diagnostic: "maxNodes must be between 1 and 200".into(),
            });
        }
        let session = &self.stream.session;
        let root_id = graph_id("session", &session.provider, &session.session_id);
        let mut nodes = Vec::with_capacity(query.max_nodes);
        let mut edges = Vec::new();
        let mut known = HashSet::new();
        let mut truncated = false;
        let mut relationship_visits = 0;
        add_graph_node(
            &mut nodes,
            &mut known,
            query.max_nodes,
            GraphNode {
                id: root_id.clone(),
                kind: "session",
                label: session.session_id.clone(),
                status: None,
                time_start: None,
                time_end: None,
                session: session.clone(),
                resolution: "resolved",
                provenance: None,
                focus: true,
            },
        );
        for branch in &self.observations.branches {
            let branch_id = graph_id("branch", &session.session_id, &branch.id);
            if !add_graph_node(
                &mut nodes,
                &mut known,
                query.max_nodes,
                GraphNode {
                    id: branch_id.clone(),
                    kind: "branch",
                    label: branch.head_entry_id.clone(),
                    status: Some(if branch.selected {
                        "active"
                    } else {
                        "abandoned"
                    }),
                    time_start: None,
                    time_end: None,
                    session: session.clone(),
                    resolution: "resolved",
                    provenance: Some(branch.evidence.provenance.clone()),
                    focus: false,
                },
            ) {
                truncated = true;
                break;
            }
            edges.push(GraphEdge {
                id: graph_id("session-branch", &session.session_id, &branch.id),
                kind: "contains-branch".into(),
                from: root_id.clone(),
                to: branch_id,
                provenance: branch.evidence.provenance.clone(),
                inferred: branch.evidence.provenance.fidelity != super::Fidelity::Recorded,
            });
        }
        if !truncated {
            for task in &self.observations.tasks {
                if !add_graph_node(
                    &mut nodes,
                    &mut known,
                    query.max_nodes,
                    GraphNode {
                        id: graph_id("task", &session.session_id, &task.id),
                        kind: "task",
                        label: task.id.clone(),
                        status: Some(task.status.as_str()),
                        time_start: task.time_created,
                        time_end: None,
                        session: session.clone(),
                        resolution: "resolved",
                        provenance: Some(task.evidence.provenance.clone()),
                        focus: false,
                    },
                ) {
                    truncated = true;
                    break;
                }
            }
        }
        if !truncated {
            for run in &self.observations.agent_runs {
                let run_id = graph_id("run", &session.session_id, &run.id);
                if !add_graph_node(
                    &mut nodes,
                    &mut known,
                    query.max_nodes,
                    GraphNode {
                        id: run_id.clone(),
                        kind: "run",
                        label: run.id.clone(),
                        status: Some(run.status.as_str()),
                        session: session.clone(),
                        time_start: run.time_start,
                        time_end: run.time_end,
                        resolution: "resolved",
                        provenance: Some(run.evidence.provenance.clone()),
                        focus: false,
                    },
                ) {
                    truncated = true;
                    break;
                }
                if let Some(task_id) = &run.task_id {
                    let task_node = graph_id("task", &session.session_id, task_id);
                    if known.contains(&task_node) {
                        edges.push(GraphEdge {
                            id: graph_id("task-run", task_id, &run.id),
                            kind: "executed-by".into(),
                            from: task_node,
                            to: run_id,
                            provenance: run.evidence.provenance.clone(),
                            inferred: run.evidence.provenance.fidelity != super::Fidelity::Recorded,
                        });
                    }
                }
            }
        }
        if !truncated {
            for relationship in &self.observations.relationships {
                relationship_visits += 1;
                if relationship_visits > query.max_nodes * 8 || edges.len() >= query.max_nodes * 4 {
                    truncated = true;
                    break;
                }
                let from_id = graph_id(
                    "session",
                    &relationship.from.provider,
                    &relationship.from.session_id,
                );
                let to_id = graph_id(
                    "session",
                    &relationship.to.provider,
                    &relationship.to.session_id,
                );
                for (id, reference) in [
                    (from_id.clone(), &relationship.from),
                    (to_id.clone(), &relationship.to),
                ] {
                    if !add_graph_node(
                        &mut nodes,
                        &mut known,
                        query.max_nodes,
                        GraphNode {
                            id,
                            kind: "session",
                            label: reference.session_id.clone(),
                            status: None,
                            time_start: None,
                            time_end: None,
                            session: reference.clone(),
                            resolution: "unverified",
                            provenance: Some(relationship.evidence.provenance.clone()),
                            focus: false,
                        },
                    ) {
                        truncated = true;
                        break;
                    }
                }
                if truncated {
                    break;
                }
                edges.push(GraphEdge {
                    id: graph_id("relationship", &session.session_id, &relationship.id),
                    kind: relationship.kind.clone(),
                    from: from_id,
                    to: to_id,
                    provenance: relationship.evidence.provenance.clone(),
                    inferred: relationship.evidence.provenance.fidelity
                        != super::Fidelity::Recorded,
                });
            }
        }
        if !truncated {
            for artifact in &self.observations.context_artifacts {
                if !add_graph_node(
                    &mut nodes,
                    &mut known,
                    query.max_nodes,
                    GraphNode {
                        id: graph_id("artifact", &session.session_id, &artifact.id),
                        kind: "artifact",
                        label: artifact
                            .title
                            .clone()
                            .unwrap_or_else(|| artifact.kind.into()),
                        status: Some(artifact.content_access),
                        session: session.clone(),
                        time_start: Some(artifact.time_created),
                        time_end: None,
                        resolution: "resolved",
                        provenance: Some(artifact.provenance.clone()),
                        focus: false,
                    },
                ) {
                    truncated = true;
                    break;
                }
            }
        }
        Ok(RuntimeGraph {
            focus: session.clone(),
            revision: self.stream.revision.clone(),
            coverage: "partial",
            domain_coverage: ["work", "coordination", "context", "branches"]
                .into_iter()
                .map(|domain| {
                    (
                        domain.to_owned(),
                        if domain == "work" {
                            self.work_coverage()
                        } else {
                            self.observations.coverage.get(domain).cloned().unwrap_or(
                                DomainCoverage {
                                    state: ObservationState::Unknown,
                                    details: format!(
                                        "{domain} coverage is not declared by this provider."
                                    ),
                                },
                            )
                        },
                    )
                })
                .collect(),
            nodes,
            edges,
            truncated,
            max_nodes: query.max_nodes,
        })
    }

    pub fn domain_page(
        &self,
        domain: RuntimeDomain,
        query: DomainQuery,
    ) -> Result<DomainPage, ProtocolError> {
        if !(1..=200).contains(&query.limit) {
            return Err(ProtocolError::InvalidQuery {
                diagnostic: "limit must be between 1 and 200".into(),
            });
        }
        let orders: HashMap<_, _> = self
            .stream
            .events
            .iter()
            .map(|event| (event.id.as_str(), event.source_order))
            .collect();
        let mut entries = Vec::new();
        match domain {
            RuntimeDomain::Execution => {
                for run in &self.observations.agent_runs {
                    entries.push(DomainEntry {
                        entry_type: "agentRun",
                        kind: &run.kind,
                        source_order: orders.get(run.evidence.event_id.as_str()).copied(),
                        fact: DomainFact::AgentRun(run),
                    });
                }
                for event in &self.stream.events {
                    if event.execution.is_some() {
                        entries.push(DomainEntry {
                            entry_type: "executionEvent",
                            kind: &event.kind,
                            source_order: Some(event.source_order),
                            fact: DomainFact::Event(event),
                        });
                    }
                }
                for usage in &self.observations.usage_records {
                    entries.push(DomainEntry {
                        entry_type: "usageRecord",
                        kind: "request-usage",
                        source_order: usage
                            .event_id
                            .as_deref()
                            .and_then(|id| orders.get(id).copied()),
                        fact: DomainFact::Usage(usage),
                    });
                }
                for observation in &self.observations.usage_observations {
                    entries.push(DomainEntry {
                        entry_type: "usageObservation",
                        kind: "unresolved-usage",
                        source_order: orders.get(observation.event_id.as_str()).copied(),
                        fact: DomainFact::UsageObservation(observation),
                    });
                }
            }
            RuntimeDomain::Coordination => {
                for fact in &self.observations.coordination {
                    entries.push(DomainEntry {
                        entry_type: "coordination",
                        kind: &fact.kind,
                        source_order: orders.get(fact.evidence.event_id.as_str()).copied(),
                        fact: DomainFact::Coordination(fact),
                    });
                }
                for relation in &self.observations.relationships {
                    entries.push(DomainEntry {
                        entry_type: "relationship",
                        kind: &relation.kind,
                        source_order: orders.get(relation.evidence.event_id.as_str()).copied(),
                        fact: DomainFact::Relationship(relation),
                    });
                }
            }
            RuntimeDomain::Context => {
                let versions: HashMap<_, _> = self
                    .observations
                    .context_versions
                    .iter()
                    .map(|version| (version.id.as_str(), version))
                    .collect();
                for transformation in &self.observations.context_transformations {
                    let version = versions
                        .get(transformation.result_version_id.as_str())
                        .copied()
                        .expect("validated context result version");
                    entries.push(DomainEntry {
                        entry_type: "contextResult",
                        kind: transformation.kind,
                        source_order: orders.get(transformation.event_id.as_str()).copied(),
                        fact: DomainFact::ContextResult(ContextResult {
                            transformation,
                            version,
                        }),
                    });
                }
                for observation in &self.observations.context_observations {
                    entries.push(DomainEntry {
                        entry_type: "contextObservation",
                        kind: &observation.kind,
                        source_order: orders.get(observation.evidence.event_id.as_str()).copied(),
                        fact: DomainFact::ContextObservation(observation),
                    });
                }
                for artifact in &self.observations.context_artifacts {
                    entries.push(DomainEntry {
                        entry_type: "contextArtifact",
                        kind: artifact.kind,
                        source_order: None,
                        fact: DomainFact::ContextArtifact(artifact),
                    });
                }
            }
        }
        entries.sort_by_key(|entry| entry.source_order);
        let identity = if matches!(domain, RuntimeDomain::Context | RuntimeDomain::Execution) {
            serde_json::to_vec(&(
                &self.stream.scope,
                &self.stream.session,
                &self.stream.revision,
                domain.as_str(),
                &query.kind,
                if matches!(domain, RuntimeDomain::Context) {
                    "context-result-v1"
                } else {
                    "usage-observations-v1"
                },
            ))
        } else {
            serde_json::to_vec(&(
                &self.stream.scope,
                &self.stream.session,
                &self.stream.revision,
                domain.as_str(),
                &query.kind,
            ))
        }
        .expect("domain cursor tuple serialization");
        let fingerprint = format!("{:x}", Sha256::digest(identity));
        let start = match query.cursor {
            None => 0,
            Some(cursor) => {
                let (hash, offset) = cursor.split_once(':').ok_or(ProtocolError::InvalidCursor)?;
                let offset = offset
                    .parse::<usize>()
                    .map_err(|_| ProtocolError::InvalidCursor)?;
                if hash != fingerprint || offset == 0 || offset >= entries.len() {
                    return Err(ProtocolError::InvalidCursor);
                }
                offset
            }
        };
        let total = entries.len();
        let mut selected = Vec::with_capacity(query.limit);
        let mut end = start;
        for entry in entries.into_iter().skip(start).take(1024) {
            end += 1;
            if query.kind.as_ref().is_none_or(|kind| kind == entry.kind) {
                selected.push(entry);
                if selected.len() == query.limit {
                    break;
                }
            }
        }
        let domain_coverage = self
            .observations
            .coverage
            .get(domain.as_str())
            .cloned()
            .unwrap_or(DomainCoverage {
                state: ObservationState::Unknown,
                details: format!(
                    "{} coverage is not declared by this provider.",
                    domain.as_str()
                ),
            });
        Ok(DomainPage {
            session: self.stream.session.clone(),
            revision: self.stream.revision.clone(),
            coverage: "partial",
            domain_coverage,
            entries: selected
                .into_iter()
                .map(|entry| OwnedDomainEntry {
                    entry_type: entry.entry_type,
                    kind: entry.kind.to_owned(),
                    source_order: entry.source_order,
                    fact: serde_json::to_value(entry.fact)
                        .expect("validated domain fact serialization"),
                })
                .collect(),
            next_cursor: (end < total).then(|| format!("{fingerprint}:{end}")),
            scanned_entries: end - start,
        })
    }
}

#[derive(Clone, Copy)]
pub enum RuntimeDomain {
    Execution,
    Coordination,
    Context,
}

impl RuntimeDomain {
    fn as_str(self) -> &'static str {
        match self {
            Self::Execution => "execution",
            Self::Coordination => "coordination",
            Self::Context => "context",
        }
    }
}

pub struct DomainQuery {
    pub kind: Option<String>,
    pub limit: usize,
    pub cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainPage {
    session: SessionRef,
    revision: String,
    coverage: &'static str,
    domain_coverage: DomainCoverage,
    entries: Vec<OwnedDomainEntry>,
    next_cursor: Option<String>,
    scanned_entries: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OwnedDomainEntry {
    #[serde(rename = "type")]
    entry_type: &'static str,
    kind: String,
    source_order: Option<SourceOrder>,
    fact: serde_json::Value,
}

struct DomainEntry<'a> {
    entry_type: &'static str,
    kind: &'a str,
    source_order: Option<SourceOrder>,
    fact: DomainFact<'a>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum DomainFact<'a> {
    AgentRun(&'a AgentRunObservation),
    Event(&'a ProtocolEvent),
    Usage(&'a UsageRecord),
    UsageObservation(&'a UsageObservation),
    Coordination(&'a CoordinationFact),
    Relationship(&'a RelationshipObservation),
    ContextObservation(&'a ContextObservation),
    ContextArtifact(&'a ContextArtifact),
    ContextResult(ContextResult<'a>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextResult<'a> {
    transformation: &'a ContextTransformation,
    version: &'a ContextVersion,
}

fn graph_id(kind: &str, scope: &str, id: &str) -> String {
    serde_json::to_string(&(kind, scope, id)).expect("graph ID tuple serialization")
}

fn add_graph_node(
    nodes: &mut Vec<GraphNode>,
    known: &mut HashSet<String>,
    max_nodes: usize,
    node: GraphNode,
) -> bool {
    if known.contains(&node.id) {
        return true;
    }
    if nodes.len() == max_nodes {
        return false;
    }
    known.insert(node.id.clone());
    nodes.push(node);
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSummary {
    session: SessionRef,
    revision: String,
    completeness: &'static str,
    validation: ProtocolValidation,
    counts: RuntimeCounts,
    categories: BTreeMap<String, usize>,
    coverage: BTreeMap<String, DomainCoverage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCounts {
    events: usize,
    relationships: usize,
    tasks: usize,
    agent_runs: usize,
    branches: usize,
    context_artifacts: usize,
    coordination: usize,
    usage_records: usize,
    usage_observations: usize,
}

pub struct GraphQuery {
    pub max_nodes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeGraph {
    focus: SessionRef,
    revision: String,
    coverage: &'static str,
    domain_coverage: BTreeMap<String, DomainCoverage>,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    truncated: bool,
    max_nodes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphNode {
    id: String,
    kind: &'static str,
    label: String,
    status: Option<&'static str>,
    time_start: Option<i64>,
    time_end: Option<i64>,
    session: SessionRef,
    resolution: &'static str,
    provenance: Option<Provenance>,
    focus: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphEdge {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    from: String,
    to: String,
    provenance: Provenance,
    inferred: bool,
}

#[derive(Default)]
pub struct WorkQuery {
    pub kind: Option<String>,
    pub status: Option<String>,
    pub limit: usize,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPage {
    session: SessionRef,
    revision: String,
    coverage: &'static str,
    domain_coverage: DomainCoverage,
    entries: Vec<WorkEntry>,
    next_cursor: Option<String>,
    scanned_entries: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkEntry {
    #[serde(rename = "type")]
    entry_type: &'static str,
    id: String,
    kind: String,
    turn_id: Option<String>,
    status: RunStatus,
    pairing: Option<Pairing>,
    time_start: Option<i64>,
    time_end: Option<i64>,
    timestamp: Option<i64>,
    source_order: SourceOrder,
    evidence: Evidence,
    terminal_evidence: Option<Evidence>,
    reader_event: Option<EventRef>,
    terminal_reader_event: Option<EventRef>,
}

impl RunStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

impl WorkEntry {
    fn from_task(task: &TaskObservation, events: &HashMap<&str, &ProtocolEvent>) -> Self {
        let event = events[task.evidence.event_id.as_str()];
        Self {
            entry_type: "task",
            id: task.id.clone(),
            kind: task.kind.clone(),
            turn_id: None,
            status: task.status,
            pairing: None,
            time_start: task.time_created,
            time_end: None,
            timestamp: event.timestamp,
            source_order: event.source_order,
            evidence: task.evidence.clone(),
            terminal_evidence: None,
            reader_event: event.reader_event.clone(),
            terminal_reader_event: None,
        }
    }
    fn from_run(run: &AgentRunObservation, events: &HashMap<&str, &ProtocolEvent>) -> Self {
        let event = events[run.evidence.event_id.as_str()];
        Self {
            entry_type: "agentRun",
            id: run.id.clone(),
            kind: run.kind.clone(),
            turn_id: run.turn_id.clone(),
            status: run.status,
            pairing: Some(run.pairing),
            time_start: run.time_start,
            time_end: run.time_end,
            timestamp: event.timestamp,
            source_order: event.source_order,
            evidence: run.evidence.clone(),
            terminal_evidence: run.terminal_evidence.clone(),
            reader_event: event.reader_event.clone(),
            terminal_reader_event: run
                .terminal_evidence
                .as_ref()
                .and_then(|value| events[value.event_id.as_str()].reader_event.clone()),
        }
    }
    fn from_lifecycle(
        observation: &RunObservation,
        events: &HashMap<&str, &ProtocolEvent>,
    ) -> Self {
        let event = events[observation.evidence.event_id.as_str()];
        Self {
            entry_type: "lifecycle",
            id: observation.id.clone(),
            kind: observation.kind.clone(),
            turn_id: observation.turn_id.clone(),
            status: observation.status,
            pairing: Some(observation.pairing),
            time_start: observation.time_start,
            time_end: observation.time_end,
            timestamp: observation.timestamp,
            source_order: event.source_order,
            evidence: observation.evidence.clone(),
            terminal_evidence: None,
            reader_event: event.reader_event.clone(),
            terminal_reader_event: None,
        }
    }
    fn type_order(&self) -> u8 {
        match self.entry_type {
            "task" => 0,
            "agentRun" => 1,
            _ => 2,
        }
    }
}

/// Validate all anchors and cross-domain references against the same finalized
/// raw stream. Success validates the recorded foundation, not full protocol parity.
pub fn finalize_observations(
    stream: &EventStream,
    input: ObservationCandidates,
) -> Result<ObservationSnapshot, ProtocolError> {
    let events: BTreeMap<_, _> = stream
        .events
        .iter()
        .map(|event| (event.id.as_str(), event))
        .collect();
    let task_ids: HashSet<_> = input.tasks.iter().map(|task| task.id.as_str()).collect();
    let run_ids: HashSet<_> = input.agent_runs.iter().map(|run| run.id.as_str()).collect();
    let mut errors = Vec::new();
    let mut seen = HashSet::new();
    let mut check = |domain: &'static str, id: &str, evidence: &Evidence| {
        let mut issue = |code: &str| {
            errors.push(Diagnostic {
                code: code.into(),
                event_id: Some(evidence.event_id.clone()),
            })
        };
        if id.is_empty() || !seen.insert((domain, id.to_owned())) {
            issue("duplicate_or_missing_observation_id");
        }
        match events.get(evidence.event_id.as_str()) {
            None => issue("unknown_evidence_event"),
            Some(event) if event.provenance.source_id != evidence.provenance.source_id => {
                issue("evidence_source_mismatch")
            }
            _ => {}
        }
        if evidence.provenance.source_type.is_empty()
            || evidence
                .provenance
                .source_id
                .as_deref()
                .is_none_or(str::is_empty)
        {
            issue("missing_observation_provenance");
        }
    };
    for task in &input.tasks {
        check("task", &task.id, &task.evidence);
    }
    for run in &input.agent_runs {
        check("run", &run.id, &run.evidence);
        if let Some(terminal) = &run.terminal_evidence {
            check("terminal", &run.id, terminal);
        }
    }
    for observation in &input.run_observations {
        check("run-observation", &observation.id, &observation.evidence);
    }
    for relationship in &input.relationships {
        check("relationship", &relationship.id, &relationship.evidence);
    }
    for branch in &input.branches {
        check("branch", &branch.id, &branch.evidence);
    }
    let mut anchor_errors = Vec::new();
    for context in &input.context_observations {
        check("context", &context.id, &context.evidence);
        if let Some(reference) = &context.reader_event {
            if events
                .get(context.evidence.event_id.as_str())
                .is_none_or(|event| event.reader_event.as_ref() != Some(reference))
            {
                anchor_errors.push(Diagnostic {
                    code: "context_reader_anchor_mismatch".into(),
                    event_id: Some(context.evidence.event_id.clone()),
                });
            }
        }
    }
    for coordination in &input.coordination {
        check("coordination", &coordination.id, &coordination.evidence);
        if let Some(reference) = &coordination.reader_event {
            if events
                .get(coordination.evidence.event_id.as_str())
                .is_none_or(|event| event.reader_event.as_ref() != Some(reference))
            {
                anchor_errors.push(Diagnostic {
                    code: "coordination_reader_anchor_mismatch".into(),
                    event_id: Some(coordination.evidence.event_id.clone()),
                });
            }
        }
    }
    drop(check);
    errors.extend(anchor_errors);
    let mut version_ids = HashSet::new();
    for version in &input.context_versions {
        if version.id.is_empty() || !version_ids.insert(version.id.as_str()) {
            errors.push(Diagnostic {
                code: "duplicate_or_missing_context_version_id".into(),
                event_id: None,
            });
        }
        let anchor = version
            .sequence
            .checked_sub(1)
            .and_then(|index| stream.events.get(index));
        if version.session_id != stream.session.session_id
            || version.sequence == 0
            || version.reader_event.is_none()
            || version.provenance.fidelity != super::Fidelity::Recorded
            || version.provenance.source_type.is_empty()
            || version
                .provenance
                .source_id
                .as_deref()
                .is_none_or(str::is_empty)
            || anchor.is_none_or(|event| {
                event.provenance.source_id != version.provenance.source_id
                    || event.reader_event != version.reader_event
            })
        {
            errors.push(Diagnostic {
                code: "invalid_context_version_anchor".into(),
                event_id: anchor.map(|event| event.id.clone()),
            });
        }
        if !version.parent_version_ids.is_empty() || !version.artifact_ids.is_empty() {
            errors.push(Diagnostic {
                code: "unsupported_context_version_references".into(),
                event_id: anchor.map(|event| event.id.clone()),
            });
        }
    }
    let versions: HashMap<_, _> = input
        .context_versions
        .iter()
        .map(|version| (version.id.as_str(), version))
        .collect();
    let mut transformation_ids = HashSet::new();
    let mut result_ids = HashSet::new();
    for transformation in &input.context_transformations {
        if transformation.id.is_empty() || !transformation_ids.insert(transformation.id.as_str()) {
            errors.push(Diagnostic {
                code: "duplicate_or_missing_context_transformation_id".into(),
                event_id: Some(transformation.event_id.clone()),
            });
        }
        if transformation.session_id != stream.session.session_id
            || transformation.kind != "compaction"
            || transformation.provenance.fidelity != super::Fidelity::Recorded
            || transformation.provenance.source_type.is_empty()
            || transformation
                .provenance
                .source_id
                .as_deref()
                .is_none_or(str::is_empty)
            || events
                .get(transformation.event_id.as_str())
                .is_none_or(|event| {
                    event.provenance.source_id != transformation.provenance.source_id
                })
        {
            errors.push(Diagnostic {
                code: "invalid_context_transformation_anchor".into(),
                event_id: Some(transformation.event_id.clone()),
            });
        }
        let result_version = versions
            .get(transformation.result_version_id.as_str())
            .copied();
        if result_version.is_none() {
            errors.push(Diagnostic {
                code: "unknown_context_result_version".into(),
                event_id: Some(transformation.event_id.clone()),
            });
        } else if result_version.is_some_and(|version| {
            events
                .get(transformation.event_id.as_str())
                .is_none_or(|event| {
                    version.sequence != event.sequence
                        || version.provenance.source_id != transformation.provenance.source_id
                        || version.reader_event != event.reader_event
                })
        }) || !result_ids.insert(transformation.result_version_id.as_str())
        {
            errors.push(Diagnostic {
                code: "context_result_anchor_mismatch".into(),
                event_id: Some(transformation.event_id.clone()),
            });
        }
        if !transformation.source_version_ids.is_empty()
            || !transformation.source_artifact_ids.is_empty()
            || !transformation.result_artifact_ids.is_empty()
            || transformation.run_id.is_some()
            || transformation.turn_id.is_some()
        {
            errors.push(Diagnostic {
                code: "unsupported_context_transformation_references".into(),
                event_id: Some(transformation.event_id.clone()),
            });
        }
        if let Some(retained) = &transformation.retained_from {
            if retained.source_id.is_empty()
                || retained.event_id.as_deref().is_some_and(|id| {
                    events.get(id).is_none_or(|event| {
                        event.provenance.source_id.as_deref() != Some(retained.source_id.as_str())
                    })
                })
            {
                errors.push(Diagnostic {
                    code: "invalid_retained_context_anchor".into(),
                    event_id: Some(transformation.event_id.clone()),
                });
            }
        }
        if transformation
            .shadowed_range
            .as_ref()
            .is_some_and(|range| range.start > range.end)
        {
            errors.push(Diagnostic {
                code: "invalid_shadowed_context_range".into(),
                event_id: Some(transformation.event_id.clone()),
            });
        }
    }
    let mut usage_ids = HashSet::new();
    for usage in &input.usage_records {
        let linked = usage
            .event_id
            .as_deref()
            .and_then(|event_id| events.get(event_id));
        if usage.id.is_empty() || !usage_ids.insert(usage.id.as_str()) {
            errors.push(Diagnostic {
                code: "duplicate_or_missing_usage_id".into(),
                event_id: usage.event_id.clone(),
            });
        }
        if usage.scope != "request"
            || usage.session_ref != stream.session
            || usage.provenance.source_type.is_empty()
            || usage
                .provenance
                .source_id
                .as_deref()
                .is_none_or(str::is_empty)
        {
            errors.push(Diagnostic {
                code: "invalid_usage_identity".into(),
                event_id: usage.event_id.clone(),
            });
        }
        if usage.event_id.is_some()
            && linked.is_none_or(|event| event.provenance.source_id != usage.provenance.source_id)
        {
            errors.push(Diagnostic {
                code: "invalid_usage_event_anchor".into(),
                event_id: usage.event_id.clone(),
            });
        }
    }
    let mut observation_ids = HashSet::new();
    let mut observation_sources = HashSet::new();
    for observation in &input.usage_observations {
        let linked = events.get(observation.event_id.as_str());
        if observation.id.is_empty()
            || !observation_ids.insert(observation.id.as_str())
            || !observation_sources.insert(observation.event_id.as_str())
        {
            errors.push(Diagnostic {
                code: "duplicate_or_missing_usage_observation_id".into(),
                event_id: Some(observation.event_id.clone()),
            });
        }
        if observation.session_ref != stream.session
            || observation.provenance.fidelity != super::Fidelity::Recorded
            || observation.provenance.source_type.is_empty()
            || observation
                .provenance
                .source_id
                .as_deref()
                .is_none_or(str::is_empty)
            || linked
                .is_none_or(|event| event.provenance.source_id != observation.provenance.source_id)
        {
            errors.push(Diagnostic {
                code: "invalid_usage_observation_anchor".into(),
                event_id: Some(observation.event_id.clone()),
            });
        }
    }
    for run in &input.agent_runs {
        if run
            .task_id
            .as_deref()
            .is_some_and(|id| !task_ids.contains(id))
        {
            errors.push(Diagnostic {
                code: "unknown_run_task".into(),
                event_id: Some(run.evidence.event_id.clone()),
            });
        }
        if run.child_session_ref.as_ref().is_some_and(|child| {
            child.provider != stream.session.provider
                || child.session_id.is_empty()
                || child == &stream.session
        }) {
            errors.push(Diagnostic {
                code: "invalid_child_run_session".into(),
                event_id: Some(run.evidence.event_id.clone()),
            });
        }
        if run
            .time_end
            .zip(run.time_start)
            .is_some_and(|(end, start)| end < start)
        {
            errors.push(Diagnostic {
                code: "run_end_before_start".into(),
                event_id: Some(run.evidence.event_id.clone()),
            });
        }
    }
    for observation in &input.run_observations {
        if observation
            .run_id
            .as_deref()
            .is_some_and(|id| !run_ids.contains(id))
        {
            errors.push(Diagnostic {
                code: "unknown_observation_run".into(),
                event_id: Some(observation.evidence.event_id.clone()),
            });
        }
    }
    for relationship in &input.relationships {
        if relationship.from.session_id.is_empty()
            || relationship.to.session_id.is_empty()
            || relationship.from.provider != stream.session.provider
            || relationship.to.provider != stream.session.provider
            || (relationship.from != stream.session && relationship.to != stream.session)
        {
            errors.push(Diagnostic {
                code: "invalid_relationship_identity".into(),
                event_id: Some(relationship.evidence.event_id.clone()),
            });
        }
    }
    for branch in &input.branches {
        let head = events.get(branch.head_event_id.as_str());
        let fork = branch
            .fork_event_id
            .as_deref()
            .and_then(|id| events.get(id));
        if branch.head_entry_id.is_empty()
            || head.is_none_or(|event| {
                event.provenance.source_id.as_deref() != Some(branch.head_entry_id.as_str())
            })
            || branch.fork_entry_id.is_some() != branch.fork_event_id.is_some()
            || branch.fork_entry_id.as_deref().is_some_and(|id| {
                fork.is_none_or(|event| event.provenance.source_id.as_deref() != Some(id))
            })
        {
            errors.push(Diagnostic {
                code: "invalid_branch_topology_anchor".into(),
                event_id: Some(branch.evidence.event_id.clone()),
            });
        }
    }
    if !input.branches.is_empty()
        && input
            .branches
            .iter()
            .filter(|branch| branch.selected)
            .count()
            != 1
    {
        errors.push(Diagnostic {
            code: "invalid_active_branch_count".into(),
            event_id: None,
        });
    }
    if !errors.is_empty() {
        return Err(ProtocolError::Invalid {
            diagnostics: errors,
        });
    }
    let mut diagnostics = input.diagnostics;
    diagnostics.push(Diagnostic {
        code: "session_protocol_v2_partial_foundation".into(),
        event_id: None,
    });
    diagnostics.push(Diagnostic {
        code: "session_protocol_v3_partial_foundation".into(),
        event_id: None,
    });
    Ok(ObservationSnapshot {
        schema: "agentsession.protocol-observations.v1",
        session: stream.session.clone(),
        revision: stream.revision.clone(),
        completeness: "partial",
        validation: ObservationValidation { status: "valid" },
        source_record_count: stream.events.len(),
        list_duration_range: input.list_duration_range,
        coverage: input.coverage,
        diagnostics,
        tasks: input.tasks,
        agent_runs: input.agent_runs,
        run_observations: input.run_observations,
        relationships: input.relationships,
        branches: input.branches,
        context_observations: input.context_observations,
        context_versions: input.context_versions,
        context_transformations: input.context_transformations,
        context_artifacts: input.context_artifacts,
        context_artifact_source_state: input.context_artifact_source_state,
        coordination: input.coordination,
        usage_records: input.usage_records,
        usage_observations: input.usage_observations,
    })
}
