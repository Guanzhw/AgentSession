//! Pi JSONL discovery and active in-file branch projection.
pub(super) fn default_data_path(home: &std::path::Path) -> std::path::PathBuf {
    super::paths::probe(
        &[
            std::env::var_os("PI_CODING_AGENT_DIR").map(std::path::PathBuf::from),
            Some(home.join(".pi").join("agent")),
        ],
        home.join(".pi").join("agent"),
    )
}

use super::{NormalizedEvent, ProviderAdapter, SessionSnapshot, SourceEntry};
use crate::protocol::{
    BranchObservation, ContextTransformation, ContextVersion, Diagnostic, DomainCoverage,
    EventCandidate, EventStream, Evidence, Fidelity, ObservationCandidates, ObservationSnapshot,
    ObservationState, ProtocolBundle, ProtocolError, Provenance, RelationshipObservation,
    RetainedFrom, SourceOrder, UsageRecord, UsageTokenComponents, finalize_events,
    finalize_protocol_bundle,
};
use crate::{CoreError, EventRef, ReaderItem, Result, SessionRef, SessionSummary};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const PROVIDER: &str = "pi";
const PREVIEW_CHARS: usize = 240;

pub(super) struct PiAdapter<'a> {
    pub root: &'a Path,
    pub scope: &'a str,
}

impl PiAdapter<'_> {
    fn sources(&self) -> Result<BTreeMap<String, PathBuf>> {
        let mut sources = BTreeMap::new();
        let sessions = self.root.join("sessions");
        if !sessions.is_dir() {
            return Ok(sources);
        }
        for entry in WalkDir::new(&sessions).follow_links(false) {
            let entry = entry.map_err(|error| CoreError::Parse {
                path: sessions.clone(),
                reason: error.to_string(),
            })?;
            if !entry.file_type().is_file()
                || entry
                    .path()
                    .extension()
                    .is_none_or(|extension| extension != "jsonl")
            {
                continue;
            }
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let filename_id = uuid_suffix(stem).unwrap_or(stem);
            let id = read_header_id(path).unwrap_or_else(|| filename_id.to_owned());
            sources.entry(id).or_insert_with(|| path.to_path_buf());
        }
        Ok(sources)
    }
}

impl ProviderAdapter for PiAdapter<'_> {
    fn resume_command(&self) -> Option<crate::DefaultResumeCommand> {
        Some(crate::DefaultResumeCommand {
            command: crate::ResumeCommandSpec {
                executable: "pi".into(),
                args: vec!["--session".into(), "{sessionId}".into()],
                cwd: None,
            },
            npm: Some(crate::NpmResumeEntry {
                package: "@earendil-works/pi-coding-agent",
                bin: "pi",
            }),
        })
    }

    fn available(&self) -> bool {
        self.sources().is_ok_and(|sources| {
            sources
                .iter()
                .any(|(id, path)| read_header_id(path).as_deref() == Some(id))
        })
    }

    fn protocol_capabilities(&self) -> super::ProtocolCapabilities {
        super::protocol_capability_map(&[
            ("sessionEvents", "recorded"),
            ("sessionRelationships", "derived"),
            ("branches", "derived"),
        ])
    }

    fn unavailable_diagnostic(&self) -> &'static str {
        "Pi sessions are unavailable or unreadable"
    }

    fn list(&self) -> Result<Vec<SessionSummary>> {
        let mut summaries = Vec::new();
        for (id, path) in self.sources()? {
            // A damaged file does not hide independently readable sessions.
            if let Ok(snapshot) = load(&path, self.scope, &id) {
                summaries.push(snapshot.summary);
            }
        }
        Ok(summaries)
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
        let mut evidence = crate::SystemPromptEvidence::new(&summary, "pi-resolved");
        evidence.current_files(&summary, &["AGENTS.md"]);
        Ok(evidence)
    }

    fn protocol_event_stream(&self, session_id: &str) -> Result<EventStream> {
        let sources = self.sources()?;
        let path = sources.get(session_id).ok_or_else(|| CoreError::NotFound {
            provider: PROVIDER.into(),
            session_id: session_id.into(),
        })?;
        pi_protocol_stream(path, self.scope, session_id)
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
        let (stream, observations) = pi_protocol_source(path, self.scope, session_id)?;
        finalize_protocol_bundle(stream, observations).map_err(CoreError::Protocol)
    }

    fn supports_index(&self) -> bool {
        true
    }

    fn inventory(&self) -> Result<Option<Vec<SourceEntry>>> {
        self.sources()?
            .into_iter()
            .map(|(id, path)| {
                if read_header_id_strict(&path)? != id {
                    return Err(CoreError::Parse {
                        path,
                        reason: "Pi source header differs from selected canonical ID".into(),
                    });
                }
                SourceEntry::new(id, path)
            })
            .collect::<Result<Vec<_>>>()
            .map(Some)
    }

    fn capture(&self, entry: &SourceEntry) -> Result<SessionSnapshot> {
        load(&entry.path, self.scope, &entry.session_id)
    }
}

fn uuid_suffix(stem: &str) -> Option<&str> {
    let suffix = stem.rsplit('_').next()?;
    let groups: Vec<_> = suffix.split('-').collect();
    (groups.len() == 5
        && groups.iter().map(|group| group.len()).collect::<Vec<_>>() == [8, 4, 4, 4, 12]
        && groups
            .iter()
            .all(|group| group.bytes().all(|byte| byte.is_ascii_hexdigit())))
    .then_some(suffix)
}

fn read_header_id(path: &Path) -> Option<String> {
    read_header_id_strict(path).ok()
}

fn read_header_id_strict(path: &Path) -> Result<String> {
    let file = fs::File::open(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })?;
    let reader = BufReader::new(file);
    let mut first = None;
    for line in reader.lines() {
        let line = line.map_err(|source| CoreError::Io {
            path: path.into(),
            source,
        })?;
        if !line.trim().is_empty() {
            first = Some(line);
            break;
        }
    }
    let line = first.ok_or_else(|| CoreError::Parse {
        path: path.into(),
        reason: "empty Pi source".into(),
    })?;
    let header: Value = serde_json::from_str(&line).map_err(|error| CoreError::Parse {
        path: path.into(),
        reason: format!("invalid Pi header: {error}"),
    })?;
    if header["type"] != "session" {
        return Err(CoreError::Parse {
            path: path.into(),
            reason: "missing Pi session header".into(),
        });
    }
    header["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| CoreError::Parse {
            path: path.into(),
            reason: "Pi session header has no canonical ID".into(),
        })
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
    let mut hasher = Sha256::new();
    hasher.update(b"pi-jsonl-v3-branches-4\0");
    hasher.update(scope.as_bytes());
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(bytes);
    let revision = format!("{:x}", hasher.finalize());
    let mut records = Vec::new();
    let mut line_numbers = Vec::new();
    for (index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value = serde_json::from_slice::<Value>(line).map_err(|error| CoreError::Parse {
            path: path.into(),
            reason: format!("line {}: {error}", index + 1),
        })?;
        line_numbers.push(index);
        records.push(value);
    }
    let Some(header) = records.first().filter(|record| record["type"] == "session") else {
        return Err(CoreError::Parse {
            path: path.into(),
            reason: "missing Pi session header".into(),
        });
    };
    if header["id"].as_str() != Some(expected_id) {
        return Err(CoreError::Parse {
            path: path.into(),
            reason: "Pi header ID differs from canonical session ID".into(),
        });
    }
    let active = active_indices(&records);
    let active_set: HashSet<usize> = active.into_iter().collect();
    let mut events = Vec::new();
    let mut calls = HashMap::<String, usize>::new();
    let mut first_user = None::<String>;
    let mut created_at = timestamp_ms(&header["timestamp"]);
    let mut updated_at = created_at;
    let mut token_count = 0u64;
    let mut has_usage = false;
    let mut message_count = 0usize;

    for (index, record) in records.iter().enumerate() {
        let time = entry_timestamp(record);
        created_at = created_at.or(time);
        if time.is_some() {
            updated_at = time;
        }
        if let Some(total) = recorded_usage_total(record) {
            token_count = token_count.saturating_add(total);
            has_usage = true;
        }
        if !active_set.contains(&index) {
            continue;
        }
        let Some(id) = record["id"].as_str() else {
            continue;
        };
        match record["type"].as_str().unwrap_or("") {
            "compaction" | "branch_summary" => {
                let summary = record["summary"].as_str().unwrap_or("");
                if !summary.trim().is_empty() {
                    push_event(
                        &mut events,
                        expected_id,
                        id,
                        "message",
                        "system",
                        time,
                        summary,
                        None,
                        "",
                        "",
                        None,
                        None,
                    );
                    message_count += 1;
                }
            }
            "custom_message" if record["display"] == true => {
                let body = text_content(&record["content"]);
                push_event(
                    &mut events,
                    expected_id,
                    id,
                    "message",
                    "system",
                    time,
                    &body,
                    None,
                    "",
                    "",
                    None,
                    None,
                );
                message_count += 1;
            }
            "message" => {
                let message = &record["message"];
                match message["role"].as_str().unwrap_or("") {
                    "user" => {
                        let body = text_content(&message["content"]);
                        if first_user.is_none() && !body.trim().is_empty() {
                            first_user = Some(body.clone());
                        }
                        push_event(
                            &mut events,
                            expected_id,
                            id,
                            "message",
                            "user",
                            time,
                            &body,
                            None,
                            "",
                            "",
                            None,
                            None,
                        );
                        message_count += 1;
                    }
                    "assistant" => {
                        message_count += 1;
                        let mut owner = None::<EventRef>;
                        let body = text_content(&message["content"]);
                        let thinking = thinking_content(&message["content"]);
                        if !body.trim().is_empty() {
                            push_event(
                                &mut events,
                                expected_id,
                                id,
                                "message",
                                "assistant",
                                time,
                                &body,
                                None,
                                "",
                                "",
                                None,
                                None,
                            );
                            owner = Some(event_ref(expected_id, id, "message"));
                        }
                        if !thinking.is_empty() {
                            push_event(
                                &mut events,
                                expected_id,
                                id,
                                "thinking",
                                "assistant",
                                time,
                                &thinking,
                                None,
                                "",
                                "",
                                None,
                                None,
                            );
                            if owner.is_none() {
                                owner = Some(event_ref(expected_id, id, "thinking"));
                            }
                        }
                        if let Some(blocks) = message["content"].as_array() {
                            for block in blocks.iter().filter(|block| block["type"] == "toolCall") {
                                let Some(call_id) = block["id"].as_str() else {
                                    continue;
                                };
                                let input = json_content(&block["arguments"]);
                                calls.insert(call_id.into(), events.len());
                                push_event(
                                    &mut events,
                                    expected_id,
                                    call_id,
                                    "tool",
                                    "tool",
                                    time,
                                    "",
                                    block["name"].as_str(),
                                    &input,
                                    "",
                                    owner.clone(),
                                    None,
                                );
                                message_count += 1;
                            }
                        }
                    }
                    "toolResult" => {
                        let output = text_content(&message["content"]);
                        let call_id = message["toolCallId"].as_str().unwrap_or("");
                        if let Some(&position) = calls.get(call_id) {
                            events[position].tool_output = output.clone();
                            events[position].item.timestamp = time;
                            events[position].item.total_chars = output.encode_utf16().count();
                            events[position].tool_status = Some(if message["isError"] == true {
                                "error".into()
                            } else {
                                "completed".into()
                            });
                            let tool_name =
                                events[position].item.tool_name.as_deref().unwrap_or("tool");
                            events[position].item.preview =
                                format!("{}: {}", tool_name, preview(&output));
                        } else {
                            push_event(
                                &mut events,
                                expected_id,
                                id,
                                "tool",
                                "tool",
                                time,
                                "",
                                message["toolName"].as_str().or(Some("tool")),
                                "",
                                &output,
                                None,
                                Some(if message["isError"] == true {
                                    "error"
                                } else {
                                    "completed"
                                }),
                            );
                            message_count += 1;
                        }
                    }
                    "custom" | "hookMessage" if message["display"] == true => {
                        let body = text_content(&message["content"]);
                        push_event(
                            &mut events,
                            expected_id,
                            id,
                            "message",
                            "system",
                            time,
                            &body,
                            None,
                            "",
                            "",
                            None,
                            None,
                        );
                        message_count += 1;
                    }
                    "bashExecution" => {
                        let output = message["output"].as_str().unwrap_or("");
                        let input = serde_json::json!({"command": message["command"].as_str().unwrap_or("")}).to_string();
                        push_event(
                            &mut events,
                            expected_id,
                            id,
                            "tool",
                            "tool",
                            time,
                            "",
                            Some("bash"),
                            &input,
                            output,
                            None,
                            Some(
                                if message["exitCode"] == 0 && message["cancelled"] != true {
                                    "completed"
                                } else {
                                    "error"
                                },
                            ),
                        );
                        message_count += 1;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let session = SessionRef {
        provider: PROVIDER.into(),
        session_id: expected_id.into(),
    };
    let requests = pi_request_usage_records(&records, &line_numbers, &active_set, &session);
    let requests_by_source: HashMap<_, _> = requests
        .iter()
        .filter_map(|request| {
            request
                .provenance
                .source_id
                .as_deref()
                .map(|id| (id, request))
        })
        .collect();
    let reply_indices: HashMap<_, _> = events
        .iter()
        .enumerate()
        .map(|(index, event)| (event.item.event.clone(), index))
        .collect();
    for (_, record) in records
        .iter()
        .enumerate()
        .filter(|(index, _)| active_set.contains(index))
    {
        if record["type"] != "message" || record["message"]["role"] != "assistant" {
            continue;
        }
        let Some(id) = record["id"].as_str() else {
            continue;
        };
        let owner = EventRef {
            provider: PROVIDER.into(),
            session_id: expected_id.into(),
            message_id: id.into(),
            segment: "message".into(),
        };
        let Some(index) = reply_indices.get(&owner) else {
            continue;
        };
        let event = &mut events[*index];
        let message = &record["message"];
        let model = message["responseModel"]
            .as_str()
            .or_else(|| message["model"].as_str())
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(str::to_owned);
        let model_provider = message["provider"]
            .as_str()
            .map(str::trim)
            .filter(|provider| !provider.is_empty())
            .map(str::to_owned);
        event.item.reply_metadata = super::reply_metadata(
            model,
            model_provider,
            Provenance {
                fidelity: Fidelity::Recorded,
                source_type: "pi.entry:message.assistant.model".into(),
                source_id: Some(id.into()),
            },
            requests_by_source.get(id).copied(),
        );
    }
    let title = records
        .iter()
        .rev()
        .find_map(|record| {
            (record["type"] == "session_info")
                .then(|| {
                    record["name"]
                        .as_str()
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                })
                .flatten()
        })
        .map(str::to_owned)
        .or_else(|| first_user.map(|body| preview(&body)))
        .unwrap_or_else(|| "Pi session".into());
    let parent = header["parentSession"].as_str().and_then(|path| {
        let stem = path.rsplit(['/', '\\']).next()?.strip_suffix(".jsonl")?;
        uuid_suffix(stem).map(|id| SessionRef {
            provider: PROVIDER.into(),
            session_id: id.into(),
        })
    });
    Ok(SessionSnapshot {
        summary: SessionSummary {
            diagnostic: None,
            session: SessionRef {
                provider: PROVIDER.into(),
                session_id: expected_id.into(),
            },
            search_title: Some(title.clone()),
            title,
            directory: header["cwd"].as_str().map(str::to_owned),
            created_at,
            updated_at,
            message_count,
            conversation_message_count: None,
            token_count: has_usage.then_some(token_count),
            duration_ms: None,
            summary_files: None,
            summary_additions: None,
            summary_deletions: None,
            parent,
        },
        revision,
        events,
        relations: Vec::new(),
    })
}

fn pi_protocol_stream(path: &Path, scope: &str, session_id: &str) -> Result<EventStream> {
    pi_protocol_source(path, scope, session_id).map(|(stream, _)| stream)
}

fn pi_protocol_source(
    path: &Path,
    scope: &str,
    session_id: &str,
) -> Result<(EventStream, ObservationCandidates)> {
    let bytes = fs::read(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })?;
    let snapshot = load_bytes(path, scope, session_id, &bytes)?;
    let mut records = Vec::new();
    let mut line_numbers = Vec::new();
    for (line_index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let record: Value = serde_json::from_slice(line).map_err(|error| CoreError::Parse {
            path: path.into(),
            reason: format!("line {}: {error}", line_index + 1),
        })?;
        let kind = record["type"]
            .as_str()
            .filter(|kind| !kind.is_empty())
            .ok_or_else(|| {
                CoreError::Protocol(ProtocolError::Invalid {
                    diagnostics: vec![Diagnostic {
                        code: "invalid_pi_record_type",
                        event_id: Some(format!("event:pi:{line_index}")),
                    }],
                })
            })?;
        if kind == "message" {
            let role = record["message"]["role"].as_str();
            if role.is_none() {
                return Err(CoreError::Protocol(ProtocolError::Invalid {
                    diagnostics: vec![Diagnostic {
                        code: "invalid_pi_message_role",
                        event_id: Some(format!("event:pi:{line_index}")),
                    }],
                }));
            }
        }
        line_numbers.push(line_index);
        records.push(record);
    }
    let active: HashSet<_> = active_indices(&records).into_iter().collect();
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
    let mut candidates = Vec::with_capacity(records.len());
    let mut calls = HashSet::<String>::new();
    for (record_index, record) in records.iter().enumerate() {
        let line_index = line_numbers[record_index];
        let kind = record["type"].as_str().expect("validated Pi record type");
        let (category, event_kind) = pi_event_vocabulary(record, kind);
        let native_id = record["id"].as_str().filter(|id| !id.is_empty());
        let reader_identity = active
            .contains(&record_index)
            .then(|| pi_reader_identity(record, kind, native_id, &mut calls))
            .flatten();
        let reader_event = reader_identity
            .filter(|(id, segment)| reader_refs.contains(&(id.as_str(), *segment)))
            .map(|(id, segment)| event_ref(session_id, &id, segment));
        candidates.push(EventCandidate {
            id: format!("event:pi:{line_index}"),
            session: session.clone(),
            source_order: SourceOrder {
                record: line_index as u64,
                ordinal: 0,
            },
            timestamp: entry_timestamp(record),
            category: category.into(),
            kind: event_kind,
            provenance: Provenance {
                fidelity: Fidelity::Recorded,
                source_type: format!("pi.{kind}"),
                source_id: native_id.map(str::to_owned),
            },
            reader_event,
            execution: None,
        });
        if kind == "message" && record["message"]["role"] == "assistant" {
            let invalid_block = || {
                CoreError::Protocol(ProtocolError::Invalid {
                    diagnostics: vec![Diagnostic {
                        code: "invalid_pi_content_block",
                        event_id: Some(format!("event:pi:{line_index}")),
                    }],
                })
            };
            let blocks = record["message"]["content"]
                .as_array()
                .ok_or_else(invalid_block)?;
            for (index, block) in blocks.iter().enumerate() {
                let block_type = block["type"]
                    .as_str()
                    .filter(|kind| !kind.is_empty())
                    .ok_or_else(invalid_block)?;
                let (category, event_kind, identity) = match block_type {
                    "text" => {
                        block["text"].as_str().ok_or_else(invalid_block)?;
                        (
                            "message",
                            "message.assistant.text",
                            native_id.map(|id| (id, "message")),
                        )
                    }
                    "thinking" => {
                        block["thinking"].as_str().ok_or_else(invalid_block)?;
                        (
                            "reasoning",
                            "reasoning",
                            native_id.map(|id| (id, "thinking")),
                        )
                    }
                    "toolCall" => {
                        let id = block["id"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                            .ok_or_else(invalid_block)?;
                        ("tool", "tool.call", Some((id, "tool")))
                    }
                    _ => ("message", "content", None),
                };
                // Reader aggregates text/thinking for this message and excludes inactive branches.
                let reader_event = identity
                    .filter(|identity| {
                        active.contains(&record_index) && reader_refs.contains(identity)
                    })
                    .map(|(id, segment)| event_ref(session_id, id, segment));
                candidates.push(EventCandidate {
                    id: format!("event:pi:{line_index}:content:{index}"),
                    session: session.clone(),
                    source_order: SourceOrder {
                        record: line_index as u64,
                        ordinal: u32::try_from(index + 1).map_err(|_| invalid_block())?,
                    },
                    timestamp: entry_timestamp(record),
                    category: category.into(),
                    kind: event_kind.into(),
                    provenance: Provenance {
                        fidelity: Fidelity::Recorded,
                        source_type: format!("pi.message.content.{block_type}"),
                        source_id: native_id.map(str::to_owned),
                    },
                    reader_event,
                    execution: None,
                });
            }
        }
    }
    let mut observations = ObservationCandidates::default();
    let parent_path = records
        .first()
        .and_then(|header| header["parentSession"].as_str())
        .filter(|path| !path.is_empty());
    if let Some(parent) = snapshot.summary.parent.clone() {
        observations.relationships.push(RelationshipObservation {
            id: format!("relationship:pi:parent:{session_id}"),
            kind: "parent".into(),
            from: parent,
            to: session.clone(),
            correlation_id: None,
            evidence: Evidence {
                event_id: format!("event:pi:{}", line_numbers[0]),
                provenance: Provenance {
                    fidelity: Fidelity::Derived,
                    source_type: "pi.session.parentSession".into(),
                    source_id: Some(session_id.into()),
                },
            },
        });
    }
    observations.coverage.insert(
        "relationships".into(),
        DomainCoverage {
            state: if !observations.relationships.is_empty() {
                ObservationState::Observed
            } else if parent_path.is_some() {
                ObservationState::Unknown
            } else {
                ObservationState::NotObserved
            },
            details: "Pi header parentSession can identify a derived parent session; file-local entry parentId is not a cross-session link. Related session availability is unverified.".into(),
        },
    );
    observations.usage_records =
        pi_request_usage_records(&records, &line_numbers, &active, &session);
    for (domain, details) in [
        (
            "tasks",
            "Task projection is unported; message and branch records do not establish assignments.",
        ),
        (
            "agentRuns",
            "AgentRun projection is unported; file-local ancestry does not establish child runs.",
        ),
        (
            "context",
            "Compaction and branch summaries remain source events; context artifacts and transformations are unported.",
        ),
        (
            "work",
            "Goals, task lifecycle, and work graph are unported.",
        ),
        (
            "execution",
            "Tool records remain source events; execution lifecycle projection is unported.",
        ),
        (
            "coordination",
            "Actor and cross-session coordination projections are unported.",
        ),
        (
            "ownership",
            "Protocol events retain all source branches; exclusive session ownership is not asserted.",
        ),
    ] {
        observations.coverage.insert(
            domain.into(),
            DomainCoverage {
                state: ObservationState::Unknown,
                details: details.into(),
            },
        );
    }
    observations.coverage.insert(
        "usage".into(),
        DomainCoverage {
            state: if observations.usage_records.is_empty() {
                ObservationState::NotObserved
            } else {
                ObservationState::Observed
            },
            details: "One recorded request per distinct Pi assistant response; retainedTail and summary usage are outside this request domain.".into(),
        },
    );
    let stream = finalize_events(session, scope.into(), snapshot.revision, candidates)?;
    let by_source_id: HashMap<_, _> = records
        .iter()
        .enumerate()
        .filter_map(|(index, record)| {
            record["id"]
                .as_str()
                .map(|id| (id, format!("event:pi:{}", line_numbers[index])))
        })
        .collect();
    let (branches, complete_branches) =
        pi_branch_observations(session_id, &records, &line_numbers, &active);
    observations.branches = branches;
    observations.coverage.insert(
        "branches".into(),
        DomainCoverage {
            state: if !complete_branches {
                ObservationState::Unknown
            } else if observations.branches.is_empty() {
                ObservationState::NotObserved
            } else {
                ObservationState::Observed
            },
            details: "File-local parentId ancestry and branch_summary fromId identify the active head and validated abandoned paths; cross-session children are a separate relationship domain.".into(),
        },
    );
    for (record_index, record) in records.iter().enumerate() {
        if !active.contains(&record_index)
            || !matches!(
                record["type"].as_str(),
                Some("compaction" | "branch_summary")
            )
        {
            continue;
        }
        if record["summary"]
            .as_str()
            .is_none_or(|summary| summary.trim().is_empty())
        {
            continue;
        }
        let Some(source_id) = record["id"].as_str() else {
            continue;
        };
        let event_id = format!("event:pi:{}", line_numbers[record_index]);
        let Some(event) = stream
            .event_detail(&event_id)
            .map(|detail| detail.event)
            .filter(|event| event.reader_event.is_some())
        else {
            continue;
        };
        let provenance = event.provenance.clone();
        let version_id = format!("context-version:pi:{source_id}");
        observations.context_versions.push(ContextVersion {
            id: version_id.clone(),
            session_id: session_id.into(),
            sequence: event.sequence,
            parent_version_ids: vec![],
            artifact_ids: vec![],
            created_at: event.timestamp,
            reader_event: event.reader_event.clone(),
            provenance: provenance.clone(),
        });
        let retained_from = record["firstKeptEntryId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(|id| RetainedFrom {
                source_id: id.into(),
                event_id: by_source_id.get(id).cloned(),
            });
        observations
            .context_transformations
            .push(ContextTransformation {
                id: format!("context-transformation:pi:{source_id}"),
                session_id: session_id.into(),
                kind: "compaction",
                source_version_ids: vec![],
                source_artifact_ids: vec![],
                result_artifact_ids: vec![],
                result_version_id: version_id,
                event_id,
                run_id: None,
                turn_id: None,
                timestamp: event.timestamp,
                retained_from,
                retained_tail_count: record["retainedTail"].as_array().map(Vec::len),
                shadowed_range: None,
                shadowed_seqs: None,
                shadowed_token_count: None,
                provenance,
            });
    }
    let has_operation = records.iter().any(|record| {
        matches!(
            record["type"].as_str(),
            Some("compaction" | "branch_summary")
        )
    });
    observations.coverage.insert(
        "context".into(),
        DomainCoverage {
            state: if !observations.context_transformations.is_empty() {
                ObservationState::Observed
            } else if has_operation {
                ObservationState::Unknown
            } else {
                ObservationState::NotObserved
            },
            details: if !observations.context_transformations.is_empty() {
                "Active Pi compaction summaries have recorded Context results linked to Reader."
                    .into()
            } else if has_operation {
                "Compaction operation exists without an active readable summary result.".into()
            } else {
                "No Pi compaction or branch summary operation is recorded.".into()
            },
        },
    );
    Ok((stream, observations))
}

fn pi_event_vocabulary(record: &Value, kind: &str) -> (&'static str, String) {
    match kind {
        "session" => ("session", "session.meta".into()),
        "session_info" => ("session", "session.info".into()),
        "model_change" => ("config", "config.model".into()),
        "thinking_level_change" => ("config", "config.thinking".into()),
        "message" => match record["message"]["role"].as_str().unwrap_or("") {
            "user" => ("message", "message.user".into()),
            "assistant" => ("message", "message.assistant".into()),
            "toolResult" => ("tool", "tool.result".into()),
            "bashExecution" => ("tool", "tool.execution".into()),
            role => ("message", format!("message.{role}")),
        },
        "compaction" => ("context", "context.compact".into()),
        "branch_summary" => ("context", "context.branch_summary".into()),
        "custom_message" => ("message", "message.custom".into()),
        _ => ("source", "pi.unknown".into()),
    }
}

fn pi_reader_identity(
    record: &Value,
    kind: &str,
    native_id: Option<&str>,
    calls: &mut HashSet<String>,
) -> Option<(String, &'static str)> {
    let id = native_id?;
    match kind {
        "compaction" | "branch_summary" => Some((id.into(), "message")),
        "custom_message" if record["display"] == true => Some((id.into(), "message")),
        "message" => {
            let message = &record["message"];
            match message["role"].as_str()? {
                "user" => Some((id.into(), "message")),
                "assistant" => {
                    let body = text_content(&message["content"]);
                    let thinking = thinking_content(&message["content"]);
                    let mut tool = None;
                    if let Some(blocks) = message["content"].as_array() {
                        for block in blocks.iter().filter(|block| block["type"] == "toolCall") {
                            if let Some(call_id) = block["id"].as_str() {
                                calls.insert(call_id.into());
                                tool.get_or_insert_with(|| call_id.to_owned());
                            }
                        }
                    }
                    if !body.trim().is_empty() {
                        Some((id.into(), "message"))
                    } else if !thinking.is_empty() {
                        Some((id.into(), "thinking"))
                    } else {
                        tool.map(|call_id| (call_id, "tool"))
                    }
                }
                "toolResult" => {
                    let call_id = message["toolCallId"].as_str().unwrap_or("");
                    if calls.contains(call_id) {
                        Some((call_id.into(), "tool"))
                    } else {
                        Some((id.into(), "tool"))
                    }
                }
                "custom" | "hookMessage" if message["display"] == true => {
                    Some((id.into(), "message"))
                }
                "bashExecution" => Some((id.into(), "tool")),
                _ => None,
            }
        }
        _ => None,
    }
}

fn active_indices(records: &[Value]) -> Vec<usize> {
    let entries: Vec<_> = records
        .iter()
        .enumerate()
        .filter(|(_, record)| record["type"] != "session" && record["id"].as_str().is_some())
        .map(|(index, _)| index)
        .collect();
    let version = records
        .first()
        .and_then(|record| record["version"].as_u64())
        .unwrap_or(1);
    if version < 2
        || entries
            .iter()
            .any(|index| records[*index].get("parentId").is_none())
    {
        return entries;
    }
    let by_id: HashMap<_, _> = entries
        .iter()
        .filter_map(|index| records[*index]["id"].as_str().map(|id| (id, *index)))
        .collect();
    let mut branch = Vec::new();
    let mut seen = HashSet::new();
    let mut current = entries.last().copied();
    while let Some(index) = current {
        if !seen.insert(index) {
            break;
        }
        branch.push(index);
        current = records[index]["parentId"]
            .as_str()
            .and_then(|id| by_id.get(id).copied());
    }
    branch.reverse();
    branch
}

fn pi_branch_observations(
    session_id: &str,
    records: &[Value],
    line_numbers: &[usize],
    active: &HashSet<usize>,
) -> (Vec<BranchObservation>, bool) {
    let by_id: HashMap<_, _> = records
        .iter()
        .enumerate()
        .filter_map(|(index, record)| record["id"].as_str().map(|id| (id, index)))
        .collect();
    let Some((head_index, head_id)) =
        records
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, record)| {
                (record["type"] != "session" && active.contains(&index))
                    .then(|| record["id"].as_str().map(|id| (index, id)))
                    .flatten()
            })
    else {
        return (vec![], true);
    };
    let mut abandoned = Vec::new();
    let mut covered_inactive = HashSet::new();
    let mut incomplete = false;
    let mut active_fork = None;
    for (summary_index, summary) in records
        .iter()
        .enumerate()
        .filter(|(_, record)| record["type"] == "branch_summary")
    {
        if !active.contains(&summary_index) {
            incomplete = true;
            continue;
        }
        let Some((summary_id, fork_id, from_id)) = summary["id"]
            .as_str()
            .zip(summary["parentId"].as_str())
            .zip(summary["fromId"].as_str())
            .map(|((summary_id, fork_id), from_id)| (summary_id, fork_id, from_id))
        else {
            incomplete = true;
            continue;
        };
        let Some((&fork_index, &from_index)) = by_id.get(fork_id).zip(by_id.get(from_id)) else {
            incomplete = true;
            continue;
        };
        if !active.contains(&fork_index)
            || active.contains(&from_index)
            || !(fork_index < from_index && from_index < summary_index)
        {
            incomplete = true;
            continue;
        }
        let mut path = Vec::new();
        let mut seen = HashSet::new();
        let mut current = Some(from_index);
        while let Some(index) = current {
            if index == fork_index {
                break;
            }
            if !seen.insert(index) || active.contains(&index) {
                current = None;
                break;
            }
            path.push(index);
            current = records[index]["parentId"]
                .as_str()
                .and_then(|id| by_id.get(id).copied());
        }
        if current != Some(fork_index) {
            incomplete = true;
            continue;
        }
        covered_inactive.extend(path);
        active_fork = Some((fork_id, fork_index));
        abandoned.push(BranchObservation {
            id: format!("branch:pi:{session_id}:abandoned:{summary_id}"),
            fork_entry_id: Some(fork_id.into()),
            fork_event_id: Some(format!("event:pi:{}", line_numbers[fork_index])),
            head_entry_id: from_id.into(),
            head_event_id: format!("event:pi:{}", line_numbers[from_index]),
            selected: false,
            evidence: Evidence {
                event_id: format!("event:pi:{}", line_numbers[summary_index]),
                provenance: Provenance {
                    fidelity: Fidelity::Recorded,
                    source_type: "pi.branch_summary.fromId".into(),
                    source_id: Some(summary_id.into()),
                },
            },
        });
    }
    if records.iter().enumerate().any(|(index, record)| {
        record["type"] != "session"
            && record["id"].as_str().is_some()
            && !active.contains(&index)
            && !covered_inactive.contains(&index)
    }) {
        incomplete = true;
    }
    let mut branches = vec![BranchObservation {
        id: format!("branch:pi:{session_id}:active"),
        fork_entry_id: active_fork.map(|(id, _)| id.into()),
        fork_event_id: active_fork.map(|(_, index)| format!("event:pi:{}", line_numbers[index])),
        head_entry_id: head_id.into(),
        head_event_id: format!("event:pi:{}", line_numbers[head_index]),
        selected: true,
        evidence: Evidence {
            event_id: format!("event:pi:{}", line_numbers[head_index]),
            provenance: Provenance {
                fidelity: Fidelity::Derived,
                source_type: "pi.session.active-file".into(),
                source_id: Some(head_id.into()),
            },
        },
    }];
    branches.extend(abandoned);
    (branches, !incomplete)
}

fn recorded_usage_total(record: &Value) -> Option<u64> {
    let usage = match record["type"].as_str()? {
        "message"
            if matches!(
                record["message"]["role"].as_str(),
                Some("assistant" | "toolResult")
            ) =>
        {
            &record["message"]["usage"]
        }
        "compaction" | "branch_summary" => &record["usage"],
        _ => return None,
    };
    if !usage.is_object() {
        return None;
    }
    usage["totalTokens"]
        .as_u64()
        .filter(|total| *total > 0)
        .or_else(|| {
            Some(
                ["input", "output", "cacheRead", "cacheWrite"]
                    .iter()
                    .filter_map(|field| usage[*field].as_u64())
                    .sum(),
            )
        })
}

fn pi_non_negative_integer(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse().ok())
}

fn pi_request_tokens(usage: &Value) -> Option<UsageTokenComponents> {
    if !usage.is_object() {
        return None;
    }
    let input = pi_non_negative_integer(&usage["input"]);
    let cache_read = pi_non_negative_integer(&usage["cacheRead"]);
    let cache_write = pi_non_negative_integer(&usage["cacheWrite"]);
    let raw_output = pi_non_negative_integer(&usage["output"]);
    let reasoning = pi_non_negative_integer(&usage["reasoning"])
        .map(|reasoning| raw_output.map_or(reasoning, |output| reasoning.min(output)));
    let output = raw_output
        .zip(reasoning)
        .map(|(output, reasoning)| output - reasoning);
    let known_total = input
        .unwrap_or(0)
        .checked_add(cache_read.unwrap_or(0))?
        .checked_add(cache_write.unwrap_or(0))?
        .checked_add(raw_output.or(reasoning).unwrap_or(0))?;
    let complete =
        input.is_some() && cache_read.is_some() && cache_write.is_some() && raw_output.is_some();
    let explicit = &usage["totalTokens"];
    let total = if explicit.is_null() || explicit == "" {
        complete.then_some(known_total)
    } else {
        pi_non_negative_integer(explicit)
            .filter(|value| *value >= known_total && (!complete || *value == known_total))
    };
    Some(UsageTokenComponents {
        input,
        cache_read,
        cache_write,
        output,
        reasoning,
        total,
    })
}

fn pi_deferred_assistant(message: &Value) -> bool {
    matches!(message["stopReason"].as_str(), Some("deferred" | "pending"))
        || !matches!(message["deferred"], Value::Null | Value::Bool(false))
}

fn entry_timestamp(record: &Value) -> Option<i64> {
    timestamp_ms(&record["message"]["timestamp"]).or_else(|| timestamp_ms(&record["timestamp"]))
}

fn timestamp_ms(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_str()?
            .parse::<jiff::Timestamp>()
            .ok()
            .map(|value| value.as_millisecond())
    })
}

fn text_content(value: &Value) -> String {
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

fn thinking_content(value: &Value) -> String {
    value
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block["type"] == "thinking")
                .filter_map(|block| block["thinking"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn json_content(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
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
    id: &str,
    segment: &str,
    role: &str,
    timestamp: Option<i64>,
    body: &str,
    tool_name: Option<&str>,
    tool_input: &str,
    tool_output: &str,
    owner: Option<EventRef>,
    status: Option<&str>,
) {
    let text = if segment == "tool" { tool_output } else { body };
    let item = ReaderItem {
        ordinal: events.len(),
        owner: owner.clone(),
        event: event_ref(session_id, id, segment),
        role: role.into(),
        timestamp,
        preview: if segment == "tool" {
            format!("{}: {}", tool_name.unwrap_or("tool"), preview(tool_output))
        } else {
            preview(text)
        },
        total_chars: text.encode_utf16().count(),
        tool_name: tool_name.map(str::to_owned),
        owner_message_id: owner.map(|owner| owner.message_id),
        presentation_phase: None,
        process_id: None,
        process_count: None,
        tool_metadata: None,
        reply_metadata: None,
        content_revisions: Default::default(),
    };
    events.push(NormalizedEvent {
        item,
        body: if segment == "tool" {
            String::new()
        } else {
            body.into()
        },
        tool_input: tool_input.into(),
        tool_output: tool_output.into(),
        tool_status: status.map(str::to_owned),
    });
}

fn preview(text: &str) -> String {
    let mut out = String::new();
    let mut units = 0;
    for character in text.chars() {
        if units + character.len_utf16() > PREVIEW_CHARS {
            out.push('…');
            break;
        }
        out.push(character);
        units += character.len_utf16();
    }
    out
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    use crate::protocol::{EventQuery, Fidelity, ProtocolError};

    fn fixture(name: &str, id: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions").join("fixture");
        fs::create_dir_all(&sessions).unwrap();
        let path = sessions.join(format!("{name}_{id}.jsonl"));
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test/fixtures")
                .join(name),
            &path,
        )
        .unwrap();
        (dir, path)
    }

    #[test]
    fn native_events_keep_physical_rows_and_branch_ownership() {
        for (name, id, abandoned) in [
            (
                "pi-v3-current.jsonl",
                "019f8a00-0000-7000-8000-000000000001",
                "asst0001",
            ),
            (
                "pi-current.jsonl",
                "019f7b00-0000-7000-8000-000000000001",
                "oldasst1",
            ),
        ] {
            let (dir, path) = fixture(name, id);
            let before = fs::read(&path).unwrap();
            let adapter = PiAdapter {
                root: dir.path(),
                scope: "fixture",
            };
            let snapshot = adapter.load(id).unwrap();
            let stream = adapter.protocol_event_stream(id).unwrap();
            let mut cursor = None;
            let mut seen = Vec::new();
            loop {
                let page = stream
                    .events(EventQuery {
                        limit: 2,
                        cursor,
                        ..EventQuery::default()
                    })
                    .unwrap();
                assert_eq!(page.revision, snapshot.revision);
                for event in page.events {
                    if event.source_order.ordinal != 0 {
                        continue;
                    }
                    assert_eq!(event.provenance.fidelity, Fidelity::Recorded);
                    assert!(event.provenance.source_type.starts_with("pi."));
                    if let Some(reference) = &event.reader_event {
                        assert!(
                            snapshot
                                .events
                                .iter()
                                .any(|item| item.item.event == *reference)
                        );
                    }
                    seen.push((
                        event.source_order.record,
                        event.provenance.source_id.clone(),
                        event.reader_event.clone(),
                        event.kind.clone(),
                    ));
                }
                cursor = page.next_cursor;
                if cursor.is_none() {
                    break;
                }
            }
            let records = before
                .split(|byte| *byte == b'\n')
                .enumerate()
                .filter(|(_, line)| !line.iter().all(u8::is_ascii_whitespace))
                .collect::<Vec<_>>();
            assert_eq!(seen.len(), records.len());
            assert_eq!(
                seen.iter().map(|row| row.0).collect::<Vec<_>>(),
                records
                    .iter()
                    .map(|(index, _)| *index as u64)
                    .collect::<Vec<_>>()
            );
            for ((_, source_id, _, _), (_, line)) in seen.iter().zip(records) {
                let record: Value = serde_json::from_slice(line).unwrap();
                assert_eq!(source_id.as_deref(), record["id"].as_str());
            }
            assert!(
                seen.iter()
                    .any(
                        |(_, source_id, reader, _)| source_id.as_deref() == Some(abandoned)
                            && reader.is_none()
                    )
            );
            assert!(
                seen.iter()
                    .any(
                        |(_, source_id, reader, kind)| source_id.as_deref() == Some("compact1")
                            && reader.is_some()
                            && kind == "context.compact"
                    )
            );
            assert!(
                !serde_json::to_string(&stream.events(EventQuery::default()).unwrap())
                    .unwrap()
                    .contains("Earlier Pi")
            );
            assert_eq!(fs::read(&path).unwrap(), before);
        }
    }

    #[test]
    fn native_events_diagnose_bad_records() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let path = sessions.join("bad.jsonl");
        let adapter = PiAdapter {
            root: dir.path(),
            scope: "fixture",
        };
        fs::write(
            &path,
            "{\"type\":\"session\",\"id\":\"bad\"}\n{\"id\":\"bad-row\"}\n",
        )
        .unwrap();
        assert!(matches!(adapter.protocol_event_stream("bad"),
            Err(CoreError::Protocol(ProtocolError::Invalid { diagnostics }))
            if diagnostics[0].code == "invalid_pi_record_type"));
        fs::write(&path, "{\"type\":\"session\",\"id\":\"bad\"}\nnot-json\n").unwrap();
        assert!(matches!(
            adapter.protocol_event_stream("bad"),
            Err(CoreError::Parse { .. })
        ));
    }

    #[test]
    fn frozen_private_pi_events_cover_all_rows_without_source_mutation() {
        let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/v3-corpus/manifest.private.json");
        if !manifest_path.exists() {
            return;
        }
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
        let root = Path::new(
            manifest["providerRoots"][PROVIDER]["path"]
                .as_str()
                .unwrap(),
        );
        let id = source["sessionId"].as_str().unwrap();
        let adapter = PiAdapter {
            root,
            scope: "frozen-pi",
        };
        let snapshot = adapter.load(id).unwrap();
        let stream = adapter.protocol_event_stream(id).unwrap();
        let mut cursor = None;
        let mut orders = Vec::new();
        loop {
            let page = stream
                .events(EventQuery {
                    limit: 2,
                    cursor,
                    ..EventQuery::default()
                })
                .unwrap();
            assert_eq!(page.revision, snapshot.revision);
            orders.extend(
                page.events
                    .iter()
                    .filter(|event| event.source_order.ordinal == 0)
                    .map(|event| event.source_order.record),
            );
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        let expected = before
            .split(|byte| *byte == b'\n')
            .enumerate()
            .filter(|(_, line)| !line.iter().all(u8::is_ascii_whitespace))
            .map(|(index, _)| index as u64)
            .collect::<Vec<_>>();
        assert_eq!(orders, expected);
        assert_eq!(
            orders.len() as u64,
            source["knownFacts"]["records"].as_u64().unwrap()
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(path).unwrap())),
            expected_sha
        );
    }
}

fn pi_request_usage_records(
    records: &[Value],
    line_numbers: &[usize],
    active: &HashSet<usize>,
    session: &SessionRef,
) -> Vec<UsageRecord> {
    let session_id = &session.session_id;
    let mut usage_records = Vec::<UsageRecord>::new();
    let mut request_index = HashMap::<String, usize>::new();
    for (record_index, record) in records.iter().enumerate() {
        if record["type"] != "message" || record["message"]["role"] != "assistant" {
            continue;
        }
        let message = &record["message"];
        let Some(tokens) = pi_request_tokens(&message["usage"]) else {
            continue;
        };
        if pi_deferred_assistant(message)
            && [
                tokens.input,
                tokens.cache_read,
                tokens.cache_write,
                pi_non_negative_integer(&message["usage"]["output"]),
                tokens.reasoning,
            ]
            .into_iter()
            .all(|value| value.unwrap_or(0) == 0)
        {
            continue;
        }
        let response_id = message["responseId"]
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let Some(entry_id) = record["id"]
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let identity = response_id.map_or_else(
            || format!("entry:{entry_id}"),
            |id| format!("response:{id}"),
        );
        let record = UsageRecord {
            id: format!("usage:{session_id}:request:{identity}"),
            scope: "request",
            session_ref: session.clone(),
            timestamp: entry_timestamp(record),
            model: message["responseModel"]
                .as_str()
                .or_else(|| message["model"].as_str())
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_owned),
            model_provider: message["provider"]
                .as_str()
                .map(str::trim)
                .filter(|provider| !provider.is_empty())
                .map(str::to_owned),
            run_id: None,
            event_id: active
                .contains(&record_index)
                .then(|| format!("event:pi:{}", line_numbers[record_index])),
            turn_id: None,
            tokens,
            context_origin_slices: vec![],
            provenance: Provenance {
                fidelity: Fidelity::Recorded,
                source_type: "pi.entry:message.assistant.usage".into(),
                source_id: Some(entry_id.into()),
            },
        };
        if let Some(index) = request_index.get(&identity).copied() {
            if usage_records[index].event_id.is_none() && record.event_id.is_some() {
                usage_records[index] = record;
            }
        } else {
            request_index.insert(identity, usage_records.len());
            usage_records.push(record);
        }
    }
    usage_records
}
