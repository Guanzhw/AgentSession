use crate::protocol::{
    ContextArtifact, ContextArtifactSourceState, Fidelity, MemoryProductionEvidence, Provenance,
};
use crate::{ContentPage, CoreError, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryArtifacts {
    pub artifacts: Vec<ContextArtifact>,
    pub source_state: ContextArtifactSourceState,
    pub revision: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryContent {
    pub artifact_id: String,
    pub format: &'static str,
    #[serde(flatten)]
    pub page: ContentPage,
}

struct Stage1Row {
    source_updated_at: i64,
    generated_at: i64,
    raw_memory: String,
    rollout_summary: String,
}

const MAX_SAFE_JS_INTEGER: i64 = 9_007_199_254_740_991;

fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn digest(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn state(
    path: &Path,
    status: &'static str,
    code: Option<&'static str>,
) -> ContextArtifactSourceState {
    ContextArtifactSourceState {
        state: status,
        code,
        source_path: path.to_string_lossy().into_owned(),
        provenance: Provenance {
            fidelity: Fidelity::Recorded,
            source_type: "codex.memories_1.sqlite".into(),
            source_id: None,
        },
    }
}

fn columns(db: &Connection, table: &str) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = db.prepare(&format!("PRAGMA table_info({table})"))?;
    stmt.query_map([], |row| row.get::<_, String>(1))?.collect()
}

fn open(path: &Path) -> std::result::Result<Connection, &'static str> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "read-failed")?;
    db.execute_batch("BEGIN").map_err(|_| "read-failed")?;
    Ok(db)
}

fn row(db: &Connection, session_id: &str) -> std::result::Result<Option<Stage1Row>, &'static str> {
    let schema = columns(db, "stage1_outputs").map_err(|_| "read-failed")?;
    if ![
        "thread_id",
        "source_updated_at",
        "generated_at",
        "raw_memory",
        "rollout_summary",
    ]
    .iter()
    .all(|field| schema.contains(*field))
    {
        return Err("unsupported-schema");
    }
    let selected = db
        .query_row(
            "SELECT source_updated_at, generated_at, raw_memory, rollout_summary
         FROM stage1_outputs WHERE thread_id = ?1",
            [session_id],
            |value| {
                Ok(Stage1Row {
                    source_updated_at: value.get(0)?,
                    generated_at: value.get(1)?,
                    raw_memory: value.get(2)?,
                    rollout_summary: value.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|_| "invalid-record")?;
    if selected.as_ref().is_some_and(|value| {
        value.source_updated_at < 0
            || value.generated_at < 0
            || value.source_updated_at > MAX_SAFE_JS_INTEGER / 1000
            || value.generated_at > MAX_SAFE_JS_INTEGER / 1000
    }) {
        return Err("invalid-record");
    }
    Ok(selected)
}

fn production(
    db: &Connection,
    session_id: &str,
    row: &Stage1Row,
) -> Option<MemoryProductionEvidence> {
    let schema = columns(db, "jobs").ok()?;
    if ![
        "kind",
        "job_key",
        "status",
        "input_watermark",
        "finished_at",
    ]
    .iter()
    .all(|field| schema.contains(*field))
    {
        return None;
    }
    let start = if schema.contains("started_at") {
        "started_at"
    } else {
        "NULL"
    };
    let sql = format!(
        "SELECT status, input_watermark, finished_at, {start}
        FROM jobs WHERE kind = 'memory_stage1' AND job_key = ?1"
    );
    let job = db
        .query_row(&sql, [session_id], |value| {
            Ok((
                value.get::<_, String>(0)?,
                value.get::<_, i64>(1)?,
                value.get::<_, i64>(2)?,
                value.get::<_, Option<i64>>(3)?,
            ))
        })
        .optional()
        .ok()??;
    if job.0 != "done" || job.1 != row.source_updated_at || job.2 != row.generated_at {
        return None;
    }
    Some(MemoryProductionEvidence {
        provenance: Provenance {
            fidelity: Fidelity::Recorded,
            source_type: "codex.memories.jobs".into(),
            source_id: Some(format!("memory_stage1:{session_id}")),
        },
        started_at: job.3.and_then(|value| {
            (0..=MAX_SAFE_JS_INTEGER / 1000)
                .contains(&value)
                .then(|| value * 1000)
        }),
        completed_at: row.generated_at * 1000,
        input_updated_at: row.source_updated_at * 1000,
    })
}

fn artifact(
    session_id: &str,
    path: &Path,
    row: &Stage1Row,
    field: &str,
    body: &str,
    evidence: &Option<MemoryProductionEvidence>,
) -> ContextArtifact {
    let hash = digest(body);
    ContextArtifact {
        id: format!(
            "codex:stage1:{}:{field}:{}:{}:{hash}",
            encode_component(session_id),
            row.source_updated_at,
            row.generated_at
        ),
        session_id: session_id.into(),
        kind: if field == "raw_memory" {
            "memory"
        } else {
            "summary"
        },
        scope: "session",
        origin: "provider-generated",
        content_access: "full",
        title: None,
        summary: None,
        source_path: path.to_string_lossy().into_owned(),
        producer_run_id: None,
        lineage_id: format!("codex:stage1:{session_id}:{field}"),
        source_session_ids: vec![session_id.into()],
        hash,
        redacted: false,
        provenance: Provenance {
            fidelity: Fidelity::Recorded,
            source_type: "codex.memories.stage1_outputs".into(),
            source_id: Some(format!("{session_id}:{field}")),
        },
        time_created: row.generated_at * 1000,
        content_source_time: row.source_updated_at * 1000,
        production_evidence: evidence.clone(),
    }
}

fn metadata(
    source_state: ContextArtifactSourceState,
    artifacts: Vec<ContextArtifact>,
) -> MemoryArtifacts {
    let revision = digest(
        serde_json::to_vec(&(&artifacts, &source_state)).expect("memory metadata serialization"),
    );
    MemoryArtifacts {
        artifacts,
        source_state,
        revision,
    }
}

fn selected_metadata(
    path: &Path,
    db: &Connection,
    session_id: &str,
) -> std::result::Result<(MemoryArtifacts, Option<Stage1Row>), &'static str> {
    let selected = row(db, session_id)?;
    let Some(ref value) = selected else {
        return Ok((metadata(state(path, "available", None), vec![]), None));
    };
    let evidence = production(db, session_id, value);
    let artifacts = [
        artifact(
            session_id,
            path,
            value,
            "raw_memory",
            &value.raw_memory,
            &evidence,
        ),
        artifact(
            session_id,
            path,
            value,
            "rollout_summary",
            &value.rollout_summary,
            &evidence,
        ),
    ]
    .into();
    Ok((
        metadata(state(path, "available", None), artifacts),
        selected,
    ))
}

pub(super) fn read_metadata(root: &Path, session_id: &str) -> MemoryArtifacts {
    let path = root.join("memories_1.sqlite");
    if !path.exists() {
        return metadata(state(&path, "unavailable", Some("not-found")), vec![]);
    }
    let db = match open(&path) {
        Ok(db) => db,
        Err(code) => return metadata(state(&path, "unavailable", Some(code)), vec![]),
    };
    match selected_metadata(&path, &db, session_id) {
        Ok((result, _)) => result,
        Err(code) => metadata(
            state(
                &path,
                if code == "read-failed" {
                    "unavailable"
                } else {
                    "invalid"
                },
                Some(code),
            ),
            vec![],
        ),
    }
}

fn page_text(content: &str, offset: usize, max_chars: usize) -> Result<ContentPage> {
    if !(1..=8192).contains(&max_chars) {
        return Err(CoreError::InvalidInput(
            "maxChars must be between 1 and 8192".into(),
        ));
    }
    let units: Vec<u16> = content.encode_utf16().collect();
    if offset > units.len()
        || (offset > 0
            && units
                .get(offset - 1)
                .is_some_and(|value| (0xd800..=0xdbff).contains(value)))
    {
        return Err(CoreError::InvalidInput(
            "invalid UTF-16 content offset".into(),
        ));
    }
    let mut end = offset.saturating_add(max_chars).min(units.len());
    if end < units.len() && end > offset && (0xd800..=0xdbff).contains(&units[end - 1]) {
        end -= 1;
    }
    if end == offset && offset < units.len() {
        end = (offset + 2).min(units.len());
    }
    Ok(ContentPage {
        text: String::from_utf16(&units[offset..end]).expect("character boundary"),
        offset,
        total_chars: units.len(),
        next_offset: (end < units.len()).then_some(end),
        truncated: end < units.len(),
    })
}

pub(super) fn read_content(
    root: &Path,
    session_id: &str,
    id: &str,
    revision: &str,
    offset: usize,
    max_chars: usize,
) -> Result<MemoryContent> {
    let path: PathBuf = root.join("memories_1.sqlite");
    if !path.exists() {
        return Err(CoreError::Unavailable(
            "Codex memory source: not-found".into(),
        ));
    }
    let db = open(&path)
        .map_err(|code| CoreError::Unavailable(format!("Codex memory source: {code}")))?;
    let (current, selected) = selected_metadata(&path, &db, session_id)
        .map_err(|code| CoreError::Unavailable(format!("Codex memory source: {code}")))?;
    if current.revision != revision {
        return Err(CoreError::SourceChanged);
    }
    let artifact = current
        .artifacts
        .iter()
        .find(|artifact| artifact.id == id)
        .ok_or_else(|| {
            if id.starts_with(&format!("codex:stage1:{}:", encode_component(session_id))) {
                CoreError::SourceChanged
            } else {
                CoreError::EventNotFound(id.into())
            }
        })?;
    let field = if artifact.kind == "memory" {
        "raw_memory"
    } else {
        "rollout_summary"
    };
    let selected = selected.ok_or_else(|| CoreError::EventNotFound(id.into()))?;
    let body = if field == "raw_memory" {
        selected.raw_memory
    } else {
        selected.rollout_summary
    };
    if digest(&body) != artifact.hash {
        return Err(CoreError::SourceChanged);
    }
    Ok(MemoryContent {
        artifact_id: id.into(),
        format: "markdown",
        page: page_text(&body, offset, max_chars)?,
    })
}
