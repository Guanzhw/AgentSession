//! OpenCode V2 prompt evidence. Current configuration is a candidate source,
//! never proof that the same bytes were used by an earlier model request.
use super::{OpenCodeAdapter, Schema, columns};
use crate::system_prompts::{PromptDiagnostic, PromptItem, PromptSection, SystemPromptEvidence};
use crate::{Result, SessionSummary};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SOURCE_BYTES: u64 = 1024 * 1024;
const MAX_RECORDED_ROWS: usize = 128;

pub(super) fn build(
    adapter: &OpenCodeAdapter<'_>,
    session_id: &str,
) -> Result<SystemPromptEvidence> {
    let revision = adapter.revision()?;
    let (db, schema) = adapter.open()?;
    let summary = adapter
        .rows(&db, schema, Some(session_id))?
        .into_iter()
        .next()
        .ok_or_else(|| crate::CoreError::NotFound {
            provider: "opencode".into(),
            session_id: session_id.into(),
        })?;
    let mut evidence = SystemPromptEvidence::new(&summary, "opencode-resolved");
    if matches!(schema, Schema::V1) {
        evidence.current_files(&summary, &["AGENTS.md", "CLAUDE.md"]);
        evidence.diagnostics.push(diagnostic("opencode_v1_prompt_scope", "This session uses the OpenCode V1 schema; V2 instruction and agent rules do not apply.", None));
        if adapter.revision()? != revision {
            return Err(crate::CoreError::SourceChanged);
        }
        return Ok(evidence);
    }
    recorded_system_rows(adapter, &db, session_id, &mut evidence)?;
    let selected = if columns(&db, "session_v2")
        .map_err(|error| adapter.source_error(error))?
        .contains("agent")
    {
        db.query_row(
            "SELECT agent FROM session_v2 WHERE id=?1",
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| adapter.source_error(error))?
        .flatten()
        .filter(|value| !value.trim().is_empty())
    } else {
        evidence.diagnostics.push(diagnostic(
            "opencode_agent_column_unavailable",
            "This V2 session schema does not store a selected agent column.",
            Some(adapter.path),
        ));
        None
    };
    evidence.selected_agent = selected.clone();
    if selected.is_none() {
        evidence.diagnostics.push(diagnostic("opencode_selected_agent_unrecorded", "No selected agent ID is stored for this session; current defaults are not evidence of the historical selection.", Some(adapter.path)));
    }
    if adapter.revision()? != revision {
        return Err(crate::CoreError::SourceChanged);
    }
    current_sources(&summary, selected.as_deref(), &mut evidence);
    Ok(evidence)
}

fn recorded_system_rows(
    adapter: &OpenCodeAdapter<'_>,
    db: &rusqlite::Connection,
    session_id: &str,
    evidence: &mut SystemPromptEvidence,
) -> Result<()> {
    let mut statement = db.prepare("SELECT m.id,m.time_created,length(CAST(m.data AS BLOB)),substr(CAST(m.data AS BLOB),1,1048577) FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE m.session_id=?1 AND m.type='system' AND (s.fork_session_id IS NULL OR substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq) ORDER BY m.seq,m.id LIMIT 129")
        .map_err(|error| adapter.source_error(error))?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(|error| adapter.source_error(error))?;
    let mut total_bytes = 0usize;
    for (index, row) in rows.enumerate() {
        if index == MAX_RECORDED_ROWS {
            evidence.diagnostics.push(diagnostic("opencode_system_rows_bounded", "More than 128 stored system rows exist; later rows are unavailable in this bounded evidence response.", Some(adapter.path)));
            break;
        }
        let (id, time, source_bytes, raw) = row.map_err(|error| adapter.source_error(error))?;
        if source_bytes < 0
            || source_bytes as u64 > MAX_SOURCE_BYTES
            || total_bytes.saturating_add(source_bytes as usize) > MAX_SOURCE_BYTES as usize
        {
            evidence.diagnostics.push(diagnostic("opencode_system_text_too_large", "Stored system text exceeds the 1 MiB evidence budget; its content is unavailable in this response.", Some(adapter.path)));
            continue;
        }
        total_bytes += source_bytes as usize;
        let data: Value = serde_json::from_slice(&raw).map_err(|error| {
            adapter.source_error(format!("Invalid OpenCode system row {id}: {error}"))
        })?;
        let Some(content) = data
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        else {
            evidence.diagnostics.push(diagnostic(
                "opencode_system_text_unavailable",
                "A stored system row has no text field.",
                Some(adapter.path),
            ));
            continue;
        };
        evidence.recorded_with_metadata(
            "Recorded OpenCode system message",
            content.into(),
            format!("{}#session_message/{id}", adapter.path.display()),
            time.max(0) as u64,
            Some(json!({"messageId": id, "sourceType": "opencode.session_message.system"})),
        );
        if let Some(item) = evidence
            .sections
            .last_mut()
            .and_then(|section| section.items.last_mut())
        {
            item.source_path = Some(adapter.path.to_string_lossy().into_owned());
        }
    }
    Ok(())
}

fn current_sources(
    summary: &SessionSummary,
    selected: Option<&str>,
    evidence: &mut SystemPromptEvidence,
) {
    let global = global_dir();
    let workspace = summary
        .directory
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    if workspace.is_none() {
        evidence.diagnostics.push(diagnostic(
            "session_directory_unavailable",
            "No absolute recorded working directory is available for V2 project source resolution.",
            None,
        ));
    }
    let mut ancestry = Vec::new();
    if let Some(workspace) = workspace.as_ref() {
        ancestry.extend(workspace.ancestors().take(64).map(Path::to_path_buf));
    }
    let project_end = ancestry.iter().position(|path| path.join(".git").exists());
    let project_count = project_end.map_or(usize::from(!ancestry.is_empty()), |end| end + 1);
    let project_ancestry: Vec<_> = ancestry.iter().take(project_count).collect();
    let home_count = home_dir()
        .filter(|home| {
            workspace
                .as_ref()
                .is_some_and(|workspace| workspace.starts_with(home))
        })
        .and_then(|home| ancestry.iter().position(|path| path == &home))
        .map(|index| index + 1);
    let mut instruction_bytes = 0u64;
    if let Some(global) = global.as_ref() {
        let path = global.join("AGENTS.md");
        if path.is_file() {
            add_agents_file(&path, &mut instruction_bytes, evidence);
        }
    }
    if std::env::var("OPENCODE_DISABLE_PROJECT_CONFIG").as_deref() != Ok("1") {
        if project_end.is_none() && !ancestry.is_empty() {
            evidence.diagnostics.push(diagnostic("opencode_project_root_unresolved", "A project root marker was not found; project .opencode/agents discovery is limited to the recorded working directory.", workspace.as_deref()));
        }
        for directory in ancestry.iter().take(home_count.unwrap_or(project_count)) {
            let path = directory.join("AGENTS.md");
            if path.is_file() {
                add_agents_file(&path, &mut instruction_bytes, evidence);
            }
        }
    }
    let agent = selected.filter(|agent| valid_agent_id(agent));
    if selected.is_some() && agent.is_none() {
        evidence.diagnostics.push(diagnostic(
            "opencode_selected_agent_invalid",
            "The stored agent ID is not a safe relative agent name.",
            None,
        ));
    }
    let mut config_paths = Vec::new();
    if let Some(global) = global.as_ref() {
        config_paths.push(global.clone());
    }
    // Direct configs merge first, then every .opencode config, farthest to nearest.
    config_paths.extend(ancestry.iter().rev().cloned());
    let mut chosen: Option<(PathBuf, String)> = None;
    for directory in &config_paths {
        read_agent_configs(directory, agent, &mut chosen, evidence);
    }
    for directory in ancestry.iter().rev() {
        read_agent_configs(&directory.join(".opencode"), agent, &mut chosen, evidence);
    }
    let Some(agent) = agent else { return };
    let mut markdown = Vec::new();
    if let Some(global) = global.as_ref() {
        markdown.push(global.join("agents").join(format!("{agent}.md")));
    }
    markdown.extend(project_ancestry.iter().rev().map(|directory| {
        directory
            .join(".opencode")
            .join("agents")
            .join(format!("{agent}.md"))
    }));
    let markdown = markdown.into_iter().rev().find(|path| path.is_file());
    if chosen.is_some() && markdown.is_some() {
        evidence.diagnostics.push(diagnostic("opencode_agent_source_ambiguous", "Both current JSONC and Markdown definitions exist for the selected agent; their cross-format precedence is not established by this evidence.", None));
    }
    if let Some((path, content)) = chosen {
        add_agent_item(evidence, agent, &path, content, "agents.*.system");
    }
    if let Some(path) = markdown {
        if let Some(raw) = read_local(&path, evidence) {
            let body = markdown_body(&raw);
            if !body.is_empty() {
                add_agent_item(evidence, agent, &path, body, "markdown-body");
            }
        }
    }
    if !evidence.sections.iter().any(|section| {
        section.title == "Current Local Instructions"
            && section.items.iter().any(|item| item.kind == "agent-prompt")
    }) {
        evidence.diagnostics.push(diagnostic("opencode_agent_prompt_unavailable", "No current local system text is resolvable for the stored selected agent; its provider prompt is unavailable.", None));
    }
}

fn add_agents_file(path: &Path, used: &mut u64, evidence: &mut SystemPromptEvidence) {
    let bytes = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(_) => {
            evidence.current_file(path);
            return;
        }
    };
    if used.saturating_add(bytes) > MAX_SOURCE_BYTES {
        evidence.diagnostics.push(diagnostic(
            "opencode_instruction_budget_exceeded",
            "Current AGENTS.md files exceed the 1 MiB aggregate evidence budget; this file is unavailable in the response.",
            Some(path),
        ));
        return;
    }
    evidence.current_file(path);
    *used += bytes;
}

fn read_agent_configs(
    directory: &Path,
    agent: Option<&str>,
    chosen: &mut Option<(PathBuf, String)>,
    evidence: &mut SystemPromptEvidence,
) {
    let json = directory.join("opencode.json");
    let jsonc = directory.join("opencode.jsonc");
    if json.is_file() && jsonc.is_file() {
        evidence.diagnostics.push(diagnostic("opencode_config_ambiguous", "Both JSON and JSONC configurations exist at one precedence level; this resolver skips that level.", Some(directory)));
        return;
    }
    let path = if jsonc.is_file() {
        jsonc
    } else if json.is_file() {
        json
    } else {
        return;
    };
    let Some(raw) = read_local(&path, evidence) else {
        return;
    };
    let Some(value) = parse_jsonc(&raw) else {
        evidence.diagnostics.push(diagnostic(
            "opencode_config_invalid",
            "Current OpenCode config could not be parsed as JSON/JSONC.",
            Some(&path),
        ));
        return;
    };
    if value
        .get("instructions")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
    {
        evidence.diagnostics.push(diagnostic("opencode_instructions_not_injected", "OpenCode V2 accepts config.instructions but does not currently inject these paths into model instructions.", Some(&path)));
    }
    if let Some(content) = agent
        .and_then(|agent| value.get("agents").and_then(|agents| agents.get(agent)))
        .and_then(|entry| entry.get("system"))
        .and_then(Value::as_str)
    {
        *chosen = (!content.is_empty()).then(|| (path, content.into()));
    }
}

fn add_agent_item(
    evidence: &mut SystemPromptEvidence,
    agent: &str,
    path: &Path,
    content: String,
    field: &str,
) {
    let source = path.to_string_lossy().into_owned();
    let preview = content
        .split_whitespace()
        .take(100)
        .collect::<Vec<_>>()
        .join(" ");
    let time = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64);
    let item = PromptItem {
        kind: "agent-prompt".into(),
        title: format!("Current agent: {agent}"),
        preview,
        content,
        source: source.clone(),
        source_path: Some(source),
        source_metadata: Some(json!({"agent": agent, "field": field})),
        provenance: "current-local",
        resolution: "resolved",
        time,
    };
    if let Some(section) = evidence
        .sections
        .iter_mut()
        .find(|section| section.title == "Current Local Instructions")
    {
        section.items.push(item);
    } else {
        evidence.sections.push(PromptSection {
            title: "Current Local Instructions".into(),
            note: "Currently resolvable local sources; historical use is not proven.".into(),
            items: vec![item],
        });
    }
}

fn global_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(xdg).join("opencode"));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".config").join("opencode"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn valid_agent_id(agent: &str) -> bool {
    !agent.is_empty()
        && agent.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        })
}

fn read_local(path: &Path, evidence: &mut SystemPromptEvidence) -> Option<String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return None,
    };
    if metadata.len() > MAX_SOURCE_BYTES {
        evidence.diagnostics.push(diagnostic(
            "instruction_too_large",
            "Current local source exceeds the 1 MiB evidence limit.",
            Some(path),
        ));
        return None;
    }
    match fs::read_to_string(path) {
        Ok(content) => Some(content),
        Err(_) => {
            evidence.diagnostics.push(diagnostic(
                "instruction_unreadable",
                "Current local source cannot be read as UTF-8.",
                Some(path),
            ));
            None
        }
    }
}

fn markdown_body(raw: &str) -> String {
    if !raw.starts_with("---\n") && !raw.starts_with("---\r\n") {
        return raw.trim().into();
    }
    let mut offset = 0;
    for line in raw.split_inclusive('\n') {
        offset += line.len();
        if offset > 4 && line.trim() == "---" {
            return raw[offset..].trim().into();
        }
    }
    String::new()
}

fn parse_jsonc(raw: &str) -> Option<Value> {
    let bytes = raw.as_bytes();
    let mut stripped = Vec::with_capacity(bytes.len());
    let (mut index, mut in_string, mut escaped) = (0, false, false);
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            stripped.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            stripped.push(byte);
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            if index + 1 >= bytes.len() {
                return None;
            }
            index += 2;
            continue;
        }
        stripped.push(byte);
        index += 1;
    }
    if in_string {
        return None;
    }
    let mut cleaned = Vec::with_capacity(stripped.len());
    let (mut in_string, mut escaped) = (false, false);
    for (index, &byte) in stripped.iter().enumerate() {
        if in_string {
            cleaned.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        if byte == b'"' {
            in_string = true;
            cleaned.push(byte);
            continue;
        }
        if byte == b','
            && stripped[index + 1..]
                .iter()
                .find(|next| !next.is_ascii_whitespace())
                .is_some_and(|next| matches!(next, b'}' | b']'))
        {
            continue;
        }
        cleaned.push(byte);
    }
    serde_json::from_slice(&cleaned).ok()
}

fn diagnostic(code: &'static str, message: &str, source: Option<&Path>) -> PromptDiagnostic {
    PromptDiagnostic {
        code,
        message: message.into(),
        source: source.map(|path| path.to_string_lossy().into_owned()),
    }
}
