//! DeepSeek Harness historical and current storage with recorded collaboration facts.
pub(super) fn default_data_path(home: &std::path::Path) -> std::path::PathBuf {
    super::paths::probe(
        &[
            std::env::var_os("DSH_HOME").map(std::path::PathBuf::from),
            Some(home.join(".dsh")),
        ],
        home.join(".dsh"),
    )
}

use super::{
    InheritedContextSnapshot, InheritedEvent, NormalizedEvent, ProviderAdapter, SessionSnapshot,
    SourceEntry,
};
use crate::protocol::{
    ContextObservation, ContextTransformation, ContextVersion, CoordinationFact, Diagnostic,
    DomainCoverage, EventCandidate, EventStream, Evidence, Fidelity, ObservationCandidates,
    ObservationSnapshot, ObservationState, ProtocolBundle, Provenance, RelationshipObservation,
    RunStatus, ShadowedRange, SourceOrder, TaskObservation, UsageRecord, UsageTokenComponents,
    finalize_events, finalize_protocol_bundle,
};
use crate::{
    ContentPage, CoordinationObservation, CoreError, EventRef, InheritedItem, ReaderItem,
    RelationEntry, RelationParticipant, RelationParticipantKind, RelationProvenance, RelationTask,
    Result, SessionRef, SessionSummary,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const PROVIDER: &str = "deepseek-harness";
const PREVIEW_CHARS: usize = 240;
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
const SQLITE_CANDIDATES: [&str; 6] = [
    "sessions.sqlite",
    "sessions.sqlite3",
    "sessions.db",
    "dsh.sqlite",
    "dsh.sqlite3",
    "dsh.db",
];

pub(super) struct DshAdapter<'a> {
    pub root: &'a Path,
    pub scope: &'a str,
}

fn sqlite_storage_diagnostic(root: &Path) -> Option<Value> {
    for name in SQLITE_CANDIDATES {
        let path = root.join(name);
        let Ok(mut file) = fs::File::open(&path) else {
            continue;
        };
        let mut header = [0u8; SQLITE_HEADER.len()];
        if file.read(&mut header).ok() != Some(header.len()) || &header != SQLITE_HEADER {
            continue;
        }
        let path = path.to_string_lossy().into_owned();
        return Some(serde_json::json!({
            "backend": "sqlite",
            "status": "unsupported",
            "path": path,
            "detectedSchema": null,
            "expectedSchema": 17,
            "message": format!(
                "Legacy DeepSeek Harness SQLite persistence was detected at {path}, but AgentSession does not inspect or migrate that database. The current reader supports JSONL; schema 17 remains documented for existing stores."
            ),
        }));
    }
    None
}

fn parse_error(path: &Path, reason: impl Into<String>) -> CoreError {
    CoreError::Parse {
        diagnostic: crate::ParseDiagnostic::new("invalid DSH source structure"),
        path: path.into(),
        reason: reason.into(),
    }
}

fn session_ref(id: &str) -> SessionRef {
    SessionRef {
        provider: PROVIDER.into(),
        session_id: id.into(),
    }
}

fn event_ref(id: &str, message_id: &str, segment: &str) -> EventRef {
    EventRef {
        provider: PROVIDER.into(),
        session_id: id.into(),
        message_id: message_id.into(),
        segment: segment.into(),
    }
}

fn required<'a>(value: &'a Value, field: &str, path: &Path) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| parse_error(path, format!("missing or invalid {field}")))
}

fn integer(value: &Value, field: &str, path: &Path) -> Result<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| parse_error(path, format!("missing or invalid {field}")))
}

fn text_blocks(value: &Value, path: &Path) -> Result<String> {
    let blocks = value
        .as_array()
        .ok_or_else(|| parse_error(path, "message content is not an array"))?;
    let mut text = String::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => text.push_str(
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| parse_error(path, "invalid text block"))?,
            ),
            // Keep non-text source evidence accessible through bounded content reads.
            Some("image") => {
                text.push_str(&block.to_string());
            }
            _ => return Err(parse_error(path, "unsupported DSH content block")),
        }
    }
    Ok(text)
}

fn preview(text: &str) -> String {
    text.chars().take(PREVIEW_CHARS).collect()
}

fn team_message_excerpt(content: &Value) -> Option<(String, bool)> {
    let mut excerpt = String::new();
    let mut total_chars = 0usize;
    for block in content.as_array()? {
        let Some(text) = block
            .get("text")
            .and_then(Value::as_str)
            .filter(|_| block.get("type").and_then(Value::as_str) == Some("text"))
        else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        if total_chars > 0 {
            let remaining = PREVIEW_CHARS.saturating_sub(total_chars);
            excerpt.extend("\n\n".chars().take(remaining));
            total_chars = total_chars.saturating_add(2);
        }
        excerpt.extend(text.chars().take(PREVIEW_CHARS.saturating_sub(total_chars)));
        total_chars = total_chars.saturating_add(text.chars().count());
    }
    (!excerpt.is_empty()).then_some((excerpt, total_chars > PREVIEW_CHARS))
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn provenance(kind: &str, seq: u64) -> RelationProvenance {
    RelationProvenance {
        fidelity: "recorded".into(),
        source_type: format!("dsh.session-event:{kind}"),
        source_id: seq.to_string(),
    }
}

fn observation(
    kind: &str,
    state: &str,
    correlation_id: &str,
    source_type: &str,
    seq: u64,
    from: &str,
    to: &str,
) -> CoordinationObservation {
    CoordinationObservation {
        kind: kind.into(),
        state: state.into(),
        correlation_id: correlation_id.into(),
        event_id: format!("event:dsh:{seq}"),
        from_session_ref: Some(session_ref(from)),
        to_session_ref: Some(session_ref(to)),
        from_participant: None,
        to_participant: None,
        message_excerpt: None,
        message_excerpt_truncated: None,
        launch_request: None,
        from_actor_path: None,
        to_actor_path: None,
        reader_event: None,
        provenance: provenance(source_type, seq),
    }
}

fn member_or_sender(
    members: &HashMap<String, RelationParticipant>,
    id: &str,
    sender_name: Option<&str>,
    sender_seq: u64,
) -> Option<RelationParticipant> {
    members.get(id).cloned().or_else(|| {
        sender_name
            .filter(|name| !name.is_empty())
            .map(|name| RelationParticipant {
                id: id.into(),
                kind: RelationParticipantKind::Sender,
                name: name.into(),
                description: None,
                provenance: provenance("team/message/queued", sender_seq),
            })
    })
}

fn add_message(
    events: &mut Vec<NormalizedEvent>,
    session_id: &str,
    time: i64,
    role: &str,
    message_id: &str,
    body: String,
) {
    if body.is_empty() && role != "assistant" {
        return;
    }
    let item = ReaderItem {
        ordinal: events.len(),
        owner: None,
        event: event_ref(session_id, message_id, "message"),
        role: role.into(),
        timestamp: Some(time),
        preview: preview(&body),
        total_chars: body.encode_utf16().count(),
        tool_name: None,
        owner_message_id: None,
        presentation_phase: None,
        process_id: None,
        process_count: None,
        tool_metadata: None,
        reply_metadata: None,
        content_revisions: Default::default(),
    };
    events.push(NormalizedEvent {
        item,
        body,
        tool_input: String::new(),
        tool_output: String::new(),
        tool_status: None,
    });
}

fn add_compaction_checkpoint(
    events: &mut Vec<NormalizedEvent>,
    session_id: &str,
    time: i64,
    seq: u64,
    data: &Value,
) {
    let Some(blocks) = data["summary"].as_array() else {
        return;
    };
    let body: String = blocks
        .iter()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect();
    if body.trim().is_empty() {
        return;
    }
    events.push(NormalizedEvent {
        item: ReaderItem {
            ordinal: events.len(),
            owner: None,
            event: event_ref(session_id, &format!("compaction:{seq}"), "context"),
            role: "context".into(),
            timestamp: Some(time),
            preview: preview(&body),
            total_chars: body.encode_utf16().count(),
            tool_name: None,
            owner_message_id: None,
            presentation_phase: None,
            process_id: None,
            process_count: None,
            tool_metadata: None,
            reply_metadata: None,
            content_revisions: Default::default(),
        },
        body,
        tool_input: String::new(),
        tool_output: String::new(),
        tool_status: None,
    });
}

fn add_tool(
    events: &mut Vec<NormalizedEvent>,
    calls: &mut HashMap<String, usize>,
    session_id: &str,
    time: i64,
    id: &str,
    name: &str,
    arguments: &Value,
    owner: Option<EventRef>,
    path: &Path,
) -> Result<()> {
    if arguments.is_null() {
        return Err(parse_error(path, "missing tool arguments"));
    }
    let input = arguments
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| arguments.to_string());
    if let Some(index) = calls.get(id) {
        let previous = &events[*index];
        if previous.tool_input != input || previous.item.tool_name.as_deref() != Some(name) {
            return Err(parse_error(path, format!("conflicting tool call {id}")));
        }
        return Ok(());
    }
    calls.insert(id.into(), events.len());
    events.push(NormalizedEvent {
        item: ReaderItem {
            ordinal: events.len(),
            owner: owner.clone(),
            event: event_ref(session_id, id, "tool"),
            role: "tool".into(),
            timestamp: Some(time),
            preview: name.into(),
            total_chars: 0,
            tool_name: Some(name.into()),
            owner_message_id: owner.map(|owner| owner.message_id),
            presentation_phase: None,
            process_id: None,
            process_count: None,
            tool_metadata: None,
            reply_metadata: None,
            content_revisions: Default::default(),
        },
        body: String::new(),
        tool_input: input,
        tool_output: String::new(),
        tool_status: None,
    });
    Ok(())
}

// Recognized runtime/configuration rows are not conversation messages. They are
// accepted here without inventing Reader messages or collaboration relations.
// Keep this vocabulary evidence-bounded; unknown records remain diagnostics.
fn supported_event(kind: &str) -> bool {
    matches!(
        kind,
        "turn/start"
            | "turn/end"
            | "step/start"
            | "step/end"
            | "subagent/descriptor"
            | "subagent/catalog"
            | "session-log-deepseek/delivery-accepted"
            | "user/message"
            | "assistant/message"
            | "assistant/attempt"
            | "llm/retry-started"
            | "tool/call"
            | "tool/result"
            | "team/member"
            | "team/task"
            | "team/message/queued"
            | "team/message/delivered"
            | "tool-workflow/agent-start"
            | "tool-workflow/agent-end"
            | "tool-workflow/run-start"
            | "tool-workflow/run-end"
            | "permission/preset"
            | "sandbox/mode"
            | "approval/policy"
            | "model/selection"
            | "agent/inbox/spliced"
            | "system/message"
            | "session/title"
            | "request/header"
            | "request/context"
            | "session/title-llm-request"
            | "command/run"
            | "command/done"
            | "goal/change"
            | "todo/write"
            | "web/deepseek-search-llm-request"
            | "compaction/start"
            | "compaction/summary"
            | "compaction/end"
            | "session/end-seed"
    )
}

fn historical_event(kind: &str, generation: u8) -> bool {
    if matches!(
        kind,
        "system/message"
            | "subagent/catalog"
            | "tool/ptc-dispatch"
            | "tool/ptc-dispatch-start"
            | "deliverables/presented"
    ) {
        return false;
    }
    if generation == 1
        && matches!(
            kind,
            "assistant/attempt" | "feedback/message-put" | "feedback/message-delete"
        )
    {
        return false;
    }
    supported_event(kind)
        || matches!(
            kind,
            "agent-preset/selected"
                | "approval/asked"
                | "approval/decided"
                | "compaction/prune"
                | "feedback/record"
                | "feedback/message-put"
                | "feedback/message-delete"
                | "hook/invoked"
                | "hook/result"
                | "llm/retry"
                | "plan/mode"
                | "schedule/change"
                | "session-log-deepseek/delivery-accepted"
                | "subagent/model-selection-policy"
                | "tool/code-dispatch"
                | "tool/code-dispatch-start"
        )
        || (generation == 1 && kind == "assistant/chunk")
}

fn historical_source_seqs(row: &Value, seq: u64, path: &Path) -> Result<Option<Vec<u64>>> {
    let Some(encoded) = row.get("sourceEventSeqs") else {
        return Ok(None);
    };
    let entries = encoded
        .as_array()
        .ok_or_else(|| parse_error(path, "invalid sourceEventSeqs"))?;
    let mut decoded = Vec::new();
    let mut contains_range = false;
    for entry in entries {
        if let Some(source) = entry.as_u64() {
            decoded.push(source);
        } else {
            let range = entry
                .as_array()
                .filter(|range| range.len() == 2)
                .ok_or_else(|| parse_error(path, "invalid sourceEventSeqs range"))?;
            let start = range[0]
                .as_u64()
                .ok_or_else(|| parse_error(path, "invalid sourceEventSeqs range"))?;
            let end = range[1]
                .as_u64()
                .ok_or_else(|| parse_error(path, "invalid sourceEventSeqs range"))?;
            if end < start || end - start >= seq {
                return Err(parse_error(path, "invalid sourceEventSeqs range"));
            }
            contains_range = true;
            decoded.extend(start..=end);
        }
    }
    if decoded.iter().any(|source| *source >= seq)
        || decoded.iter().collect::<HashSet<_>>().len() != decoded.len()
        || (contains_range && decoded.windows(2).any(|pair| pair[0] >= pair[1]))
    {
        return Err(parse_error(path, "invalid sourceEventSeqs provenance"));
    }
    Ok(Some(decoded))
}

fn validate_historical_header(header: &Value, generation: u8, path: &Path) -> Result<()> {
    let fields = header
        .as_object()
        .ok_or_else(|| parse_error(path, "invalid DSH header"))?;
    let allowed = [
        "type",
        "version",
        "id",
        "createdAt",
        "cwd",
        "parentSession",
        "origin",
        "delegationDepth",
        "agentPreset",
        if generation == 1 {
            "seedLength"
        } else {
            "isSeeded"
        },
    ];
    if let Some(field) = fields
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(parse_error(
            path,
            format!("unexpected v{generation} header field {field}"),
        ));
    }
    for field in ["createdAt", "delegationDepth"] {
        if integer(header, field, path)? > 9_007_199_254_740_991 {
            return Err(parse_error(path, format!("invalid session.{field}")));
        }
    }
    if header
        .get("parentSession")
        .is_some_and(|value| !value.is_string())
    {
        return Err(parse_error(path, "invalid session.parentSession"));
    }
    if header
        .get("agentPreset")
        .is_some_and(|value| !value.is_string())
    {
        return Err(parse_error(path, "invalid session.agentPreset"));
    }
    if header
        .get("origin")
        .is_some_and(|value| value != "subagent")
    {
        return Err(parse_error(path, "invalid session.origin"));
    }
    if let Some(cwd) = header.get("cwd") {
        let cwd = cwd
            .as_str()
            .ok_or_else(|| parse_error(path, "invalid session.cwd"))?;
        let windows_absolute = cwd.as_bytes().get(1) == Some(&b':')
            && cwd
                .as_bytes()
                .get(2)
                .is_some_and(|byte| matches!(byte, b'/' | b'\\'));
        if !(cwd.starts_with('/') || cwd.starts_with("\\\\") || windows_absolute) {
            return Err(parse_error(path, "invalid session.cwd"));
        }
    }
    Ok(())
}

fn validate_historical_event_envelope(
    row: &Value,
    kind: &str,
    seq: u64,
    path: &Path,
) -> Result<()> {
    let fields = row
        .as_object()
        .ok_or_else(|| parse_error(path, "invalid DSH event"))?;
    let allowed = [
        "type",
        "seq",
        "time",
        "data",
        "ignorable",
        "surfaceOp",
        "sourceEventSeqs",
    ];
    if let Some(field) = fields
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(parse_error(
            path,
            format!("unexpected {kind} field {field} at seq {seq}"),
        ));
    }
    if row.get("ignorable").is_some_and(|value| value != true) {
        return Err(parse_error(
            path,
            format!("invalid {kind}.ignorable at seq {seq}"),
        ));
    }
    for field in ["seq", "time"] {
        if integer(row, field, path)? > 9_007_199_254_740_991 {
            return Err(parse_error(
                path,
                format!("invalid {kind}.{field} at seq {seq}"),
            ));
        }
    }
    Ok(())
}

#[derive(Clone)]
struct WorkflowStart {
    source_seq: u64,
    child_id: String,
}

type LoadedDsh = (
    SessionSnapshot,
    Vec<EventCandidate>,
    Vec<UsageRecord>,
    Vec<Diagnostic>,
    Vec<InheritedEvent>,
    Vec<DshCompaction>,
);

struct DshCompaction {
    seq: u64,
    shadowed_range: Option<ShadowedRange>,
    shadowed_seqs: Option<Vec<u64>>,
    shadowed_token_count: Option<u64>,
}

fn recorded_compactions(
    rows: &[Value],
    owned_from_seq: u64,
    path: &Path,
) -> Result<Vec<DshCompaction>> {
    rows.iter()
        .filter(|row| row["type"] == "compaction/summary")
        .filter(|row| row["seq"].as_u64().is_some_and(|seq| seq >= owned_from_seq))
        .map(|row| {
            let seq = integer(row, "seq", path)?;
            let data = &row["data"];
            let shadowed_range = data
                .get("shadowedRange")
                .filter(|value| !value.is_null())
                .map(|range| {
                    let start = integer(range, "start", path)?;
                    let end = integer(range, "end", path)?;
                    if start > end {
                        return Err(parse_error(
                            path,
                            format!("invalid compaction shadowedRange at seq {seq}"),
                        ));
                    }
                    Ok(ShadowedRange { start, end })
                })
                .transpose()?;
            let shadowed_seqs = data
                .get("shadowedSeqs")
                .filter(|value| !value.is_null())
                .map(|value| {
                    value
                        .as_array()
                        .ok_or_else(|| {
                            parse_error(
                                path,
                                format!("invalid compaction shadowedSeqs at seq {seq}"),
                            )
                        })?
                        .iter()
                        .map(|value| {
                            value.as_u64().ok_or_else(|| {
                                parse_error(
                                    path,
                                    format!("invalid compaction shadowedSeqs at seq {seq}"),
                                )
                            })
                        })
                        .collect::<Result<Vec<_>>>()
                })
                .transpose()?;
            let shadowed_token_count = data
                .get("shadowedTokenCount")
                .filter(|value| !value.is_null())
                .map(|_| integer(data, "shadowedTokenCount", path))
                .transpose()?;
            Ok(DshCompaction {
                seq,
                shadowed_range,
                shadowed_seqs,
                shadowed_token_count,
            })
        })
        .collect()
}

fn dsh_usage_count(value: Option<&Value>) -> Option<Option<u64>> {
    match value {
        None => Some(None),
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= 9_007_199_254_740_991)
            .map(Some),
    }
}

fn dsh_usage_tokens(value: &Value, generation: u8) -> Option<UsageTokenComponents> {
    let input = dsh_usage_count(value.get("inputTokens"))??;
    let raw_output = dsh_usage_count(value.get("outputTokens"))??;
    let cache_read = dsh_usage_count(value.get("cacheReadTokens"))?;
    let cache_write = dsh_usage_count(value.get("cacheWriteTokens"))?;
    let reasoning = dsh_usage_count(value.get("reasoningTokens"))?;
    let total = dsh_usage_count(value.get("totalTokens"))?;
    if reasoning.is_some_and(|reasoning| reasoning > raw_output) {
        return None;
    }
    let known = input
        .checked_add(cache_read.unwrap_or(0))?
        .checked_add(cache_write.unwrap_or(0))?
        .checked_add(raw_output)?;
    if total.is_some_and(|total| {
        total < known || (cache_read.is_some() && cache_write.is_some() && total != known)
    }) {
        return None;
    }
    Some(UsageTokenComponents {
        input: Some(input),
        cache_read,
        cache_write,
        output: reasoning.map(|reasoning| raw_output - reasoning),
        reasoning,
        total: if generation < 3 {
            total.or_else(|| (cache_read.is_some() && cache_write.is_some()).then_some(known))
        } else {
            total
        },
    })
}

fn dsh_usage_sample(row: &Value) -> Option<&Value> {
    let data = row.get("data")?;
    if row["type"] == "assistant/message" {
        if let Some(usage) = data.get("usage") {
            return Some(usage);
        }
    }
    data.get("stream")?
        .as_array()?
        .iter()
        .rev()
        .find(|item| item["type"] == "usage")?
        .get("usage")
}

fn dsh_request_usage_records(
    rows: &[Value],
    session_id: &str,
    owned_from_seq: u64,
    generation: u8,
) -> (Vec<UsageRecord>, Vec<Diagnostic>) {
    let mut selected = Vec::<UsageRecord>::new();
    let mut slots = HashMap::<(u64, u64), usize>::new();
    let mut diagnostics = Vec::new();
    for row in rows.iter().skip(1) {
        if row["seq"].as_u64().is_some_and(|seq| seq < owned_from_seq) {
            continue;
        }
        let kind = row["type"].as_str().expect("validated DSH source type");
        let data = &row["data"];
        let slot = data["turn"].as_u64().zip(data["step"].as_u64());
        if kind == "llm/retry-started" {
            if let Some(slot) = slot {
                slots.remove(&slot);
            }
            continue;
        }
        if !(kind == "assistant/message" || (generation > 0 && kind == "assistant/attempt")) {
            continue;
        }
        let Some(sample) = dsh_usage_sample(row) else {
            continue;
        };
        let seq = row["seq"].as_u64().expect("validated DSH source sequence");
        let Some(tokens) = dsh_usage_tokens(sample, generation) else {
            diagnostics.push(Diagnostic {
                code: "invalid_dsh_request_usage".into(),
                event_id: Some(format!("event:dsh:{seq}")),
            });
            continue;
        };
        if generation > 0 && slot.is_none() {
            diagnostics.push(Diagnostic {
                code: "invalid_dsh_request_usage".into(),
                event_id: Some(format!("event:dsh:{seq}")),
            });
            continue;
        }
        let model_source = dsh_model_source(data);
        let model = model_source
            .and_then(|source| source["model"].as_str())
            .map(str::to_owned);
        let model_provider = model_source
            .and_then(|source| source["provider"].as_str())
            .filter(|provider| !provider.trim().is_empty())
            .map(str::to_owned);
        let record = UsageRecord {
            id: format!("usage:dsh:{session_id}:{seq}"),
            scope: "request",
            session_ref: session_ref(session_id),
            timestamp: row["time"].as_i64(),
            model,
            model_provider,
            run_id: None,
            event_id: Some(format!("event:dsh:{seq}")),
            turn_id: data["turn"].as_u64().map(|turn| turn.to_string()),
            tokens,
            context_origin_slices: Vec::new(),
            provenance: Provenance {
                fidelity: Fidelity::Recorded,
                source_type: format!("dsh.session-event:{kind}:usage"),
                source_id: Some(seq.to_string()),
            },
        };
        if let Some((turn, step)) = slot.filter(|_| generation > 0) {
            if let Some(index) = slots.get(&(turn, step)).copied() {
                selected[index] = record;
            } else {
                slots.insert((turn, step), selected.len());
                selected.push(record);
            }
        } else {
            selected.push(record);
        }
    }
    (selected, diagnostics)
}

fn complete_zstd_frames(bytes: &[u8], path: &Path) -> Result<Vec<(usize, usize)>> {
    let mut frames = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let start = offset;
        if bytes.len() - offset < 4 {
            break;
        }
        if bytes[offset..offset + 4] != [0x28, 0xb5, 0x2f, 0xfd] {
            return Err(CoreError::Parse {
                path: path.into(),
                reason: format!("invalid Zstandard frame magic at byte {offset}"),
                diagnostic: crate::ParseDiagnostic::new("invalid Zstandard frame magic"),
            });
        }
        offset += 4;
        if offset == bytes.len() {
            break;
        }
        let descriptor = bytes[offset];
        offset += 1;
        if descriptor & 0x18 != 0 {
            return Err(CoreError::Parse {
                path: path.into(),
                reason: format!("reserved Zstandard frame header bit at byte {}", offset - 1),
                diagnostic: crate::ParseDiagnostic::new("reserved Zstandard frame header bit"),
            });
        }
        let size_flag = descriptor >> 6;
        let single_segment = descriptor & 0x20 != 0;
        let checksum = descriptor & 0x04 != 0;
        let dictionary_bytes = match descriptor & 0x03 {
            3 => 4,
            value => value as usize,
        };
        let content_bytes = if size_flag == 0 {
            usize::from(single_segment)
        } else {
            1usize << size_flag
        };
        let header_bytes = usize::from(!single_segment) + dictionary_bytes + content_bytes;
        if bytes.len() - offset < header_bytes {
            break;
        }
        offset += header_bytes;
        let complete = loop {
            if bytes.len() - offset < 3 {
                break false;
            }
            let header = usize::from(bytes[offset])
                | (usize::from(bytes[offset + 1]) << 8)
                | (usize::from(bytes[offset + 2]) << 16);
            offset += 3;
            let block_type = (header >> 1) & 3;
            if block_type == 3 {
                return Err(CoreError::Parse {
                    path: path.into(),
                    reason: format!("reserved Zstandard block type at byte {}", offset - 3),
                    diagnostic: crate::ParseDiagnostic::new("reserved Zstandard block type"),
                });
            }
            let payload_bytes = if block_type == 1 { 1 } else { header >> 3 };
            if bytes.len() - offset < payload_bytes {
                break false;
            }
            offset += payload_bytes;
            if header & 1 != 0 {
                if checksum {
                    if bytes.len() - offset < 4 {
                        break false;
                    }
                    offset += 4;
                }
                break true;
            }
        };
        if !complete {
            break;
        }
        frames.push((start, offset));
    }
    if frames.is_empty() {
        return Err(CoreError::Parse {
            path: path.into(),
            reason: "Zstandard session has no complete header frame".into(),
            diagnostic: crate::ParseDiagnostic::new(
                "Zstandard session has no complete header frame",
            ),
        });
    }
    Ok(frames)
}

fn read_dsh_rows(path: &Path, bytes: &[u8]) -> Result<Vec<Value>> {
    let compressed = path.to_string_lossy().ends_with(".zstd");
    let decoded = if compressed {
        let mut decoded = Vec::new();
        for (start, end) in complete_zstd_frames(bytes, path)? {
            decoded.extend(
                zstd::stream::decode_all(&bytes[start..end]).map_err(|error| CoreError::Parse {
                    path: path.into(),
                    reason: format!("Zstandard decode failed: {error}"),
                    diagnostic: crate::ParseDiagnostic::new("Zstandard decoding failed"),
                })?,
            );
        }
        if !decoded.is_empty() && !decoded.ends_with(b"\n") {
            return Err(CoreError::Parse {
                path: path.into(),
                reason: "complete Zstandard frame contains torn JSONL record".into(),
                diagnostic: crate::ParseDiagnostic::new(
                    "complete Zstandard frame contains torn JSONL record",
                ),
            });
        }
        decoded
    } else {
        bytes.to_vec()
    };
    let mut rows = Vec::new();
    let lines: Vec<_> = decoded.split(|byte| *byte == b'\n').collect();
    for (line, raw) in lines.iter().enumerate() {
        if raw.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice(raw) {
            Ok(row) => rows.push(row),
            Err(_) if !compressed && line + 1 == lines.len() && !decoded.ends_with(b"\n") => break,
            Err(error) => {
                return Err(CoreError::Parse {
                    path: path.into(),
                    reason: format!("invalid JSONL line {}: {error}", line + 1),
                    diagnostic: crate::ParseDiagnostic::json(&error, line),
                });
            }
        }
    }
    Ok(rows)
}

fn versioned_revision(path: &Path, scope: &str, generation: u8, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(match generation {
        4 => b"dsh-v4-2\0".as_slice(),
        3 => b"dsh-v3-s2-2\0".as_slice(),
        _ => b"dsh-v1-v2-3\0".as_slice(),
    });
    hasher.update(scope.as_bytes());
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn load_versioned_with_protocol(path: &Path, scope: &str, expected_id: &str) -> Result<LoadedDsh> {
    let generation = match path.file_name().and_then(|name| name.to_str()) {
        Some("session.v1.jsonl" | "session.v1.jsonl.zstd") => 1,
        Some("session.v2.jsonl" | "session.v2.jsonl.zstd") => 2,
        Some("session.v3.jsonl" | "session.v3.jsonl.zstd") => 3,
        Some("session.v4.jsonl" | "session.v4.jsonl.zstd") => 4,
        _ => return Err(parse_error(path, "unsupported DSH source generation")),
    };
    let bytes = fs::read(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })?;
    let revision = versioned_revision(path, scope, generation, &bytes);
    let mut rows = read_dsh_rows(path, &bytes)?;
    if generation == 1 {
        rows = rows
            .into_iter()
            .map(|row| expand_v0_packed_row(row, path))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
    }
    let header = rows
        .first()
        .ok_or_else(|| parse_error(path, "empty DSH source"))?;
    if header.get("type").and_then(Value::as_str) != Some("session")
        || header.get("version").and_then(Value::as_u64) != Some(generation.into())
    {
        return Err(parse_error(
            path,
            "DSH header version disagrees with selected source generation",
        ));
    }
    if generation < 3 {
        validate_historical_header(header, generation, path)?;
    }
    if required(header, "id", path)? != expected_id {
        return Err(parse_error(
            path,
            "header canonical ID differs from session directory",
        ));
    }
    if generation < 3 {
        integer(header, "delegationDepth", path)?;
    }
    let is_seeded = if generation >= 2 {
        if header.get("seedLength").is_some() {
            return Err(parse_error(path, "v2/v3 header cannot carry seedLength"));
        }
        header
            .get("isSeeded")
            .and_then(Value::as_bool)
            .ok_or_else(|| parse_error(path, "missing or invalid session.isSeeded"))?
    } else {
        if header.get("isSeeded").is_some() {
            return Err(parse_error(path, "v1 header cannot carry isSeeded"));
        }
        false
    };
    let seed_length = if generation == 1 {
        header
            .get("seedLength")
            .map(|_| integer(header, "seedLength", path))
            .transpose()?
            .unwrap_or(0)
    } else {
        0
    };
    if seed_length > (rows.len() - 1) as u64 {
        return Err(parse_error(
            path,
            "session.seedLength exceeds stored event count",
        ));
    }
    let inherited_boundary = rows
        .iter()
        .skip(1)
        .filter(|row| row["type"] == "session/end-seed" && row["data"]["inherited"] == true)
        .filter_map(|row| row["seq"].as_u64())
        .last();
    let owned_from_seq = if generation == 1 {
        seed_length
    } else if is_seeded {
        inherited_boundary.ok_or_else(|| {
            parse_error(
                path,
                format!("seeded DSH v{generation} source lacks inherited session/end-seed marker"),
            )
        })?
    } else {
        if inherited_boundary.is_some() {
            return Err(parse_error(
                path,
                format!(
                    "unseeded DSH v{generation} source contains inherited session/end-seed marker"
                ),
            ));
        }
        0
    };
    let created_at = i64::try_from(integer(header, "createdAt", path)?)
        .map_err(|_| parse_error(path, "session.createdAt exceeds timestamp range"))?;
    let cwd = header.get("cwd").and_then(Value::as_str).map(str::to_owned);
    let parent = header
        .get("parentSession")
        .and_then(Value::as_str)
        .map(session_ref);
    let mut events = Vec::<NormalizedEvent>::new();
    let mut relation_rows = Vec::<(u64, RelationEntry)>::new();
    let mut team_tasks = BTreeMap::<String, (u64, u64, RelationTask)>::new();
    let mut team_members = HashMap::<String, RelationParticipant>::new();
    let mut workflow_starts = BTreeMap::<(String, u64), WorkflowStart>::new();
    let mut workflow_ends = HashMap::<(String, u64), String>::new();
    let mut queued = HashMap::<String, (String, String, Option<String>, u64)>::new();
    let mut tool_calls = HashMap::<String, usize>::new();
    let mut latest_assistant: Option<EventRef> = None;
    let mut reply_owners = HashMap::<u64, EventRef>::new();
    let mut inherited_event_end = None;
    let mut updated_at = created_at;
    let mut surface_heads = Vec::<u64>::new();
    let mut stored_title = None;
    let mut system_head = None;

    for (expected_seq, row) in rows.iter().skip(1).enumerate() {
        let kind = required(row, "type", path)?;
        let seq = integer(row, "seq", path)?;
        if seq != expected_seq as u64 {
            return Err(parse_error(
                path,
                format!("non-contiguous DSH seq: expected {expected_seq}, got {seq}"),
            ));
        }
        if generation < 3 {
            validate_historical_event_envelope(row, kind, seq, path)?;
        }
        if inherited_event_end.is_none() && seq >= owned_from_seq {
            let owned_event_start = events.len();
            inherited_event_end = Some(owned_event_start);
            tool_calls.retain(|_, index| *index >= owned_event_start);
            latest_assistant = None;
        }
        let time = i64::try_from(integer(row, "time", path)?).map_err(|_| {
            parse_error(
                path,
                format!("event time exceeds timestamp range at seq {seq}"),
            )
        })?;
        updated_at = time;
        if generation < 3 && !row["data"].is_object() {
            return Err(parse_error(
                path,
                format!("missing {kind}.data at seq {seq}"),
            ));
        }
        if !(if generation >= 3 {
            supported_event(kind)
                || (generation >= 3 && matches!(kind, "llm/retry"))
                || (generation == 4
                    && matches!(
                        kind,
                        "developer/message" | "compaction/prune" | "workspace/changes"
                    ))
                || matches!(
                    kind,
                    "agent-preset/selected"
                        | "approval/asked"
                        | "approval/decided"
                        | "deliverables/presented"
                        | "tool/ptc-dispatch-start"
                        | "tool/ptc-dispatch"
                )
        } else {
            historical_event(kind, generation)
        }) {
            // An ignorable record is explicitly marked optional by the
            // producer (only the exact true literal qualifies). Unknown kinds
            // with that flag stay loadable for every generation instead of
            // failing the whole session source.
            if row["ignorable"] == true {
                continue;
            }
            return Err(parse_error(
                path,
                format!("unsupported required DSH v{generation} event {kind} at seq {seq}"),
            ));
        }
        let data = row
            .get("data")
            .filter(|value| value.is_object())
            .ok_or_else(|| parse_error(path, format!("missing {kind}.data at seq {seq}")))?;
        if generation == 4
            && matches!(
                kind,
                "user/message"
                    | "system/message"
                    | "assistant/message"
                    | "tool/result"
                    | "developer/message"
            )
        {
            let message = if kind == "user/message" {
                data
            } else {
                &data["message"]
            };
            let source_kind = required(&message["source"], "kind", path)?;
            if source_kind == "plugin" {
                return Err(parse_error(
                    path,
                    "v4 message requires a producer-owned source kind",
                ));
            }
        }
        if kind == "session/end-seed"
            && data
                .get("inherited")
                .is_some_and(|inherited| inherited != true)
        {
            return Err(parse_error(
                path,
                format!("invalid session/end-seed.inherited at seq {seq}"),
            ));
        }
        if generation == 1 && kind == "session/end-seed" && seq < seed_length {
            return Err(parse_error(path, "session/end-seed precedes seedLength"));
        }
        let surface_eligible = matches!(kind, "user/message" | "assistant/message" | "tool/result")
            || (generation >= 3 && kind == "system/message")
            || (generation == 4 && kind == "developer/message");
        let historical_sources = if generation < 3 {
            historical_source_seqs(row, seq, path)?
        } else {
            None
        };
        if generation < 3 {
            if !surface_eligible && (row.get("surfaceOp").is_some() || historical_sources.is_some())
            {
                return Err(parse_error(
                    path,
                    format!("{kind} cannot carry surface metadata"),
                ));
            }
            if generation == 2 && surface_eligible && row.get("surfaceOp").is_none() {
                return Err(parse_error(path, format!("v2 {kind} requires surfaceOp")));
            }
            if generation == 2 && kind == "assistant/message" && historical_sources.is_some() {
                return Err(parse_error(
                    path,
                    "v2 assistant/message cannot carry sourceEventSeqs",
                ));
            }
            if generation == 2 && historical_sources.as_ref().is_some_and(Vec::is_empty) {
                return Err(parse_error(path, "v2 sourceEventSeqs cannot be empty"));
            }
        }
        if surface_eligible && (generation >= 2 || row.get("surfaceOp").is_some()) {
            if row.get("surfaceOp").and_then(Value::as_str) == Some("append") {
                surface_heads.push(seq);
                if kind == "system/message" && system_head.is_none() {
                    system_head = Some(seq);
                }
            } else {
                let op = &row["surfaceOp"];
                if generation == 1 {
                    let start = op.get("start").and_then(Value::as_u64);
                    let end = op.get("end").and_then(Value::as_u64);
                    if op.get("op").and_then(Value::as_str) != Some("replace")
                        || start.zip(end).is_none_or(|(start, end)| start > end)
                    {
                        return Err(parse_error(
                            path,
                            format!("invalid {kind} surfaceOp at seq {seq}"),
                        ));
                    }
                    continue;
                }
                let start_field = if generation >= 3 { "startSeq" } else { "start" };
                let end_field = if generation >= 3 { "endSeq" } else { "end" };
                let start = op
                    .get(start_field)
                    .and_then(Value::as_u64)
                    .and_then(|head| surface_heads.iter().position(|seq| *seq == head));
                let end = op
                    .get(end_field)
                    .and_then(Value::as_u64)
                    .and_then(|head| surface_heads.iter().position(|seq| *seq == head));
                let (Some(start), Some(end)) = (start, end) else {
                    return Err(parse_error(
                        path,
                        format!("invalid {kind} surface operation range at seq {seq}"),
                    ));
                };
                let sources = if generation >= 3 {
                    let entries = row
                        .get("sourceEventSeqs")
                        .and_then(Value::as_array)
                        .ok_or_else(|| {
                            parse_error(
                                path,
                                format!("missing replacement provenance at seq {seq}"),
                            )
                        })?;
                    entries
                        .iter()
                        .map(|entry| {
                            entry.as_u64().ok_or_else(|| {
                                parse_error(
                                    path,
                                    format!("invalid replacement provenance at seq {seq}"),
                                )
                            })
                        })
                        .collect::<Result<Vec<_>>>()?
                } else {
                    historical_sources.clone().ok_or_else(|| {
                        parse_error(path, format!("missing replacement provenance at seq {seq}"))
                    })?
                };
                if op.get("op").and_then(Value::as_str) != Some("replace")
                    || start > end
                    || surface_heads[start..=end]
                        .iter()
                        .any(|head| !sources.contains(head))
                    || sources.iter().any(|source| *source >= seq)
                {
                    return Err(parse_error(
                        path,
                        format!("invalid {kind} surface operation at seq {seq}"),
                    ));
                }
                let shadowed = &surface_heads[start..=end];
                if let Some(head) = system_head {
                    if shadowed.contains(&head) {
                        if kind != "system/message" || shadowed.len() != 1 {
                            return Err(parse_error(
                                path,
                                "replacement shadows protected system head",
                            ));
                        }
                        system_head = Some(seq);
                    }
                }
                if generation >= 3 && kind == "assistant/message" {
                    return Err(parse_error(
                        path,
                        "assistant replacement cannot carry sourceEventSeqs",
                    ));
                }
                if kind == "tool/result" {
                    let original = &rows[shadowed[0] as usize + 1];
                    if shadowed.len() != 1 || original["type"] != "tool/result" {
                        return Err(parse_error(path, "invalid tool result replacement target"));
                    }
                    let mut original_data = original["data"].clone();
                    let mut replacement_data = data.clone();
                    for value in [&mut original_data, &mut replacement_data] {
                        let content = value
                            .pointer_mut(if generation == 4 {
                                "/message/content"
                            } else {
                                "/message/content/0/content"
                            })
                            .ok_or_else(|| {
                                parse_error(path, "invalid tool result replacement content")
                            })?;
                        *content = Value::Null;
                    }
                    if original_data != replacement_data {
                        return Err(parse_error(
                            path,
                            "tool result replacement changes fields other than content",
                        ));
                    }
                }
                surface_heads.splice(start..=end, [seq]);
                // Surface replacements are model-context copies. Human history retains
                // the original appended messages and original tool result bodies.
                continue;
            }
        }
        match kind {
            "agent-preset/selected" if generation >= 3 => {
                data.get("agentPreset")
                    .and_then(Value::as_str)
                    .ok_or_else(|| parse_error(path, "missing or invalid agentPreset"))?;
            }
            "approval/asked" if generation >= 3 => {
                for field in ["id", "toolName"] {
                    if !data.get(field).is_some_and(Value::is_string) {
                        return Err(parse_error(
                            path,
                            format!("missing or invalid {kind}.{field}"),
                        ));
                    }
                }
                for field in ["callId", "reason"] {
                    if data.get(field).is_some_and(|value| !value.is_string()) {
                        return Err(parse_error(path, format!("invalid {kind}.{field}")));
                    }
                }
            }
            "approval/decided" if generation >= 3 => {
                if !data.get("id").is_some_and(Value::is_string)
                    || !matches!(
                        data.get("outcome").and_then(Value::as_str),
                        Some("allowed-once" | "rejected" | "cancelled" | "unavailable")
                    )
                {
                    return Err(parse_error(path, "invalid approval/decided payload"));
                }
            }
            "deliverables/presented" if generation >= 3 => {
                if !data.get("turn").is_some_and(Value::is_number)
                    || !data.get("callId").is_some_and(Value::is_string)
                {
                    return Err(parse_error(path, "invalid deliverables/presented payload"));
                }
                let files = data
                    .get("files")
                    .and_then(Value::as_array)
                    .ok_or_else(|| parse_error(path, "invalid deliverables/presented.files"))?;
                for file in files {
                    if !file.get("path").is_some_and(Value::is_string)
                        || file
                            .get("description")
                            .is_some_and(|value| !value.is_string())
                    {
                        return Err(parse_error(path, "invalid deliverables/presented file"));
                    }
                }
            }
            "tool/ptc-dispatch-start" | "tool/ptc-dispatch" if generation >= 3 => {
                for field in ["rootCallId", "parentCallId", "subCallId", "name"] {
                    if !data.get(field).is_some_and(Value::is_string) {
                        return Err(parse_error(
                            path,
                            format!("missing or invalid {kind}.{field}"),
                        ));
                    }
                }
                if data.get("arguments").is_none() {
                    return Err(parse_error(path, format!("missing {kind}.arguments")));
                }
                if kind == "tool/ptc-dispatch" {
                    if !data.get("isError").is_some_and(Value::is_boolean) {
                        return Err(parse_error(path, "invalid tool/ptc-dispatch.isError"));
                    }
                    let content = data
                        .get("content")
                        .and_then(Value::as_array)
                        .ok_or_else(|| parse_error(path, "invalid tool/ptc-dispatch.content"))?;
                    for block in content {
                        let block_type =
                            block.get("type").and_then(Value::as_str).ok_or_else(|| {
                                parse_error(path, "invalid tool/ptc-dispatch content block")
                            })?;
                        if matches!(block_type, "text" | "reasoning")
                            && !block.get("text").is_some_and(Value::is_string)
                        {
                            return Err(parse_error(path, "invalid tool/ptc-dispatch text block"));
                        }
                    }
                    if let Some(error) = data.get("error") {
                        if !error.get("name").is_some_and(Value::is_string)
                            || !error.get("code").is_some_and(Value::is_string)
                            || error.get("reason").is_some_and(|value| !value.is_string())
                        {
                            return Err(parse_error(path, "invalid tool/ptc-dispatch.error"));
                        }
                    }
                }
            }
            "session-log-deepseek/delivery-accepted" if generation >= 3 => {
                let accepted_session = required(data, "sessionId", path)?;
                let accepted_format = data
                    .get("sessionFormatVersion")
                    .map(|_| integer(data, "sessionFormatVersion", path))
                    .transpose()?
                    .unwrap_or(0);
                let through = integer(data, "throughSeq", path)?;
                if accepted_format == u64::from(generation)
                    && (through >= seq
                        || (seq >= owned_from_seq && accepted_session != expected_id))
                {
                    return Err(parse_error(
                        path,
                        format!("invalid delivery acceptance watermark at seq {seq}"),
                    ));
                }
            }
            "subagent/catalog" => {
                let catalog_fields = data.as_object().unwrap();
                let mode = required(data, "mode", path)?;
                let label = data
                    .get("label")
                    .map(|value| {
                        value
                            .as_str()
                            .ok_or_else(|| parse_error(path, "invalid catalog label"))
                    })
                    .transpose()?;
                let fields = if label.is_some() { 5 } else { 4 };
                let catalog_version = integer(data, "version", path)?;
                if !(catalog_version == 0 || (generation == 4 && catalog_version == 1))
                    || !(matches!(mode, "one-shot" | "continuable")
                        || (catalog_version == 1 && mode == "unknown"))
                    || (mode == "continuable" && label.is_none_or(str::is_empty))
                    || catalog_fields.len() != fields
                    || catalog_fields.keys().any(|key| {
                        !matches!(
                            key.as_str(),
                            "version" | "childId" | "childCreatedAt" | "mode" | "label"
                        )
                    })
                {
                    return Err(parse_error(
                        path,
                        format!("invalid subagent/catalog payload at seq {seq}"),
                    ));
                }
                let child = required(data, "childId", path)?;
                integer(data, "childCreatedAt", path)?;
                let (catalog_kind, catalog_state) = if generation == 4 && catalog_version == 1 {
                    ("catalog", "recorded")
                } else {
                    ("spawn", "started")
                };
                let mut catalog = observation(
                    catalog_kind,
                    catalog_state,
                    child,
                    kind,
                    seq,
                    expected_id,
                    child,
                );
                catalog.to_participant = team_members.get(child).cloned().or_else(|| {
                    label.map(|name| RelationParticipant {
                        id: child.into(),
                        kind: RelationParticipantKind::Member,
                        name: name.into(),
                        description: None,
                        provenance: provenance(kind, seq),
                    })
                });
                relation_rows.push((
                    seq,
                    RelationEntry::Coordination {
                        observation: catalog,
                    },
                ));
            }
            "user/message" => {
                if data.pointer("/source/kind").and_then(Value::as_str) != Some("user") {
                    match data.pointer("/source/kind").and_then(Value::as_str) {
                        Some("team-message") => {
                            let source = &data["source"];
                            for field in ["teamId", "messageId", "senderId", "senderName"] {
                                required(source, field, path)?;
                            }
                            required(data, "id", path)?;
                            text_blocks(&data["content"], path)?;
                            // Received mailbox content remains a raw protocol fact, as in
                            // the provider's human Conversation projection.
                            continue;
                        }
                        Some(
                            "agent-instructions" | "plugin" | "skill-catalog" | "subagent-report"
                            | "goal" | "subagent-settled",
                        ) => continue,
                        Some(kind) if generation == 4 && kind != "plugin" && !kind.is_empty() => {
                            continue;
                        }
                        _ => {
                            return Err(parse_error(
                                path,
                                format!("unsupported user source at seq {seq}"),
                            ));
                        }
                    }
                }
                add_message(
                    &mut events,
                    expected_id,
                    time,
                    "user",
                    if generation >= 3 {
                        required(data, "id", path)?.to_owned()
                    } else {
                        data["id"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("user:{seq}"))
                    }
                    .as_str(),
                    text_blocks(&data["content"], path)?,
                );
                latest_assistant = None;
            }
            "assistant/message" => {
                let message = &data["message"];
                if message.get("role").and_then(Value::as_str) != Some("assistant")
                    && !(generation < 3 && message.get("role").is_none())
                {
                    return Err(parse_error(
                        path,
                        format!("invalid assistant role at seq {seq}"),
                    ));
                }
                let id = if generation >= 3 {
                    required(message, "id", path)?.to_owned()
                } else {
                    message["id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("assistant:{seq}"))
                };
                let blocks = message["content"]
                    .as_array()
                    .ok_or_else(|| parse_error(path, "assistant content is not an array"))?;
                let mut text = String::new();
                let mut reasoning = String::new();
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text" | "reasoning") => {
                            let value = block
                                .get("text")
                                .and_then(Value::as_str)
                                .ok_or_else(|| parse_error(path, "invalid assistant text"))?;
                            if block["type"] == "text" {
                                text.push_str(value);
                            } else {
                                reasoning.push_str(value);
                            }
                        }
                        Some("tool-call") => {}
                        _ => {
                            return Err(parse_error(
                                path,
                                format!("unsupported assistant block at seq {seq}"),
                            ));
                        }
                    }
                }
                if generation < 3
                    && text.is_empty()
                    && reasoning.is_empty()
                    && !blocks.iter().any(|block| block["type"] == "tool-call")
                {
                    continue;
                }
                add_message(&mut events, expected_id, time, "assistant", &id, text);
                latest_assistant = Some(event_ref(expected_id, &id, "message"));
                reply_owners.insert(seq, latest_assistant.clone().expect("assistant owner"));
                events
                    .last_mut()
                    .expect("assistant message")
                    .item
                    .reply_metadata = dsh_reply_metadata(data, seq);
                if !reasoning.is_empty() {
                    add_message(&mut events, expected_id, time, "assistant", &id, reasoning);
                    let event = events.last_mut().unwrap();
                    event.item.event.segment = "thinking".into();
                    event.item.owner = latest_assistant.clone();
                    event.item.owner_message_id = Some(id.clone());
                }
                for block in blocks.iter().filter(|block| block["type"] == "tool-call") {
                    add_tool(
                        &mut events,
                        &mut tool_calls,
                        expected_id,
                        time,
                        required(block, "id", path)?,
                        required(block, "name", path)?,
                        &block["arguments"],
                        latest_assistant.clone(),
                        path,
                    )?;
                }
            }
            "tool/call" => {
                let id = required(data, "callId", path)?;
                let name = required(data, "name", path)?;
                add_tool(
                    &mut events,
                    &mut tool_calls,
                    expected_id,
                    time,
                    id,
                    name,
                    &data["arguments"],
                    latest_assistant.clone(),
                    path,
                )?;
            }
            "tool/result" => {
                let message = &data["message"];
                let call_id = required(&message["source"], "callId", path)?;
                let blocks = message["content"].as_array().ok_or_else(|| {
                    parse_error(path, format!("invalid tool result content at seq {seq}"))
                })?;
                let mut output = String::new();
                if generation == 4 {
                    if message["role"] != "tool"
                        || message["toolCallId"] != call_id
                        || message["source"]["kind"] != "tool"
                        || message
                            .get("isError")
                            .is_some_and(|value| !value.is_boolean())
                    {
                        return Err(parse_error(
                            path,
                            format!("invalid native tool result message at seq {seq}"),
                        ));
                    }
                    required(message, "id", path)?;
                    output = text_blocks(&message["content"], path)?;
                } else {
                    for block in blocks {
                        if block.get("type").and_then(Value::as_str) != Some("tool-result")
                            || block.get("toolCallId").and_then(Value::as_str) != Some(call_id)
                        {
                            return Err(parse_error(
                                path,
                                format!("unsupported tool result block at seq {seq}"),
                            ));
                        }
                        output.push_str(&text_blocks(&block["content"], path)?);
                    }
                }
                let index = if let Some(index) = tool_calls.get(call_id).copied() {
                    index
                } else {
                    let owner = latest_assistant.clone();
                    let index = events.len();
                    events.push(NormalizedEvent {
                        item: ReaderItem {
                            ordinal: index,
                            owner: owner.clone(),
                            event: event_ref(expected_id, call_id, "tool"),
                            role: "tool".into(),
                            timestamp: Some(time),
                            preview: "tool".into(),
                            total_chars: 0,
                            tool_name: Some("tool".into()),
                            owner_message_id: owner.map(|owner| owner.message_id),
                            presentation_phase: None,
                            process_id: None,
                            process_count: None,
                            tool_metadata: None,
                            reply_metadata: None,
                            content_revisions: Default::default(),
                        },
                        body: String::new(),
                        tool_input: String::new(),
                        tool_output: String::new(),
                        tool_status: None,
                    });
                    tool_calls.insert(call_id.into(), index);
                    index
                };
                let failed = (generation == 4 && message["isError"] == true)
                    || blocks
                        .iter()
                        .any(|block| block.get("isError") == Some(&Value::Bool(true)))
                    || data.get("error").is_some_and(js_truthy);
                events[index].tool_status = Some(if failed { "error" } else { "completed" }.into());
                events[index].tool_output = output.clone();
                events[index].item.preview = format!(
                    "{}: {}",
                    events[index].item.tool_name.as_deref().unwrap_or("tool"),
                    preview(&output)
                );
                events[index].item.total_chars = output.encode_utf16().count();
            }
            "session/title" => {
                if seq >= owned_from_seq {
                    stored_title = Some(required(data, "title", path)?.to_owned());
                }
            }
            "compaction/summary" => {
                add_compaction_checkpoint(&mut events, expected_id, time, seq, data);
                latest_assistant = None;
            }
            "team/member" => {
                let member = &data["member"];
                let id = required(member, "id", path)?.to_owned();
                team_members.insert(
                    id.clone(),
                    RelationParticipant {
                        id,
                        kind: RelationParticipantKind::Member,
                        name: required(member, "name", path)?.to_owned(),
                        description: member
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        provenance: provenance(kind, seq),
                    },
                );
            }
            "team/task" => {
                let task = &data["task"];
                let id = required(task, "id", path)?.to_owned();
                let revision = integer(task, "revision", path)?;
                let owner = task
                    .get("ownerId")
                    .map(|_| required(task, "ownerId", path).map(str::to_owned))
                    .transpose()?;
                let status = required(task, "status", path)?;
                let status = match status {
                    "in_progress" => "running",
                    "pending" => "queued",
                    "completed" => "completed",
                    other => {
                        return Err(parse_error(
                            path,
                            format!("unsupported team task status {other} at seq {seq}"),
                        ));
                    }
                };
                if team_tasks
                    .get(&id)
                    .is_some_and(|(_, prior, _)| revision <= *prior)
                {
                    return Err(parse_error(
                        path,
                        format!("non-increasing team task revision at seq {seq}"),
                    ));
                }
                team_tasks.insert(
                    id.clone(),
                    (
                        seq,
                        revision,
                        RelationTask {
                            id: format!("team:{id}"),
                            kind: "team-task".into(),
                            status: status.into(),
                            owner_participant: owner
                                .as_ref()
                                .and_then(|owner| team_members.get(owner))
                                .cloned(),
                            owner,
                            subject: task
                                .get("subject")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            description: task
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            reader_event: None,
                            provenance: provenance(kind, seq),
                        },
                    ),
                );
            }
            "team/message/queued" => {
                let message = &data["message"];
                let id = required(message, "id", path)?;
                let from = required(message, "senderId", path)?;
                let to = required(message, "targetId", path)?;
                let sender_name = message
                    .get("senderName")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let excerpt = team_message_excerpt(&message["content"]);
                if queued
                    .insert(
                        id.into(),
                        (from.into(), to.into(), sender_name.clone(), seq),
                    )
                    .is_some()
                {
                    return Err(parse_error(
                        path,
                        format!("duplicate team message {id} at seq {seq}"),
                    ));
                }
                let mut row = observation("message", "requested", id, kind, seq, from, to);
                row.from_participant =
                    member_or_sender(&team_members, from, sender_name.as_deref(), seq);
                row.to_participant = team_members.get(to).cloned();
                if let Some((text, truncated)) = excerpt {
                    row.message_excerpt = Some(text);
                    row.message_excerpt_truncated = Some(truncated);
                }
                relation_rows.push((seq, RelationEntry::Coordination { observation: row }));
            }
            "team/message/delivered" => {
                let id = required(data, "messageId", path)?;
                let (from, to, sender_name, queued_seq) = queued.get(id).ok_or_else(|| {
                    parse_error(path, format!("unmatched team delivery {id} at seq {seq}"))
                })?;
                if required(data, "targetId", path)? != to {
                    return Err(parse_error(
                        path,
                        format!("team delivery target differs at seq {seq}"),
                    ));
                }
                let mut row = observation("mailbox-delivery", "delivered", id, kind, seq, from, to);
                row.from_participant =
                    member_or_sender(&team_members, from, sender_name.as_deref(), *queued_seq);
                row.to_participant = team_members.get(to).cloned();
                relation_rows.push((seq, RelationEntry::Coordination { observation: row }));
            }
            "tool-workflow/run-start" if generation >= 3 => {
                required(data, "runId", path)?;
                required(data, "name", path)?;
                // Run records are log-only producer observations. They carry no
                // child assignment or AgentRun identity to project into Reader.
            }
            "tool-workflow/run-end" if generation >= 3 => {
                required(data, "runId", path)?;
                let stop_reason = required(data, "stopReason", path)?;
                if !matches!(stop_reason, "completed" | "cancelled" | "error") {
                    return Err(parse_error(
                        path,
                        format!("unsupported workflow stopReason {stop_reason} at seq {seq}"),
                    ));
                }
            }
            "tool-workflow/agent-start" => {
                let run_id = required(data, "runId", path)?;
                let sequence = integer(data, "seq", path)?;
                let child_id = required(data, "childId", path)?;
                if workflow_starts
                    .insert(
                        (run_id.into(), sequence),
                        WorkflowStart {
                            source_seq: seq,
                            child_id: child_id.into(),
                        },
                    )
                    .is_some()
                {
                    return Err(parse_error(
                        path,
                        format!("duplicate workflow start at seq {seq}"),
                    ));
                }
                let mut row = observation(
                    "spawn",
                    "started",
                    &format!("{run_id}:{sequence}"),
                    kind,
                    seq,
                    expected_id,
                    child_id,
                );
                row.to_participant = team_members.get(child_id).cloned();
                relation_rows.push((seq, RelationEntry::Coordination { observation: row }));
            }
            "tool-workflow/agent-end" => {
                let run_id = required(data, "runId", path)?;
                let sequence = integer(data, "seq", path)?;
                let key = (run_id.into(), sequence);
                let start = workflow_starts.get(&key).ok_or_else(|| {
                    parse_error(path, format!("workflow end has no start at seq {seq}"))
                })?;
                let outcome = required(data, "outcome", path)?;
                if !matches!(outcome, "completed" | "failed" | "cancelled") {
                    return Err(parse_error(
                        path,
                        format!("unsupported workflow outcome {outcome} at seq {seq}"),
                    ));
                }
                if workflow_ends.insert(key, outcome.into()).is_some() {
                    return Err(parse_error(
                        path,
                        format!("duplicate workflow end at seq {seq}"),
                    ));
                }
                let mut row = observation(
                    "spawn",
                    outcome,
                    &format!("{run_id}:{sequence}"),
                    kind,
                    seq,
                    expected_id,
                    &start.child_id,
                );
                row.to_participant = team_members.get(&start.child_id).cloned();
                relation_rows.push((seq, RelationEntry::Coordination { observation: row }));
            }
            _ => {}
        }
    }
    for (seq, _, task) in team_tasks.into_values() {
        relation_rows.push((seq, RelationEntry::Task { task }));
    }
    for ((run_id, sequence), start) in workflow_starts {
        let status = workflow_ends
            .get(&(run_id.clone(), sequence))
            .map(String::as_str)
            .unwrap_or("running");
        relation_rows.push((
            start.source_seq,
            RelationEntry::Task {
                task: RelationTask {
                    id: format!("workflow:{run_id}:{sequence}"),
                    kind: "workflow".into(),
                    status: status.into(),
                    owner_participant: team_members.get(&start.child_id).cloned(),
                    owner: Some(start.child_id),
                    subject: None,
                    description: None,
                    reader_event: None,
                    provenance: provenance("tool-workflow/agent-start", start.source_seq),
                },
            },
        ));
    }
    relation_rows.retain(|(seq, _)| *seq >= owned_from_seq);
    relation_rows.sort_by_key(|(seq, _)| *seq);
    let inherited_event_end = inherited_event_end.unwrap_or(events.len());
    let inherited_events = events
        .drain(..inherited_event_end)
        .enumerate()
        .map(|(ordinal, event)| InheritedEvent {
            item: InheritedItem {
                ordinal,
                message_id: event.item.event.message_id,
                segment: event.item.event.segment,
                role: event.item.role,
                timestamp: event.item.timestamp,
                preview: event.item.preview,
                total_chars: event.item.total_chars,
                tool_name: event.item.tool_name,
            },
            body: event.body,
            tool_input: event.tool_input,
            tool_output: event.tool_output,
        })
        .collect();
    for (ordinal, event) in events.iter_mut().enumerate() {
        event.item.ordinal = ordinal;
    }
    let title = stored_title.unwrap_or_else(|| {
        events
            .iter()
            .find(|event| event.item.role == "user")
            .map(|event| preview(&event.body))
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "DeepSeek Harness session".into())
    });
    let message_count = events
        .iter()
        .filter(|event| matches!(event.item.event.segment.as_str(), "message" | "tool"))
        .count();
    let (usage_records, usage_diagnostics) =
        dsh_request_usage_records(&rows, expected_id, owned_from_seq, generation);
    dsh_attach_reply_usage(&mut events, &reply_owners, &usage_records);
    let token_count = (!usage_records.is_empty())
        .then(|| {
            usage_records.iter().try_fold(0u64, |total, record| {
                total.checked_add(record.tokens.total?)
            })
        })
        .flatten();
    let summary = SessionSummary {
        diagnostic: None,
        session: session_ref(expected_id),
        search_title: Some(title.clone()),
        title,
        directory: cwd,
        created_at: Some(created_at),
        updated_at: Some(updated_at),
        message_count,
        conversation_message_count: None,
        token_count,
        duration_ms: None,
        summary_files: None,
        summary_additions: None,
        summary_deletions: None,
        parent,
    };
    let protocol_candidates = dsh_event_candidates(&rows, expected_id, &events, owned_from_seq);
    let compactions = recorded_compactions(&rows, owned_from_seq, path)?;
    Ok((
        SessionSnapshot {
            summary,
            revision,
            events,
            relations: relation_rows.into_iter().map(|(_, entry)| entry).collect(),
        },
        protocol_candidates,
        usage_records,
        usage_diagnostics,
        inherited_events,
        compactions,
    ))
}

#[cfg(test)]
fn load_v3(path: &Path, scope: &str, expected_id: &str) -> Result<SessionSnapshot> {
    load_versioned_with_protocol(path, scope, expected_id).map(|(snapshot, _, _, _, _, _)| snapshot)
}

#[cfg(test)]
mod v4_tests {
    use super::*;
    use tempfile::tempdir;

    fn source() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../fixtures/deepseek-harness-v4/sessions/public/dsh-v4-parent/session.v4.jsonl",
        )
    }

    #[test]
    fn native_v4_keeps_required_workflow_run_records_without_inferred_execution() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../fixtures/deepseek-harness-v4-workflow/sessions/public/dsh-v4-workflow/session.v4.jsonl",
        );
        let (snapshot, candidates, _, _, _, _) =
            load_dsh_with_protocol(&path, "v4-workflow-test", "dsh-v4-workflow").unwrap();
        assert_eq!(snapshot.summary.message_count, 2);
        assert_eq!(candidates.len(), 5);
        assert!(snapshot.relations.is_empty());
        for (index, kind) in [(2, "tool-workflow/run-start"), (3, "tool-workflow/run-end")] {
            assert_eq!(
                candidates[index].provenance.source_type,
                format!("dsh.session-event:{kind}")
            );
            assert!(candidates[index].reader_event.is_none());
            assert!(candidates[index].execution.is_none());
        }
        let bundle = dsh_protocol_bundle(&path, "v4-workflow-test", "dsh-v4-workflow").unwrap();
        let document = serde_json::to_value(bundle.document(3).unwrap()).unwrap();
        assert!(document["agentRuns"].as_array().unwrap().is_empty());
    }

    #[test]
    fn native_v4_preserves_unknown_ignorable_records_and_rejects_required_records() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v4.jsonl");
        let header = serde_json::json!({
            "type": "session", "version": 4, "id": "opaque-v4", "createdAt": 100,
            "isSeeded": false, "delegationDepth": 0
        });
        let mut event = serde_json::json!({
            "type": "future/opaque", "seq": 0, "time": 101,
            "ignorable": true, "data": {"future": "public"}
        });
        fs::write(&path, format!("{header}\n{event}\n")).unwrap();
        let (snapshot, candidates, _, _, _, _) =
            load_dsh_with_protocol(&path, "v4-test", "opaque-v4").unwrap();
        assert!(snapshot.events.is_empty());
        assert_eq!(candidates.len(), 2);
        let opaque = &candidates[1];
        assert_eq!(opaque.id, "event:dsh:0");
        assert_eq!(opaque.source_order.record, 1);
        assert_eq!(
            opaque.provenance.source_type,
            "dsh.session-event:future/opaque"
        );
        assert!(opaque.reader_event.is_none());

        event.as_object_mut().unwrap().remove("ignorable");
        fs::write(&path, format!("{header}\n{event}\n")).unwrap();
        assert!(
            matches!(load_v3(&path, "v4-test", "opaque-v4"), Err(CoreError::Parse { reason, .. })
                if reason.contains("unsupported required DSH v4 event future/opaque at seq 0"))
        );
    }

    #[test]
    fn native_v4_keeps_tool_body_source_records_and_catalog_discovery() {
        let path = source();
        let (snapshot, candidates, _, _, _, _) =
            load_dsh_with_protocol(&path, "v4-test", "dsh-v4-parent").unwrap();
        assert_eq!(snapshot.summary.message_count, 3);
        let tool = snapshot
            .events
            .iter()
            .find(|event| event.item.event.message_id == "v4-call")
            .unwrap();
        assert_eq!(tool.tool_output, "Original tool body 🚀 end.");
        assert_eq!(tool.tool_status.as_deref(), Some("completed"));
        assert_eq!(tool.item.owner.as_ref().unwrap().message_id, "v4-reply");
        assert_eq!(candidates.len(), 14);
        for seq in [2, 3, 7, 12] {
            assert!(
                candidates
                    .iter()
                    .find(|event| event.id == format!("event:dsh:{seq}"))
                    .unwrap()
                    .reader_event
                    .is_none()
            );
        }
        let catalog = snapshot
            .relations
            .iter()
            .find_map(|row| match row {
                RelationEntry::Coordination { observation }
                    if observation.provenance.source_id == "8" =>
                {
                    Some(observation)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            catalog.to_session_ref.as_ref().unwrap().session_id,
            "v4-unavailable-child"
        );
        assert_eq!(catalog.kind, "catalog");
        assert_eq!(catalog.state, "recorded");
        let before = fs::read(&path).unwrap();
        let bundle = dsh_protocol_bundle(&path, "v4-test", "dsh-v4-parent").unwrap();
        let document = serde_json::to_value(bundle.document(3).unwrap()).unwrap();
        assert_eq!(document["agentRuns"], serde_json::json!([]));
        let fact = document["coordination"]
            .as_array()
            .unwrap()
            .iter()
            .find(|fact| fact["evidence"]["provenance"]["sourceId"] == "8")
            .unwrap();
        assert_eq!(fact["kind"], "catalog");
        assert_eq!(fact["state"], "recorded");
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn generation_four_takes_precedence_and_invalid_tool_identity_fails() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("sessions/public/dsh-v4-parent");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("session.v4.jsonl");
        fs::copy(source(), &path).unwrap();
        fs::write(
            directory.join("session.v3.jsonl"),
            "invalid older generation",
        )
        .unwrap();
        let adapter = DshAdapter {
            root: temp.path(),
            scope: "v4-test",
        };
        assert_eq!(adapter.source_path("dsh-v4-parent").unwrap(), path);
        assert_eq!(
            adapter.load("dsh-v4-parent").unwrap().summary.message_count,
            3
        );
        let text = fs::read_to_string(&path).unwrap();
        fs::write(
            &path,
            text.replace(
                "\"toolCallId\":\"v4-call\"",
                "\"toolCallId\":\"wrong-call\"",
            ),
        )
        .unwrap();
        assert!(
            matches!(adapter.load("dsh-v4-parent"), Err(CoreError::Parse { reason, .. }) if reason.contains("invalid native tool result"))
        );
    }

    #[test]
    fn native_v4_retains_existing_version_zero_catalog_semantics() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v4.jsonl");
        let text = fs::read_to_string(source())
            .unwrap()
            .replace("\"version\":1,\"childId\"", "\"version\":0,\"childId\"")
            .replace("\"mode\":\"unknown\"", "\"mode\":\"one-shot\"");
        fs::write(&path, text).unwrap();
        let snapshot = load_v3(&path, "v4-test", "dsh-v4-parent").unwrap();
        let catalog = snapshot
            .relations
            .iter()
            .find_map(|entry| match entry {
                RelationEntry::Coordination { observation }
                    if observation.provenance.source_id == "8" =>
                {
                    Some(observation)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(catalog.kind, "spawn");
        assert_eq!(catalog.state, "started");
    }
}

fn expand_v0_packed_row(row: Value, path: &Path) -> Result<Vec<Value>> {
    let kind = required(&row, "type", path)?;
    if !matches!(
        kind,
        "text-chunks" | "reasoning-chunks" | "tool-call-chunks"
    ) {
        return Ok(vec![row]);
    }
    let seq0 = integer(&row, "seq0", path)?;
    let time0 = i64::try_from(integer(&row, "time0", path)?)
        .map_err(|_| parse_error(path, "packed chunk time exceeds timestamp range"))?;
    let data = row
        .get("data")
        .filter(|value| value.is_object())
        .ok_or_else(|| parse_error(path, "invalid packed chunk data"))?;
    let turn = integer(data, "turn", path)?;
    let step = integer(data, "step", path)?;
    let index = integer(data, "index", path)?;
    let member_key = if kind == "tool-call-chunks" {
        "args"
    } else {
        "texts"
    };
    let members = data[member_key]
        .as_array()
        .filter(|members| !members.is_empty())
        .ok_or_else(|| parse_error(path, format!("invalid {kind} members")))?;
    let gaps = data["dt"]
        .as_array()
        .filter(|gaps| gaps.len() + 1 == members.len())
        .ok_or_else(|| parse_error(path, format!("invalid {kind} timing gaps")))?;
    let call_id = if kind == "tool-call-chunks" {
        Some(required(data, "id", path)?)
    } else {
        None
    };
    let mut time = time0;
    let mut expanded = Vec::with_capacity(members.len());
    for (offset, member) in members.iter().enumerate() {
        if offset > 0 {
            let gap = gaps[offset - 1]
                .as_i64()
                .ok_or_else(|| parse_error(path, "invalid packed chunk timing gap"))?;
            time = time
                .checked_add(gap)
                .ok_or_else(|| parse_error(path, "packed chunk time exceeds timestamp range"))?;
        }
        let seq = seq0
            .checked_add(offset as u64)
            .ok_or_else(|| parse_error(path, "packed chunk sequence exceeds range"))?;
        let text = member
            .as_str()
            .ok_or_else(|| parse_error(path, "invalid packed chunk member"))?;
        let chunk = match kind {
            "text-chunks" => serde_json::json!({"type":"text-delta","index":index,"text":text}),
            "reasoning-chunks" => {
                serde_json::json!({"type":"reasoning-delta","index":index,"text":text})
            }
            _ => {
                let mut chunk = serde_json::json!({"type":"tool-call-delta","index":index,"id":call_id,"argumentsDelta":text});
                if let Some(name) = data.get("name") {
                    if !name.is_string() {
                        return Err(parse_error(path, "invalid packed tool call name"));
                    }
                    chunk["name"] = name.clone();
                }
                chunk
            }
        };
        expanded.push(serde_json::json!({"type":"assistant/chunk","seq":seq,"time":time,"data":{"turn":turn,"step":step,"chunk":chunk}}));
    }
    Ok(expanded)
}

fn load_v0_with_protocol(path: &Path, scope: &str, expected_id: &str) -> Result<LoadedDsh> {
    let bytes = fs::read(path).map_err(|source| CoreError::Io {
        path: path.into(),
        source,
    })?;
    let mut hasher = Sha256::new();
    hasher.update(b"dsh-v0-source-3\0");
    hasher.update(scope.as_bytes());
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(&bytes);
    let revision = format!("{:x}", hasher.finalize());
    let mut rows = Vec::<Value>::new();
    for row in read_dsh_rows(path, &bytes)? {
        rows.extend(expand_v0_packed_row(row, path)?);
    }
    let header = rows
        .first()
        .ok_or_else(|| parse_error(path, "empty DSH source"))?;
    if header.get("type").and_then(Value::as_str) != Some("session")
        || header.get("version").and_then(Value::as_u64) != Some(0)
    {
        return Err(parse_error(path, "unsupported DSH v0 header"));
    }
    if required(header, "id", path)? != expected_id {
        return Err(parse_error(
            path,
            "header canonical ID differs from session directory",
        ));
    }
    let created_at = i64::try_from(integer(header, "createdAt", path)?)
        .map_err(|_| parse_error(path, "session.createdAt exceeds timestamp range"))?;
    let seed_length = header
        .get("seedLength")
        .map(|_| integer(header, "seedLength", path))
        .transpose()?
        .unwrap_or(0);
    if seed_length > (rows.len() - 1) as u64 {
        return Err(parse_error(
            path,
            "session.seedLength exceeds stored event count",
        ));
    }
    let cwd = header.get("cwd").and_then(Value::as_str).map(str::to_owned);
    let parent = header
        .get("parentSession")
        .and_then(Value::as_str)
        .map(session_ref);
    let mut events = Vec::<NormalizedEvent>::new();
    let mut tool_calls = HashMap::<String, usize>::new();
    let mut latest_assistant: Option<EventRef> = None;
    let mut reply_owners = HashMap::<u64, EventRef>::new();
    let mut stored_title = None;
    let mut descriptor_label = None;
    let mut updated_at = created_at;
    for (expected_seq, row) in rows.iter().skip(1).enumerate() {
        let kind = required(row, "type", path)?;
        let seq = integer(row, "seq", path)?;
        if seq != expected_seq as u64 {
            return Err(parse_error(
                path,
                format!("non-contiguous DSH seq: expected {expected_seq}, got {seq}"),
            ));
        }
        let time = i64::try_from(integer(row, "time", path)?).map_err(|_| {
            parse_error(
                path,
                format!("event time exceeds timestamp range at seq {seq}"),
            )
        })?;
        let data = row
            .get("data")
            .filter(|value| value.is_object())
            .ok_or_else(|| parse_error(path, format!("missing {kind}.data at seq {seq}")))?;
        if !supported_event(kind) && kind != "assistant/chunk" {
            return Err(parse_error(
                path,
                format!("unsupported DSH v0 event {kind} at seq {seq}"),
            ));
        }
        if seq < seed_length {
            continue;
        }
        updated_at = updated_at.max(time);
        if row.get("surfaceOp").is_some_and(Value::is_object) {
            continue;
        }
        match kind {
            "session/title" => {
                stored_title = Some(required(data, "title", path)?.trim().to_owned())
            }
            "subagent/descriptor" => {
                descriptor_label = data.get("label").and_then(Value::as_str).map(str::to_owned);
            }
            "user/message"
                if data.pointer("/source/kind").and_then(Value::as_str) == Some("user") =>
            {
                let id = data
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("user:{seq}"));
                add_message(
                    &mut events,
                    expected_id,
                    time,
                    "user",
                    &id,
                    text_blocks(&data["content"], path)?,
                );
                latest_assistant = None;
            }
            "assistant/message" => {
                let legacy = data.get("message").is_none();
                let message = if legacy { data } else { &data["message"] };
                let id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("assistant:{seq}"));
                let blocks = message["content"].as_array().ok_or_else(|| {
                    parse_error(path, format!("missing assistant content at seq {seq}"))
                })?;
                let mut body = String::new();
                let mut reasoning = String::new();
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text" | "reasoning") => {
                            let value = required(block, "text", path)?;
                            if block["type"] == "text" {
                                body.push_str(value);
                            } else {
                                reasoning.push_str(value);
                            }
                        }
                        Some("tool-call") => {}
                        _ => {
                            return Err(parse_error(
                                path,
                                format!("unsupported assistant block at seq {seq}"),
                            ));
                        }
                    }
                }
                add_message(&mut events, expected_id, time, "assistant", &id, body);
                latest_assistant = Some(event_ref(expected_id, &id, "message"));
                reply_owners.insert(seq, latest_assistant.clone().expect("assistant owner"));
                events
                    .last_mut()
                    .expect("assistant message")
                    .item
                    .reply_metadata = dsh_reply_metadata(data, seq);
                if !reasoning.is_empty() {
                    add_message(&mut events, expected_id, time, "assistant", &id, reasoning);
                    let thought = events.last_mut().unwrap();
                    thought.item.event.segment = "thinking".into();
                    thought.item.owner = latest_assistant.clone();
                    thought.item.owner_message_id = Some(id.clone());
                }
                for block in blocks.iter().filter(|block| block["type"] == "tool-call") {
                    add_tool(
                        &mut events,
                        &mut tool_calls,
                        expected_id,
                        time,
                        required(block, "id", path)?,
                        required(block, "name", path)?,
                        &block["arguments"],
                        latest_assistant.clone(),
                        path,
                    )?;
                }
            }
            "tool/call" => {
                add_tool(
                    &mut events,
                    &mut tool_calls,
                    expected_id,
                    time,
                    required(data, "callId", path)?,
                    required(data, "name", path)?,
                    &data["arguments"],
                    latest_assistant.clone(),
                    path,
                )?;
            }
            "tool/result" => {
                if let Some(call_id) = data.get("callId").and_then(Value::as_str) {
                    let output = text_blocks(&data["content"], path)?;
                    let id = format!("tool-result:{seq}:0");
                    let failed = data.get("isError") == Some(&Value::Bool(true));
                    let index = *tool_calls.get(call_id).ok_or_else(|| {
                        parse_error(
                            path,
                            format!("unmatched tool result {call_id} at seq {seq}"),
                        )
                    })?;
                    events[index].tool_status =
                        Some(if failed { "error" } else { "completed" }.into());
                    events[index].tool_output = output.clone();
                    events[index].item.preview = format!(
                        "{}: {}",
                        events[index].item.tool_name.as_deref().unwrap_or("tool"),
                        preview(&output)
                    );
                    events[index].item.total_chars = output.encode_utf16().count();
                    events.push(NormalizedEvent {
                        item: ReaderItem {
                            ordinal: events.len(),
                            owner: latest_assistant.clone(),
                            event: event_ref(expected_id, &id, "tool"),
                            role: "tool".into(),
                            timestamp: Some(time),
                            preview: format!("tool: {}", preview(&output)),
                            total_chars: output.encode_utf16().count(),
                            tool_name: Some("tool".into()),
                            owner_message_id: latest_assistant
                                .as_ref()
                                .map(|owner| owner.message_id.clone()),
                            presentation_phase: None,
                            process_id: None,
                            process_count: None,
                            tool_metadata: None,
                            reply_metadata: None,
                            content_revisions: Default::default(),
                        },
                        body: String::new(),
                        tool_input: String::new(),
                        tool_output: output,
                        tool_status: Some(if failed { "error" } else { "completed" }.into()),
                    });
                    continue;
                }
                let message = &data["message"];
                let call_id = required(&message["source"], "callId", path)?;
                let blocks = message["content"].as_array().ok_or_else(|| {
                    parse_error(path, format!("invalid tool result content at seq {seq}"))
                })?;
                let mut output = String::new();
                for block in blocks {
                    if block["type"] != "tool-result" || block["toolCallId"] != call_id {
                        return Err(parse_error(
                            path,
                            format!("unsupported tool result block at seq {seq}"),
                        ));
                    }
                    output.push_str(&text_blocks(&block["content"], path)?);
                }
                let index = *tool_calls.get(call_id).ok_or_else(|| {
                    parse_error(
                        path,
                        format!("unmatched tool result {call_id} at seq {seq}"),
                    )
                })?;
                let failed = blocks.iter().any(|block| block["isError"] == true)
                    || data.get("error").is_some_and(js_truthy);
                events[index].tool_status = Some(if failed { "error" } else { "completed" }.into());
                events[index].tool_output = output.clone();
                events[index].item.preview = format!(
                    "{}: {}",
                    events[index].item.tool_name.as_deref().unwrap_or("tool"),
                    preview(&output)
                );
                events[index].item.total_chars = output.encode_utf16().count();
            }
            "compaction/summary" => {
                add_compaction_checkpoint(&mut events, expected_id, time, seq, data);
                latest_assistant = None;
            }
            _ => {}
        }
    }
    let title = stored_title
        .filter(|title| !title.is_empty())
        .or_else(|| descriptor_label.filter(|title| !title.trim().is_empty()))
        .or_else(|| {
            events
                .iter()
                .find(|event| event.item.role == "user")
                .map(|event| preview(&event.body))
                .filter(|title| !title.is_empty())
        })
        .unwrap_or_else(|| "DeepSeek Harness session".into());
    let message_count = events
        .iter()
        .filter(|event| matches!(event.item.event.segment.as_str(), "message" | "tool"))
        .count();
    let (usage_records, usage_diagnostics) =
        dsh_request_usage_records(&rows, expected_id, seed_length, 0);
    dsh_attach_reply_usage(&mut events, &reply_owners, &usage_records);
    let token_count = (!usage_records.is_empty())
        .then(|| {
            usage_records.iter().try_fold(0u64, |total, record| {
                total.checked_add(record.tokens.total?)
            })
        })
        .flatten();
    let summary = SessionSummary {
        diagnostic: None,
        session: session_ref(expected_id),
        search_title: Some(title.clone()),
        title,
        directory: cwd,
        created_at: Some(created_at),
        updated_at: Some(updated_at),
        message_count,
        conversation_message_count: None,
        token_count,
        duration_ms: None,
        summary_files: None,
        summary_additions: None,
        summary_deletions: None,
        parent,
    };
    let candidates = dsh_event_candidates(&rows, expected_id, &events, 0);
    let compactions = recorded_compactions(&rows, 0, path)?;
    Ok((
        SessionSnapshot {
            summary,
            revision,
            events,
            relations: Vec::new(),
        },
        candidates,
        usage_records,
        usage_diagnostics,
        Vec::new(),
        compactions,
    ))
}

fn load_dsh_with_protocol(path: &Path, scope: &str, expected_id: &str) -> Result<LoadedDsh> {
    match path.file_name().and_then(|name| name.to_str()) {
        Some("session.jsonl" | "session.jsonl.zstd") => {
            load_v0_with_protocol(path, scope, expected_id)
        }
        Some(
            "session.v1.jsonl"
            | "session.v1.jsonl.zstd"
            | "session.v2.jsonl"
            | "session.v2.jsonl.zstd"
            | "session.v3.jsonl"
            | "session.v3.jsonl.zstd"
            | "session.v4.jsonl"
            | "session.v4.jsonl.zstd",
        ) => load_versioned_with_protocol(path, scope, expected_id),
        _ => Err(parse_error(path, "unsupported DSH source generation")),
    }
}

fn load_dsh(path: &Path, scope: &str, expected_id: &str) -> Result<SessionSnapshot> {
    load_dsh_with_protocol(path, scope, expected_id).map(|(snapshot, _, _, _, _, _)| snapshot)
}

fn dsh_event_candidates(
    rows: &[Value],
    session_id: &str,
    reader: &[NormalizedEvent],
    owned_from_seq: u64,
) -> Vec<EventCandidate> {
    let reader_refs: HashMap<_, _> = reader
        .iter()
        .map(|event| {
            (
                (
                    event.item.event.message_id.as_str(),
                    event.item.event.segment.as_str(),
                ),
                &event.item.event,
            )
        })
        .collect();
    rows.iter()
        .enumerate()
        .filter(|(index, row)| {
            *index == 0 || row["seq"].as_u64().is_some_and(|seq| seq >= owned_from_seq)
        })
        .map(|(index, row)| {
            let raw_type = row["type"].as_str().expect("validated DSH source type");
            let seq =
                (index > 0).then(|| row["seq"].as_u64().expect("validated DSH source sequence"));
            let (category, kind) = if rows[0]["version"] == 4
                && matches!(raw_type, "compaction/prune" | "developer/message")
            {
                ("context", raw_type.replace('/', "."))
            } else {
                dsh_event_vocabulary(raw_type)
            };
            let message_id = if row["surfaceOp"].is_object() {
                None
            } else {
                match raw_type {
                    "user/message"
                        if row.pointer("/data/source/kind").and_then(Value::as_str)
                            == Some("user") =>
                    {
                        row.pointer("/data/id")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| seq.map(|seq| format!("user:{seq}")))
                            .map(|id| (id, "message"))
                    }
                    "assistant/message" => row
                        .pointer("/data/message/id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| {
                            (row.pointer("/data/content").is_some())
                                .then(|| format!("assistant:{}", seq.unwrap()))
                        })
                        .map(|id| (id, "message")),
                    "tool/call" => row
                        .pointer("/data/callId")
                        .and_then(Value::as_str)
                        .map(|id| (id.to_owned(), "tool")),
                    "tool/result" => row
                        .pointer("/data/callId")
                        .and_then(Value::as_str)
                        .map(|_| (format!("tool-result:{}:0", seq.unwrap()), "tool"))
                        .or_else(|| {
                            row.pointer("/data/message/source/callId")
                                .and_then(Value::as_str)
                                .map(|id| (id.to_owned(), "tool"))
                        }),
                    "compaction/summary" => seq.map(|seq| (format!("compaction:{seq}"), "context")),
                    _ => None,
                }
            };
            let reader_event = message_id.and_then(|(id, segment)| {
                reader_refs
                    .get(&(id.as_str(), segment))
                    .map(|event| (*event).clone())
            });
            EventCandidate {
                id: seq.map_or_else(
                    || "event:dsh:header".into(),
                    |seq| format!("event:dsh:{seq}"),
                ),
                session: session_ref(session_id),
                source_order: SourceOrder {
                    record: index as u64,
                    ordinal: 0,
                },
                timestamp: if index == 0 {
                    row["createdAt"].as_i64()
                } else {
                    row["time"].as_i64()
                },
                category: category.into(),
                kind,
                provenance: Provenance {
                    fidelity: Fidelity::Recorded,
                    source_type: if index == 0 {
                        "dsh.session.header".into()
                    } else {
                        format!("dsh.session-event:{raw_type}")
                    },
                    source_id: Some(seq.map_or_else(|| session_id.into(), |seq| seq.to_string())),
                },
                reader_event,
                execution: None,
            }
        })
        .collect()
}

fn dsh_event_vocabulary(raw_type: &str) -> (&'static str, String) {
    match raw_type {
        "session" => ("session", "session.header".into()),
        "user/message" => ("message", "message.user".into()),
        "assistant/message" => ("message", "message.assistant".into()),
        "tool/call" => ("tool", "tool.call".into()),
        "tool/result" => ("tool", "tool.result".into()),
        "team/message/queued" => ("coordination", "team.message.queued".into()),
        "team/message/delivered" => ("coordination", "team.message.delivered".into()),
        "team/member" => ("coordination", "team.member".into()),
        "team/task" => ("coordination", "team.task".into()),
        "tool-workflow/agent-start" => ("coordination", "tool-workflow.agent-start".into()),
        "tool-workflow/agent-end" => ("coordination", "tool-workflow.agent-end".into()),
        "compaction/summary" => ("context", "context.compaction".into()),
        "compaction/start" | "compaction/end" => ("context", raw_type.replace('/', ".")),
        _ => ("source", format!("dsh.{}", raw_type.replace('/', "."))),
    }
}

fn dsh_protocol_stream(path: &Path, scope: &str, session_id: &str) -> Result<EventStream> {
    let (snapshot, candidates, _, _, _, _) = load_dsh_with_protocol(path, scope, session_id)?;
    finalize_events(
        session_ref(session_id),
        scope.into(),
        snapshot.revision,
        candidates,
    )
    .map_err(CoreError::Protocol)
}

fn dsh_protocol_bundle(path: &Path, scope: &str, session_id: &str) -> Result<ProtocolBundle> {
    let (snapshot, candidates, usage_records, usage_diagnostics, _, compactions) =
        load_dsh_with_protocol(path, scope, session_id)?;
    let mut observations = ObservationCandidates::default();
    observations.usage_records = usage_records;
    let usage_incomplete = !usage_diagnostics.is_empty();
    observations.diagnostics.extend(usage_diagnostics);
    // Reader normalization already validates revision ordering and retains the latest
    // native team-task record. Workflow correlation is not AgentRun identity.
    for relation in &snapshot.relations {
        match relation {
            RelationEntry::Coordination { observation } => {
                observations.coordination.push(CoordinationFact {
                    id: format!("coordination:{}", observation.event_id),
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
            RelationEntry::Task { task } if task.kind == "team-task" => {
                observations.tasks.push(TaskObservation {
                    id: task.id.clone(),
                    kind: task.kind.clone(),
                    status: if task.status == "completed" {
                        RunStatus::Completed
                    } else {
                        RunStatus::Unknown
                    },
                    // The latest snapshot timestamp is an update, not task creation.
                    time_created: None,
                    evidence: Evidence {
                        event_id: format!("event:dsh:{}", task.provenance.source_id),
                        provenance: Provenance {
                            fidelity: Fidelity::Recorded,
                            source_type: task.provenance.source_type.clone(),
                            source_id: Some(task.provenance.source_id.clone()),
                        },
                    },
                })
            }
            RelationEntry::Task { .. } => {}
        }
    }
    let task_state = if observations.tasks.is_empty() {
        ObservationState::NotObserved
    } else {
        ObservationState::Observed
    };
    observations.coverage.insert("tasks".into(), DomainCoverage {
        state: task_state,
        details: "Latest recorded team/task revisions only; nonterminal status is unknown in this projection and creation time is not projected.".into(),
    });
    observations.coverage.insert("work".into(), DomainCoverage {
        state: if observations.tasks.is_empty() { ObservationState::Unknown } else { task_state },
        details: "Latest recorded team tasks and their explicit completion; goals, workflow tasks, task owners and dependencies are not projected.".into(),
    });
    observations.coverage.insert("coordination".into(), DomainCoverage {
        state: if observations.coordination.is_empty() {
            ObservationState::NotObserved
        } else {
            ObservationState::Observed
        },
        details: "Recorded team mailbox and workflow start/end observations; team members, actors and unrecorded outcomes are not projected.".into(),
    });
    if let Some(parent) = snapshot.summary.parent {
        observations.relationships.push(RelationshipObservation {
            id: "relationship:dsh:parent".into(),
            kind: "parent".into(),
            from: parent,
            to: session_ref(session_id),
            correlation_id: None,
            evidence: Evidence {
                event_id: "event:dsh:header".into(),
                provenance: Provenance {
                    fidelity: Fidelity::Recorded,
                    source_type: "dsh.session.header".into(),
                    source_id: Some(session_id.into()),
                },
            },
        });
    }
    observations.coverage.insert(
        "relationships".into(),
        DomainCoverage {
            state: if observations.relationships.is_empty() {
                ObservationState::NotObserved
            } else {
                ObservationState::Observed
            },
            details: "Recorded header parentSession only; parent availability, spawned children, and workflow ownership are not resolved.".into(),
        },
    );
    let compactions_by_source: HashMap<_, _> = compactions
        .into_iter()
        .map(|item| (item.seq.to_string(), item))
        .collect();
    for (sequence, event) in candidates
        .iter()
        .enumerate()
        .filter(|(_, event)| event.kind == "context.compaction")
    {
        let source_id = event.provenance.source_id.as_deref().unwrap();
        let compaction = compactions_by_source
            .get(source_id)
            .expect("validated DSH compaction source row");
        if event.reader_event.is_some() {
            let version_id = format!("context-version:dsh:{source_id}");
            observations.context_versions.push(ContextVersion {
                id: version_id.clone(),
                session_id: session_id.into(),
                sequence: sequence + 1,
                parent_version_ids: vec![],
                artifact_ids: vec![],
                created_at: event.timestamp,
                reader_event: event.reader_event.clone(),
                provenance: event.provenance.clone(),
            });
            observations
                .context_transformations
                .push(ContextTransformation {
                    id: format!("context-transformation:dsh:{source_id}"),
                    session_id: session_id.into(),
                    kind: "compaction",
                    source_version_ids: vec![],
                    source_artifact_ids: vec![],
                    result_artifact_ids: vec![],
                    result_version_id: version_id,
                    event_id: event.id.clone(),
                    run_id: None,
                    turn_id: None,
                    timestamp: event.timestamp,
                    retained_from: None,
                    retained_tail_count: None,
                    shadowed_range: compaction.shadowed_range.clone(),
                    shadowed_seqs: compaction.shadowed_seqs.clone(),
                    shadowed_token_count: compaction.shadowed_token_count,
                    provenance: event.provenance.clone(),
                });
        }
        observations.context_observations.push(ContextObservation {
            id: format!("context:dsh:{}", source_id),
            kind: "compaction-record".into(),
            timestamp: event.timestamp,
            trigger: None,
            pre_compact_tokens: None,
            window_id: None,
            previous_window_id: None,
            first_window_id: None,
            summary_available: event.reader_event.is_some(),
            reader_event: event.reader_event.clone(),
            evidence: Evidence {
                event_id: event.id.clone(),
                provenance: event.provenance.clone(),
            },
        });
    }
    observations.coverage.insert("context".into(), DomainCoverage {
        state: if observations.context_observations.is_empty() {
            ObservationState::Unknown
        } else {
            ObservationState::Observed
        },
        details: "Recorded compaction summaries and shadowed source ranges only; start/end remain raw events and context windows are not inferred.".into(),
    });
    for (domain, details) in [
        (
            "agentRuns",
            "Turn and workflow records remain source events; no AgentRun identity is inferred.",
        ),
        (
            "execution",
            "Tool and workflow execution lifecycle projections are unported.",
        ),
        (
            "ownership",
            "Protocol events preserve source records; exclusive session ownership is not asserted.",
        ),
        ("branches", "Branch projection is unported."),
    ] {
        observations.coverage.insert(
            domain.into(),
            DomainCoverage {
                state: ObservationState::Unknown,
                details: details.into(),
            },
        );
    }
    observations.coverage.insert("usage".into(), DomainCoverage {
        state: if !observations.usage_records.is_empty() {
            ObservationState::Observed
        } else if usage_incomplete {
            ObservationState::Unknown
        } else {
            ObservationState::NotObserved
        },
        details: if usage_incomplete {
            "DSH v0 assistant settlements and v1/v2/v3 turn/step request usage are source-owned; invalid recorded samples are omitted with source-event diagnostics."
        } else {
            "DSH v0 assistant settlements are one recorded request each; v1/v2/v3 usage is folded once per turn/step slot, and a retry opens a new request."
        }.into(),
    });
    let stream = finalize_events(
        session_ref(session_id),
        scope.into(),
        snapshot.revision,
        candidates,
    )?;
    finalize_protocol_bundle(stream, observations).map_err(CoreError::Protocol)
}

impl DshAdapter<'_> {
    fn source_path(&self, session_id: &str) -> Result<PathBuf> {
        let mut inventory = self.sources()?;
        if let Some(ambiguity) = inventory.ambiguities.remove(session_id) {
            return Err(ambiguity.error());
        }
        inventory
            .sources
            .remove(session_id)
            .ok_or_else(|| CoreError::NotFound {
                provider: PROVIDER.into(),
                session_id: session_id.into(),
            })
    }

    fn sources(&self) -> Result<SourceInventory> {
        let sessions = self.root.join("sessions");
        if !sessions.is_dir() {
            return Ok(SourceInventory::default());
        }
        let mut found = BTreeMap::<String, Vec<(u8, PathBuf)>>::new();
        for entry in WalkDir::new(&sessions) {
            let entry = entry.map_err(|error| parse_error(&sessions, error.to_string()))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy();
            let generation = match name.as_ref() {
                "session.jsonl" | "session.jsonl.zstd" => 0,
                "session.v1.jsonl" | "session.v1.jsonl.zstd" => 1,
                "session.v2.jsonl" | "session.v2.jsonl.zstd" => 2,
                "session.v3.jsonl" | "session.v3.jsonl.zstd" => 3,
                "session.v4.jsonl" | "session.v4.jsonl.zstd" => 4,
                _ => continue,
            };
            let path = entry.path().to_path_buf();
            let id = path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .ok_or_else(|| parse_error(&path, "missing canonical session directory"))?;
            found
                .entry(id.to_owned())
                .or_default()
                .push((generation, path));
        }
        let mut inventory = SourceInventory::default();
        for (id, mut entries) in found {
            entries.sort();
            let mixed = entries
                .iter()
                .any(|(_, path)| path.to_string_lossy().ends_with(".zstd"))
                && entries
                    .iter()
                    .any(|(_, path)| !path.to_string_lossy().ends_with(".zstd"));
            if mixed {
                inventory.ambiguities.insert(
                    id.clone(),
                    SourceAmbiguity {
                        session_id: id,
                        code: "dsh_mixed_source_encodings".into(),
                        candidates: entries,
                    },
                );
                continue;
            }
            let generation = entries
                .iter()
                .map(|(generation, _)| *generation)
                .max()
                .unwrap();
            let paths: Vec<_> = entries
                .iter()
                .filter_map(|(candidate, path)| (*candidate == generation).then_some(path.clone()))
                .collect();
            if paths.len() > 1 {
                inventory.ambiguities.insert(
                    id.clone(),
                    SourceAmbiguity {
                        session_id: id,
                        code: "dsh_duplicate_source_generation".into(),
                        candidates: entries,
                    },
                );
            } else if let Some(path) = paths.into_iter().next() {
                inventory.sources.insert(id, path);
            }
        }
        Ok(inventory)
    }

    fn source_entries(&self) -> Result<Vec<SourceEntry>> {
        let inventory = self.sources()?;
        let mut entries = inventory
            .sources
            .into_iter()
            .map(|(id, path)| SourceEntry::new(id, path))
            .collect::<Result<Vec<_>>>()?;
        for ambiguity in inventory.ambiguities.into_values() {
            entries.push(ambiguity.entry()?);
        }
        entries.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        Ok(entries)
    }
}

#[derive(Default)]
struct SourceInventory {
    sources: BTreeMap<String, PathBuf>,
    ambiguities: BTreeMap<String, SourceAmbiguity>,
}

struct SourceAmbiguity {
    session_id: String,
    code: &'static str,
    candidates: Vec<(u8, PathBuf)>,
}

impl SourceAmbiguity {
    fn error(&self) -> CoreError {
        let reason = if self.code == "dsh_mixed_source_encodings" {
            format!(
                "mixed raw/Zstandard DSH generations for canonical session {}",
                self.session_id
            )
        } else {
            format!(
                "duplicate DSH generation v{} for canonical session {}",
                self.candidates
                    .iter()
                    .map(|(generation, _)| generation)
                    .max()
                    .unwrap(),
                self.session_id
            )
        };
        parse_error(&self.candidates[0].1, reason)
    }

    fn entry(&self) -> Result<SourceEntry> {
        let mut digest = Sha256::new();
        digest.update(self.code.as_bytes());
        digest.update(self.session_id.as_bytes());
        for (generation, path) in &self.candidates {
            digest.update([*generation]);
            digest.update(
                SourceEntry::new(self.session_id.clone(), path.clone())?
                    .signature
                    .as_bytes(),
            );
        }
        Ok(SourceEntry {
            session_id: self.session_id.clone(),
            path: self.candidates[0].1.clone(),
            signature: format!("dsh-ambiguity:{:x}", digest.finalize()),
        })
    }

    fn snapshot(&self, revision: String) -> SessionSnapshot {
        SessionSnapshot {
            summary: SessionSummary {
                session: session_ref(&self.session_id),
                title: self.session_id.clone(),
                search_title: Some(self.session_id.clone()),
                diagnostic: Some(self.code.into()),
                directory: None,
                created_at: None,
                updated_at: None,
                message_count: 0,
                conversation_message_count: None,
                token_count: None,
                duration_ms: None,
                summary_files: None,
                summary_additions: None,
                summary_deletions: None,
                parent: None,
            },
            revision,
            events: Vec::new(),
            relations: Vec::new(),
        }
    }
}

impl ProviderAdapter for DshAdapter<'_> {
    fn team_messages(&self, session_id: &str) -> Result<crate::TeamMessageInventory> {
        let snapshot = self.load(session_id)?;
        let messages = snapshot
            .relations
            .iter()
            .filter_map(|entry| {
                let RelationEntry::Coordination { observation } = entry else {
                    return None;
                };
                if observation.provenance.source_type != "dsh.session-event:team/message/queued" {
                    return None;
                }
                let message = crate::TeamMessageRef {
                    provider: "deepseek-harness".into(),
                    session_id: session_id.into(),
                    source_id: observation.provenance.source_id.clone(),
                    message_id: observation.correlation_id.clone(),
                };
                Some(crate::TeamMessageSummary {
                    message: message.clone(),
                    from: observation.from_session_ref.clone(),
                    to: observation.to_session_ref.clone(),
                    from_participant: observation.from_participant.clone(),
                    to_participant: observation.to_participant.clone(),
                    excerpt: observation.message_excerpt.clone(),
                    excerpt_truncated: observation.message_excerpt_truncated.unwrap_or(false),
                    provenance: observation.provenance.clone(),
                    read_arguments: crate::TeamMessageReadArguments {
                        action: "read",
                        message,
                        revision: snapshot.revision.clone(),
                    },
                })
            })
            .collect();
        Ok(crate::TeamMessageInventory {
            revision: snapshot.revision,
            messages,
        })
    }

    fn team_message_read(
        &self,
        session_id: &str,
        source_id: &str,
        message_id: &str,
        revision: &str,
        offset: usize,
        max_chars: usize,
    ) -> Result<ContentPage> {
        let sequence = source_id
            .parse::<u64>()
            .map_err(|_| CoreError::EventNotFound(message_id.into()))?;
        self.team_message_content(
            session_id, sequence, message_id, revision, offset, max_chars,
        )
    }

    fn team_message_content(
        &self,
        session_id: &str,
        sequence: u64,
        message_id: &str,
        revision: &str,
        offset: usize,
        max_chars: usize,
    ) -> Result<ContentPage> {
        let path = self.source_path(session_id)?;
        let generation = match path.file_name().and_then(|name| name.to_str()) {
            Some("session.v1.jsonl" | "session.v1.jsonl.zstd") => 1,
            Some("session.v2.jsonl" | "session.v2.jsonl.zstd") => 2,
            Some("session.v3.jsonl" | "session.v3.jsonl.zstd") => 3,
            Some("session.v4.jsonl" | "session.v4.jsonl.zstd") => 4,
            _ => return Err(CoreError::EventNotFound(message_id.into())),
        };
        let bytes = fs::read(&path).map_err(|source| CoreError::Io {
            path: path.clone(),
            source,
        })?;
        if versioned_revision(&path, self.scope, generation, &bytes) != revision {
            return Err(CoreError::SourceChanged);
        }
        let rows = read_dsh_rows(&path, &bytes)?;
        let rows = if generation == 1 {
            rows.into_iter()
                .map(|row| expand_v0_packed_row(row, &path))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
        } else {
            rows
        };
        if rows
            .first()
            .map(|row| required(row, "id", &path))
            .transpose()?
            != Some(session_id)
        {
            return Err(parse_error(
                &path,
                "header canonical ID differs from session directory",
            ));
        }
        let owned_from_seq = if generation == 1 {
            rows[0]["seedLength"].as_u64().unwrap_or(0)
        } else if rows[0]["isSeeded"] == true {
            rows.iter()
                .filter(|row| row["type"] == "session/end-seed" && row["data"]["inherited"] == true)
                .filter_map(|row| row["seq"].as_u64())
                .last()
                .ok_or_else(|| {
                    parse_error(
                        &path,
                        "seeded source lacks inherited session/end-seed marker",
                    )
                })?
        } else {
            0
        };
        if sequence < owned_from_seq {
            return Err(CoreError::EventNotFound(message_id.into()));
        }
        let row = rows
            .get(
                usize::try_from(sequence)
                    .ok()
                    .and_then(|seq| seq.checked_add(1))
                    .ok_or_else(|| CoreError::EventNotFound(message_id.into()))?,
            )
            .filter(|row| {
                row["seq"] == sequence
                    && row["type"] == "team/message/queued"
                    && row["data"]["message"]["id"] == message_id
            })
            .ok_or_else(|| CoreError::EventNotFound(message_id.into()))?;
        let blocks = row["data"]["message"]["content"]
            .as_array()
            .ok_or_else(|| parse_error(&path, "team message content is not an array"))?;
        let text = blocks
            .iter()
            .map(|block| {
                if block["type"] != "text" {
                    return Err(parse_error(&path, "unsupported team message content block"));
                }
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| parse_error(&path, "invalid team message text block"))
            })
            .collect::<Result<Vec<_>>>()?
            .join("\n\n");
        crate::page_text(&text, offset, max_chars)
    }

    fn storage_diagnostic(&self) -> Option<Value> {
        let mut diagnostic = sqlite_storage_diagnostic(self.root);
        match self.sources() {
            Ok(inventory) if !inventory.ambiguities.is_empty() => {
                let mut counts = BTreeMap::<&str, usize>::new();
                for ambiguity in inventory.ambiguities.values() {
                    *counts.entry(ambiguity.code).or_default() += 1;
                }
                let source_diagnostics = counts.into_iter().map(|(code, count)| {
                    serde_json::json!({"code": code, "affectedSessions": count})
                }).collect::<Vec<_>>();
                let value = diagnostic.get_or_insert_with(|| serde_json::json!({
                    "code": "dsh_source_ambiguity",
                    "note": "Some DeepSeek Harness sessions have ambiguous source generations; their history is unavailable."
                }));
                value["sourceDiagnostics"] = serde_json::json!(source_diagnostics);
            }
            Err(error) => {
                let value = diagnostic.get_or_insert_with(|| serde_json::json!({}));
                value["code"] = serde_json::json!("dsh_source_inventory_read_failed");
                value["note"] = serde_json::json!(error.to_string());
            }
            _ => {}
        }
        diagnostic
    }

    fn protocol_capabilities(&self) -> super::ProtocolCapabilities {
        super::protocol_capability_map(&[
            ("sessionEvents", "recorded"),
            ("sessionRelationships", "recorded"),
            ("tasks", "recorded"),
        ])
    }

    fn available(&self) -> bool {
        self.root.join("sessions").is_dir() || self.storage_diagnostic().is_some()
    }
    fn unavailable_diagnostic(&self) -> &'static str {
        "DeepSeek Harness sessions directory is unavailable"
    }
    fn load(&self, session_id: &str) -> Result<SessionSnapshot> {
        let path = self.source_path(session_id)?;
        load_dsh(&path, self.scope, session_id)
    }
    fn inherited_context(&self, session_id: &str) -> Result<Option<InheritedContextSnapshot>> {
        let path = self.source_path(session_id)?;
        let (snapshot, _, _, _, events, _) = load_dsh_with_protocol(&path, self.scope, session_id)?;
        if events.is_empty() {
            return Ok(None);
        }
        Ok(Some(InheritedContextSnapshot {
            revision: snapshot.revision,
            source_session: snapshot.summary.parent,
            events: events.into(),
        }))
    }
    fn system_prompt_evidence(&self, session_id: &str) -> Result<crate::SystemPromptEvidence> {
        let path = self.source_path(session_id)?;
        let snapshot = load_dsh(&path, self.scope, session_id)?;
        let summary = snapshot.summary;
        let mut evidence = crate::SystemPromptEvidence::new(&summary, "deepseek-harness-recorded");
        let bytes = fs::read(&path).map_err(|source| CoreError::Io {
            path: path.clone(),
            source,
        })?;
        let mut rows = Vec::new();
        for row in read_dsh_rows(&path, &bytes)? {
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("session.v3") || name.starts_with("session.v4")
                })
            {
                rows.push(row);
            } else {
                rows.extend(expand_v0_packed_row(row, &path)?);
            }
        }
        if rows
            .first()
            .is_some_and(|header| matches!(header["version"].as_u64(), Some(3 | 4)))
        {
            let mut surface = Vec::<&Value>::new();
            for row in rows.iter().skip(1) {
                if !matches!(
                    row["type"].as_str(),
                    Some(
                        "system/message"
                            | "user/message"
                            | "assistant/message"
                            | "tool/result"
                            | "developer/message"
                    )
                ) {
                    continue;
                }
                if row["surfaceOp"] == "append" {
                    surface.push(row);
                } else if let (Some(start_seq), Some(end_seq)) = (
                    row["surfaceOp"]["startSeq"].as_u64(),
                    row["surfaceOp"]["endSeq"].as_u64(),
                ) {
                    if let (Some(start), Some(end)) = (
                        surface
                            .iter()
                            .position(|head| head["seq"].as_u64() == Some(start_seq)),
                        surface
                            .iter()
                            .position(|head| head["seq"].as_u64() == Some(end_seq)),
                    ) {
                        surface.splice(start..=end, [row]);
                    }
                }
            }
            for row in surface
                .into_iter()
                .filter(|row| row["type"] == "system/message")
            {
                evidence.recorded_with_metadata(
                    "Recorded DSH system message",
                    text_blocks(&row["data"]["message"]["content"], &path)?,
                    format!(
                        "{}#event:{}",
                        path.display(),
                        row["seq"].as_u64().unwrap_or(0)
                    ),
                    row["time"].as_u64().unwrap_or(0),
                    row["data"]["message"]["source"]
                        .as_object()
                        .map(|_| row["data"]["message"]["source"].clone()),
                );
            }
        } else if let Some(row) = rows
            .iter()
            .rev()
            .find(|row| row["type"] == "request/header")
        {
            if let Some(content) = row["data"]["header"]["system"].as_str() {
                evidence.recorded(
                    "Recorded DSH request system prompt",
                    content.into(),
                    format!(
                        "{}#event:{}",
                        path.display(),
                        row["seq"].as_u64().unwrap_or(0)
                    ),
                    row["time"].as_u64().unwrap_or(0),
                );
            }
        }
        if load_dsh(&path, self.scope, session_id)?.revision != snapshot.revision {
            return Err(CoreError::SourceChanged);
        }
        evidence.current_files(&summary, &["AGENTS.md"]);
        Ok(evidence)
    }
    fn protocol_event_stream(&self, session_id: &str) -> Result<EventStream> {
        let path = self.source_path(session_id)?;
        dsh_protocol_stream(&path, self.scope, session_id)
    }
    fn protocol_observations(&self, session_id: &str) -> Result<ObservationSnapshot> {
        Ok(self.protocol_bundle(session_id)?.into_observations())
    }
    fn protocol_bundle(&self, session_id: &str) -> Result<ProtocolBundle> {
        let path = self.source_path(session_id)?;
        dsh_protocol_bundle(&path, self.scope, session_id)
    }
    fn inventory(&self) -> Result<Vec<SourceEntry>> {
        self.source_entries()
    }
    fn capture(&self, entry: &SourceEntry) -> Result<SessionSnapshot> {
        let mut inventory = self.sources()?;
        if let Some(ambiguity) = inventory.ambiguities.remove(&entry.session_id) {
            let current = ambiguity.entry()?;
            if current.signature != entry.signature || current.path != entry.path {
                return Err(CoreError::SourceChanged);
            }
            return Ok(ambiguity.snapshot(current.signature));
        }
        if inventory.sources.get(&entry.session_id) != Some(&entry.path)
            || SourceEntry::new(entry.session_id.clone(), entry.path.clone())?.signature
                != entry.signature
        {
            return Err(CoreError::SourceChanged);
        }
        load_dsh(&entry.path, self.scope, &entry.session_id)
    }
    fn source_signature(&self, entry: &SourceEntry) -> Result<String> {
        let mut inventory = self.sources()?;
        if let Some(ambiguity) = inventory.ambiguities.remove(&entry.session_id) {
            return Ok(ambiguity.entry()?.signature);
        }
        let path = inventory
            .sources
            .remove(&entry.session_id)
            .ok_or(CoreError::SourceChanged)?;
        Ok(SourceEntry::new(entry.session_id.clone(), path)?.signature)
    }
    fn validate_inventory(&self, incoming: &BTreeMap<String, SourceEntry>) -> Result<()> {
        let current = self
            .source_entries()?
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn agent_preset_selection_v3_keeps_conversation_and_recorded_source_evidence() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v3.jsonl");
        let rows = [
            serde_json::json!({"type":"session","version":3,"id":"preset-selection","createdAt":1,"isSeeded":false}),
            serde_json::json!({"type":"agent-preset/selected","seq":0,"time":2,"data":{"agentPreset":"research"}}),
            serde_json::json!({"type":"user/message","seq":1,"time":3,"surfaceOp":"append","data":{"id":"request","source":{"kind":"user"},"content":[{"type":"text","text":"Read the selected session."}]}}),
            serde_json::json!({"type":"assistant/message","seq":2,"time":4,"surfaceOp":"append","data":{"message":{"id":"answer","role":"assistant","content":[{"type":"text","text":"The conversation remains readable."}]}}}),
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
        let snapshot = load_v3(&path, "test", "preset-selection").unwrap();
        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.events[0].body, "Read the selected session.");
        assert_eq!(
            snapshot.events[1].body,
            "The conversation remains readable."
        );
        assert!(snapshot.relations.is_empty());
        let protocol = dsh_protocol_stream(&path, "test", "preset-selection").unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(page.events.len(), 4);
        assert_eq!(
            page.events[1].provenance.source_type,
            "dsh.session-event:agent-preset/selected"
        );
        assert_eq!(page.events[1].provenance.source_id.as_deref(), Some("0"));
        assert!(page.events[1].reader_event.is_none());
    }

    #[test]
    fn agent_preset_selection_v3_requires_a_string_preset() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v3.jsonl");
        let header = serde_json::json!({"type":"session","version":3,"id":"preset-selection","createdAt":1,"isSeeded":false});
        for data in [
            serde_json::json!({}),
            serde_json::json!({"agentPreset":false}),
        ] {
            let event =
                serde_json::json!({"type":"agent-preset/selected","seq":0,"time":2,"data":data});
            fs::write(&path, format!("{header}\n{event}\n")).unwrap();
            assert!(matches!(load_v3(&path, "test", "preset-selection"),
                Err(CoreError::Parse { reason, .. }) if reason.contains("agentPreset")));
        }
    }

    #[test]
    fn agent_preset_selection_v3_retains_unknown_required_event_failure() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v3.jsonl");
        let rows = [
            serde_json::json!({"type":"session","version":3,"id":"preset-selection","createdAt":1,"isSeeded":false}),
            serde_json::json!({"type":"agent-preset/selected","seq":0,"time":2,"data":{"agentPreset":"research"}}),
            serde_json::json!({"type":"future/required-event","seq":1,"time":3,"data":{}}),
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
        assert!(matches!(load_v3(&path, "test", "preset-selection"),
            Err(CoreError::Parse { reason, .. }) if reason.contains("unsupported required DSH v3 event future/required-event at seq 1")));
    }

    #[test]
    fn native_v3_keeps_recorded_llm_retry_and_unknown_ignorable_records_loadable() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v3.jsonl");
        let header = serde_json::json!({"type":"session","version":3,"id":"v3-optional","createdAt":1,"isSeeded":false});
        let retry = serde_json::json!({"type":"llm/retry","seq":0,"time":2,"data":{"turn":1,"step":1,"reason":"rate-limited"}});
        let ignorable = serde_json::json!({"type":"web/metaso-search-request","seq":1,"time":3,"ignorable":true,"data":{"query":"public"}});
        let user = serde_json::json!({"type":"user/message","seq":2,"time":4,"surfaceOp":"append","data":{"id":"request","source":{"kind":"user"},"content":[{"type":"text","text":"Read the retried session."}]}});
        let assistant = serde_json::json!({"type":"assistant/message","seq":3,"time":5,"surfaceOp":"append","data":{"message":{"id":"answer","role":"assistant","content":[{"type":"text","text":"The conversation remains readable."}]}}});
        let write = |rows: &[Value], path: &Path| {
            fs::write(
                path,
                rows.iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\n",
            )
            .unwrap();
        };
        write(
            &[header.clone(), retry, ignorable.clone(), user, assistant],
            &path,
        );
        let snapshot = load_v3(&path, "test", "v3-optional").unwrap();
        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.events[0].body, "Read the retried session.");
        let protocol = dsh_protocol_stream(&path, "test", "v3-optional").unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(page.events.len(), 5);
        assert_eq!(
            page.events[1].provenance.source_type,
            "dsh.session-event:llm/retry"
        );
        assert_eq!(
            page.events[2].provenance.source_type,
            "dsh.session-event:web/metaso-search-request"
        );
        assert!(page.events[2].reader_event.is_none());

        let mut required = ignorable;
        required.as_object_mut().unwrap().remove("ignorable");
        write(
            &[
                header,
                serde_json::json!({"type":"llm/retry","seq":0,"time":2,"data":{"turn":1,"step":1,"reason":"rate-limited"}}),
                required,
                serde_json::json!({"type":"user/message","seq":2,"time":4,"surfaceOp":"append","data":{"id":"request","source":{"kind":"user"},"content":[{"type":"text","text":"Read the retried session."}]}}),
                serde_json::json!({"type":"assistant/message","seq":3,"time":5,"surfaceOp":"append","data":{"message":{"id":"answer","role":"assistant","content":[{"type":"text","text":"The conversation remains readable."}]}}}),
            ],
            &path,
        );
        assert!(matches!(load_v3(&path, "test", "v3-optional"),
            Err(CoreError::Parse { reason, .. }) if reason.contains("unsupported required DSH v3 event web/metaso-search-request at seq 1")));
    }

    #[test]
    fn recorded_v3_control_events_preserve_source_facts_without_reader_messages() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v3.jsonl");
        let rows = [
            serde_json::json!({"type":"session","version":3,"id":"control-events","createdAt":1,"isSeeded":false}),
            serde_json::json!({"type":"approval/asked","seq":0,"time":2,"data":{"id":"approval-1","toolName":"run_code","callId":"root-call","reason":"Public synthetic approval reason"}}),
            serde_json::json!({"type":"approval/decided","seq":1,"time":3,"data":{"id":"approval-1","outcome":"allowed-once"}}),
            serde_json::json!({"type":"tool/ptc-dispatch-start","seq":2,"time":4,"data":{"rootCallId":"root-call","parentCallId":"root-call","subCallId":"nested-call","name":"read","arguments":{"path":"public.txt"}}}),
            serde_json::json!({"type":"tool/ptc-dispatch","seq":3,"time":5,"data":{"rootCallId":"root-call","parentCallId":"root-call","subCallId":"nested-call","name":"read","arguments":{"path":"public.txt"},"isError":false,"content":[{"type":"text","text":"Public nested result"}]}}),
            serde_json::json!({"type":"deliverables/presented","seq":4,"time":6,"data":{"turn":1,"callId":"root-call","files":[{"path":"public.txt","description":"Public deliverable"}]}}),
            serde_json::json!({"type":"user/message","seq":5,"time":7,"surfaceOp":"append","data":{"id":"request","source":{"kind":"user"},"content":[{"type":"text","text":"Show the conversation."}]}}),
            serde_json::json!({"type":"assistant/message","seq":6,"time":8,"surfaceOp":"append","data":{"message":{"id":"answer","role":"assistant","content":[{"type":"text","text":"The conversation remains readable."}]}}}),
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
        let snapshot = load_v3(&path, "test", "control-events").unwrap();
        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.events[0].body, "Show the conversation.");
        assert_eq!(
            snapshot.events[1].body,
            "The conversation remains readable."
        );
        assert!(snapshot.relations.is_empty());
        let protocol = dsh_protocol_stream(&path, "test", "control-events").unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(page.events.len(), rows.len());
        for (index, row) in rows.iter().enumerate().take(6).skip(1) {
            assert_eq!(
                page.events[index].provenance.source_type,
                format!("dsh.session-event:{}", row["type"].as_str().unwrap())
            );
            assert_eq!(
                page.events[index].provenance.source_id.as_deref(),
                Some((index - 1).to_string().as_str())
            );
            assert!(page.events[index].reader_event.is_none());
        }
    }

    #[test]
    fn recorded_v3_control_events_reject_malformed_declared_payload_fields() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v3.jsonl");
        let header = serde_json::json!({"type":"session","version":3,"id":"control-events","createdAt":1,"isSeeded":false});
        let dispatch = serde_json::json!({"rootCallId":"root","parentCallId":"parent","subCallId":"sub","name":"read","arguments":{},"isError":false,"content":[{"type":"text","text":"Public result"}]});
        let mut cases = vec![
            ("approval/asked", serde_json::json!({"id":"approval"})),
            (
                "approval/asked",
                serde_json::json!({"id":"approval","toolName":"read","reason":false}),
            ),
            (
                "approval/decided",
                serde_json::json!({"id":"approval","outcome":"future-grant"}),
            ),
            (
                "deliverables/presented",
                serde_json::json!({"turn":"one","callId":"root","files":[]}),
            ),
            (
                "deliverables/presented",
                serde_json::json!({"turn":1,"callId":"root","files":[{"path":false}]}),
            ),
            (
                "deliverables/presented",
                serde_json::json!({"turn":1,"callId":"root","files":[{"path":"public.txt","description":1}]}),
            ),
        ];
        let mut missing_root = dispatch.clone();
        missing_root.as_object_mut().unwrap().remove("rootCallId");
        cases.push(("tool/ptc-dispatch-start", missing_root));
        let mut missing_arguments = dispatch.clone();
        missing_arguments
            .as_object_mut()
            .unwrap()
            .remove("arguments");
        cases.push(("tool/ptc-dispatch-start", missing_arguments));
        for (field, invalid) in [
            ("isError", serde_json::json!("false")),
            ("content", serde_json::json!({})),
            ("content", serde_json::json!([{"type":"text","text":false}])),
            ("error", serde_json::json!({"name":"Failure","code":1})),
        ] {
            let mut data = dispatch.clone();
            data[field] = invalid;
            cases.push(("tool/ptc-dispatch", data));
        }
        for (kind, data) in cases {
            let event = serde_json::json!({"type":kind,"seq":0,"time":2,"data":data});
            fs::write(&path, format!("{header}\n{event}\n")).unwrap();
            assert!(
                matches!(load_v3(&path, "test", "control-events"),
                Err(CoreError::Parse { reason, .. }) if reason.contains(kind)),
                "accepted malformed {kind}"
            );
        }
    }

    #[test]
    fn native_team_v3_restores_catalog_watermarks_and_unassigned_pending_tasks() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/deepseek-harness-native-team/sessions/public/native-team-parent/session.v3.jsonl");
        let loaded = load_dsh_with_protocol(&source, "test", "native-team-parent").unwrap();
        assert_eq!(loaded.1.len(), 13);
        let snapshot = loaded.0;
        let catalog = snapshot
            .relations
            .iter()
            .find_map(|entry| match entry {
                RelationEntry::Coordination { observation }
                    if observation.provenance.source_id == "4" =>
                {
                    Some(observation)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(catalog.kind, "spawn");
        assert_eq!(catalog.state, "started");
        assert_eq!(
            catalog.provenance.source_type,
            "dsh.session-event:subagent/catalog"
        );
        assert_eq!(
            catalog.to_session_ref,
            Some(session_ref("native-team-child"))
        );
        assert!(
            !snapshot
                .events
                .iter()
                .any(|event| event.item.event.message_id == "public-received-mail")
        );
        let mut rows: Vec<Value> = fs::read_to_string(&source)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        rows.truncate(4);
        let temp = tempdir().unwrap();
        let file = temp.path().join("session.v3.jsonl");
        fs::write(
            &file,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let pending = load_dsh(&file, "test", "native-team-parent").unwrap();
        assert!(
            matches!(&pending.relations[0], RelationEntry::Task { task } if task.owner.is_none() && task.owner_participant.is_none() && task.status == "queued")
        );
    }

    #[test]
    fn native_team_v3_one_shot_catalog_preserves_empty_optional_label() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/deepseek-harness-native-team/sessions/public/native-team-parent/session.v3.jsonl");
        let mut rows: Vec<Value> = fs::read_to_string(&source)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        rows[5]["data"]["mode"] = serde_json::json!("one-shot");
        rows[5]["data"]["label"] = serde_json::json!("");
        let temp = tempdir().unwrap();
        let file = temp.path().join("session.v3.jsonl");
        fs::write(
            &file,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let snapshot = load_dsh(&file, "test", "native-team-parent").unwrap();
        assert!(snapshot.relations.iter().any(|entry| matches!(entry,
            RelationEntry::Coordination { observation } if observation.kind == "spawn" && observation.provenance.source_id == "4")));
    }

    #[test]
    fn native_team_v3_consumed_payload_boundaries_remain_explicit() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/deepseek-harness-native-team/sessions/public/native-team-parent/session.v3.jsonl");
        let rows: Vec<Value> = fs::read_to_string(&source)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let temp = tempdir().unwrap();
        let file = temp.path().join("session.v3.jsonl");
        assert!(load_dsh(&source, "test", "native-team-parent").is_ok());
        for (index, key, invalid) in [
            (2, "throughSeq", serde_json::json!(1)),
            (2, "sessionId", serde_json::json!("foreign")),
            (5, "version", serde_json::json!(1)),
            (5, "childCreatedAt", serde_json::json!(-1)),
            (5, "mode", serde_json::json!("unknown")),
            (5, "label", serde_json::json!(null)),
            (5, "unrecorded", serde_json::json!(true)),
        ] {
            let mut invalid_rows = rows.clone();
            invalid_rows[index]["data"][key] = invalid;
            fs::write(
                &file,
                invalid_rows
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\n",
            )
            .unwrap();
            assert!(
                load_dsh(&file, "test", "native-team-parent").is_err(),
                "accepted invalid {key}"
            );
        }
    }

    #[test]
    fn queued_team_content_pages_multi_block_utf16_and_rejects_rewrites() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("sessions").join("team-owner");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("session.v3.jsonl");
        let mut rows = vec![
            serde_json::json!({"type":"session","version":3,"id":"team-owner",
                "createdAt":100,"isSeeded":false,"delegationDepth":0}),
            serde_json::json!({"type":"team/message/queued","seq":0,"time":101,
                "data":{"version":2,"teamId":"team-owner","message":{
                    "id":"mail-1","senderId":"team-owner","targetId":"worker",
                    "content":[{"type":"text","text":"A🚀"},{"type":"text","text":"B-tail"}]}}}),
            serde_json::json!({"type":"team/message/delivered","seq":1,"time":102,
                "data":{"version":2,"teamId":"team-owner","messageId":"mail-1","targetId":"worker"}}),
        ];
        let write_rows = |rows: &[Value]| {
            fs::write(
                &path,
                rows.iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\n",
            )
            .unwrap()
        };
        write_rows(&rows);
        let adapter = DshAdapter {
            root: temp.path(),
            scope: "team-test",
        };
        let revision = adapter.load("team-owner").unwrap().revision;
        let first = adapter
            .team_message_content("team-owner", 0, "mail-1", &revision, 0, 3)
            .unwrap();
        assert_eq!(first.text, "A🚀");
        assert_eq!(first.next_offset, Some(3));
        let second = adapter
            .team_message_content("team-owner", 0, "mail-1", &revision, 3, 8)
            .unwrap();
        assert_eq!(second.text, "\n\nB-tail");
        assert_eq!(second.total_chars, 11);
        assert!(matches!(
            adapter.team_message_content("team-owner", 0, "mail-1", &revision, 2, 8),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            adapter.team_message_content("team-owner", 1, "mail-1", &revision, 0, 8),
            Err(CoreError::EventNotFound(_))
        ));
        assert!(matches!(
            adapter.team_message_content("team-owner", 0, "other", &revision, 0, 8),
            Err(CoreError::EventNotFound(_))
        ));
        rows[1]["data"]["message"]["content"][1]["text"] = "rewritten".into();
        write_rows(&rows);
        assert!(matches!(
            adapter.team_message_content("team-owner", 0, "mail-1", &revision, 0, 8),
            Err(CoreError::SourceChanged)
        ));
        rows[0]["isSeeded"] = true.into();
        rows.insert(
            2,
            serde_json::json!({"type":"session/end-seed","seq":1,"time":102,
            "data":{"inherited":true}}),
        );
        rows[3]["seq"] = 2.into();
        rows[3]["time"] = 103.into();
        write_rows(&rows);
        let seeded_revision = adapter.load("team-owner").unwrap().revision;
        assert!(matches!(
            adapter.team_message_content("team-owner", 0, "mail-1", &seeded_revision, 0, 8),
            Err(CoreError::EventNotFound(_))
        ));
    }

    #[test]
    fn sqlite_storage_detection_matches_the_conventional_2_0_locations() {
        let temp = tempdir().unwrap();
        let candidates = [
            "sessions.sqlite",
            "sessions.sqlite3",
            "sessions.db",
            "dsh.sqlite",
            "dsh.sqlite3",
            "dsh.db",
        ];
        for (index, name) in candidates.into_iter().enumerate() {
            let root = temp.path().join(index.to_string());
            fs::create_dir_all(&root).unwrap();
            let path = root.join(name);
            fs::write(&path, SQLITE_HEADER).unwrap();
            let display = path.to_string_lossy().into_owned();
            assert_eq!(
                sqlite_storage_diagnostic(&root),
                Some(serde_json::json!({
                    "backend": "sqlite",
                    "status": "unsupported",
                    "path": display,
                    "detectedSchema": null,
                    "expectedSchema": 17,
                    "message": format!(
                        "Legacy DeepSeek Harness SQLite persistence was detected at {display}, but AgentSession does not inspect or migrate that database. The current reader supports JSONL; schema 17 remains documented for existing stores."
                    ),
                })),
                "SQLite header at {name}"
            );
        }

        let invalid_root = temp.path().join("invalid");
        fs::create_dir(&invalid_root).unwrap();
        fs::write(invalid_root.join(candidates[0]), b"not SQLite").unwrap();
        assert_eq!(sqlite_storage_diagnostic(&invalid_root), None);
    }

    #[test]
    fn recorded_compaction_summary_has_one_source_positioned_reader_checkpoint() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/deepseek-harness-compaction/sessions/public");
        let id = "dsh-v3-compact";
        let path = root.join(id).join("session.v3.jsonl");
        let snapshot = load_dsh(&path, "test", id).unwrap();
        assert_eq!(snapshot.summary.message_count, 2);
        assert_eq!(snapshot.events.len(), 3);
        assert_eq!(snapshot.events[0].item.event.message_id, "before");
        let checkpoint = &snapshot.events[1];
        assert_eq!(
            checkpoint.item.event,
            event_ref(id, "compaction:2", "context")
        );
        assert_eq!(checkpoint.item.role, "context");
        assert_eq!(checkpoint.item.ordinal, 1);
        assert_eq!(
            checkpoint.body,
            "Recorded DSH summary. Facts retained: alpha and beta. END-OF-SUMMARY."
        );
        assert_eq!(snapshot.events[2].item.event.message_id, "after");
        let stream = dsh_protocol_stream(&path, "test", id).unwrap();
        let page = stream
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        let context: Vec<_> = page
            .events
            .iter()
            .filter(|event| event.category == "context")
            .collect();
        assert_eq!(context.len(), 3);
        assert_eq!(context[0].kind, "compaction.start");
        assert!(context[0].reader_event.is_none());
        assert_eq!(context[1].kind, "context.compaction");
        assert_eq!(context[1].source_order.record, 3);
        assert_eq!(
            context[1].reader_event.as_ref(),
            Some(&checkpoint.item.event)
        );
        assert!(context[2].reader_event.is_none());
        let observations = serde_json::to_value(
            dsh_protocol_bundle(&path, "test", id)
                .unwrap()
                .into_observations(),
        )
        .unwrap();
        assert_eq!(
            observations["contextObservations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let observation = &observations["contextObservations"][0];
        assert_eq!(observation["evidence"]["eventId"], "event:dsh:2");
        assert_eq!(observation["summaryAvailable"], true);
        assert_eq!(
            observation["evidence"]["provenance"]["fidelity"],
            "recorded"
        );
        let version = &observations["contextVersions"][0];
        let transformation = &observations["contextTransformations"][0];
        assert_eq!(version["sequence"], 4);
        assert_eq!(version["readerEvent"]["messageId"], "compaction:2");
        assert_eq!(transformation["eventId"], "event:dsh:2");
        assert_eq!(
            transformation["shadowedRange"],
            serde_json::json!({ "start": 0, "end": 0 })
        );
        assert_eq!(transformation["shadowedSeqs"], serde_json::json!([0]));
        assert_eq!(transformation["shadowedTokenCount"], 123);
        assert_eq!(transformation["sourceVersionIds"], serde_json::json!([]));

        let opaque_id = "dsh-v3-no-summary";
        let opaque_path = root.join(opaque_id).join("session.v3.jsonl");
        let opaque = load_dsh(&opaque_path, "test", opaque_id).unwrap();
        assert_eq!(opaque.events.len(), 2);
        assert!(
            opaque
                .events
                .iter()
                .all(|event| event.item.event.segment != "context")
        );
        let opaque_observations = serde_json::to_value(
            dsh_protocol_bundle(&opaque_path, "test", opaque_id)
                .unwrap()
                .into_observations(),
        )
        .unwrap();
        assert!(
            opaque_observations["contextObservations"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn invalid_recorded_compaction_scope_fails_at_the_dsh_source_boundary() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/deepseek-harness-compaction/sessions/public/dsh-v3-compact/session.v3.jsonl");
        let original = fs::read_to_string(source).unwrap();
        let rows: Vec<Value> = original
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v3.jsonl");
        for invalid in [
            serde_json::json!({ "shadowedRange": { "start": 1, "end": 0 } }),
            serde_json::json!({ "shadowedSeqs": ["0"] }),
        ] {
            let mut changed = rows.clone();
            for (key, value) in invalid.as_object().unwrap() {
                changed[3]["data"][key] = value.clone();
            }
            fs::write(
                &path,
                changed
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\n",
            )
            .unwrap();
            assert!(matches!(load_dsh(&path, "test", "dsh-v3-compact"),
                Err(CoreError::Parse { reason, .. }) if reason.contains("compaction shadowed")));
        }
    }

    #[test]
    fn compaction_text_blocks_join_without_inventing_missing_summary_content() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/deepseek-harness-compaction/sessions/public/dsh-v3-compact/session.v3.jsonl");
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v3.jsonl");
        let mut rows: Vec<Value> = fs::read_to_string(root)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        rows[3]["data"]["summary"] = serde_json::json!([
            {"type":"text","text":"First block."},
            {"type":"reasoning","text":"not summary text"},
            {"type":"text","text":"Second block."}
        ]);
        fs::write(
            &path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let snapshot = load_v3(&path, "test", "dsh-v3-compact").unwrap();
        assert_eq!(snapshot.events[1].body, "First block.Second block.");

        rows[3]["data"]["summary"] = serde_json::json!([]);
        fs::write(
            &path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let snapshot = load_v3(&path, "test", "dsh-v3-compact").unwrap();
        assert_eq!(snapshot.events.len(), 2);
        let stream = dsh_protocol_stream(&path, "test", "dsh-v3-compact").unwrap();
        let summary = stream.event_detail("event:dsh:2").unwrap();
        assert!(summary.event.reader_event.is_none());
        let observations = serde_json::to_value(
            dsh_protocol_bundle(&path, "test", "dsh-v3-compact")
                .unwrap()
                .into_observations(),
        )
        .unwrap();
        assert_eq!(
            observations["contextObservations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            observations["contextObservations"][0]["summaryAvailable"],
            false
        );
    }

    #[test]
    fn recorded_durable_blocks_keep_append_origin_and_tool_ownership() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("session.v3.jsonl");
        let rows = [
            serde_json::json!({"type":"session","version":3,"id":"public","createdAt":1,"isSeeded":false}),
            serde_json::json!({"type":"permission/preset","seq":0,"time":2,"data":{"preset":"default"}}),
            serde_json::json!({"type":"user/message","seq":1,"time":3,"surfaceOp":"append","data":{"id":"u","source":{"kind":"user"},"content":[{"type":"text","text":"original request"}]}}),
            serde_json::json!({"type":"assistant/message","seq":2,"time":4,"surfaceOp":"append","data":{"message":{"id":"a","role":"assistant","content":[{"type":"reasoning","text":"recorded reasoning"},{"type":"text","text":"response"},{"type":"tool-call","id":"c","name":"read","arguments":"{\"path\":\"public.txt\"}"}]},"stream":[{"type":"text","text":"must not replay"}]}}),
            serde_json::json!({"type":"tool/call","seq":3,"time":5,"data":{"callId":"c","name":"read","arguments":"{\"path\":\"public.txt\"}"}}),
            serde_json::json!({"type":"tool/result","seq":4,"time":6,"surfaceOp":"append","data":{"message":{"source":{"callId":"c"},"content":[{"type":"tool-result","toolCallId":"c","content":[{"type":"text","text":"original output"}]}]}}}),
            serde_json::json!({"type":"user/message","seq":5,"time":7,"surfaceOp":{"op":"replace","startSeq":1,"endSeq":4},"sourceEventSeqs":[1,2,4],"data":{"id":"compressed","source":{"kind":"user"},"content":[{"type":"text","text":"model summary"}]}}),
        ];
        fs::write(
            &path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let snapshot = load_v3(&path, "test", "public").unwrap();
        assert_eq!(snapshot.events.len(), 4);
        assert_eq!(snapshot.summary.message_count, 3);
        assert_eq!(snapshot.events[0].body, "original request");
        assert_eq!(snapshot.events[1].body, "response");
        assert_eq!(snapshot.events[2].body, "recorded reasoning");
        assert_eq!(
            snapshot.events[2].item.owner.as_ref().unwrap().message_id,
            "a"
        );
        assert_eq!(snapshot.events[3].tool_output, "original output");
        assert_eq!(snapshot.events[3].tool_input, "{\"path\":\"public.txt\"}");
        assert_eq!(snapshot.events[3].tool_status.as_deref(), Some("completed"));
        let protocol = dsh_protocol_stream(&path, "test", "public").unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(
            page.events[5].provenance.source_type,
            "dsh.session-event:tool/result"
        );
        assert_eq!(
            page.events[5].reader_event.as_ref().unwrap().message_id,
            "c"
        );
        assert_eq!(
            page.events[6].provenance.source_type,
            "dsh.session-event:user/message"
        );
        assert!(page.events[6].reader_event.is_none());
        assert_eq!(
            snapshot.events[3].item.owner.as_ref().unwrap().message_id,
            "a"
        );
        let mut error_block = rows.to_vec();
        error_block[5]["data"]["message"]["content"][0]["isError"] = Value::Bool(true);
        fs::write(
            &path,
            error_block
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let snapshot = load_v3(&path, "test", "public").unwrap();
        assert_eq!(snapshot.events[3].tool_status.as_deref(), Some("error"));

        let mut error_field = rows.to_vec();
        error_field[5]["data"]["error"] = Value::String("tool failed".into());
        fs::write(
            &path,
            error_field
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let snapshot = load_v3(&path, "test", "public").unwrap();
        assert_eq!(snapshot.events[3].tool_status.as_deref(), Some("error"));

        let mut unknown = rows.to_vec();
        unknown
            .push(serde_json::json!({"type":"future/meaningful-event","seq":6,"time":8,"data":{}}));
        fs::write(
            &path,
            unknown
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        assert!(
            matches!(load_v3(&path, "test", "public"), Err(CoreError::Parse { reason, .. }) if reason.contains("future/meaningful-event"))
        );
    }

    #[test]
    fn seeded_prefix_keeps_source_optional_and_post_seed_tool_result_owned() {
        let temp = tempdir().unwrap();
        let session_id = "seeded-without-parent";
        let directory = temp.path().join("sessions/fixture").join(session_id);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("session.v3.jsonl");
        let rows = [
            serde_json::json!({"type":"session","version":3,"id":session_id,"createdAt":1,"isSeeded":true}),
            serde_json::json!({"type":"user/message","seq":0,"time":2,"surfaceOp":"append","data":{"id":"inherited-user","source":{"kind":"user"},"content":[{"type":"text","text":"copied prefix"}]}}),
            serde_json::json!({"type":"tool/call","seq":1,"time":3,"data":{"callId":"inherited-call","name":"read","arguments":{"path":"prefix.txt"}}}),
            serde_json::json!({"type":"session/end-seed","seq":2,"time":4,"data":{"inherited":true}}),
            serde_json::json!({"type":"user/message","seq":3,"time":5,"surfaceOp":"append","data":{"id":"owned-user","source":{"kind":"user"},"content":[{"type":"text","text":"current request"}]}}),
            serde_json::json!({"type":"assistant/message","seq":4,"time":6,"surfaceOp":"append","data":{"message":{"id":"owned-assistant","role":"assistant","content":[{"type":"text","text":"current answer"}]}}}),
            serde_json::json!({"type":"tool/result","seq":5,"time":7,"surfaceOp":"append","data":{"message":{"id":"owned-result","source":{"callId":"inherited-call"},"content":[{"type":"tool-result","toolCallId":"inherited-call","content":[{"type":"text","text":"owned result"}]}]}}}),
        ];
        fs::write(
            &source,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let source_before = fs::read(&source).unwrap();
        let adapter = DshAdapter {
            root: temp.path(),
            scope: "seeded-ownership-test",
        };

        let owned = adapter.load(session_id).unwrap();
        assert_eq!(owned.summary.parent, None);
        assert_eq!(owned.summary.message_count, 3);
        assert_eq!(owned.events.len(), 3);
        assert_eq!(owned.events[0].item.event.message_id, "owned-user");
        assert_eq!(owned.events[1].item.event.message_id, "owned-assistant");
        assert_eq!(owned.events[2].item.event.message_id, "inherited-call");
        assert_eq!(owned.events[2].tool_output, "owned result");
        assert_eq!(
            owned.events[2].item.owner.as_ref().unwrap().message_id,
            "owned-assistant"
        );

        let inherited = adapter.inherited_context(session_id).unwrap().unwrap();
        assert_eq!(inherited.source_session, None);
        assert_eq!(inherited.events.len(), 2);
        assert_eq!(inherited.events[0].item.message_id, "inherited-user");
        assert_eq!(inherited.events[1].item.message_id, "inherited-call");
        assert_eq!(inherited.events[1].tool_output, "");
        assert_eq!(fs::read(&source).unwrap(), source_before);
    }

    #[test]
    fn image_attachment_evidence_is_retained_and_unknown_blocks_fail() {
        let path = Path::new("session.v3.jsonl");
        let content = serde_json::json!([
            {"type":"text","text":"captured image:"},
            {"type":"image","attachment":{"id":"public-image","mimeType":"image/png"}}
        ]);
        let output = text_blocks(&content, path).unwrap();
        assert!(output.starts_with("captured image:"));
        assert_eq!(
            serde_json::from_str::<Value>(&output[15..]).unwrap(),
            content[1]
        );
        assert!(text_blocks(&serde_json::json!([{"type":"unknown-future-block"}]), path).is_err());
    }

    #[test]
    #[ignore = "requires explicitly selected frozen private corpus"]
    fn frozen_private_v3_compaction_summary_stays_source_aligned() {
        let path = std::env::var("DSH_PRIVATE_SOURCE").unwrap();
        let path = Path::new(&path);
        let id = path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let before = fs::read(path).unwrap();
        let rows = read_dsh_rows(path, &before).unwrap();
        let summaries: Vec<_> = rows
            .iter()
            .filter(|row| row["type"] == "compaction/summary")
            .collect();
        eprintln!("frozen DSH v3 compaction summaries={}", summaries.len());
        assert!(!summaries.is_empty());
        let snapshot = load_v3(path, "private-read-only", id).unwrap();
        let stream = dsh_protocol_stream(path, "private-read-only", id).unwrap();
        let reader_checkpoints: Vec<_> = snapshot
            .events
            .iter()
            .filter(|event| event.item.event.segment == "context")
            .collect();
        assert_eq!(reader_checkpoints.len(), summaries.len());
        for row in summaries {
            let seq = row["seq"].as_u64().unwrap();
            let blocks = row["data"]["summary"].as_array().unwrap();
            let expected: String = blocks
                .iter()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .collect();
            let checkpoint = reader_checkpoints
                .iter()
                .find(|event| event.item.event.message_id == format!("compaction:{seq}"))
                .unwrap();
            assert_eq!(checkpoint.body, expected);
            let protocol = stream.event_detail(&format!("event:dsh:{seq}")).unwrap();
            assert_eq!(
                protocol.event.reader_event.as_ref(),
                Some(&checkpoint.item.event)
            );
            eprintln!(
                "frozen DSH summary seq={seq} blocks={} utf16={}",
                blocks.len(),
                expected.encode_utf16().count()
            );
        }
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    #[ignore = "requires explicitly selected frozen private corpus"]
    fn frozen_private_v3_smoke() {
        let path = std::env::var("DSH_PRIVATE_SOURCE").unwrap();
        let path = Path::new(&path);
        let id = path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let bytes_before = fs::read(path).unwrap();
        let snapshot = load_v3(path, "private-read-only", id).unwrap();
        let protocol = dsh_protocol_stream(path, "private-read-only", id).unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(page.revision, snapshot.revision);
        assert_eq!(page.coverage, crate::protocol::Coverage::Partial);
        assert_eq!(page.events[0].provenance.source_type, "dsh.session.header");
        let reader_refs: std::collections::HashSet<_> = snapshot
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
            "DSH private reader_items={} relations={} protocol_events={count}",
            snapshot.events.len(),
            snapshot.relations.len()
        );
        if let Ok(output) = std::env::var("DSH_PRIVATE_REPORT") {
            let rows: Vec<Value> = snapshot.events.iter().map(|e| serde_json::json!({"id":e.item.event.message_id,"segment":e.item.event.segment,"role":e.item.role,"owner":e.item.owner,"body":e.body,"input":e.tool_input,"output":e.tool_output})).collect();
            fs::write(output, serde_json::to_vec(&rows).unwrap()).unwrap();
        }
    }

    #[test]
    #[ignore = "requires explicitly selected frozen private v0 corpus"]
    fn frozen_private_v0_smoke() {
        let path = std::env::var("DSH_PRIVATE_V0_SOURCE").unwrap();
        let path = Path::new(&path);
        let id = path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let source_before = fs::read(path).unwrap();
        let snapshot = load_dsh(path, "frozen-v0-read-only", id).unwrap();
        assert_eq!(snapshot.summary.session.session_id, id);
        assert_eq!(
            snapshot.summary.title,
            "Check parent-only marker visibility"
        );
        assert_eq!(
            snapshot.summary.directory.as_deref(),
            Some("D:\\WorkSpace\\OpenSession")
        );
        assert_eq!(snapshot.summary.updated_at, Some(1788176072133));
        assert_eq!(snapshot.summary.message_count, 2);
        assert_eq!(
            snapshot.summary.parent,
            Some(session_ref("session-b9bef2b1-7d5b-4551-847b-71a6fa47d2e3"))
        );
        assert_eq!(snapshot.events[0].item.role, "user");
        assert_eq!(snapshot.events[1].item.role, "assistant");
        assert!(
            !snapshot
                .events
                .iter()
                .any(|event| event.item.tool_name.as_deref() == Some("read"))
        );
        let protocol = dsh_protocol_stream(path, "frozen-v0-read-only", id).unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(page.coverage, crate::protocol::Coverage::Partial);
        assert_eq!(page.events[0].provenance.source_type, "dsh.session.header");
        assert_eq!(fs::read(path).unwrap(), source_before);
    }

    #[test]
    fn public_two_frame_v3_sources_keep_recorded_identity_and_relations() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/deepseek-harness");
        let adapter = DshAdapter {
            root: &root,
            scope: "public-dsh-test",
        };
        let sessions = {
            let catalog_dir = tempfile::tempdir().unwrap();
            crate::index::refresh(catalog_dir.path(), adapter.scope, PROVIDER, &adapter)
                .unwrap()
                .rows
        };
        assert_eq!(sessions.len(), 3);
        let parent = adapter.load("dsh-v3-s2-root").unwrap();
        assert_eq!(parent.events.len(), 5);
        assert_eq!(
            parent.events.last().unwrap().item.event.message_id,
            "root-final"
        );
        assert_eq!(parent.relations.len(), 16);
        assert_eq!(
            parent
                .relations
                .iter()
                .filter(|entry| matches!(entry, RelationEntry::Task { .. }))
                .count(),
            4
        );
        let alpha_task = parent
            .relations
            .iter()
            .find_map(|entry| match entry {
                RelationEntry::Task { task } if task.id == "team:alpha" => Some(task),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            alpha_task.subject.as_deref(),
            Some("Inspect synthetic alpha")
        );
        assert_eq!(
            alpha_task.description.as_deref(),
            Some("Read synthetic alpha input and report back")
        );
        let alpha = alpha_task.owner_participant.as_ref().unwrap();
        assert_eq!(alpha.kind, RelationParticipantKind::Member);
        assert_eq!(alpha.name, "alpha");
        assert_eq!(alpha.description.as_deref(), Some("Synthetic alpha worker"));
        assert_eq!(alpha.provenance.source_id, "4");
        let queued_alpha = parent
            .relations
            .iter()
            .find_map(|entry| match entry {
                RelationEntry::Coordination { observation }
                    if observation.event_id == "event:dsh:8" =>
                {
                    Some(observation)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            queued_alpha.message_excerpt.as_deref(),
            Some("Inspect synthetic alpha.")
        );
        assert_eq!(queued_alpha.from_participant.as_ref().unwrap().name, "lead");
        assert_eq!(
            queued_alpha.from_participant.as_ref().unwrap().kind,
            RelationParticipantKind::Sender
        );
        assert_eq!(queued_alpha.to_participant.as_ref().unwrap().name, "alpha");
        assert_eq!(queued_alpha.message_excerpt_truncated, Some(false));
        let followup = parent
            .relations
            .iter()
            .find_map(|entry| match entry {
                RelationEntry::Coordination { observation }
                    if observation.event_id == "event:dsh:15" =>
                {
                    Some(observation)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(followup.message_excerpt_truncated, Some(true));
        assert_eq!(
            followup.message_excerpt.as_ref().unwrap().chars().count(),
            PREVIEW_CHARS
        );
        assert!(
            !followup
                .message_excerpt
                .as_ref()
                .unwrap()
                .contains("FINAL-ALPHA-FOLLOWUP-MARKER")
        );
        let delivered_alpha = parent
            .relations
            .iter()
            .find_map(|entry| match entry {
                RelationEntry::Coordination { observation }
                    if observation.event_id == "event:dsh:9" =>
                {
                    Some(observation)
                }
                _ => None,
            })
            .unwrap();
        assert!(delivered_alpha.message_excerpt.is_none());
        assert_eq!(delivered_alpha.kind, "mailbox-delivery");
        for child in ["dsh-v3-s2-alpha", "dsh-v3-s2-beta"] {
            let snapshot = adapter.load(child).unwrap();
            assert_eq!(snapshot.summary.parent, Some(session_ref("dsh-v3-s2-root")));
            assert_eq!(snapshot.events.len(), 2);
        }

        let source = adapter
            .sources()
            .unwrap()
            .sources
            .remove("dsh-v3-s2-root")
            .unwrap();
        let source_before = fs::read(&source).unwrap();
        let protocol = dsh_protocol_stream(&source, "public-dsh-test", "dsh-v3-s2-root").unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(page.revision, parent.revision);
        assert_eq!(page.coverage, crate::protocol::Coverage::Partial);
        assert_eq!(page.events.len(), 29);
        assert_eq!(page.events[9].source_order.record, 9);
        assert_eq!(page.events[9].kind, "team.message.queued");
        assert_eq!(
            page.events[9].provenance.source_type,
            "dsh.session-event:team/message/queued"
        );
        assert_eq!(page.events[9].provenance.source_id.as_deref(), Some("8"));
        assert_eq!(
            page.events[2].reader_event.as_ref().unwrap().message_id,
            "root-user"
        );
        assert_eq!(
            page.events[24].reader_event.as_ref().unwrap().message_id,
            "root-check"
        );
        assert_eq!(fs::read(&source).unwrap(), source_before);
    }

    #[test]
    fn legacy_v0_multiframe_source_keeps_owned_reader_and_metadata() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("sessions/legacy-public");
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("session.jsonl.zstd");
        let header = serde_json::json!({"type":"session","version":0,"id":"legacy-public","createdAt":100,"cwd":"C:\\workspace","parentSession":"parent-public","seedLength":1});
        let inherited = serde_json::json!({"type":"user/message","seq":0,"time":101,"data":{"id":"inherited","source":{"kind":"user"},"content":[{"type":"text","text":"read inherited only"}]},"surfaceOp":"append"});
        let owned = [
            serde_json::json!({"type":"session/end-seed","seq":1,"time":102,"data":{}}),
            serde_json::json!({"type":"subagent/descriptor","seq":2,"time":103,"data":{"label":"Inspect public child"}}),
            serde_json::json!({"type":"user/message","seq":3,"time":104,"data":{"id":"owned-user","source":{"kind":"user"},"content":[{"type":"text","text":"Inspect current state"}]},"surfaceOp":"append"}),
            serde_json::json!({"type":"text-chunks","seq0":4,"time0":105,"data":{"turn":0,"step":0,"index":0,"texts":["current ","state"],"dt":[1]}}),
            serde_json::json!({"type":"assistant/message","seq":6,"time":107,"data":{"turn":0,"step":0,"message":{"id":"owned-assistant","role":"assistant","content":[{"type":"text","text":"current state"}]}},"surfaceOp":"append","sourceEventSeqs":[4,5]}),
        ];
        let first = [header, inherited]
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let second = owned
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let mut compressed = zstd::stream::encode_all(first.as_bytes(), 0).unwrap();
        compressed.extend(zstd::stream::encode_all(second.as_bytes(), 0).unwrap());
        fs::write(&source, &compressed).unwrap();

        let adapter = DshAdapter {
            root: temp.path(),
            scope: "legacy-public-test",
        };
        let listed = {
            let catalog_dir = tempfile::tempdir().unwrap();
            crate::index::refresh(catalog_dir.path(), adapter.scope, PROVIDER, &adapter)
                .unwrap()
                .rows
        };
        assert_eq!(listed.len(), 1);
        let snapshot = adapter.load("legacy-public").unwrap();
        assert_eq!(snapshot.summary.session.session_id, "legacy-public");
        assert_eq!(snapshot.summary.title, "Inspect public child");
        assert_eq!(snapshot.summary.directory.as_deref(), Some("C:\\workspace"));
        assert_eq!(snapshot.summary.updated_at, Some(107));
        assert_eq!(snapshot.summary.parent, Some(session_ref("parent-public")));
        assert_eq!(snapshot.summary.message_count, 2);
        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.events[0].body, "Inspect current state");
        assert_eq!(snapshot.events[1].body, "current state");
        assert!(
            !snapshot
                .events
                .iter()
                .any(|event| event.body.contains("read"))
        );
        let protocol = adapter.protocol_event_stream("legacy-public").unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery::default())
            .unwrap();
        assert_eq!(page.coverage, crate::protocol::Coverage::Partial);
        assert_eq!(page.events.len(), 8);
        assert_eq!(
            page.events[5].provenance.source_type,
            "dsh.session-event:assistant/chunk"
        );
        assert_eq!(fs::read(&source).unwrap(), compressed);
    }

    #[test]
    fn rc8_v0_fixture_keeps_reader_identity_and_tool_result() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("sessions/rc8-public");
        fs::create_dir_all(&directory).unwrap();
        let fixture = include_str!("../../../../../test/fixtures/dsh-rc8-fresh-round-trip.jsonl");
        let materialized = fixture
            .replace("{{sessionId}}", "rc8-public")
            .replace("{{cwd}}", "C:");
        fs::write(directory.join("session.jsonl"), materialized).unwrap();
        let adapter = DshAdapter {
            root: temp.path(),
            scope: "rc8-test",
        };
        let snapshot = adapter.load("rc8-public").unwrap();
        assert_eq!(snapshot.summary.title, "Use the bash tool to");
        assert_eq!(snapshot.summary.message_count, 5);
        assert_eq!(
            snapshot
                .events
                .iter()
                .filter(|event| event.item.event.segment == "message")
                .map(|event| event.item.event.message_id.as_str())
                .collect::<Vec<_>>(),
            ["user:1", "assistant:55", "assistant:91"]
        );
        assert_eq!(
            snapshot
                .events
                .iter()
                .filter(|event| event.item.event.segment == "tool")
                .map(|event| event.item.event.message_id.as_str())
                .collect::<Vec<_>>(),
            ["call_00_BYXlxjFaalMg95YVqEeF2495", "tool-result:57:0"]
        );
        assert_eq!(
            snapshot
                .events
                .iter()
                .find(|event| event.item.event.message_id == "assistant:91"
                    && event.item.event.segment == "message")
                .unwrap()
                .body,
            "DONE"
        );
        assert_eq!(
            snapshot
                .events
                .iter()
                .find(|event| event.item.event.message_id == "tool-result:57:0")
                .unwrap()
                .tool_output,
            "WEB_E2E_OK\n"
        );
        let bash = snapshot
            .events
            .iter()
            .find(|event| event.item.event.message_id == "call_00_BYXlxjFaalMg95YVqEeF2495")
            .unwrap();
        assert_eq!(bash.item.tool_name.as_deref(), Some("bash"));
        assert_eq!(bash.tool_status.as_deref(), Some("completed"));
        assert_eq!(bash.tool_output, "WEB_E2E_OK\n");
        let protocol = adapter.protocol_event_stream("rc8-public").unwrap();
        let page = protocol
            .events(crate::protocol::EventQuery {
                limit: 100,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            page.events[2].reader_event.as_ref().unwrap().message_id,
            "user:1"
        );
        assert_eq!(
            page.events[58].reader_event.as_ref().unwrap().message_id,
            "tool-result:57:0"
        );
        let bundle = adapter.protocol_bundle("rc8-public").unwrap();
        let document = serde_json::to_value(bundle.document(3).unwrap()).unwrap();
        let observations = bundle.into_observations();
        assert_eq!(observations.usage_records().len(), 2);
        assert_eq!(
            observations
                .usage_records()
                .iter()
                .map(|record| (
                    record.event_id.as_deref(),
                    record.model.as_deref(),
                    record.tokens.input,
                    record.tokens.cache_read,
                    record.tokens.output,
                    record.tokens.reasoning,
                    record.tokens.total,
                ))
                .collect::<Vec<_>>(),
            [
                (
                    Some("event:dsh:55"),
                    Some("deepseek-v4-flash"),
                    Some(122),
                    Some(7680),
                    Some(68),
                    Some(17),
                    None
                ),
                (
                    Some("event:dsh:91"),
                    Some("deepseek-v4-flash"),
                    Some(97),
                    Some(7808),
                    Some(3),
                    Some(23),
                    None
                ),
            ]
        );
        assert_eq!(document["coverage"]["usage"]["state"], "observed");
    }

    #[test]
    fn live_writer_tail_is_ignored_but_completed_corruption_fails() {
        let temp = tempdir().unwrap();
        let v0 = temp.path().join("session.jsonl");
        let complete = concat!(
            "{\"type\":\"session\",\"version\":0,\"id\":\"public\",\"createdAt\":1}\n",
            "{\"type\":\"user/message\",\"seq\":0,\"time\":2,\"data\":{\"id\":\"u\",\"source\":{\"kind\":\"user\"},\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n"
        );
        fs::write(&v0, format!("{complete}{{\"type\":")).unwrap();
        assert_eq!(
            load_dsh(&v0, "tail-test", "public")
                .unwrap()
                .summary
                .message_count,
            1
        );
        fs::write(&v0, format!("{complete}{{\"type\":\n")).unwrap();
        assert!(load_dsh(&v0, "tail-test", "public").is_err());

        let v0_compressed = temp.path().join("session.jsonl.zstd");
        let first_v0 = zstd::stream::encode_all(complete.as_bytes(), 0).unwrap();
        let final_v0 = zstd::stream::encode_all(b"invalid\n".as_slice(), 0).unwrap();
        let mut torn_v0 = first_v0.clone();
        torn_v0.extend_from_slice(&final_v0[..final_v0.len() - 2]);
        fs::write(&v0_compressed, torn_v0).unwrap();
        assert_eq!(
            load_dsh(&v0_compressed, "tail-test", "public")
                .unwrap()
                .summary
                .message_count,
            1
        );
        fs::write(&v0_compressed, [first_v0, final_v0].concat()).unwrap();
        assert!(load_dsh(&v0_compressed, "tail-test", "public").is_err());

        let v3 = temp.path().join("session.v3.jsonl.zstd");
        let valid = concat!(
            "{\"type\":\"session\",\"version\":3,\"id\":\"public\",\"createdAt\":1,\"isSeeded\":false}\n",
            "{\"type\":\"user/message\",\"seq\":0,\"time\":2,\"surfaceOp\":\"append\",\"data\":{\"id\":\"u\",\"source\":{\"kind\":\"user\"},\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n"
        );
        let first = zstd::stream::encode_all(valid.as_bytes(), 0).unwrap();
        let final_frame = zstd::stream::encode_all(b"invalid\n".as_slice(), 0).unwrap();
        let mut torn = first.clone();
        torn.extend_from_slice(&final_frame[..final_frame.len() - 2]);
        fs::write(&v3, &torn).unwrap();
        assert_eq!(
            load_dsh(&v3, "tail-test", "public")
                .unwrap()
                .summary
                .message_count,
            1
        );
        fs::write(&v3, [first, final_frame].concat()).unwrap();
        assert!(load_dsh(&v3, "tail-test", "public").is_err());
    }

    #[test]
    fn mixed_encoding_is_diagnostic_and_inventory_keeps_healthy_sessions() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("sessions");
        for id in ["mixed", "same", "healthy"] {
            let directory = root.join(id);
            fs::create_dir_all(&directory).unwrap();
            let header = serde_json::json!({"type":"session","version":3,"id":id,"createdAt":1,"isSeeded":false});
            let source = format!("{}\n", header);
            if id == "healthy" {
                fs::write(directory.join("session.v3.jsonl"), &source).unwrap();
            } else {
                fs::write(
                    directory.join("session.v3.jsonl.zstd"),
                    zstd::stream::encode_all(source.as_bytes(), 0).unwrap(),
                )
                .unwrap();
                let prior = serde_json::json!({"type":"session","version":0,"id":id,"createdAt":1});
                let prior = format!("{}\n", prior);
                if id == "mixed" {
                    fs::write(directory.join("session.jsonl"), prior).unwrap();
                } else {
                    fs::write(
                        directory.join("session.jsonl.zstd"),
                        zstd::stream::encode_all(prior.as_bytes(), 0).unwrap(),
                    )
                    .unwrap();
                }
            }
        }
        let adapter = DshAdapter {
            root: temp.path(),
            scope: "encoding-test",
        };
        assert!(
            matches!(adapter.load("mixed"), Err(CoreError::Parse { reason, .. }) if reason.contains("mixed raw/Zstandard"))
        );
        assert_eq!(
            adapter.load("same").unwrap().summary.session.session_id,
            "same"
        );
        assert_eq!(
            adapter
                .inventory()
                .unwrap()
                .iter()
                .map(|entry| entry.session_id.as_str())
                .collect::<Vec<_>>(),
            ["healthy", "mixed", "same"]
        );
        let entries = adapter.inventory().unwrap();
        let mixed = entries
            .iter()
            .find(|entry| entry.session_id == "mixed")
            .unwrap();
        let snapshot = adapter.capture(mixed).unwrap();
        assert_eq!(
            snapshot.summary.diagnostic.as_deref(),
            Some("dsh_mixed_source_encodings")
        );
        assert!(snapshot.summary.directory.is_none());
        assert!(snapshot.summary.created_at.is_none());
        assert!(snapshot.summary.updated_at.is_none());
        assert!(snapshot.summary.token_count.is_none());
        assert!(snapshot.events.is_empty());
        assert_eq!(snapshot.revision, mixed.signature);
        let catalog_dir = tempfile::tempdir().unwrap();
        let published =
            crate::index::refresh(catalog_dir.path(), adapter.scope, PROVIDER, &adapter).unwrap();
        assert_eq!(published.rows.len(), 3);
        assert_eq!(
            published
                .rows
                .iter()
                .filter(|row| row.diagnostic.is_none())
                .count(),
            2
        );
        let diagnostic = published
            .rows
            .iter()
            .find(|row| row.session.session_id == "mixed")
            .unwrap();
        assert_eq!(
            diagnostic.diagnostic.as_deref(),
            Some("dsh_mixed_source_encodings")
        );
    }

    #[test]
    fn ambiguous_inventory_tracks_all_candidates_and_rejects_stale_captures() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let first = root.join("sessions/a/shared");
        let second = root.join("sessions/b/shared");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let header = "{\"type\":\"session\",\"version\":3,\"id\":\"shared\",\"createdAt\":1,\"isSeeded\":false}\n";
        let primary = first.join("session.v3.jsonl");
        let duplicate = second.join("session.v3.jsonl");
        let older = first.join("session.jsonl");
        fs::write(&primary, header).unwrap();
        let adapter = DshAdapter {
            root,
            scope: "candidate-test",
        };
        let healthy = adapter.source_entries().unwrap().remove(0);
        fs::write(&duplicate, header).unwrap();
        assert!(matches!(
            adapter.capture(&healthy),
            Err(CoreError::SourceChanged)
        ));
        let duplicated = adapter.source_entries().unwrap().remove(0);
        assert_eq!(
            adapter
                .capture(&duplicated)
                .unwrap()
                .summary
                .diagnostic
                .as_deref(),
            Some("dsh_duplicate_source_generation")
        );
        assert_eq!(
            adapter.sources().unwrap().ambiguities["shared"]
                .candidates
                .len(),
            2
        );
        assert_eq!(
            adapter.source_signature(&duplicated).unwrap(),
            duplicated.signature
        );
        let incoming = BTreeMap::from([("shared".into(), duplicated.clone())]);
        adapter.validate_inventory(&incoming).unwrap();
        fs::write(&older, "older candidate").unwrap();
        assert!(matches!(
            adapter.validate_inventory(&incoming),
            Err(CoreError::SourceChanged)
        ));
        assert!(matches!(
            adapter.capture(&duplicated),
            Err(CoreError::SourceChanged)
        ));
        let with_older = adapter.source_entries().unwrap().remove(0);
        assert_ne!(with_older.signature, duplicated.signature);
        assert_eq!(
            adapter.sources().unwrap().ambiguities["shared"]
                .candidates
                .len(),
            3
        );
        fs::write(&older, "changed older candidate").unwrap();
        assert_ne!(
            adapter.source_signature(&with_older).unwrap(),
            with_older.signature
        );
        let compressed = second.join("session.v2.jsonl.zstd");
        fs::write(&compressed, "candidate stat only").unwrap();
        let mixed = adapter.source_entries().unwrap().remove(0);
        assert_eq!(
            adapter
                .capture(&mixed)
                .unwrap()
                .summary
                .diagnostic
                .as_deref(),
            Some("dsh_mixed_source_encodings")
        );
        assert_eq!(
            adapter.sources().unwrap().ambiguities["shared"]
                .candidates
                .len(),
            4
        );
        assert_eq!(
            adapter.storage_diagnostic().unwrap()["sourceDiagnostics"],
            serde_json::json!([{"code":"dsh_mixed_source_encodings", "affectedSessions":1}])
        );
        for path in [&older, &duplicate, &compressed] {
            fs::remove_file(path).unwrap();
        }
        assert!(matches!(
            adapter.capture(&mixed),
            Err(CoreError::SourceChanged)
        ));
        assert!(adapter.storage_diagnostic().is_none());
        assert!(adapter.load("shared").unwrap().summary.diagnostic.is_none());
        fs::remove_file(primary).unwrap();
        assert!(matches!(
            adapter.source_signature(&mixed),
            Err(CoreError::SourceChanged)
        ));
    }

    #[test]
    fn ambiguous_generation_only_invalidates_its_canonical_session() {
        let temp = tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        let healthy_dir = sessions.join("healthy");
        let ambiguous_dir = sessions.join("ambiguous");
        fs::create_dir_all(&healthy_dir).unwrap();
        fs::create_dir_all(&ambiguous_dir).unwrap();
        let rows = [
            serde_json::json!({"type":"session","version":3,"id":"healthy","createdAt":1,"isSeeded":false}),
            serde_json::json!({"type":"user/message","seq":0,"time":2,"surfaceOp":"append","data":{"id":"u","source":{"kind":"user"},"content":[{"type":"text","text":"healthy"}]}}),
        ];
        let healthy_source = rows
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(healthy_dir.join("session.v3.jsonl"), &healthy_source).unwrap();
        let ambiguous_source = healthy_source.replace("healthy", "ambiguous");
        fs::write(ambiguous_dir.join("session.v3.jsonl"), &ambiguous_source).unwrap();
        fs::write(
            ambiguous_dir.join("session.v3.jsonl.zstd"),
            &ambiguous_source,
        )
        .unwrap();

        let adapter = DshAdapter {
            root: temp.path(),
            scope: "test",
        };
        let listed = {
            let catalog_dir = tempfile::tempdir().unwrap();
            crate::index::refresh(catalog_dir.path(), adapter.scope, PROVIDER, &adapter)
                .unwrap()
                .rows
        };
        assert_eq!(listed.len(), 2);
        let healthy = listed
            .iter()
            .find(|row| row.session.session_id == "healthy")
            .unwrap();
        assert!(healthy.diagnostic.is_none());
        let diagnostic = listed
            .iter()
            .find(|row| row.session.session_id == "ambiguous")
            .unwrap();
        assert_eq!(
            diagnostic.diagnostic.as_deref(),
            Some("dsh_mixed_source_encodings")
        );
        assert_eq!(adapter.load("healthy").unwrap().summary.message_count, 1);
        assert!(
            matches!(adapter.load("ambiguous"), Err(CoreError::Parse { reason, .. }) if reason.contains("mixed raw/Zstandard") && reason.contains("ambiguous"))
        );
    }

    #[test]
    fn malformed_historical_header_and_surface_operation_fail_explicitly() {
        let temp = tempdir().unwrap();
        let directory = temp.path().join("sessions/public");
        fs::create_dir_all(&directory).unwrap();
        let old = directory.join("session.v1.jsonl");
        fs::write(
            &old,
            "{\"type\":\"session\",\"version\":1,\"id\":\"public\",\"createdAt\":1}\n",
        )
        .unwrap();
        let adapter = DshAdapter {
            root: temp.path(),
            scope: "test",
        };
        assert!(
            matches!(adapter.load("public"), Err(CoreError::Parse { reason, .. }) if reason.contains("delegationDepth"))
        );
        fs::remove_file(old).unwrap();
        let current = directory.join("session.v3.jsonl");
        fs::write(&current, concat!(
            "{\"type\":\"session\",\"version\":3,\"id\":\"public\",\"createdAt\":1,\"isSeeded\":false}\n",
            "{\"type\":\"user/message\",\"seq\":0,\"time\":2,\"data\":{\"id\":\"u\",\"source\":{\"kind\":\"user\"},\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]},\"surfaceOp\":{\"op\":\"replace\",\"startSeq\":0,\"endSeq\":0}}\n"
        )).unwrap();
        assert!(
            matches!(adapter.load("public"), Err(CoreError::Parse { reason, .. }) if reason.contains("surface operation"))
        );
    }
}

fn dsh_model_source(data: &Value) -> Option<&Value> {
    data.pointer("/message/source")
        .filter(|source| source.get("model").is_some())
        .or_else(|| {
            data.get("source")
                .filter(|source| source.get("model").is_some())
        })
        .or_else(|| {
            data.get("provenance")
                .filter(|source| source.get("model").is_some())
        })
}

fn dsh_reply_metadata(data: &Value, seq: u64) -> Option<crate::ReaderReplyMetadata> {
    let source = dsh_model_source(data);
    let model = source
        .and_then(|source| source["model"].as_str())
        .map(str::to_owned);
    let model_provider = source
        .and_then(|source| source["provider"].as_str())
        .filter(|provider| !provider.trim().is_empty())
        .map(str::to_owned);
    super::reply_metadata(
        model,
        model_provider,
        Provenance {
            fidelity: Fidelity::Recorded,
            source_type: "dsh.session-event:assistant/message:model".into(),
            source_id: Some(seq.to_string()),
        },
        None,
    )
}

fn dsh_attach_reply_usage(
    events: &mut [NormalizedEvent],
    owners: &HashMap<u64, EventRef>,
    requests: &[UsageRecord],
) {
    let event_indices: HashMap<_, _> = events
        .iter()
        .enumerate()
        .map(|(index, event)| (event.item.event.clone(), index))
        .collect();
    for request in requests {
        let seq = request
            .provenance
            .source_id
            .as_deref()
            .expect("DSH request source sequence")
            .parse::<u64>()
            .expect("DSH source sequence is normalized");
        let Some(index) = owners.get(&seq).and_then(|owner| event_indices.get(owner)) else {
            continue;
        };
        let item = &mut events[*index].item;
        let metadata = item
            .reply_metadata
            .get_or_insert_with(|| crate::ReaderReplyMetadata {
                model: None,
                model_provider: None,
                model_provenance: None,
                request_usage: None,
            });
        metadata.request_usage = Some(crate::ReaderRequestUsage::from(request));
    }
}
