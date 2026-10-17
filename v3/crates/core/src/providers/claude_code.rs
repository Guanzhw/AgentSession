//! Claude Code JSONL discovery, canonical identity and recorded Reader facts.
pub(super) fn default_data_path(home: &std::path::Path) -> std::path::PathBuf {
    super::paths::probe(
        &[
            std::env::var_os("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from),
            Some(home.join(".claude")),
            super::paths::app_data_dir(home, "claude"),
        ],
        home.join(".claude"),
    )
}

use super::{NormalizedEvent, ProviderAdapter, SessionSnapshot, SourceEntry};
use crate::protocol::{
    ContextObservation, CoordinationFact, Diagnostic, DomainCoverage, EventCandidate, EventStream,
    Evidence, Fidelity, ObservationCandidates, ObservationSnapshot, ObservationState,
    ProtocolBundle, ProtocolError, Provenance, RelationshipObservation, SourceOrder, UsageRecord,
    UsageTokenComponents, finalize_events, finalize_protocol_bundle,
};
use crate::{
    CoordinationObservation, CoreError, EventRef, ReaderItem, RelationEntry, RelationProvenance,
    RelationTask, Result, SessionRef, SessionSummary, bounded_preview,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const PROVIDER: &str = "claude-code";
const PREVIEW_CHARS: usize = 240;

pub(super) struct ClaudeAdapter<'a> {
    pub root: &'a Path,
    pub scope: &'a str,
}

impl ClaudeAdapter<'_> {
    fn sources(&self) -> Result<BTreeMap<String, PathBuf>> {
        let mut sources = BTreeMap::new();
        let transcripts = self.root.join("transcripts");
        if transcripts.is_dir() {
            for entry in fs::read_dir(&transcripts).map_err(|source| CoreError::Io {
                path: transcripts.clone(),
                source,
            })? {
                let entry = entry.map_err(|source| CoreError::Io {
                    path: transcripts.clone(),
                    source,
                })?;
                let path = entry.path();
                if path.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
                    if let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) {
                        sources.entry(id.to_owned()).or_insert(path);
                    }
                }
            }
        }
        let projects = self.root.join("projects");
        if projects.is_dir() {
            for project in fs::read_dir(&projects).map_err(|source| CoreError::Io {
                path: projects.clone(),
                source,
            })? {
                let project = project.map_err(|source| CoreError::Io {
                    path: projects.clone(),
                    source,
                })?;
                let project_path = project.path();
                if !project
                    .file_type()
                    .map_err(|source| CoreError::Io {
                        path: project_path.clone(),
                        source,
                    })?
                    .is_dir()
                {
                    continue;
                }
                for entry in WalkDir::new(&project_path).follow_links(false).max_depth(7) {
                    let entry = entry.map_err(|error| CoreError::Parse {
                        diagnostic: crate::ParseDiagnostic::new(
                            "source directory traversal failed",
                        ),
                        path: project_path.clone(),
                        reason: error.to_string(),
                    })?;
                    if !entry.file_type().is_file()
                        || entry.path().extension().is_none_or(|ext| ext != "jsonl")
                    {
                        continue;
                    }
                    let relative = entry
                        .path()
                        .strip_prefix(&project_path)
                        .expect("WalkDir entry under project");
                    let inside_subagents = relative
                        .components()
                        .any(|part| part.as_os_str() == "subagents");
                    if relative.components().count() != 1 && !inside_subagents {
                        continue;
                    }
                    let Some(stem) = entry.path().file_stem().and_then(|stem| stem.to_str()) else {
                        continue;
                    };
                    let id = if inside_subagents {
                        stem.strip_prefix("agent-").unwrap_or(stem)
                    } else {
                        stem
                    };
                    sources
                        .entry(id.to_owned())
                        .or_insert_with(|| entry.path().to_path_buf());
                }
            }
        }
        Ok(sources)
    }
}

impl ProviderAdapter for ClaudeAdapter<'_> {
    fn resume_command(&self) -> Option<crate::DefaultResumeCommand> {
        Some(crate::DefaultResumeCommand {
            command: crate::ResumeCommandSpec {
                executable: "claude".into(),
                args: vec!["--resume".into(), "{sessionId}".into()],
                cwd: None,
            },
            npm: Some(crate::NpmResumeEntry {
                package: "@anthropic-ai/claude-code",
                bin: "claude",
            }),
        })
    }

    fn available(&self) -> bool {
        self.sources()
            .is_ok_and(|sources| sources.values().any(|path| source_has_header(path)))
    }

    fn protocol_capabilities(&self) -> super::ProtocolCapabilities {
        super::protocol_capability_map(&[
            ("sessionEvents", "mixed"),
            ("sessionRelationships", "recorded"),
        ])
    }

    fn unavailable_diagnostic(&self) -> &'static str {
        "Claude Code transcripts are unavailable or unreadable"
    }

    fn load(&self, session_id: &str) -> Result<SessionSnapshot> {
        let sources = self.sources()?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: PROVIDER.into(),
            session_id: session_id.into(),
        })?;
        load(path, self.scope, session_id)
    }
    fn system_prompt_evidence(&self, session_id: &str) -> Result<crate::SystemPromptEvidence> {
        let summary = self.load(session_id)?.summary;
        let mut evidence = crate::SystemPromptEvidence::new(&summary, "claude-code-resolved");
        evidence.current_files(&summary, &["CLAUDE.md"]);
        Ok(evidence)
    }

    fn protocol_event_stream(&self, session_id: &str) -> Result<EventStream> {
        let sources = self.sources()?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: PROVIDER.into(),
            session_id: session_id.into(),
        })?;
        claude_protocol_stream(path, self.scope, session_id)
    }

    fn protocol_observations(&self, session_id: &str) -> Result<ObservationSnapshot> {
        Ok(self.protocol_bundle(session_id)?.into_observations())
    }

    fn protocol_bundle(&self, session_id: &str) -> Result<ProtocolBundle> {
        let sources = self.sources()?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: PROVIDER.into(),
            session_id: session_id.into(),
        })?;
        let bytes = fs::read(path).map_err(|source| CoreError::Io {
            path: path.clone(),
            source,
        })?;
        let stream = claude_protocol_stream_bytes(path, self.scope, session_id, &bytes)?;
        let (usage_records, usage_observed) =
            claude_request_usage(path, session_id, &bytes, &stream)?;
        let mut observations = ObservationCandidates {
            usage_records,
            ..ObservationCandidates::default()
        };
        let mut sidechain_seen = false;
        let mut agent_calls = HashSet::new();
        for (line_index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let record =
                serde_json::from_slice::<Value>(line).map_err(|error| CoreError::Parse {
                    diagnostic: crate::ParseDiagnostic::json(&error, line_index),
                    path: path.clone(),
                    reason: format!("line {}: {error}", line_index + 1),
                })?;
            for mut observation in
                claude_agent_handoffs(&record, line_index, session_id, &mut agent_calls)
            {
                let event = stream
                    .event_detail(&observation.event_id)
                    .expect("Agent source record is in the same finalized stream")
                    .event;
                if observation.reader_event != event.reader_event {
                    observation.reader_event = None;
                }
                let evidence = Evidence {
                    event_id: observation.event_id.clone(),
                    provenance: Provenance {
                        fidelity: Fidelity::Recorded,
                        source_type: observation.provenance.source_type.clone(),
                        source_id: Some(observation.provenance.source_id.clone()),
                    },
                };
                if let Some(child) = &observation.to_session_ref {
                    observations.relationships.push(RelationshipObservation {
                        id: format!("relationship:claude:child:{}", observation.correlation_id),
                        kind: "child".into(),
                        from: observation
                            .from_session_ref
                            .clone()
                            .expect("Agent spawn has a source session"),
                        to: child.clone(),
                        correlation_id: Some(observation.correlation_id.clone()),
                        evidence: evidence.clone(),
                    });
                }
                observations.coordination.push(CoordinationFact {
                    id: format!(
                        "coordination:claude:{}:{}",
                        observation.correlation_id, observation.state
                    ),
                    kind: observation.kind,
                    state: observation.state,
                    correlation_id: observation.correlation_id,
                    from_session_ref: observation.from_session_ref,
                    to_session_ref: observation.to_session_ref,
                    from_actor_path: None,
                    to_actor_path: None,
                    reader_event: observation.reader_event,
                    evidence,
                });
            }
            if record["type"] == "system" && record["subtype"] == "compact_boundary" {
                let event_id = format!("event:claude:{line_index}");
                let event = stream
                    .event_detail(&event_id)
                    .expect("compact boundary source event is in the same finalized stream")
                    .event;
                observations.context_observations.push(ContextObservation {
                    id: format!("context:claude:{line_index}"),
                    kind: "compaction-boundary".into(),
                    timestamp: event.timestamp,
                    trigger: record["compactMetadata"]["trigger"]
                        .as_str()
                        .map(str::to_owned),
                    pre_compact_tokens: record["compactMetadata"]["preTokens"].as_u64(),
                    window_id: None,
                    previous_window_id: None,
                    first_window_id: None,
                    summary_available: false,
                    reader_event: event.reader_event.clone(),
                    evidence: Evidence {
                        event_id,
                        provenance: event.provenance,
                    },
                });
            }
            if sidechain_seen || record["isSidechain"] != true {
                continue;
            }
            sidechain_seen = true;
            if let (Some(parent_id), Some(source_id)) = (
                record["sessionId"]
                    .as_str()
                    .filter(|id| !id.trim().is_empty() && *id != session_id),
                record["uuid"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .or_else(|| record["id"].as_str().filter(|id| !id.is_empty())),
            ) {
                observations.relationships.push(RelationshipObservation {
                    id: format!("relationship:claude:parent:{session_id}"),
                    kind: "parent".into(),
                    from: SessionRef {
                        provider: PROVIDER.into(),
                        session_id: parent_id.into(),
                    },
                    to: SessionRef {
                        provider: PROVIDER.into(),
                        session_id: session_id.into(),
                    },
                    correlation_id: None,
                    evidence: Evidence {
                        event_id: format!("event:claude:{line_index}"),
                        provenance: Provenance {
                            fidelity: Fidelity::Recorded,
                            source_type: "claude.sidechain.sessionId".into(),
                            source_id: Some(source_id.into()),
                        },
                    },
                });
            }
        }
        for (domain, details) in [
            (
                "relationships",
                "Sidechain parent IDs and structured asynchronous Agent results identify recorded session links; target availability is unverified. Opaque or missing lineage remains unknown.",
            ),
            (
                "tasks",
                "Task notifications remain source events; task lifecycle projection is unported.",
            ),
            (
                "agentRuns",
                "Cross-file sidechain run correlation is unported.",
            ),
            ("branches", "Branch projection is unported."),
            (
                "context",
                "Recorded compact boundaries have Reader checkpoints and Context observations; no missing summary or context version is invented.",
            ),
            ("work", "Goals and work graph are unported."),
            (
                "execution",
                "Tool records remain source events; execution lifecycle is unported.",
            ),
            (
                "coordination",
                "Recorded Agent requests and matching structured asynchronous launch results identify dispatch and child IDs. Completion, actor paths and other coordination remain unported.",
            ),
            (
                "usage",
                "One request per recorded assistant response; cache and reasoning fields remain separate, inconsistent totals stay unknown, and all-zero pending rows are omitted.",
            ),
            ("ownership", "Exclusive source ownership is not asserted."),
        ] {
            observations.coverage.insert(
                domain.into(),
                DomainCoverage {
                    state: if domain == "context" && !observations.context_observations.is_empty() {
                        ObservationState::Observed
                    } else if domain == "relationships" && !observations.relationships.is_empty() {
                        ObservationState::Observed
                    } else if domain == "coordination" && !observations.coordination.is_empty() {
                        ObservationState::Observed
                    } else if domain == "usage" {
                        if usage_observed {
                            ObservationState::Observed
                        } else {
                            ObservationState::NotObserved
                        }
                    } else {
                        ObservationState::Unknown
                    },
                    details: details.into(),
                },
            );
        }
        finalize_protocol_bundle(stream, observations).map_err(CoreError::Protocol)
    }

    fn inventory(&self) -> Result<Vec<SourceEntry>> {
        self.sources()?
            .into_iter()
            .map(|(id, path)| SourceEntry::new(id, path))
            .collect::<Result<Vec<_>>>()
    }

    fn capture(&self, entry: &SourceEntry) -> Result<SessionSnapshot> {
        load(&entry.path, self.scope, &entry.session_id)
    }
}

fn source_has_header(path: &Path) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    BufReader::new(file)
        .lines()
        .find_map(|line| line.ok().filter(|line| !line.trim().is_empty()))
        .and_then(|line| serde_json::from_str::<Value>(&line).ok())
        .is_some_and(|record| record["type"].is_string())
}

fn source_revision(path: &Path, scope: &str, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"claude-jsonl-v3-slice-4\0");
    hasher.update(scope.as_bytes());
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn load(path: &Path, scope: &str, expected_id: &str) -> Result<SessionSnapshot> {
    let bytes = fs::read(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })?;
    load_bytes(path, scope, expected_id, &bytes)
}

fn load_bytes(
    path: &Path,
    scope: &str,
    expected_id: &str,
    bytes: &[u8],
) -> Result<SessionSnapshot> {
    let revision = source_revision(path, scope, bytes);
    let mut records = Vec::new();
    let mut line_numbers = Vec::new();
    for (line_number, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value = serde_json::from_slice::<Value>(line).map_err(|error| CoreError::Parse {
            diagnostic: crate::ParseDiagnostic::json(&error, line_number),
            path: path.into(),
            reason: format!("line {}: {error}", line_number + 1),
        })?;
        line_numbers.push(line_number);
        records.push(value);
    }
    if records.is_empty() {
        return Err(CoreError::Parse {
            diagnostic: crate::ParseDiagnostic::new("empty transcript"),
            path: path.into(),
            reason: "empty transcript".into(),
        });
    }
    let sidechain = records.iter().find(|record| record["isSidechain"] == true);
    if let Some(record) = sidechain {
        if let Some(agent) = record["agentId"].as_str() {
            if agent != expected_id {
                return Err(CoreError::Parse {
                    diagnostic: crate::ParseDiagnostic::new(
                        "sidechain agent ID differs from canonical filename",
                    ),
                    path: path.into(),
                    reason: "sidechain agent ID differs from canonical filename".into(),
                });
            }
        }
    }
    let parent_id = sidechain
        .and_then(|record| record["sessionId"].as_str())
        .filter(|id| !id.trim().is_empty() && *id != expected_id)
        .map(str::to_owned);
    let directory = records
        .iter()
        .find_map(|record| record["cwd"].as_str())
        .map(str::to_owned);
    let created_at = records
        .iter()
        .filter_map(|record| timestamp_ms(&record["timestamp"]))
        .min();
    let updated_at = records
        .iter()
        .filter_map(|record| timestamp_ms(&record["timestamp"]))
        .max();
    let title = title(&records, expected_id, sidechain.is_some());
    let mut events = Vec::new();
    let mut relations = Vec::new();
    let mut message_count = 0;
    let mut token_total = 0u64;
    let mut has_usage = false;
    let mut usage_selector = ClaudeUsageSelector::default();
    let mut owner = None::<EventRef>;
    let mut pending_thinking = Vec::<String>::new();
    let mut pending_thinking_id = None::<String>;
    let mut pending_thinking_time = None;
    let mut generated = 0usize;

    let mut reply_owners = HashMap::new();
    let mut agent_calls = HashSet::new();
    for (record_index, record) in records.iter().enumerate() {
        relations.extend(
            claude_agent_handoffs(
                record,
                line_numbers[record_index],
                expected_id,
                &mut agent_calls,
            )
            .into_iter()
            .map(|observation| RelationEntry::Coordination { observation }),
        );
        let reply_start = events.len();
        let kind = record["type"].as_str().unwrap_or("");
        let timestamp = timestamp_ms(&record["timestamp"]);
        let uuid = record["uuid"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let id = format!("record-{generated}");
                generated += 1;
                id
            });
        if let Some(selection) = usage_selector.select(record) {
            if selection.first {
                token_total = token_total.saturating_add(usage_total(selection.usage));
                has_usage = true;
            }
        }
        if kind != "assistant" {
            if !pending_thinking.is_empty() {
                let id = pending_thinking_id
                    .take()
                    .expect("pending thinking has source ID");
                let thought = std::mem::take(&mut pending_thinking).join("\n\n");
                push_event(
                    &mut events,
                    expected_id,
                    &id,
                    "thinking",
                    "assistant",
                    pending_thinking_time,
                    &thought,
                    None,
                    "",
                    "",
                    None,
                );
                message_count += 1;
            }
        }

        match kind {
            "user" => {
                let content = content(&record["message"]["content"], &record["content"]);
                let text = text_blocks(content);
                if let Some(notification) = task_notification(&text) {
                    let status = notification.status.unwrap_or_else(|| "unknown".into());
                    let notification_body = notification
                        .summary
                        .as_deref()
                        .unwrap_or(&status)
                        .to_owned();
                    let relation_status = match status.to_lowercase().as_str() {
                        "completed" => "completed",
                        "failed" => "failed",
                        "stopped" => "cancelled",
                        "running" => "running",
                        _ => "unknown",
                    };
                    relations.push(RelationEntry::Task {
                        task: RelationTask {
                            id: notification.id,
                            kind: "task_notification".into(),
                            status: relation_status.into(),
                            owner: notification.tool_use_id,
                            subject: None,
                            description: notification.summary,
                            owner_participant: None,
                            reader_event: Some(event_ref(expected_id, &uuid, "tool")),
                            provenance: RelationProvenance {
                                fidelity: "recorded".into(),
                                source_type: "task-notification".into(),
                                source_id: uuid.clone(),
                            },
                        },
                    });
                    push_event(
                        &mut events,
                        expected_id,
                        &uuid,
                        "tool",
                        "tool",
                        timestamp,
                        &notification_body,
                        Some("task_notification"),
                        "",
                        &notification_body,
                        None,
                    );
                    message_count += 1;
                } else if !text.is_empty() {
                    push_event(
                        &mut events,
                        expected_id,
                        &uuid,
                        "message",
                        "user",
                        timestamp,
                        &text,
                        None,
                        "",
                        "",
                        None,
                    );
                    message_count += 1;
                    owner = None;
                }
                if let Some(blocks) = content.as_array() {
                    for (index, block) in blocks.iter().enumerate() {
                        if block["type"] != "tool_result" {
                            continue;
                        }
                        let tool_id = block["tool_use_id"].as_str();
                        let id = tool_id
                            .map(|id| format!("tool-result:{id}"))
                            .unwrap_or_else(|| format!("{uuid}:tool-result-{index}"));
                        let output =
                            text_value(block.get("content").or_else(|| block.get("tool_output")));
                        push_event(
                            &mut events,
                            expected_id,
                            &id,
                            "tool",
                            "tool",
                            timestamp,
                            &output,
                            Some(block["tool_name"].as_str().unwrap_or("tool_result")),
                            "",
                            &output,
                            owner.clone(),
                        );
                        message_count += 1;
                    }
                }
            }
            "assistant" => {
                let content = content(&record["message"]["content"], &record["content"]);
                if let Some(blocks) = content.as_array() {
                    for (index, block) in blocks.iter().enumerate() {
                        match block["type"].as_str().unwrap_or("") {
                            "thinking" | "redacted_thinking" => {
                                let thought = block["thinking"]
                                    .as_str()
                                    .or_else(|| block["data"].as_str())
                                    .unwrap_or("[Redacted thinking]");
                                if pending_thinking.is_empty() {
                                    pending_thinking_id = Some(uuid.clone());
                                    pending_thinking_time = timestamp;
                                }
                                pending_thinking.push(thought.into());
                            }
                            "text" => {
                                if let Some(text) =
                                    block["text"].as_str().filter(|text| !text.is_empty())
                                {
                                    let id = if blocks.len() == 1 {
                                        uuid.clone()
                                    } else {
                                        format!("{uuid}:{index}")
                                    };
                                    if !pending_thinking.is_empty() {
                                        let thought =
                                            std::mem::take(&mut pending_thinking).join("\n\n");
                                        pending_thinking_id = None;
                                        push_event(
                                            &mut events,
                                            expected_id,
                                            &id,
                                            "thinking",
                                            "assistant",
                                            timestamp,
                                            &thought,
                                            None,
                                            "",
                                            "",
                                            Some(event_ref(expected_id, &id, "message")),
                                        );
                                    }
                                    push_event(
                                        &mut events,
                                        expected_id,
                                        &id,
                                        "message",
                                        "assistant",
                                        timestamp,
                                        text,
                                        None,
                                        "",
                                        "",
                                        None,
                                    );
                                    owner = Some(event_ref(expected_id, &id, "message"));
                                    message_count += 1;
                                }
                            }
                            "tool_use" => {
                                let id = block["id"]
                                    .as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| format!("{uuid}:tool-{index}"));
                                if !pending_thinking.is_empty() {
                                    let thought =
                                        std::mem::take(&mut pending_thinking).join("\n\n");
                                    pending_thinking_id = None;
                                    push_event(
                                        &mut events,
                                        expected_id,
                                        &id,
                                        "thinking",
                                        "tool",
                                        timestamp,
                                        &thought,
                                        None,
                                        "",
                                        "",
                                        Some(event_ref(expected_id, &id, "tool")),
                                    );
                                }
                                let input = text_value(block.get("input"));
                                push_event(
                                    &mut events,
                                    expected_id,
                                    &id,
                                    "tool",
                                    "tool",
                                    timestamp,
                                    "",
                                    Some(block["name"].as_str().unwrap_or("unknown")),
                                    &input,
                                    "",
                                    owner.clone(),
                                );
                                message_count += 1;
                                owner = Some(event_ref(expected_id, &id, "tool"));
                            }
                            _ => {}
                        }
                    }
                } else if let Some(text) = content.as_str().filter(|text| !text.is_empty()) {
                    if !pending_thinking.is_empty() {
                        let thought = std::mem::take(&mut pending_thinking).join("\n\n");
                        pending_thinking_id = None;
                        push_event(
                            &mut events,
                            expected_id,
                            &uuid,
                            "thinking",
                            "assistant",
                            timestamp,
                            &thought,
                            None,
                            "",
                            "",
                            Some(event_ref(expected_id, &uuid, "message")),
                        );
                    }
                    push_event(
                        &mut events,
                        expected_id,
                        &uuid,
                        "message",
                        "assistant",
                        timestamp,
                        text,
                        None,
                        "",
                        "",
                        None,
                    );
                    owner = Some(event_ref(expected_id, &uuid, "message"));
                    message_count += 1;
                }
            }
            "system" if record["subtype"] == "compact_boundary" => {
                let trigger = record["compactMetadata"]["trigger"]
                    .as_str()
                    .unwrap_or("unknown");
                let body = format!("Recorded compact boundary ({trigger})");
                push_event(
                    &mut events,
                    expected_id,
                    &uuid,
                    "context",
                    "context",
                    timestamp,
                    &body,
                    None,
                    "",
                    "",
                    None,
                );
                owner = None;
            }
            "tool_result" => {
                let output =
                    text_value(record.get("tool_output").or_else(|| record.get("content")));
                push_event(
                    &mut events,
                    expected_id,
                    &uuid,
                    "tool",
                    "tool",
                    timestamp,
                    &output,
                    Some(record["tool_name"].as_str().unwrap_or("tool_result")),
                    "",
                    &output,
                    owner.clone(),
                );
                message_count += 1;
            }
            "tool_use" => {
                let input = text_value(record.get("tool_input").or_else(|| record.get("input")));
                push_event(
                    &mut events,
                    expected_id,
                    &uuid,
                    "tool",
                    "tool",
                    timestamp,
                    "",
                    Some(
                        record["tool_name"]
                            .as_str()
                            .or_else(|| record["name"].as_str())
                            .unwrap_or("unknown"),
                    ),
                    &input,
                    "",
                    owner.clone(),
                );
                message_count += 1;
            }
            _ => {}
        }
        if kind == "assistant" {
            let source_id = record["uuid"]
                .as_str()
                .filter(|id| !id.is_empty())
                .or_else(|| record["id"].as_str().filter(|id| !id.is_empty()));
            let model = record["message"]["model"]
                .as_str()
                .or_else(|| record["model"].as_str())
                .map(str::to_owned);
            let mut primary = true;
            for event in events[reply_start..].iter_mut().filter(|event| {
                event.item.role == "assistant" && event.item.event.segment == "message"
            }) {
                event.item.reply_metadata = super::reply_metadata(
                    model.clone(),
                    None,
                    Provenance {
                        fidelity: Fidelity::Recorded,
                        source_type: "claude.transcript:assistant.model".into(),
                        source_id: source_id.map(str::to_owned),
                    },
                    None,
                );
                if primary {
                    reply_owners.insert(
                        format!("event:claude:{}", line_numbers[record_index]),
                        event.item.event.clone(),
                    );
                    primary = false;
                }
            }
        }
    }
    if !pending_thinking.is_empty() {
        let id = pending_thinking_id.expect("pending thinking has source ID");
        let thought = pending_thinking.join("\n\n");
        push_event(
            &mut events,
            expected_id,
            &id,
            "thinking",
            "assistant",
            pending_thinking_time,
            &thought,
            None,
            "",
            "",
            None,
        );
        message_count += 1;
    }
    let native_sources: HashMap<_, _> = records
        .iter()
        .enumerate()
        .filter_map(|(index, record)| {
            record["uuid"]
                .as_str()
                .filter(|id| !id.is_empty())
                .or_else(|| record["id"].as_str().filter(|id| !id.is_empty()))
                .map(|id| (line_numbers[index], id))
        })
        .collect();
    let (requests, _) =
        claude_request_usage_with_owner(path, expected_id, bytes, |line_index, source_id| {
            (native_sources.get(&line_index).copied() == Some(source_id))
                .then(|| format!("event:claude:{line_index}"))
        })?;
    let event_indices: HashMap<_, _> = events
        .iter()
        .enumerate()
        .map(|(index, event)| (event.item.event.clone(), index))
        .collect();
    for request in &requests {
        let Some(index) = request
            .event_id
            .as_ref()
            .and_then(|id| reply_owners.get(id))
            .and_then(|owner| event_indices.get(owner))
        else {
            continue;
        };
        let metadata =
            events[*index]
                .item
                .reply_metadata
                .get_or_insert_with(|| crate::ReaderReplyMetadata {
                    model: None,
                    model_provider: None,
                    model_provenance: None,
                    request_usage: None,
                });
        metadata.request_usage = Some(crate::ReaderRequestUsage::from(request));
    }
    let summary = SessionSummary {
        diagnostic: None,
        session: SessionRef {
            provider: PROVIDER.into(),
            session_id: expected_id.into(),
        },
        search_title: Some(title.clone()),
        title,
        directory,
        created_at,
        updated_at,
        message_count,
        conversation_message_count: None,
        token_count: has_usage.then_some(token_total),
        duration_ms: None,
        summary_files: None,
        summary_additions: None,
        summary_deletions: None,
        parent: parent_id.map(|session_id| SessionRef {
            provider: PROVIDER.into(),
            session_id,
        }),
    };
    Ok(SessionSnapshot {
        summary,
        revision,
        events,
        relations,
    })
}

fn claude_protocol_stream(path: &Path, scope: &str, session_id: &str) -> Result<EventStream> {
    let bytes = fs::read(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })?;
    claude_protocol_stream_bytes(path, scope, session_id, &bytes)
}

fn claude_protocol_stream_bytes(
    path: &Path,
    scope: &str,
    session_id: &str,
    bytes: &[u8],
) -> Result<EventStream> {
    let snapshot = load_bytes(path, scope, session_id, bytes)?;
    let revision = snapshot.revision.clone();
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
    let session = SessionRef {
        provider: PROVIDER.into(),
        session_id: session_id.into(),
    };
    let mut candidates = Vec::new();
    let mut generated = 0usize;
    for (line_index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let record = serde_json::from_slice::<Value>(line).map_err(|error| CoreError::Parse {
            diagnostic: crate::ParseDiagnostic::json(&error, line_index),
            path: path.into(),
            reason: format!("line {}: {error}", line_index + 1),
        })?;
        let kind = record["type"]
            .as_str()
            .filter(|kind| !kind.is_empty())
            .ok_or_else(|| {
                CoreError::Protocol(ProtocolError::Invalid {
                    diagnostics: vec![Diagnostic {
                        code: "invalid_claude_record_type".into(),
                        event_id: Some(format!("event:claude:{line_index}")),
                    }],
                })
            })?;
        if matches!(kind, "user" | "assistant") {
            let content = content(&record["message"]["content"], &record["content"]);
            let valid = content.is_string()
                || content.as_array().is_some_and(|blocks| {
                    blocks.iter().all(|block| block["type"].as_str().is_some())
                });
            if !valid {
                return Err(CoreError::Protocol(ProtocolError::Invalid {
                    diagnostics: vec![Diagnostic {
                        code: "invalid_claude_message_content".into(),
                        event_id: Some(format!("event:claude:{line_index}")),
                    }],
                }));
            }
        }
        let uuid = record["uuid"].as_str().filter(|id| !id.is_empty());
        let reader_id = uuid.map(str::to_owned).unwrap_or_else(|| {
            let id = format!("record-{generated}");
            generated += 1;
            id
        });
        let native_id = uuid.or_else(|| record["id"].as_str().filter(|id| !id.is_empty()));
        let (category, event_kind, reference) = claude_event_vocabulary(&record, kind, &reader_id);
        let reader_event = reference
            .filter(|(id, segment)| reader_refs.contains(&(id.as_str(), *segment)))
            .map(|(id, segment)| event_ref(session_id, &id, segment));
        let subtype = record["subtype"].as_str().filter(|value| !value.is_empty());
        candidates.push(EventCandidate {
            id: format!("event:claude:{line_index}"),
            session: session.clone(),
            source_order: SourceOrder {
                record: line_index as u64,
                ordinal: 0,
            },
            timestamp: timestamp_ms(&record["timestamp"]),
            category: category.into(),
            kind: event_kind.into(),
            provenance: Provenance {
                fidelity: if native_id.is_some() {
                    Fidelity::Recorded
                } else {
                    Fidelity::Derived
                },
                source_type: subtype
                    .map(|value| format!("claude.{kind}:{value}"))
                    .unwrap_or_else(|| format!("claude.{kind}")),
                source_id: native_id.map(str::to_owned),
            },
            reader_event,
            execution: None,
        });
    }
    finalize_events(session, scope.into(), revision, candidates).map_err(CoreError::Protocol)
}

fn claude_request_usage(
    path: &Path,
    session_id: &str,
    bytes: &[u8],
    stream: &EventStream,
) -> Result<(Vec<UsageRecord>, bool)> {
    claude_request_usage_with_owner(path, session_id, bytes, |line_index, source_id| {
        stream
            .event_detail(&format!("event:claude:{line_index}"))
            .filter(|detail| detail.event.provenance.source_id.as_deref() == Some(source_id))
            .map(|detail| detail.event.id)
    })
}

fn claude_request_usage_with_owner(
    path: &Path,
    session_id: &str,
    bytes: &[u8],
    event_owner: impl Fn(usize, &str) -> Option<String>,
) -> Result<(Vec<UsageRecord>, bool)> {
    let session = SessionRef {
        provider: PROVIDER.into(),
        session_id: session_id.into(),
    };
    let mut usage_records = Vec::<UsageRecord>::new();
    let mut selector = ClaudeUsageSelector::default();

    for (line_index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let record = serde_json::from_slice::<Value>(line).map_err(|error| CoreError::Parse {
            diagnostic: crate::ParseDiagnostic::json(&error, line_index),
            path: path.into(),
            reason: format!("line {}: {error}", line_index + 1),
        })?;
        let Some(selection) = selector.select(&record) else {
            continue;
        };
        let response_id = record["message"]["id"].as_str().filter(|id| !id.is_empty());

        let native_id = record["uuid"]
            .as_str()
            .filter(|id| !id.is_empty())
            .or_else(|| record["id"].as_str().filter(|id| !id.is_empty()));
        let identity = response_id
            .or(native_id)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("record:{line_index}"));
        let source_id = native_id
            .or(response_id)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("event:claude:{line_index}"));
        let fidelity = if native_id.is_some() || response_id.is_some() {
            Fidelity::Recorded
        } else {
            Fidelity::Derived
        };
        let event_id = event_owner(line_index, &source_id);
        let request = UsageRecord {
            id: format!("usage:{session_id}:response:{identity}"),
            scope: "request",
            session_ref: session.clone(),
            timestamp: timestamp_ms(&record["timestamp"]),
            model: record["message"]["model"]
                .as_str()
                .or_else(|| record["model"].as_str())
                .map(str::to_owned),
            model_provider: None,
            run_id: None,
            event_id,
            turn_id: None,
            tokens: selection.tokens,
            context_origin_slices: vec![],
            provenance: Provenance {
                fidelity,
                source_type: "claude.transcript:assistant.usage".into(),
                source_id: Some(source_id),
            },
        };

        if selection.first {
            usage_records.push(request);
        } else if usage_records[selection.index].event_id.is_none() && request.event_id.is_some() {
            usage_records[selection.index] = request;
        }
    }

    Ok((usage_records, selector.observed))
}

type ClaudeUsageSignature = (
    Option<u64>,
    Option<u64>,
    Option<u64>,
    Option<u64>,
    Option<u64>,
);

#[derive(Default)]
struct ClaudeUsageSelector {
    response_records: HashMap<String, usize>,
    previous_fallback: Option<(ClaudeUsageSignature, usize)>,
    selected_count: usize,
    observed: bool,
}

struct ClaudeUsageSelection<'a> {
    usage: &'a Value,
    tokens: UsageTokenComponents,
    index: usize,
    first: bool,
}

impl ClaudeUsageSelector {
    fn select<'a>(&mut self, record: &'a Value) -> Option<ClaudeUsageSelection<'a>> {
        if record["type"] != "assistant" {
            self.previous_fallback = None;
            return None;
        }
        let nested = &record["message"]["usage"];
        let usage = if nested.is_null() {
            &record["usage"]
        } else {
            nested
        };
        let tokens = claude_request_tokens(usage)?;
        self.observed = true;
        let response_id = record["message"]["id"].as_str().filter(|id| !id.is_empty());
        if response_id.is_some() {
            self.previous_fallback = None;
        }
        let signature = claude_usage_signature(&tokens, usage);
        if claude_usage_is_pending(usage, &tokens) {
            if response_id.is_none() {
                self.previous_fallback = None;
            }
            return None;
        }
        let existing = if let Some(response_id) = response_id {
            self.response_records.get(response_id).copied()
        } else {
            self.previous_fallback
                .and_then(|(previous, index)| (previous == signature).then_some(index))
        };
        let index = existing.unwrap_or(self.selected_count);
        let first = existing.is_none();
        if first {
            self.selected_count += 1;
            if let Some(response_id) = response_id {
                self.response_records.insert(response_id.into(), index);
            } else {
                self.previous_fallback = Some((signature, index));
            }
        }
        Some(ClaudeUsageSelection {
            usage,
            tokens,
            index,
            first,
        })
    }
}

fn claude_request_tokens(usage: &Value) -> Option<UsageTokenComponents> {
    if !usage.is_object() {
        return None;
    }
    let field = |name: &str| claude_nonnegative_integer(&usage[name]);
    let input = field("input_tokens");
    let raw_output = field("output_tokens");
    let cache_read = field("cache_read_input_tokens");
    let (cache_write, cache_write_lower_bound) =
        if let Some(value) = claude_nonnegative_integer(&usage["cache_creation_input_tokens"]) {
            (Some(value), value)
        } else if usage["cache_creation"].is_object() {
            let five_minutes =
                claude_nonnegative_integer(&usage["cache_creation"]["ephemeral_5m_input_tokens"]);
            let one_hour =
                claude_nonnegative_integer(&usage["cache_creation"]["ephemeral_1h_input_tokens"]);
            let lower_bound = five_minutes
                .unwrap_or(0)
                .checked_add(one_hour.unwrap_or(0))?;
            (
                (five_minutes.is_some() && one_hour.is_some()).then_some(lower_bound),
                lower_bound,
            )
        } else {
            (None, 0)
        };
    let reasoning = claude_nonnegative_integer(&usage["reasoning_tokens"])
        .or_else(|| claude_nonnegative_integer(&usage["output_tokens_details"]["thinking_tokens"]))
        .map(|reasoning| raw_output.map_or(reasoning, |output| reasoning.min(output)));
    let output = raw_output
        .zip(reasoning)
        .map(|(output, reasoning)| output - reasoning);
    let known_total = input
        .unwrap_or(0)
        .checked_add(cache_read.unwrap_or(0))?
        .checked_add(cache_write_lower_bound)?
        .checked_add(raw_output.or(reasoning).unwrap_or(0))?;
    let complete =
        input.is_some() && cache_read.is_some() && cache_write.is_some() && raw_output.is_some();
    let total = claude_nonnegative_integer(&usage["total_tokens"])
        .filter(|explicit| *explicit >= known_total && (!complete || *explicit == known_total));
    Some(UsageTokenComponents {
        input,
        cache_read,
        cache_write,
        output,
        reasoning,
        total,
    })
}

fn claude_usage_signature(tokens: &UsageTokenComponents, usage: &Value) -> ClaudeUsageSignature {
    (
        tokens.input,
        tokens.cache_read,
        tokens.cache_write,
        claude_nonnegative_integer(&usage["output_tokens"]),
        tokens.reasoning,
    )
}

fn claude_usage_is_pending(usage: &Value, tokens: &UsageTokenComponents) -> bool {
    [
        tokens.input,
        tokens.cache_read,
        tokens.cache_write,
        claude_nonnegative_integer(&usage["output_tokens"]),
        tokens.reasoning,
    ]
    .into_iter()
    .all(|value| value.unwrap_or(0) == 0)
        && claude_nonnegative_integer(&usage["total_tokens"]).unwrap_or(0) == 0
}

fn claude_nonnegative_integer(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse().ok())
}

fn claude_event_vocabulary(
    record: &Value,
    kind: &str,
    reader_id: &str,
) -> (&'static str, &'static str, Option<(String, &'static str)>) {
    match kind {
        "user" => {
            let content = content(&record["message"]["content"], &record["content"]);
            let text = text_blocks(content);
            if task_notification(&text).is_some() {
                return (
                    "task",
                    "task.notification",
                    Some((reader_id.into(), "tool")),
                );
            }
            if !text.is_empty() {
                return (
                    "message",
                    "message.user",
                    Some((reader_id.into(), "message")),
                );
            }
            if let Some(blocks) = content.as_array() {
                if let Some((index, block)) = blocks
                    .iter()
                    .enumerate()
                    .find(|(_, block)| block["type"] == "tool_result")
                {
                    let id = block["tool_use_id"]
                        .as_str()
                        .map(|id| format!("tool-result:{id}"))
                        .unwrap_or_else(|| format!("{reader_id}:tool-result-{index}"));
                    return ("tool", "tool.result", Some((id, "tool")));
                }
            }
            ("source", "claude.unknown", None)
        }
        "assistant" => {
            let content = content(&record["message"]["content"], &record["content"]);
            if let Some(blocks) = content.as_array() {
                for (index, block) in blocks.iter().enumerate() {
                    match block["type"].as_str() {
                        Some("thinking" | "redacted_thinking") => {
                            return (
                                "message",
                                "message.reasoning",
                                Some((reader_id.into(), "thinking")),
                            );
                        }
                        Some("text") => {
                            let id = if blocks.len() == 1 {
                                reader_id.into()
                            } else {
                                format!("{reader_id}:{index}")
                            };
                            return ("message", "message.assistant", Some((id, "message")));
                        }
                        Some("tool_use") => {
                            let id = block["id"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| format!("{reader_id}:tool-{index}"));
                            return ("tool", "tool.call", Some((id, "tool")));
                        }
                        _ => {}
                    }
                }
            } else if content.is_string() {
                return (
                    "message",
                    "message.assistant",
                    Some((reader_id.into(), "message")),
                );
            }
            ("source", "claude.unknown", None)
        }
        "system" if record["subtype"] == "compact_boundary" => (
            "context",
            "context.compact",
            Some((reader_id.into(), "context")),
        ),
        "system" => ("source", "source.system", None),
        "tool_use" => ("tool", "tool.call", Some((reader_id.into(), "tool"))),
        "tool_result" => ("tool", "tool.result", Some((reader_id.into(), "tool"))),
        "summary" | "custom-title" | "custom_title" | "ai-title" => {
            ("session", "session.metadata", None)
        }
        "attachment" => ("source", "source.attachment", None),
        "file-history-snapshot" => ("source", "source.file_history", None),
        "last-prompt" => ("source", "source.last_prompt", None),
        "mode" | "permission-mode" => ("source", "source.mode", None),
        "queue-operation" => ("source", "source.queue_operation", None),
        _ => ("source", "claude.unknown", None),
    }
}

fn content<'a>(nested: &'a Value, fallback: &'a Value) -> &'a Value {
    if nested.is_null() { fallback } else { nested }
}

fn text_blocks(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    value
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn text_value(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(value) => value.to_string(),
    }
}

fn usage_total(usage: &Value) -> u64 {
    let field = |name: &str| usage[name].as_u64().unwrap_or(0);
    let cache_creation = usage["cache_creation_input_tokens"]
        .as_u64()
        .unwrap_or_else(|| {
            usage["cache_creation"]["ephemeral_5m_input_tokens"]
                .as_u64()
                .unwrap_or(0)
                + usage["cache_creation"]["ephemeral_1h_input_tokens"]
                    .as_u64()
                    .unwrap_or(0)
        });
    field("input_tokens")
        + field("output_tokens")
        + field("cache_read_input_tokens")
        + cache_creation
}

fn timestamp_ms(value: &Value) -> Option<i64> {
    value
        .as_str()?
        .parse::<jiff::Timestamp>()
        .ok()
        .map(|stamp| stamp.as_millisecond())
}

fn title(records: &[Value], id: &str, is_sidechain: bool) -> String {
    if is_sidechain {
        return id.into();
    }
    if let Some(title) = records.iter().rev().find_map(|record| {
        matches!(
            record["type"].as_str(),
            Some("custom-title" | "custom_title")
        )
        .then(|| record["customTitle"].as_str())
        .flatten()
    }) {
        return title.chars().take(160).collect();
    }
    if let Some(summary) = records.iter().rev().find_map(|record| {
        (record["type"] == "summary")
            .then(|| record["summary"].as_str())
            .flatten()
    }) {
        return summary.chars().take(160).collect();
    }
    records
        .iter()
        .filter(|record| record["type"] == "user")
        .map(|record| text_blocks(content(&record["message"]["content"], &record["content"])))
        .find(|text| !text.is_empty() && task_notification(text).is_none())
        .map(|text| text.chars().take(120).collect())
        .unwrap_or_else(|| "Claude Code session".into())
}

fn claude_agent_handoffs(
    record: &Value,
    line_index: usize,
    session_id: &str,
    agent_calls: &mut HashSet<String>,
) -> Vec<CoordinationObservation> {
    let Some(source_id) = record["uuid"].as_str().filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    let Some(blocks) = record["message"]["content"].as_array() else {
        return Vec::new();
    };
    let mut handoffs = Vec::new();
    for block in blocks {
        let (call_id, state, target, prompt, source_type, reader_id) = if record["type"]
            == "assistant"
            && block["type"] == "tool_use"
            && block["name"] == "Agent"
        {
            let Some(call_id) = block["id"].as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            agent_calls.insert(call_id.into());
            (
                call_id,
                "requested",
                None,
                block["input"]["prompt"].as_str(),
                "claude.assistant:tool_use:Agent",
                call_id.to_owned(),
            )
        } else if record["type"] == "user" && block["type"] == "tool_result" {
            let result = &record["toolUseResult"];
            let Some(call_id) = block["tool_use_id"]
                .as_str()
                .filter(|id| agent_calls.contains(*id))
            else {
                continue;
            };
            if result["isAsync"] != true || result["status"] != "async_launched" {
                continue;
            }
            let Some(agent_id) = result["agentId"]
                .as_str()
                .filter(|id| !id.trim().is_empty() && *id != session_id)
            else {
                continue;
            };
            (
                call_id,
                "started",
                Some(SessionRef {
                    provider: PROVIDER.into(),
                    session_id: agent_id.into(),
                }),
                result["prompt"].as_str(),
                "claude.user:toolUseResult:Agent",
                format!("tool-result:{call_id}"),
            )
        } else {
            continue;
        };
        handoffs.push(CoordinationObservation {
            kind: "spawn".into(),
            state: state.into(),
            correlation_id: call_id.into(),
            event_id: format!("event:claude:{line_index}"),
            from_session_ref: Some(SessionRef {
                provider: PROVIDER.into(),
                session_id: session_id.into(),
            }),
            to_session_ref: target,
            from_participant: None,
            to_participant: None,
            message_excerpt: prompt.map(|text| bounded_preview(text, PREVIEW_CHARS)),
            message_excerpt_truncated: prompt.map(|text| text.chars().count() > PREVIEW_CHARS),
            launch_request: None,
            from_actor_path: None,
            to_actor_path: None,
            reader_event: Some(event_ref(session_id, &reader_id, "tool")),
            provenance: RelationProvenance {
                fidelity: "recorded".into(),
                source_type: source_type.into(),
                source_id: source_id.into(),
            },
        });
    }
    handoffs
}

struct Notification {
    id: String,
    tool_use_id: Option<String>,
    status: Option<String>,
    summary: Option<String>,
}

fn task_notification(text: &str) -> Option<Notification> {
    let text = text.trim();
    if !text.starts_with("<task-notification>") || !text.ends_with("</task-notification>") {
        return None;
    }
    let field = |name: &str| {
        let start = format!("<{name}>");
        let end = format!("</{name}>");
        let value = text.split_once(&start)?.1.split_once(&end)?.0.trim();
        (!value.is_empty()).then(|| value.to_owned())
    };
    Some(Notification {
        id: field("task-id")?,
        tool_use_id: field("tool-use-id"),
        status: field("status"),
        summary: field("summary"),
    })
}

fn event_ref(session_id: &str, message_id: &str, segment: &str) -> EventRef {
    EventRef {
        provider: PROVIDER.into(),
        session_id: session_id.into(),
        message_id: message_id.into(),
        segment: segment.into(),
    }
}

#[allow(clippy::too_many_arguments)]
fn push_event(
    events: &mut Vec<NormalizedEvent>,
    session_id: &str,
    message_id: &str,
    segment: &str,
    role: &str,
    timestamp: Option<i64>,
    body: &str,
    tool_name: Option<&str>,
    tool_input: &str,
    tool_output: &str,
    owner: Option<EventRef>,
) {
    let content = if segment == "tool" { tool_output } else { body };
    let preview = if segment == "tool" {
        bounded_preview(
            &format!("{}: {content}", tool_name.unwrap_or("tool")),
            PREVIEW_CHARS,
        )
    } else {
        bounded_preview(content, PREVIEW_CHARS)
    };
    let item = ReaderItem {
        ordinal: events.len(),
        owner: owner.clone(),
        event: event_ref(session_id, message_id, segment),
        role: role.into(),
        timestamp,
        preview,
        total_chars: content.encode_utf16().count(),
        tool_name: tool_name.map(str::to_owned),
        owner_message_id: owner.map(|event| event.message_id),
        presentation_phase: None,
        process_id: None,
        process_count: None,
        tool_metadata: None,
        reply_metadata: None,
        content_revisions: Default::default(),
    };
    events.push(NormalizedEvent {
        item,
        body: body.into(),
        tool_input: tool_input.into(),
        tool_output: tool_output.into(),
        tool_status: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::EventQuery;

    fn usage_snapshot(rows: &[Value]) -> SessionSnapshot {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tmp");
        fs::create_dir_all(&root).unwrap();
        let dir = tempfile::Builder::new()
            .prefix("claude-usage-selection-")
            .tempdir_in(root)
            .unwrap();
        let path = dir.path().join("session.jsonl");
        fs::write(
            &path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        load(&path, "fixture", "session").unwrap()
    }

    #[test]
    fn usage_selection_pending_response_does_not_claim_final_usage() {
        let row = |uuid, usage| {
            serde_json::json!({"type":"assistant", "uuid":uuid,
            "message":{"id":"response-1", "content":[], "usage":usage}})
        };
        let pending = row(
            "pending",
            serde_json::json!({"input_tokens":0,"output_tokens":0}),
        );
        let final_row = row(
            "final",
            serde_json::json!({"input_tokens":10,"output_tokens":4}),
        );
        let snapshot = usage_snapshot(&[pending.clone(), final_row.clone(), final_row]);
        assert_eq!(snapshot.summary.token_count, Some(14));
        assert_eq!(usage_snapshot(&[pending]).summary.token_count, None);
    }

    #[test]
    fn usage_selection_legacy_equal_totals_keep_distinct_component_signatures() {
        let row = |uuid, input, output| {
            serde_json::json!({"type":"assistant", "uuid":uuid,
            "message":{"content":[],"usage":{"input_tokens":input,"output_tokens":output}}})
        };
        let first = row("first", 8, 2);
        let duplicate = row("fragment", 8, 2);
        let distinct = row("different-components", 7, 3);
        assert_eq!(
            usage_snapshot(&[first, duplicate, distinct])
                .summary
                .token_count,
            Some(20)
        );
    }

    #[test]
    fn current_structured_agent_launch_records_child_dispatch_without_a_run() {
        let root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/claude-current-agent");
        let adapter = ClaudeAdapter {
            root: &root,
            scope: "fixture",
        };
        let snapshot = adapter.load("parent").unwrap();
        let handoffs: Vec<_> = snapshot
            .relations
            .iter()
            .filter_map(|entry| match entry {
                RelationEntry::Coordination { observation } => Some(observation),
                _ => None,
            })
            .collect();
        assert_eq!(handoffs.len(), 2);
        assert_eq!(handoffs[0].state, "requested");
        assert_eq!(handoffs[0].to_session_ref, None);
        assert_eq!(handoffs[1].state, "started");
        assert_eq!(
            handoffs[1].to_session_ref.as_ref().unwrap().session_id,
            "child"
        );
        assert_eq!(handoffs[1].event_id, "event:claude:2");
        assert_eq!(
            handoffs[1].reader_event,
            Some(event_ref("parent", "tool-result:agent-call", "tool"))
        );
        let RelationEntry::Task { task } = &snapshot.relations[2] else {
            panic!("recorded notification");
        };
        assert_eq!(
            task.description.as_deref(),
            Some("Agent \"Run child marker check\" finished")
        );
        let bundle = adapter.protocol_bundle("parent").unwrap();
        let document = serde_json::to_value(bundle.document(3).unwrap()).unwrap();
        assert_eq!(document["coordination"].as_array().unwrap().len(), 2);
        assert_eq!(document["agentRuns"], serde_json::json!([]));
        assert_eq!(document["relationships"][0]["kind"], "child");
        assert_eq!(
            adapter
                .load("child")
                .unwrap()
                .summary
                .parent
                .unwrap()
                .session_id,
            "parent"
        );
    }

    #[test]
    fn agent_launch_keeps_missing_identity_or_unknown_status_unresolved() {
        let rows: Vec<Value> =
            include_str!("../../../../fixtures/claude-current-agent/transcripts/parent.jsonl")
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        for (field, value) in [
            ("status", serde_json::json!("unknown")),
            ("agentId", Value::Null),
        ] {
            let mut calls = HashSet::new();
            assert_eq!(
                claude_agent_handoffs(&rows[1], 1, "parent", &mut calls)[0].state,
                "requested"
            );
            let mut result = rows[2].clone();
            result["toolUseResult"][field] = value;
            assert!(claude_agent_handoffs(&result, 2, "parent", &mut calls).is_empty());
        }
        let mut unrelated = rows[1].clone();
        unrelated["message"]["content"][0]["name"] = serde_json::json!("Read");
        let mut calls = HashSet::new();
        assert!(claude_agent_handoffs(&unrelated, 1, "parent", &mut calls).is_empty());
        assert!(claude_agent_handoffs(&rows[2], 2, "parent", &mut calls).is_empty());
    }

    #[test]
    fn task_notification_without_recorded_status_stays_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let transcripts = dir.path().join("transcripts");
        fs::create_dir(&transcripts).unwrap();
        fs::write(
            transcripts.join("session.jsonl"),
            r#"{"type":"user","uuid":"notification-1","timestamp":"2026-09-27T00:00:00Z","message":{"content":"<task-notification><task-id>task-1</task-id><summary>Waiting for an update</summary></task-notification>"}}"#,
        )
        .unwrap();
        let adapter = ClaudeAdapter {
            root: dir.path(),
            scope: "fixture",
        };
        let snapshot = adapter.load("session").unwrap();
        let RelationEntry::Task { task } = &snapshot.relations[0] else {
            panic!("expected a recorded task notification");
        };
        assert_eq!(task.status, "unknown");
        assert_eq!(task.description.as_deref(), Some("Waiting for an update"));
        assert_eq!(task.provenance.source_id, "notification-1");
        assert_eq!(
            task.reader_event,
            Some(event_ref("session", "notification-1", "tool"))
        );
    }

    #[test]
    fn native_stream_keeps_current_and_legacy_source_rows() {
        for (fixture, id, kinds) in [
            (
                "claude-current-v259-synthetic.jsonl",
                "current",
                vec!["context.compact", "message.user", "message.assistant"],
            ),
            (
                "claude-legacy.jsonl",
                "legacy",
                vec!["message.user", "message.assistant"],
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let transcripts = dir.path().join("transcripts");
            fs::create_dir(&transcripts).unwrap();
            fs::copy(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../test/fixtures")
                    .join(fixture),
                transcripts.join(format!("{id}.jsonl")),
            )
            .unwrap();
            let adapter = ClaudeAdapter {
                root: dir.path(),
                scope: "fixture",
            };
            let snapshot = adapter.load(id).unwrap();
            let stream = adapter.protocol_event_stream(id).unwrap();
            let page = stream
                .events(EventQuery {
                    limit: 1,
                    ..EventQuery::default()
                })
                .unwrap();
            assert_eq!(page.events[0].kind, kinds[0]);
            assert_eq!(page.revision, snapshot.revision);
            let mut observed = Vec::new();
            let mut cursor = None;
            loop {
                let page = stream
                    .events(EventQuery {
                        limit: 1,
                        cursor,
                        ..EventQuery::default()
                    })
                    .unwrap();
                observed.extend(page.events.iter().map(|event| {
                    (
                        event.kind.clone(),
                        event.source_order.record,
                        event.reader_event.clone(),
                    )
                }));
                cursor = page.next_cursor;
                if cursor.is_none() {
                    break;
                }
            }
            assert_eq!(
                observed
                    .iter()
                    .map(|(kind, _, _)| kind.as_str())
                    .collect::<Vec<_>>(),
                kinds
            );
            assert!(
                observed
                    .iter()
                    .enumerate()
                    .all(|(index, (_, order, _))| *order == index as u64)
            );
            assert!(
                observed
                    .iter()
                    .skip(1)
                    .all(|(_, _, reference)| reference.is_some())
            );
        }
    }

    #[test]
    fn native_stream_keeps_opaque_rows_and_diagnoses_invalid_shape() {
        let dir = tempfile::tempdir().unwrap();
        let transcripts = dir.path().join("transcripts");
        fs::create_dir(&transcripts).unwrap();
        let path = transcripts.join("session.jsonl");
        fs::write(
            &path,
            "{\"type\":\"future-kind\",\"uuid\":\"future-1\",\"secret\":\"do not expose\"}\n",
        )
        .unwrap();
        let adapter = ClaudeAdapter {
            root: dir.path(),
            scope: "fixture",
        };
        let stream = adapter.protocol_event_stream("session").unwrap();
        let page = stream.events(EventQuery::default()).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].kind, "claude.unknown");
        assert_eq!(page.events[0].provenance.source_type, "claude.future-kind");
        assert_eq!(
            page.events[0].provenance.source_id.as_deref(),
            Some("future-1")
        );
        assert_eq!(page.events[0].provenance.fidelity, Fidelity::Recorded);
        assert!(
            !serde_json::to_string(&page)
                .unwrap()
                .contains("do not expose")
        );
        fs::write(&path, "{\"uuid\":\"bad-1\"}\n").unwrap();
        assert!(matches!(
            adapter.protocol_event_stream("session"),
            Err(CoreError::Protocol(_))
        ));
        fs::write(&path, "{\"type\":\"assistant\",\"uuid\":\"bad-2\",\"message\":{\"content\":{\"text\":\"bad\"}}}\n").unwrap();
        let error = adapter.protocol_event_stream("session").unwrap_err();
        assert!(
            matches!(error, CoreError::Protocol(ProtocolError::Invalid { diagnostics })
            if diagnostics[0].code == "invalid_claude_message_content")
        );
    }

    #[test]
    #[ignore = "requires an explicitly selected private Claude Code source manifest"]
    fn frozen_private_claude_native_stream_full_pagination() {
        let manifest_path = std::env::var_os("AGENTSESSION_V3_CLAUDE_PRIVATE_MANIFEST")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                panic!("set AGENTSESSION_V3_CLAUDE_PRIVATE_MANIFEST to the frozen private Claude Code manifest before explicitly running this ignored test")
            });
        let manifest: Value = serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
        let source = manifest["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["provider"] == PROVIDER)
            .unwrap();
        let path = Path::new(source["snapshotPath"].as_str().unwrap());
        let expected_sha = source["snapshotSha256"].as_str().unwrap();
        let before = fs::read(path).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&before)), expected_sha);
        let id = source["sessionId"].as_str().unwrap();
        let adapter = ClaudeAdapter {
            root: Path::new(
                manifest["providerRoots"][PROVIDER]["path"]
                    .as_str()
                    .unwrap(),
            ),
            scope: "frozen-claude",
        };
        let snapshot = adapter.load(id).unwrap();
        let stream = adapter.protocol_event_stream(id).unwrap();
        let refs: HashSet<_> = snapshot
            .events
            .iter()
            .map(|event| {
                (
                    event.item.event.message_id.as_str(),
                    event.item.event.segment.as_str(),
                )
            })
            .collect();
        let mut cursor = None;
        let mut seen = Vec::new();
        loop {
            let page = stream
                .events(EventQuery {
                    limit: 3,
                    cursor,
                    ..EventQuery::default()
                })
                .unwrap();
            assert_eq!(page.revision, snapshot.revision);
            for event in &page.events {
                if let Some(reference) = &event.reader_event {
                    assert!(
                        refs.contains(&(reference.message_id.as_str(), reference.segment.as_str()))
                    );
                }
                seen.push(event.source_order.record);
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            seen.len(),
            source["knownFacts"]["records"].as_u64().unwrap() as usize
        );
        assert_eq!(seen, (0..seen.len() as u64).collect::<Vec<_>>());
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(path).unwrap())),
            expected_sha
        );
    }

    #[test]
    fn recorded_thinking_names_the_following_tool_message_as_reader_owner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let rows = [
            serde_json::json!({"type":"assistant","uuid":"thought","message":{"id":"response-1","content":[{"type":"thinking","thinking":"Consider source"}]}}),
            serde_json::json!({"type":"assistant","uuid":"call","message":{"id":"response-1","content":[{"type":"tool_use","id":"tool-1","name":"Read","input":{"file":"sample"}}]}}),
            serde_json::json!({"type":"user","uuid":"result","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"done"}]}}),
        ];
        fs::write(
            &path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let snapshot = load(&path, "fixture", "session").unwrap();
        assert_eq!(snapshot.summary.message_count, 2);
        let thinking = &snapshot.events[0].item;
        assert_eq!(thinking.event, event_ref("session", "tool-1", "thinking"));
        assert_eq!(thinking.owner, Some(event_ref("session", "tool-1", "tool")));
        assert_eq!(
            snapshot.events[2].item.owner,
            Some(event_ref("session", "tool-1", "tool"))
        );
    }

    #[test]
    fn empty_or_corrupt_only_sources_are_unavailable_but_selected_corrupt_file_is_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = ClaudeAdapter {
            root: dir.path(),
            scope: "fixture",
        };
        assert!(!adapter.available());
        let transcripts = dir.path().join("transcripts");
        fs::create_dir(&transcripts).unwrap();
        fs::write(transcripts.join("broken.jsonl"), "{broken}\n").unwrap();
        assert!(!adapter.available());
        assert!(matches!(
            adapter.load("broken"),
            Err(CoreError::Parse { .. })
        ));
    }
}
