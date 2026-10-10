//! Source-ordered event foundation for provider-owned protocol builders.
//!
//! This partial event stream is not a complete Session Protocol v2/v3 snapshot.
//! Native tasks, runs, relationships and context require provider evidence before
//! those domains can be published. Reader messages cannot reconstruct that evidence.
use crate::{EventRef, SessionRef};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

mod observations;
pub use observations::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fidelity {
    Recorded,
    Derived,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub fidelity: Fidelity,
    pub source_type: String,
    pub source_id: Option<String>,
}

/// Normalized source order. Recorded events retain native record and local event
/// positions; derived dependency declarations use deterministic slots after native records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SourceOrder {
    pub record: u64,
    pub ordinal: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionKind {
    AsyncTool,
    Process,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionPhase {
    Started,
    Yielded,
    Polled,
    Input,
    InterruptionRequested,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionObservation {
    pub id: String,
    pub kind: ExecutionKind,
    pub phase: ExecutionPhase,
    pub handle: String,
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Debug)]
pub struct EventCandidate {
    pub id: String,
    pub session: SessionRef,
    pub source_order: SourceOrder,
    pub timestamp: Option<i64>,
    pub category: String,
    pub kind: String,
    pub provenance: Provenance,
    pub reader_event: Option<EventRef>,
    pub execution: Option<ExecutionObservation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolEvent {
    pub id: String,
    pub sequence: usize,
    pub source_order: SourceOrder,
    pub timestamp: Option<i64>,
    pub category: String,
    pub kind: String,
    pub provenance: Provenance,
    pub reader_event: Option<EventRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionObservation>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Diagnostic {
    pub code: &'static str,
    pub event_id: Option<String>,
}

#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProtocolError {
    #[error("protocol unavailable: {diagnostic}")]
    Unavailable { diagnostic: String },
    #[error("protocol evidence is invalid")]
    Invalid { diagnostics: Vec<Diagnostic> },
    #[error("invalid protocol event cursor")]
    InvalidCursor,
    #[error("invalid protocol query: {diagnostic}")]
    InvalidQuery { diagnostic: String },
}

#[derive(Debug)]
pub struct EventStream {
    session: SessionRef,
    scope: String,
    revision: String,
    events: Vec<ProtocolEvent>,
}

/// Validate once at the builder boundary; successful streams are immutable.
pub fn finalize_events(
    session: SessionRef,
    scope: String,
    revision: String,
    mut candidates: Vec<EventCandidate>,
) -> Result<EventStream, ProtocolError> {
    let mut diagnostics = Vec::new();
    if session.provider.is_empty()
        || session.session_id.is_empty()
        || scope.is_empty()
        || revision.is_empty()
    {
        diagnostics.push(Diagnostic {
            code: "missing_snapshot_identity",
            event_id: None,
        });
    }
    let mut ids = HashSet::new();
    let mut positions = HashSet::new();
    for event in &candidates {
        let mut issue = |code| {
            diagnostics.push(Diagnostic {
                code,
                event_id: Some(event.id.clone()),
            })
        };
        if event.session != session {
            issue("event_session_mismatch");
        }
        if event.id.is_empty() || event.kind.is_empty() || event.category.is_empty() {
            issue("missing_event_identity");
        }
        if !ids.insert(&event.id) {
            issue("duplicate_event_id");
        }
        if !positions.insert(event.source_order) {
            issue("duplicate_source_order");
        }
        if event.provenance.source_type.is_empty() {
            issue("missing_provenance_source");
        }
        if let Some(reader) = &event.reader_event {
            if reader.provider != session.provider || reader.session_id != session.session_id {
                issue("reader_session_mismatch");
            }
            if reader.message_id.is_empty() || reader.segment.is_empty() {
                issue("missing_reader_identity");
            }
        }
        if let Some(execution) = &event.execution {
            if execution.id.is_empty()
                || execution.handle.is_empty()
                || execution.tool_name.is_empty()
                || event.category != "tool"
                || event.provenance.fidelity != Fidelity::Recorded
                || event
                    .reader_event
                    .as_ref()
                    .is_none_or(|reader| reader.segment != "tool")
            {
                issue("invalid_execution_observation");
            }
        }
    }
    if !diagnostics.is_empty() {
        return Err(ProtocolError::Invalid { diagnostics });
    }
    candidates.sort_by_key(|event| event.source_order);
    let events = candidates
        .into_iter()
        .enumerate()
        .map(|(index, event)| ProtocolEvent {
            id: event.id,
            sequence: index + 1,
            source_order: event.source_order,
            timestamp: event.timestamp,
            category: event.category,
            kind: event.kind,
            provenance: event.provenance,
            reader_event: event.reader_event,
            execution: event.execution,
        })
        .collect();
    Ok(EventStream {
        session,
        scope,
        revision,
        events,
    })
}

#[derive(Debug)]
pub struct EventQuery {
    pub category: Option<String>,
    pub kind: Option<String>,
    pub execution_only: bool,
    pub limit: usize,
    pub cursor: Option<String>,
}
impl Default for EventQuery {
    fn default() -> Self {
        Self {
            category: None,
            kind: None,
            execution_only: false,
            limit: 50,
            cursor: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Coverage {
    Partial,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage<'a> {
    pub session: &'a SessionRef,
    pub revision: &'a str,
    pub coverage: Coverage,
    pub events: Vec<&'a ProtocolEvent>,
    pub next_cursor: Option<String>,
    /// Work bound for this page; a sparse filter may return an empty continuation page.
    pub scanned_events: usize,
}

#[derive(Debug, Serialize)]
pub struct EventDetail {
    pub session: SessionRef,
    pub revision: String,
    pub coverage: Coverage,
    pub event: ProtocolEvent,
}

impl EventStream {
    pub(crate) fn execution_events(&self) -> impl Iterator<Item = &ProtocolEvent> {
        self.events
            .iter()
            .filter(|event| event.category == "tool" && event.execution.is_some())
    }

    pub fn execution_boundary_refs(&self) -> HashSet<EventRef> {
        self.events
            .iter()
            .filter(|event| {
                matches!(
                    event.execution.as_ref().map(|fact| fact.phase),
                    Some(
                        ExecutionPhase::Completed
                            | ExecutionPhase::Failed
                            | ExecutionPhase::Yielded
                            | ExecutionPhase::InterruptionRequested
                    )
                )
            })
            .filter_map(|event| event.reader_event.clone())
            .collect()
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn event_detail(&self, event_id: &str) -> Option<EventDetail> {
        self.events
            .iter()
            .find(|event| event.id == event_id)
            .map(|event| EventDetail {
                session: self.session.clone(),
                revision: self.revision.clone(),
                coverage: Coverage::Partial,
                event: event.clone(),
            })
    }

    pub fn events(&self, query: EventQuery) -> Result<EventPage<'_>, ProtocolError> {
        if !(1..=200).contains(&query.limit) {
            return Err(ProtocolError::InvalidQuery {
                diagnostic: "limit must be between 1 and 200".into(),
            });
        }
        // The tuple encoding keeps arbitrary provider IDs and filter values unambiguous.
        let identity = serde_json::to_vec(&(
            &self.scope,
            &self.session,
            &self.revision,
            &query.category,
            &query.kind,
            query.execution_only,
        ))
        .expect("string tuple serialization");
        let fingerprint = format!("{:x}", Sha256::digest(identity));
        let start = match query.cursor {
            None => 0,
            Some(cursor) => {
                let (hash, offset) = cursor.split_once(':').ok_or(ProtocolError::InvalidCursor)?;
                let offset = offset
                    .parse::<usize>()
                    .map_err(|_| ProtocolError::InvalidCursor)?;
                if hash != fingerprint || offset == 0 || offset >= self.events.len() {
                    return Err(ProtocolError::InvalidCursor);
                }
                offset
            }
        };
        let mut events = Vec::with_capacity(query.limit);
        let mut end = start;
        for event in self.events.iter().skip(start).take(1024) {
            end += 1;
            if query
                .category
                .as_ref()
                .is_none_or(|value| value == &event.category)
                && query.kind.as_ref().is_none_or(|value| value == &event.kind)
                && (!query.execution_only || event.execution.is_some())
            {
                events.push(event);
                if events.len() == query.limit {
                    break;
                }
            }
        }
        Ok(EventPage {
            session: &self.session,
            revision: &self.revision,
            coverage: Coverage::Partial,
            events,
            next_cursor: (end < self.events.len()).then(|| format!("{fingerprint}:{end}")),
            scanned_events: end - start,
        })
    }
}

#[cfg(test)]
mod tests;
