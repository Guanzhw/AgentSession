//! OpenCode v1/v2 SQLite storage and Reader facts.
pub(super) fn default_data_path(home: &std::path::Path) -> std::path::PathBuf {
    let fallback = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".local").join("share"))
        .join("opencode")
        .join("opencode.db");
    let native = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
            .join("opencode")
            .join("opencode.db")
    } else if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("opencode")
            .join("opencode.db")
    } else {
        fallback.clone()
    };
    super::paths::probe(&[Some(fallback.clone()), Some(native)], fallback)
}

use super::{NormalizedEvent, ProviderAdapter, SessionSnapshot, SourceEntry};
use crate::protocol::{
    CoordinationFact, DomainCoverage, EventCandidate, EventStream, Evidence, Fidelity,
    ObservationCandidates, ObservationSnapshot, ObservationState, ProtocolBundle, Provenance,
    RelationshipObservation, RunStatus, SourceOrder, TaskObservation, UsageRecord,
    UsageTokenComponents, finalize_events, finalize_protocol_bundle,
};
use crate::{
    CoordinationObservation, CoreError, EventRef, ReaderItem, RelationEntry, RelationProvenance,
    Result, SessionRef, SessionSummary, bounded_preview,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

#[path = "opencode_prompt.rs"]
mod prompt;

const PROVIDER: &str = "opencode";

pub(super) struct OpenCodeAdapter<'a> {
    pub path: &'a Path,
    pub scope: &'a str,
}

#[derive(Clone, Copy)]
enum Schema {
    V1,
    V2,
}

struct TaskDispatch {
    part_id: String,
    message_id: String,
    call_id: Option<String>,
    timestamp: Option<i64>,
    child_id: Option<String>,
}

impl TaskDispatch {
    fn event_id(&self, schema: Schema) -> String {
        match schema {
            Schema::V1 => format!("event:opencode:v1:part:{}", self.part_id),
            Schema::V2 => format!("event:opencode:v2:{}", self.part_id),
        }
    }

    fn reader_id(&self, schema: Schema) -> String {
        match schema {
            Schema::V1 => format!("{}:{}", self.message_id, self.part_id),
            Schema::V2 => self.part_id.clone(),
        }
    }

    fn source_type(schema: Schema) -> &'static str {
        match schema {
            Schema::V1 => "opencode.part.tool.task",
            Schema::V2 => "opencode.session_message.content.tool.task",
        }
    }

    fn evidence_source_id(&self, schema: Schema) -> &str {
        match schema {
            Schema::V1 => &self.part_id,
            Schema::V2 => &self.message_id,
        }
    }

    fn relationship_source_type(schema: Schema) -> &'static str {
        match schema {
            Schema::V1 => "opencode.part.tool+session.parent_id",
            Schema::V2 => "opencode.session_message.content.tool+session_v2.parent_id",
        }
    }
}

impl OpenCodeAdapter<'_> {
    fn task_dispatches(&self, db: &Connection, session_id: &str) -> Result<Vec<TaskDispatch>> {
        let mut statement = db.prepare("SELECT p.id, p.message_id, p.data FROM part p JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id WHERE p.session_id=?1 ORDER BY COALESCE(CAST(json_extract(m.data,'$.time.created') AS INTEGER),0), m.id, p.rowid, p.id")
            .map_err(|error| self.source_error(error))?;
        let rows = statement
            .query_map([session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| self.source_error(error))?;
        let mut dispatches = Vec::new();
        for row in rows {
            let (part_id, message_id, data) = row.map_err(|error| self.source_error(error))?;
            let part: Value = serde_json::from_str(&data).map_err(|_| {
                self.source_error(format!("Invalid OpenCode v1 part JSON: {part_id}"))
            })?;
            if part["type"] != "tool" || part["tool"] != "task" {
                continue;
            }
            let metadata = &part["state"]["metadata"];
            let claimed = metadata["sessionId"].as_str().filter(|id| !id.is_empty());
            let claimed_parent = metadata["parentSessionId"].as_str();
            let child_id = if let Some(claimed) = claimed {
                let parent: Option<String> = db
                    .query_row(
                        "SELECT parent_id FROM session WHERE id=?1",
                        [claimed],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| self.source_error(error))?
                    .flatten();
                (parent.as_deref() == Some(session_id)
                    && claimed_parent.is_none_or(|parent| parent == session_id))
                .then(|| claimed.to_owned())
            } else {
                None
            };
            dispatches.push(TaskDispatch {
                part_id,
                message_id,
                call_id: part["callID"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned),
                timestamp: part["state"]["time"]["start"].as_i64(),
                child_id,
            });
        }
        Ok(dispatches)
    }

    fn v2_task_dispatches(&self, db: &Connection, session_id: &str) -> Result<Vec<TaskDispatch>> {
        let mut statement = db.prepare("SELECT m.id, m.time_created, m.data FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE m.session_id=?1 AND (s.fork_session_id IS NULL OR substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq) AND m.type='assistant' ORDER BY m.seq, m.id")
            .map_err(|error| self.source_error(error))?;
        let rows = statement
            .query_map([session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| self.source_error(error))?;
        let mut dispatches = Vec::new();
        for row in rows {
            let (message_id, time, data) = row.map_err(|error| self.source_error(error))?;
            let value: Value = serde_json::from_str(&data).map_err(|_| {
                self.source_error(format!("Invalid OpenCode v2 message JSON: {message_id}"))
            })?;
            let content = value["content"].as_array().ok_or_else(|| {
                self.source_error(format!(
                    "Invalid OpenCode v2 assistant content: {message_id}"
                ))
            })?;
            for (index, part) in content.iter().enumerate() {
                if part["type"] != "tool" || part["name"] != "task" {
                    continue;
                }
                let metadata = &part["state"]["metadata"];
                let claimed = metadata["sessionId"].as_str().filter(|id| !id.is_empty());
                let claimed_parent = metadata["parentSessionId"].as_str();
                let child_id = if let Some(claimed) = claimed {
                    let parent: Option<String> = db
                        .query_row(
                            "SELECT parent_id FROM session_v2 WHERE id=?1",
                            [claimed],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|error| self.source_error(error))?
                        .flatten();
                    (parent.as_deref() == Some(session_id)
                        && claimed_parent.is_none_or(|parent| parent == session_id))
                    .then(|| claimed.to_owned())
                } else {
                    None
                };
                dispatches.push(TaskDispatch {
                    part_id: format!("{message_id}:content:{index}"),
                    message_id: message_id.clone(),
                    call_id: part["id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned),
                    timestamp: part["time"]["created"].as_i64().or(Some(time)),
                    child_id,
                });
            }
        }
        Ok(dispatches)
    }

    fn protocol_relationships(&self, session_id: &str) -> Result<Vec<RelationshipObservation>> {
        let (db, schema) = self.open()?;
        let (parent, fork): (Option<String>, Option<String>) = match schema {
            Schema::V1 => (
                db.query_row(
                    "SELECT parent_id FROM session WHERE id=?1",
                    [session_id],
                    |row| row.get(0),
                )
                .map_err(|error| self.source_error(error))?,
                None,
            ),
            Schema::V2 => db
                .query_row(
                    "SELECT parent_id, fork_session_id FROM session_v2 WHERE id=?1",
                    [session_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|error| self.source_error(error))?,
        };
        let table = match schema {
            Schema::V1 => "session",
            Schema::V2 => "session_v2",
        };
        let mut relationships = Vec::new();
        for (kind, source_id, field) in [
            ("parent", parent, "parent_id"),
            ("forked", fork, "fork_session_id"),
        ] {
            if let Some(source_id) = source_id {
                if source_id.is_empty() {
                    return Err(self
                        .source_error(format!("Invalid OpenCode {table}.{field}: {session_id}")));
                }
                relationships.push(RelationshipObservation {
                    id: format!("relationship:opencode:{kind}:{session_id}"),
                    kind: kind.into(),
                    from: SessionRef {
                        provider: PROVIDER.into(),
                        session_id: source_id,
                    },
                    to: SessionRef {
                        provider: PROVIDER.into(),
                        session_id: session_id.into(),
                    },
                    correlation_id: None,
                    evidence: Evidence {
                        event_id: format!(
                            "event:opencode:{schema_id}:session:{session_id}",
                            schema_id = if matches!(schema, Schema::V1) {
                                "v1"
                            } else {
                                "v2"
                            }
                        ),
                        provenance: Provenance {
                            fidelity: Fidelity::Recorded,
                            source_type: format!("opencode.{table}.{field}"),
                            source_id: Some(session_id.into()),
                        },
                    },
                });
            }
        }
        Ok(relationships)
    }

    fn open(&self) -> Result<(Connection, Schema)> {
        if !self.path.is_file() {
            return Err(self.source_error("OpenCode database is missing"));
        }
        let db = Connection::open_with_flags(self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| self.source_error(error))?;
        db.execute_batch("BEGIN")
            .map_err(|error| self.source_error(error))?;
        let has_v2: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_v2')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| self.source_error(error))?;
        let required: &[(&str, &[&str])] = if has_v2 {
            &[
                (
                    "session_v2",
                    &[
                        "id",
                        "parent_id",
                        "fork_session_id",
                        "fork_boundary",
                        "title",
                        "directory",
                        "time_created",
                        "time_updated",
                        "time_archived",
                        "tokens_input",
                        "tokens_output",
                        "tokens_reasoning",
                        "tokens_cache_read",
                        "tokens_cache_write",
                    ],
                ),
                (
                    "session_message",
                    &[
                        "id",
                        "session_id",
                        "type",
                        "seq",
                        "time_created",
                        "time_updated",
                        "data",
                    ],
                ),
            ]
        } else {
            &[
                (
                    "session",
                    &[
                        "id",
                        "parent_id",
                        "title",
                        "directory",
                        "time_created",
                        "time_updated",
                        "time_archived",
                    ],
                ),
                ("message", &["id", "session_id", "data", "time_created"]),
                (
                    "part",
                    &["id", "message_id", "session_id", "data", "time_created"],
                ),
            ]
        };
        for (table, names) in required {
            let present = columns(&db, table).map_err(|error| self.source_error(error))?;
            let missing: Vec<_> = names
                .iter()
                .filter(|column| !present.contains(**column))
                .copied()
                .collect();
            if !missing.is_empty() {
                return Err(self.source_error(format!(
                    "Unsupported OpenCode schema: {table} missing {}",
                    missing.join(", ")
                )));
            }
        }
        Ok((db, if has_v2 { Schema::V2 } else { Schema::V1 }))
    }

    fn source_error(&self, reason: impl ToString) -> CoreError {
        CoreError::Parse {
            path: self.path.into(),
            reason: reason.to_string(),
        }
    }

    fn protocol_tool_kind(&self, part: &Value) -> Result<&'static str> {
        let state = &part["state"];
        if !state.is_null() && !state.is_object() {
            return Err(self.source_error("Invalid OpenCode tool state"));
        }
        let status = &state["status"];
        if !status.is_null() && !status.is_string() {
            return Err(self.source_error("Invalid OpenCode tool status"));
        }
        // A persisted tool state is one observation, not an inferred lifecycle.
        Ok(match status.as_str() {
            Some("pending") => "tool.pending",
            Some("running") => "tool.running",
            Some("completed") => "tool.completed",
            Some("error") => "tool.error",
            _ => "tool",
        })
    }

    fn revision(&self) -> Result<String> {
        let mut digest = Sha256::new();
        digest.update(b"opencode-sqlite-v3-slice-4\0");
        digest.update(self.scope.as_bytes());
        let mut wal = self.path.as_os_str().to_os_string();
        wal.push("-wal");
        let wal = std::path::PathBuf::from(wal);
        let mut wal_nonempty = false;
        for path in [self.path.to_path_buf(), wal.clone()] {
            digest.update(path.to_string_lossy().as_bytes());
            match fs::metadata(&path) {
                Ok(metadata) => {
                    if path == wal {
                        wal_nonempty = metadata.len() != 0;
                    }
                    digest.update(metadata.len().to_le_bytes());
                    for time in [metadata.modified(), metadata.created()] {
                        if let Ok(duration) = time.and_then(|time| {
                            time.duration_since(std::time::UNIX_EPOCH)
                                .map_err(std::io::Error::other)
                        }) {
                            digest.update(duration.as_nanos().to_le_bytes());
                        }
                    }
                    let mut file = File::open(&path).map_err(|source| CoreError::Io {
                        path: path.clone(),
                        source,
                    })?;
                    let prefix_len = if path == self.path { 100 } else { 32 };
                    let mut header = vec![0; metadata.len().min(prefix_len as u64) as usize];
                    file.read_exact(&mut header)
                        .map_err(|source| CoreError::Io {
                            path: path.clone(),
                            source,
                        })?;
                    digest.update(&header);
                    if path == self.path && header.len() < 100 {
                        return Err(self.source_error("OpenCode database header is truncated"));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    digest.update(b"missing");
                }
                Err(source) => return Err(CoreError::Io { path, source }),
            }
        }
        // An empty WAL has no committed frames. Readers can rebuild or release
        // its SHM index without changing provider data, so that transient header
        // must not participate in the empty-WAL source revision. For a nonempty
        // WAL, both header copies still detect commits despite WAL preallocation,
        // file timestamp granularity, or checkpoint reuse.
        let mut shm = self.path.as_os_str().to_os_string();
        shm.push("-shm");
        let shm = std::path::PathBuf::from(shm);
        if wal_nonempty {
            match File::open(&shm) {
                Ok(mut file) => {
                    let mut header = [0; 96];
                    file.read_exact(&mut header)
                        .map_err(|source| CoreError::Io { path: shm, source })?;
                    digest.update(header);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    digest.update(b"shm-missing");
                }
                Err(source) => return Err(CoreError::Io { path: shm, source }),
            }
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    fn protocol_usage_records(&self, session_id: &str) -> Result<Vec<UsageRecord>> {
        let revision = self.revision()?;
        let (db, schema) = self.open()?;
        let mut usage_records = Vec::new();
        match schema {
            Schema::V1 => {
                let mut statement = db
                    .prepare("SELECT id, data, time_created FROM message WHERE session_id=?1 ORDER BY COALESCE(CAST(json_extract(data,'$.time.created') AS INTEGER),0), id")
                    .map_err(|error| self.source_error(error))?;
                let rows = statement
                    .query_map([session_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    })
                    .map_err(|error| self.source_error(error))?;
                for row in rows {
                    let (message_id, data, created) =
                        row.map_err(|error| self.source_error(error))?;
                    let message: Value = serde_json::from_str(&data).map_err(|_| {
                        self.source_error(format!("Invalid OpenCode v1 message JSON: {message_id}"))
                    })?;
                    if !message.is_object() {
                        return Err(
                            self.source_error(format!("Invalid OpenCode v1 message: {message_id}"))
                        );
                    }
                    if message["role"].as_str() != Some("assistant") {
                        continue;
                    }
                    let timestamp = message["time"]["created"].as_i64().or(Some(created));
                    if let Some(record) = open_code_usage_record(
                        session_id,
                        &message_id,
                        timestamp,
                        &message,
                        format!("event:opencode:v1:message:{message_id}"),
                    ) {
                        usage_records.push(record);
                    }
                }
            }
            Schema::V2 => {
                let mut statement = db.prepare("SELECT m.id, m.type, m.time_created, m.data FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE m.session_id=?1 AND (s.fork_session_id IS NULL OR substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq) AND m.type='assistant' ORDER BY m.seq, m.id")
                    .map_err(|error| self.source_error(error))?;
                let rows = statement
                    .query_map([session_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    })
                    .map_err(|error| self.source_error(error))?;
                for row in rows {
                    let (message_id, timestamp, data) =
                        row.map_err(|error| self.source_error(error))?;
                    let message: Value = serde_json::from_str(&data).map_err(|_| {
                        self.source_error(format!("Invalid OpenCode v2 record JSON: {message_id}"))
                    })?;
                    if !message.is_object() {
                        return Err(
                            self.source_error(format!("Invalid OpenCode v2 record: {message_id}"))
                        );
                    }
                    if let Some(record) = open_code_usage_record(
                        session_id,
                        &message_id,
                        Some(timestamp),
                        &message,
                        format!("event:opencode:v2:{message_id}"),
                    ) {
                        usage_records.push(record);
                    }
                }
            }
        }
        drop(db);
        if self.revision()? != revision {
            return Err(CoreError::SourceChanged);
        }
        Ok(usage_records)
    }

    fn rows(
        &self,
        db: &Connection,
        schema: Schema,
        id: Option<&str>,
    ) -> Result<Vec<SessionSummary>> {
        let table = match schema {
            Schema::V1 => "session",
            Schema::V2 => "session_v2",
        };
        let mut columns_query = db
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|error| self.source_error(error))?;
        let columns = columns_query
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| self.source_error(error))?
            .collect::<std::result::Result<HashSet<_>, _>>()
            .map_err(|error| self.source_error(error))?;
        let recorded = |field: &str| {
            if columns.contains(field) {
                format!("s.{field}")
            } else {
                "NULL".to_owned()
            }
        };
        let counts = format!(
            "{}, {}, {}",
            recorded("summary_files"),
            recorded("summary_additions"),
            recorded("summary_deletions")
        );
        let query = match schema {
            Schema::V2 => {
                format!(
                    "SELECT s.id, s.parent_id, COALESCE(NULLIF(s.title,''), NULLIF(s.slug,''), s.id), s.directory, s.time_created, s.time_updated, \
                (SELECT COUNT(*) FROM session_message m WHERE m.session_id=s.id AND \
                 (s.fork_session_id IS NULL OR substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq) \
                 AND m.type IN ('user','assistant')), \
                COALESCE(s.tokens_input,0)+COALESCE(s.tokens_output,0)+COALESCE(s.tokens_reasoning,0)+COALESCE(s.tokens_cache_read,0)+COALESCE(s.tokens_cache_write,0), \
                COALESCE(NULLIF(s.title,''), NULLIF(s.slug,'')), {counts} \
                FROM session_v2 s WHERE (?1 IS NOT NULL AND s.id=?1) OR (?1 IS NULL AND s.time_archived IS NULL) ORDER BY s.time_updated DESC, s.id"
                )
            }
            Schema::V1 => {
                format!(
                    "SELECT s.id, s.parent_id, COALESCE(NULLIF(s.title,''), s.id), s.directory, s.time_created, s.time_updated, \
                (SELECT COUNT(DISTINCT m.id) FROM message m WHERE m.session_id=s.id), NULL, NULLIF(s.title,''), {counts} \
                FROM session s WHERE (?1 IS NOT NULL AND s.id=?1) OR (?1 IS NULL AND s.time_archived IS NULL) ORDER BY s.time_updated DESC, s.id"
                )
            }
        };
        let mut statement = db
            .prepare(&query)
            .map_err(|error| self.source_error(error))?;
        let rows = statement
            .query_map([id], |row| {
                let parent: Option<String> = row.get(1)?;
                Ok(SessionSummary {
                    diagnostic: None,
                    session: SessionRef {
                        provider: PROVIDER.into(),
                        session_id: row.get(0)?,
                    },
                    title: row.get(2)?,
                    search_title: row.get(8)?,
                    directory: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    message_count: row.get::<_, i64>(6)?.max(0) as usize,
                    conversation_message_count: None,
                    token_count: row
                        .get::<_, Option<i64>>(7)?
                        .map(|value| value.max(0) as u64),
                    duration_ms: None,
                    summary_files: row.get(9)?,
                    summary_additions: row.get(10)?,
                    summary_deletions: row.get(11)?,
                    parent: parent.map(|session_id| SessionRef {
                        provider: PROVIDER.into(),
                        session_id,
                    }),
                })
            })
            .map_err(|error| self.source_error(error))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|error| self.source_error(error))
    }

    fn load_v2(&self, db: &Connection, id: &str, events: &mut Vec<NormalizedEvent>) -> Result<()> {
        let mut statement = db.prepare("SELECT m.id, m.type, m.seq, m.time_created, m.data FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE m.session_id=?1 AND (s.fork_session_id IS NULL OR substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq) ORDER BY m.seq, m.id")
            .map_err(|error| self.source_error(error))?;
        let rows = statement
            .query_map([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| self.source_error(error))?;
        for row in rows {
            let (message_id, kind, time, data) = row.map_err(|error| self.source_error(error))?;
            let value: Value = serde_json::from_str(&data).map_err(|error| {
                self.source_error(format!(
                    "Invalid OpenCode v2 message JSON: {message_id}: {error}"
                ))
            })?;
            if !value.is_object() {
                return Err(self.source_error(format!("Invalid OpenCode v2 message: {message_id}")));
            }
            match kind.as_str() {
                "user" => push(
                    events,
                    id,
                    &message_id,
                    "message",
                    "user",
                    Some(time),
                    value["text"].as_str().unwrap_or_default().into(),
                    None,
                    None,
                    None,
                    None,
                ),
                "assistant" => {
                    let reply_start = events.len();
                    let parts = value["content"].as_array().ok_or_else(|| {
                        self.source_error(format!(
                            "Invalid OpenCode v2 assistant content: {message_id}"
                        ))
                    })?;
                    let owner_id = parts
                        .iter()
                        .enumerate()
                        .find(|(_, part)| part["type"] == "text")
                        .map(|(index, _)| format!("{message_id}:content:{index}"));
                    if owner_id.is_none() {
                        push(
                            events,
                            id,
                            &message_id,
                            "message",
                            "assistant",
                            Some(time),
                            String::new(),
                            None,
                            None,
                            None,
                            None,
                        );
                    }
                    let owner = owner_id.unwrap_or_else(|| message_id.clone());
                    let owner = Some(EventRef {
                        provider: PROVIDER.into(),
                        session_id: id.into(),
                        message_id: owner,
                        segment: "message".into(),
                    });
                    for (index, part) in parts.iter().enumerate() {
                        let part_id = format!("{message_id}:content:{index}");
                        match part["type"].as_str() {
                            Some("text") => push(
                                events,
                                id,
                                &part_id,
                                "message",
                                "assistant",
                                Some(time),
                                part["text"].as_str().unwrap_or_default().into(),
                                None,
                                None,
                                None,
                                None,
                            ),
                            Some("reasoning") => push(
                                events,
                                id,
                                &part_id,
                                "thinking",
                                "assistant",
                                Some(time),
                                part["text"].as_str().unwrap_or_default().into(),
                                None,
                                None,
                                None,
                                owner.clone(),
                            ),
                            Some("tool") => {
                                let name = part["name"].as_str().ok_or_else(|| {
                                    self.source_error(format!(
                                        "Invalid OpenCode v2 tool: {message_id}:{index}"
                                    ))
                                })?;
                                let state = &part["state"];
                                if !state.is_object() {
                                    return Err(self.source_error(format!(
                                        "Invalid OpenCode v2 tool: {message_id}:{index}"
                                    )));
                                }
                                let input = json_text(&state["input"]);
                                let output = if state["status"] == "error" {
                                    json_text(&state["error"])
                                } else {
                                    content_text(&state["content"])
                                };
                                let stamp = part["time"]["created"].as_i64().unwrap_or(time);
                                push(
                                    events,
                                    id,
                                    &part_id,
                                    "tool",
                                    "tool",
                                    Some(stamp),
                                    output,
                                    Some(name.into()),
                                    Some(input),
                                    state["status"].as_str().map(str::to_owned),
                                    owner.clone(),
                                );
                            }
                            other => {
                                return Err(self.source_error(format!(
                                    "Unsupported OpenCode v2 assistant content type: {other:?}"
                                )));
                            }
                        }
                    }
                    let mut primary = true;
                    for event in events[reply_start..].iter_mut().filter(|event| {
                        event.item.event.segment == "message" && event.item.role == "assistant"
                    }) {
                        event.item.reply_metadata = open_code_reply_metadata(
                            id,
                            &message_id,
                            Some(time),
                            &value,
                            Schema::V2,
                            primary,
                        );
                        primary = false;
                    }
                }
                "compaction" => push(
                    events,
                    id,
                    &message_id,
                    "message",
                    "system",
                    Some(time),
                    value["summary"].as_str().unwrap_or("Compaction").into(),
                    None,
                    None,
                    None,
                    None,
                ),
                "system" | "synthetic" | "skill" => push(
                    events,
                    id,
                    &message_id,
                    "message",
                    "system",
                    Some(time),
                    value["text"].as_str().unwrap_or_default().into(),
                    None,
                    None,
                    None,
                    None,
                ),
                _ => push(
                    events,
                    id,
                    &message_id,
                    "message",
                    "system",
                    Some(time),
                    format!("{kind}: {value}"),
                    None,
                    None,
                    None,
                    None,
                ),
            }
        }
        Ok(())
    }

    fn load_v1(&self, db: &Connection, id: &str, events: &mut Vec<NormalizedEvent>) -> Result<()> {
        let mut statement = db.prepare("SELECT m.id, m.data, m.time_created, p.id, p.data FROM message m JOIN part p ON p.message_id=m.id WHERE m.session_id=?1 ORDER BY COALESCE(CAST(json_extract(m.data,'$.time.created') AS INTEGER),0), m.id, p.rowid, p.id")
            .map_err(|error| self.source_error(error))?;
        let rows = statement
            .query_map([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| self.source_error(error))?;
        let mut primary_messages = HashSet::new();
        for row in rows {
            let (message_id, message_data, created, part_id, part_data) =
                row.map_err(|error| self.source_error(error))?;
            let message: Value = serde_json::from_str(&message_data).map_err(|error| {
                self.source_error(format!("Invalid OpenCode v1 message {message_id}: {error}"))
            })?;
            let part: Value = serde_json::from_str(&part_data).map_err(|error| {
                self.source_error(format!("Invalid OpenCode v1 part {part_id}: {error}"))
            })?;
            let role = message["role"].as_str().unwrap_or("system");
            let time = message["time"]["created"].as_i64().unwrap_or(created);
            let event_id = format!("{message_id}:{part_id}");
            match part["type"].as_str() {
                Some("text") => {
                    push(
                        events,
                        id,
                        &event_id,
                        "message",
                        role,
                        Some(time),
                        part["text"].as_str().unwrap_or_default().into(),
                        None,
                        None,
                        None,
                        None,
                    );
                    if role == "assistant" {
                        events.last_mut().expect("text event").item.reply_metadata =
                            open_code_reply_metadata(
                                id,
                                &message_id,
                                Some(time),
                                &message,
                                Schema::V1,
                                primary_messages.insert(message_id.clone()),
                            );
                    }
                }
                Some("reasoning") => push(
                    events,
                    id,
                    &event_id,
                    "thinking",
                    role,
                    Some(time),
                    part["text"].as_str().unwrap_or_default().into(),
                    None,
                    None,
                    None,
                    None,
                ),
                Some("tool") => {
                    let name = part["tool"].as_str().unwrap_or("unknown");
                    let state = &part["state"];
                    let output = if state["status"] == "error" {
                        json_text(&state["error"])
                    } else {
                        json_text(&state["output"])
                    };
                    push(
                        events,
                        id,
                        &event_id,
                        "tool",
                        "tool",
                        Some(time),
                        output,
                        Some(name.into()),
                        Some(json_text(&state["input"])),
                        state["status"].as_str().map(str::to_owned),
                        None,
                    );
                }
                _ => {}
            }
        }
        Ok(())
    }
}

impl ProviderAdapter for OpenCodeAdapter<'_> {
    fn storage_diagnostic(&self) -> Option<Value> {
        let path = self.path.to_string_lossy();
        let (schema, note) = if !self.path.exists() {
            (
                "missing",
                Some(format!("OpenCode database not found: {path}")),
            )
        } else {
            match self.open() {
                Ok((_, Schema::V1)) => ("v1", None),
                Ok((_, Schema::V2)) => (
                    "v2",
                    Some("OpenCode v2 read-only support: ordered messages, tools, compaction, parent/fork links and token usage. Copied fork context is shown separately. Pending inbox and event replay are not projected; recorded task tool dispatch is projected.".to_owned()),
                ),
                Err(CoreError::Parse { reason, .. })
                    if reason.starts_with("Unsupported OpenCode schema:") =>
                {
                    ("unsupported", Some(reason))
                }
                Err(CoreError::Parse { reason, .. }) => (
                    "unreadable",
                    Some(format!("Cannot read OpenCode database: {reason}")),
                ),
                Err(error) => (
                    "unreadable",
                    Some(format!("Cannot read OpenCode database: {error}")),
                ),
            }
        };
        Some(serde_json::json!({ "schema": schema, "path": path, "note": note }))
    }

    fn legacy_content_title_first(&self) -> Result<bool> {
        self.open().map(|(_, schema)| matches!(schema, Schema::V1))
    }
    fn stats_project_ids(&self) -> Result<Option<BTreeMap<String, String>>> {
        let (db, schema) = self.open()?;
        let table = match schema {
            Schema::V1 => "session",
            Schema::V2 => "session_v2",
        };
        if !columns(&db, table)
            .map_err(|error| self.source_error(error))?
            .contains("project_id")
        {
            return Ok(None);
        }
        let sql =
            format!("SELECT id, COALESCE(project_id,'') FROM {table} WHERE time_archived IS NULL");
        let mut statement = db.prepare(&sql).map_err(|error| self.source_error(error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| self.source_error(error))?;
        rows.collect::<std::result::Result<BTreeMap<_, _>, _>>()
            .map(Some)
            .map_err(|error| self.source_error(error))
    }
    fn resume_command(&self) -> Option<crate::DefaultResumeCommand> {
        Some(crate::DefaultResumeCommand {
            command: crate::ResumeCommandSpec {
                executable: "opencode".into(),
                args: vec!["--session".into(), "{sessionId}".into()],
                cwd: None,
            },
            npm: Some(crate::NpmResumeEntry {
                package: "@opencode/cli",
                bin: "opencode",
            }),
        })
    }

    fn available(&self) -> bool {
        self.open().is_ok()
    }

    fn protocol_capabilities(&self) -> super::ProtocolCapabilities {
        super::protocol_capability_map(&[
            ("sessionEvents", "recorded"),
            ("sessionRelationships", "recorded"),
            ("tasks", "recorded"),
        ])
    }

    fn unavailable_diagnostic(&self) -> &'static str {
        "OpenCode database is missing, unreadable, or has unsupported schema"
    }

    fn list(&self) -> Result<Vec<SessionSummary>> {
        let (db, schema) = self.open()?;
        self.rows(&db, schema, None)
    }

    fn load(&self, session_id: &str) -> Result<SessionSnapshot> {
        let revision = self.revision()?;
        let (db, schema) = self.open()?;
        let summary = self
            .rows(&db, schema, Some(session_id))?
            .into_iter()
            .next()
            .ok_or_else(|| CoreError::NotFound {
                provider: PROVIDER.into(),
                session_id: session_id.into(),
            })?;
        let mut events = Vec::new();
        let mut relations = Vec::new();
        match schema {
            Schema::V1 => {
                self.load_v1(&db, session_id, &mut events)?;
                for dispatch in self.task_dispatches(&db, session_id)? {
                    let event_id = dispatch.event_id(schema);
                    let reader_event = Some(open_code_event_ref(
                        session_id,
                        &dispatch.reader_id(schema),
                        "tool",
                    ));
                    relations.push(RelationEntry::Coordination {
                        observation: CoordinationObservation {
                            kind: if dispatch.child_id.is_some() {
                                "spawn"
                            } else {
                                "delegate"
                            }
                            .into(),
                            state: if dispatch.child_id.is_some() {
                                "started"
                            } else {
                                "requested"
                            }
                            .into(),
                            correlation_id: dispatch
                                .call_id
                                .unwrap_or_else(|| dispatch.part_id.clone()),
                            event_id,
                            from_session_ref: Some(summary.session.clone()),
                            to_session_ref: dispatch.child_id.map(|session_id| SessionRef {
                                provider: PROVIDER.into(),
                                session_id,
                            }),
                            from_actor_path: None,
                            to_actor_path: None,
                            from_participant: None,
                            to_participant: None,
                            message_excerpt: None,
                            message_excerpt_truncated: None,
                            launch_request: None,
                            reader_event,
                            provenance: RelationProvenance {
                                fidelity: "recorded".into(),
                                source_type: TaskDispatch::source_type(schema).into(),
                                source_id: dispatch.part_id,
                            },
                        },
                    });
                }
            }
            Schema::V2 => {
                self.load_v2(&db, session_id, &mut events)?;
                for dispatch in self.v2_task_dispatches(&db, session_id)? {
                    let event_id = dispatch.event_id(schema);
                    let evidence_source_id = dispatch.evidence_source_id(schema).to_owned();
                    let reader_event =
                        open_code_event_ref(session_id, &dispatch.reader_id(schema), "tool");
                    relations.push(RelationEntry::Coordination {
                        observation: CoordinationObservation {
                            kind: if dispatch.child_id.is_some() {
                                "spawn"
                            } else {
                                "delegate"
                            }
                            .into(),
                            state: if dispatch.child_id.is_some() {
                                "started"
                            } else {
                                "requested"
                            }
                            .into(),
                            correlation_id: dispatch
                                .call_id
                                .unwrap_or_else(|| dispatch.part_id.clone()),
                            event_id,
                            from_session_ref: Some(summary.session.clone()),
                            to_session_ref: dispatch.child_id.map(|session_id| SessionRef {
                                provider: PROVIDER.into(),
                                session_id,
                            }),
                            from_actor_path: None,
                            to_actor_path: None,
                            from_participant: None,
                            to_participant: None,
                            message_excerpt: None,
                            message_excerpt_truncated: None,
                            launch_request: None,
                            reader_event: Some(reader_event),
                            provenance: RelationProvenance {
                                fidelity: "recorded".into(),
                                source_type: TaskDispatch::source_type(schema).into(),
                                source_id: evidence_source_id,
                            },
                        },
                    });
                }
                let source: Option<String> = db
                    .query_row(
                        "SELECT fork_session_id FROM session_v2 WHERE id=?1",
                        [session_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| self.source_error(error))?
                    .flatten();
                if let Some(source_id) = source {
                    relations.push(RelationEntry::Coordination {
                        observation: CoordinationObservation {
                            kind: "fork".into(),
                            state: "recorded".into(),
                            correlation_id: format!("opencode:fork:{session_id}"),
                            event_id: format!("opencode:fork:{session_id}"),
                            from_session_ref: Some(SessionRef {
                                provider: PROVIDER.into(),
                                session_id: source_id,
                            }),
                            to_session_ref: Some(summary.session.clone()),
                            from_actor_path: None,
                            to_actor_path: None,
                            from_participant: None,
                            to_participant: None,
                            message_excerpt: None,
                            message_excerpt_truncated: None,
                            launch_request: None,
                            reader_event: None,
                            provenance: RelationProvenance {
                                fidelity: "recorded".into(),
                                source_type: "opencode.session_v2.fork_session_id".into(),
                                source_id: session_id.into(),
                            },
                        },
                    });
                }
            }
        }
        if self.revision()? != revision {
            return Err(CoreError::SourceChanged);
        }
        Ok(SessionSnapshot {
            summary,
            revision,
            events,
            relations,
        })
    }

    fn system_prompt_evidence(&self, session_id: &str) -> Result<crate::SystemPromptEvidence> {
        prompt::build(self, session_id)
    }

    fn protocol_observations(&self, session_id: &str) -> Result<ObservationSnapshot> {
        Ok(self.protocol_bundle(session_id)?.into_observations())
    }

    fn protocol_bundle(&self, session_id: &str) -> Result<ProtocolBundle> {
        // The event stream, usage, and session links must describe one source revision.
        let revision = self.revision()?;
        let stream = self.protocol_event_stream(session_id)?;
        let usage_records = self.protocol_usage_records(session_id)?;
        let relationships = self.protocol_relationships(session_id)?;
        if self.revision()? != revision {
            return Err(CoreError::SourceChanged);
        }
        let mut observations = ObservationCandidates::default();
        observations.relationships = relationships;
        let (db, schema) = self.open()?;
        let dispatches = match schema {
            Schema::V1 => self.task_dispatches(&db, session_id)?,
            Schema::V2 => self.v2_task_dispatches(&db, session_id)?,
        };
        let mut spawned = HashSet::new();
        for dispatch in dispatches {
            let event_id = dispatch.event_id(schema);
            let evidence_source_id = dispatch.evidence_source_id(schema).to_owned();
            let reader_event = Some(open_code_event_ref(
                session_id,
                &dispatch.reader_id(schema),
                "tool",
            ));
            let evidence = Evidence {
                event_id: event_id.clone(),
                provenance: Provenance {
                    fidelity: Fidelity::Recorded,
                    source_type: TaskDispatch::source_type(schema).into(),
                    source_id: Some(evidence_source_id.clone()),
                },
            };
            observations.tasks.push(TaskObservation {
                id: format!("task:{}", dispatch.part_id),
                kind: "subagent-task".into(),
                status: RunStatus::Unknown,
                time_created: dispatch.timestamp,
                evidence: evidence.clone(),
            });
            let child = dispatch.child_id.map(|session_id| SessionRef {
                provider: PROVIDER.into(),
                session_id,
            });
            observations.coordination.push(CoordinationFact {
                id: format!("coord:opencode:launch:{}", dispatch.part_id),
                kind: if child.is_some() { "spawn" } else { "delegate" }.into(),
                state: if child.is_some() {
                    "started"
                } else {
                    "requested"
                }
                .into(),
                correlation_id: dispatch
                    .call_id
                    .clone()
                    .unwrap_or_else(|| dispatch.part_id.clone()),
                from_session_ref: Some(SessionRef {
                    provider: PROVIDER.into(),
                    session_id: session_id.into(),
                }),
                to_session_ref: child.clone(),
                from_actor_path: None,
                to_actor_path: None,
                reader_event,
                evidence: evidence.clone(),
            });
            if let Some(child) = child.filter(|child| spawned.insert(child.session_id.clone())) {
                observations.relationships.push(RelationshipObservation {
                    id: format!("relationship:opencode:spawned:{}", child.session_id),
                    kind: "spawned".into(),
                    from: SessionRef {
                        provider: PROVIDER.into(),
                        session_id: session_id.into(),
                    },
                    to: child,
                    correlation_id: dispatch.call_id,
                    evidence: Evidence {
                        event_id,
                        provenance: Provenance {
                            fidelity: Fidelity::Recorded,
                            source_type: TaskDispatch::relationship_source_type(schema).into(),
                            source_id: Some(evidence_source_id),
                        },
                    },
                });
            }
        }
        drop(db);
        if self.revision()? != revision {
            return Err(CoreError::SourceChanged);
        }
        observations.coverage.insert("relationships".into(), DomainCoverage {
            state: if observations.relationships.is_empty() {
                ObservationState::NotObserved
            } else {
                ObservationState::Observed
            },
            details: "Recorded current-session parent and fork fields; related session availability is unverified.".into(),
        });
        for (domain, details) in [
            (
                "tasks",
                "Task tool parts project assignments; Todo rows and task completion remain unported.",
            ),
            (
                "agentRuns",
                "Subagent tool parts do not establish an AgentRun in this foundation.",
            ),
            (
                "branches",
                "Fork metadata and boundaries are not yet projected into structured branches.",
            ),
            (
                "context",
                "Compaction records remain source events; context artifacts and transformations are unported.",
            ),
            (
                "work",
                "Task tool assignments are recorded; goals and task lifecycle remain unported.",
            ),
            (
                "execution",
                "Persisted tool states remain source observations; execution lifecycle projection is unported.",
            ),
            (
                "coordination",
                "Task tool dispatch projects recorded child links; actors and other coordination remain unported.",
            ),
            (
                "ownership",
                "Inherited fork rows follow Reader source selection; exclusive session ownership is not asserted.",
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
        if !observations.tasks.is_empty() {
            observations.coverage.insert(
                "tasks".into(),
                DomainCoverage {
                    state: ObservationState::Observed,
                    details: "Recorded task tool requests; task outcome remains unknown.".into(),
                },
            );
        }
        if !observations.coordination.is_empty() {
            observations.coverage.insert(
                "coordination".into(),
                DomainCoverage {
                    state: ObservationState::Observed,
                    details: "Recorded task tool requests and confirmed child dispatch links only."
                        .into(),
                },
            );
        }
        let usage_observed = !usage_records.is_empty();
        observations.usage_records = usage_records;
        observations.coverage.insert(
            "usage".into(),
            DomainCoverage {
                state: if usage_observed {
                    ObservationState::Observed
                } else {
                    ObservationState::NotObserved
                },
                details: "one request record per canonical assistant message with nonzero tokens"
                    .into(),
            },
        );
        finalize_protocol_bundle(stream, observations).map_err(CoreError::Protocol)
    }

    fn protocol_event_stream(&self, session_id: &str) -> Result<EventStream> {
        // Reader refs are an optional link to the same source revision, never the event source.
        let snapshot = self.load(session_id)?;
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
        let (db, schema) = self.open()?;
        let relationships = self.protocol_relationships(session_id)?;
        let session = SessionRef {
            provider: PROVIDER.into(),
            session_id: session_id.into(),
        };
        let mut candidates = Vec::new();
        if !relationships.is_empty() {
            let schema_id = if matches!(schema, Schema::V1) {
                "v1"
            } else {
                "v2"
            };
            let table = if matches!(schema, Schema::V1) {
                "session"
            } else {
                "session_v2"
            };
            candidates.push(EventCandidate {
                id: format!("event:opencode:{schema_id}:session:{session_id}"),
                session: session.clone(),
                source_order: SourceOrder {
                    record: 0,
                    ordinal: 0,
                },
                timestamp: snapshot.summary.created_at,
                category: "lifecycle".into(),
                kind: "session.metadata".into(),
                provenance: Provenance {
                    fidelity: Fidelity::Recorded,
                    source_type: format!("opencode.{table}"),
                    source_id: Some(session_id.into()),
                },
                reader_event: None,
                execution: None,
            });
        }
        match schema {
            Schema::V2 => {
                // seq is the native order. id breaks equal-seq ties deterministically.
                let mut statement = db.prepare("SELECT m.id, m.type, m.seq, m.time_created, m.data FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE m.session_id=?1 AND (s.fork_session_id IS NULL OR substr(m.id,-length(CAST(m.seq AS TEXT))-1) != '_' || m.seq) ORDER BY m.seq, m.id")
                    .map_err(|error| self.source_error(error))?;
                let rows = statement
                    .query_map([session_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    })
                    .map_err(|error| self.source_error(error))?;
                let mut previous_seq = None;
                let mut tie = 0u32;
                for row in rows {
                    let (id, native_type, seq, timestamp, data) =
                        row.map_err(|error| self.source_error(error))?;
                    if seq < 0 || !valid_native_type(&native_type) {
                        return Err(
                            self.source_error(format!("Invalid OpenCode v2 record identity: {id}"))
                        );
                    }
                    if previous_seq == Some(seq) {
                        tie = tie.checked_add(1).ok_or_else(|| {
                            self.source_error("OpenCode v2 source order overflow")
                        })?;
                    } else {
                        previous_seq = Some(seq);
                        tie = 0;
                    }
                    // A source row occupies one record position; tie-breaking keeps duplicate
                    // seq values distinct without claiming a chronology the DB did not record.
                    let record = seq as u64;
                    let base_ordinal = tie
                        .checked_mul(100_000)
                        .ok_or_else(|| self.source_error("OpenCode v2 source order overflow"))?;
                    let value: Value = serde_json::from_str(&data).map_err(|_| {
                        self.source_error(format!("Invalid OpenCode v2 record JSON: {id}"))
                    })?;
                    if !value.is_object() {
                        return Err(self.source_error(format!("Invalid OpenCode v2 record: {id}")));
                    }
                    let (category, kind, reader_segment) = match native_type.as_str() {
                        "user" => ("message", "message.user", Some("message")),
                        "assistant" => ("message", "message.assistant", None),
                        "compaction" => ("context", "context.compaction", Some("message")),
                        "system" | "synthetic" | "skill" => {
                            ("message", "message.system", Some("message"))
                        }
                        _ => ("lifecycle", "record", None),
                    };
                    let reader_event = reader_segment.and_then(|segment| {
                        reader_refs
                            .contains(&(id.as_str(), segment))
                            .then(|| open_code_event_ref(session_id, &id, segment))
                    });
                    candidates.push(EventCandidate {
                        id: format!("event:opencode:v2:{id}"),
                        session: session.clone(),
                        source_order: SourceOrder {
                            record,
                            ordinal: base_ordinal,
                        },
                        timestamp: Some(timestamp),
                        category: category.into(),
                        kind: kind.into(),
                        provenance: Provenance {
                            fidelity: Fidelity::Recorded,
                            source_type: format!("opencode.session_message.{native_type}"),
                            source_id: Some(id.clone()),
                        },
                        reader_event,
                        execution: None,
                    });
                    if native_type == "assistant" {
                        let content = value["content"].as_array().ok_or_else(|| {
                            self.source_error(format!(
                                "Invalid OpenCode v2 assistant content: {id}"
                            ))
                        })?;
                        for (index, part) in content.iter().enumerate() {
                            let part_ordinal = u32::try_from(index + 1).map_err(|_| {
                                self.source_error("OpenCode v2 content order overflow")
                            })?;
                            if part_ordinal >= 100_000 {
                                return Err(self.source_error("OpenCode v2 content order overflow"));
                            }
                            let part_type = part["type"]
                                .as_str()
                                .filter(|kind| valid_native_type(kind))
                                .ok_or_else(|| {
                                    self.source_error(format!(
                                        "Invalid OpenCode v2 content type: {id}:{index}"
                                    ))
                                })?;
                            let (category, kind, segment) = match part_type {
                                "text" => ("message", "message.assistant.text", Some("message")),
                                "reasoning" => ("reasoning", "reasoning", Some("thinking")),
                                "tool" => ("tool", self.protocol_tool_kind(part)?, Some("tool")),
                                _ => ("message", "content", None),
                            };
                            let part_id = format!("{id}:content:{index}");
                            let reader_event = segment.and_then(|segment| {
                                reader_refs
                                    .contains(&(part_id.as_str(), segment))
                                    .then(|| open_code_event_ref(session_id, &part_id, segment))
                            });
                            candidates.push(EventCandidate {
                                id: format!("event:opencode:v2:{id}:content:{index}"),
                                session: session.clone(),
                                source_order: SourceOrder {
                                    record,
                                    ordinal: base_ordinal.checked_add(part_ordinal).ok_or_else(
                                        || self.source_error("OpenCode v2 content order overflow"),
                                    )?,
                                },
                                timestamp: part["time"]["created"].as_i64().or(Some(timestamp)),
                                category: category.into(),
                                kind: kind.into(),
                                provenance: Provenance {
                                    fidelity: Fidelity::Recorded,
                                    source_type: format!(
                                        "opencode.session_message.content.{part_type}"
                                    ),
                                    source_id: Some(id.clone()),
                                },
                                reader_event,
                                execution: None,
                            });
                        }
                    }
                }
            }
            Schema::V1 => {
                let mut statement = db.prepare("SELECT m.id, m.data, m.time_created, p.id, p.data FROM message m LEFT JOIN part p ON p.message_id=m.id AND p.session_id=m.session_id WHERE m.session_id=?1 ORDER BY COALESCE(CAST(json_extract(m.data,'$.time.created') AS INTEGER),0), m.id, p.rowid, p.id")
                    .map_err(|error| self.source_error(error))?;
                let rows = statement
                    .query_map([session_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    })
                    .map_err(|error| self.source_error(error))?;
                let mut previous_message = None::<String>;
                let mut record = 0u64;
                for row in rows {
                    let (message_id, message_data, created, part_id, part_data) =
                        row.map_err(|error| self.source_error(error))?;
                    let message: Value = serde_json::from_str(&message_data).map_err(|_| {
                        self.source_error(format!("Invalid OpenCode v1 message JSON: {message_id}"))
                    })?;
                    if !message.is_object() {
                        return Err(
                            self.source_error(format!("Invalid OpenCode v1 message: {message_id}"))
                        );
                    }
                    let role = message["role"]
                        .as_str()
                        .filter(|role| valid_native_type(role))
                        .ok_or_else(|| {
                            self.source_error(format!(
                                "Invalid OpenCode v1 message role: {message_id}"
                            ))
                        })?;
                    let timestamp = message["time"]["created"].as_i64().or(Some(created));
                    if previous_message.as_deref() != Some(&message_id) {
                        previous_message = Some(message_id.clone());
                        candidates.push(EventCandidate {
                            id: format!("event:opencode:v1:message:{message_id}"),
                            session: session.clone(),
                            source_order: SourceOrder { record, ordinal: 0 },
                            timestamp,
                            category: "message".into(),
                            kind: format!("message.{role}"),
                            provenance: Provenance {
                                fidelity: Fidelity::Recorded,
                                source_type: format!("opencode.message.{role}"),
                                source_id: Some(message_id.clone()),
                            },
                            reader_event: None,
                            execution: None,
                        });
                    }
                    if let Some(part_id) = part_id {
                        let part: Value =
                            serde_json::from_str(part_data.as_deref().unwrap_or_default())
                                .map_err(|_| {
                                    self.source_error(format!(
                                        "Invalid OpenCode v1 part JSON: {part_id}"
                                    ))
                                })?;
                        let part_type = part["type"]
                            .as_str()
                            .filter(|kind| valid_native_type(kind))
                            .ok_or_else(|| {
                                self.source_error(format!(
                                    "Invalid OpenCode v1 part type: {part_id}"
                                ))
                            })?;
                        let (category, kind, segment) = match part_type {
                            "text" => ("message", "message.text", Some("message")),
                            "reasoning" => ("reasoning", "reasoning", Some("thinking")),
                            "tool" => ("tool", self.protocol_tool_kind(&part)?, Some("tool")),
                            _ => ("message", "part", None),
                        };
                        let reader_id = format!("{message_id}:{part_id}");
                        let reader_event = segment.and_then(|segment| {
                            reader_refs
                                .contains(&(reader_id.as_str(), segment))
                                .then(|| open_code_event_ref(session_id, &reader_id, segment))
                        });
                        candidates.push(EventCandidate {
                            id: format!("event:opencode:v1:part:{part_id}"),
                            session: session.clone(),
                            source_order: SourceOrder { record, ordinal: 1 },
                            timestamp,
                            category: category.into(),
                            kind: kind.into(),
                            provenance: Provenance {
                                fidelity: Fidelity::Recorded,
                                source_type: format!("opencode.part.{part_type}"),
                                source_id: Some(part_id),
                            },
                            reader_event,
                            execution: None,
                        });
                    }
                    record += 1;
                }
            }
        }
        drop(db);
        if self.revision()? != snapshot.revision {
            return Err(CoreError::SourceChanged);
        }
        if !relationships.is_empty()
            && candidates.iter().skip(1).any(|candidate| {
                candidate.source_order
                    == SourceOrder {
                        record: 0,
                        ordinal: 0,
                    }
            })
        {
            for candidate in candidates.iter_mut().skip(1) {
                candidate.source_order.record = candidate
                    .source_order
                    .record
                    .checked_add(1)
                    .ok_or_else(|| self.source_error("OpenCode source order overflow"))?;
            }
        }
        finalize_events(session, self.scope.into(), snapshot.revision, candidates)
            .map_err(CoreError::Protocol)
    }

    fn supports_index(&self) -> bool {
        true
    }

    fn inventory(&self) -> Result<Option<Vec<SourceEntry>>> {
        let signature = self.revision()?;
        let (db, schema) = self.open()?;
        let query = match schema {
            Schema::V1 => "SELECT id FROM session WHERE time_archived IS NULL ORDER BY id",
            Schema::V2 => "SELECT id FROM session_v2 WHERE time_archived IS NULL ORDER BY id",
        };
        let mut statement = db
            .prepare(query)
            .map_err(|error| self.source_error(error))?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| self.source_error(error))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|error| self.source_error(error))?;
        drop(statement);
        drop(db);
        if self.revision()? != signature {
            return Err(CoreError::SourceChanged);
        }
        Ok(Some(
            ids.into_iter()
                .map(|session_id| SourceEntry {
                    session_id,
                    path: self.path.to_path_buf(),
                    signature: signature.clone(),
                })
                .collect(),
        ))
    }

    fn capture(&self, entry: &SourceEntry) -> Result<SessionSnapshot> {
        self.load(&entry.session_id)
    }

    fn source_signature(&self, _entry: &SourceEntry) -> Result<String> {
        self.revision()
    }
}

fn open_code_usage_record(
    session_id: &str,
    message_id: &str,
    timestamp: Option<i64>,
    message: &Value,
    event_id: String,
) -> Option<UsageRecord> {
    let tokens = message.get("tokens")?.as_object()?;
    let token = |value: &Value| value.as_u64();
    let input = tokens.get("input").and_then(token);
    let output = tokens.get("output").and_then(token);
    let reasoning = tokens.get("reasoning").and_then(token);
    let cache_read = tokens.get("cache").and_then(|cache| token(&cache["read"]));
    let cache_write = tokens.get("cache").and_then(|cache| token(&cache["write"]));
    if input.unwrap_or(0) == 0
        && cache_read.unwrap_or(0) == 0
        && cache_write.unwrap_or(0) == 0
        && output.unwrap_or(0) == 0
        && reasoning.unwrap_or(0) == 0
    {
        return None;
    }
    let sum = input
        .unwrap_or(0)
        .checked_add(cache_read.unwrap_or(0))
        .and_then(|sum| sum.checked_add(cache_write.unwrap_or(0)))
        .and_then(|sum| sum.checked_add(output.unwrap_or(0)))
        .and_then(|sum| sum.checked_add(reasoning.unwrap_or(0)));
    let total = tokens
        .get("total")
        .and_then(token)
        .filter(|total| sum == Some(*total));
    let (model, model_provider) = open_code_model(message);
    Some(UsageRecord {
        id: format!("usage:{session_id}:message:{message_id}"),
        scope: "request",
        session_ref: SessionRef {
            provider: PROVIDER.into(),
            session_id: session_id.into(),
        },
        timestamp,
        model,
        model_provider,
        run_id: None,
        event_id: Some(event_id),
        turn_id: Some(message_id.into()),
        tokens: UsageTokenComponents {
            input,
            cache_read,
            cache_write,
            output,
            reasoning,
            total,
        },
        context_origin_slices: vec![],
        provenance: Provenance {
            fidelity: Fidelity::Recorded,
            source_type: "opencode.message.tokens".into(),
            source_id: Some(message_id.into()),
        },
    })
}

fn columns(db: &Connection, table: &str) -> std::result::Result<HashSet<String>, rusqlite::Error> {
    let mut statement = db.prepare(&format!("PRAGMA table_info({table})"))?;
    statement
        .query_map([], |row: &Row<'_>| row.get(1))?
        .collect()
}

fn valid_native_type(kind: &str) -> bool {
    !kind.is_empty()
        && kind.len() <= 64
        && kind
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn open_code_event_ref(session_id: &str, message_id: &str, segment: &str) -> EventRef {
    EventRef {
        provider: PROVIDER.into(),
        session_id: session_id.into(),
        message_id: message_id.into(),
        segment: segment.into(),
    }
}

fn json_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn content_text(value: &Value) -> String {
    value
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .map(|part| match part["type"].as_str() {
                    Some("text") => json_text(&part["text"]),
                    Some("file") => format!(
                        "[{}] {}",
                        part["name"]
                            .as_str()
                            .or(part["mime"].as_str())
                            .unwrap_or_default(),
                        part["uri"].as_str().unwrap_or_default()
                    ),
                    _ => part.to_string(),
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn push(
    events: &mut Vec<NormalizedEvent>,
    session_id: &str,
    message_id: &str,
    segment: &str,
    role: &str,
    timestamp: Option<i64>,
    body: String,
    tool_name: Option<String>,
    tool_input: Option<String>,
    tool_status: Option<String>,
    owner: Option<EventRef>,
) {
    let preview = if segment == "tool" {
        format!(
            "{}: {}",
            tool_name.as_deref().unwrap_or("tool"),
            bounded_preview(&body, 220)
        )
    } else {
        bounded_preview(&body, 240)
    };
    let event = EventRef {
        provider: PROVIDER.into(),
        session_id: session_id.into(),
        message_id: message_id.into(),
        segment: segment.into(),
    };
    events.push(NormalizedEvent {
        item: ReaderItem {
            ordinal: events.len(),
            owner: owner.clone(),
            event,
            role: role.into(),
            timestamp,
            preview,
            total_chars: body.encode_utf16().count(),
            tool_name,
            owner_message_id: owner.map(|ref_| ref_.message_id),
            presentation_phase: None,
            process_id: None,
            process_count: None,
            tool_metadata: None,
            reply_metadata: None,
            content_revisions: Default::default(),
        },
        body: if segment == "tool" {
            String::new()
        } else {
            body.clone()
        },
        tool_input: tool_input.unwrap_or_default(),
        tool_output: if segment == "tool" {
            body
        } else {
            String::new()
        },
        tool_status,
    });
}

#[cfg(test)]
mod empty_wal_revision_tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opencode.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT,
                directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
            INSERT INTO session VALUES ('one',NULL,'First','/owned',1,2,NULL);
            INSERT INTO session VALUES ('two',NULL,'Second','/owned',3,4,NULL);
            PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        drop(db);
        fs::write(path.with_file_name("opencode.db-wal"), []).unwrap();
        fs::write(path.with_file_name("opencode.db-shm"), []).unwrap();
        (directory, path)
    }

    #[test]
    fn empty_wal_short_shm_is_a_readable_catalog() {
        let (_directory, path) = fixture();
        let before = fs::read(&path).unwrap();
        let adapter = OpenCodeAdapter {
            path: &path,
            scope: "owned-wal-lifecycle",
        };
        let entries = adapter
            .inventory()
            .expect("An empty WAL must not require a 96-byte SHM header")
            .unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.session_id.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
        assert_eq!(adapter.list().unwrap().len(), 2);
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(
            fs::read(path.with_file_name("opencode.db-wal"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn empty_wal_reader_shm_lifecycle_keeps_revision() {
        let (_directory, path) = fixture();
        let adapter = OpenCodeAdapter {
            path: &path,
            scope: "owned-wal-lifecycle",
        };
        let revision = adapter
            .revision()
            .expect("Empty SHM is not a provider source error");
        // An empty WAL has no committed frames. SHM is a reader-owned index,
        // whose zero/partial/full header does not change these database rows.
        for size in [24, 95, 96, 32768, 0] {
            fs::write(
                path.with_file_name("opencode.db-shm"),
                vec![size as u8; size],
            )
            .unwrap();
            assert_eq!(adapter.revision().unwrap(), revision);
        }
    }

    #[test]
    fn nonempty_wal_commit_still_invalidates_revision() {
        let (_directory, path) = fixture();
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("UPDATE session SET title='Before commit' WHERE id='one';")
            .unwrap();
        let adapter = OpenCodeAdapter {
            path: &path,
            scope: "owned-wal-lifecycle",
        };
        let before = adapter.revision().unwrap();
        writer
            .execute_batch("UPDATE session SET title='After commit' WHERE id='one';")
            .unwrap();
        assert!(
            fs::metadata(path.with_file_name("opencode.db-wal"))
                .unwrap()
                .len()
                > 0
        );
        assert_ne!(adapter.revision().unwrap(), before);
        assert_eq!(
            adapter
                .list()
                .unwrap()
                .iter()
                .find(|row| row.session.session_id == "one")
                .unwrap()
                .title,
            "After commit"
        );
    }

    #[test]
    fn empty_wal_does_not_hide_truncated_database() {
        let (_directory, path) = fixture();
        fs::write(&path, b"SQLite format 3\0").unwrap();
        let adapter = OpenCodeAdapter {
            path: &path,
            scope: "owned-wal-lifecycle",
        };
        assert!(matches!(adapter.revision(), Err(CoreError::Parse { .. })));
    }
}

fn open_code_model(message: &Value) -> (Option<String>, Option<String>) {
    let model = message["modelID"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            message["model"]["id"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
        })
        .map(str::to_owned);
    let model_provider = message["providerID"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            message["model"]["providerID"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
        })
        .map(str::to_owned);
    (model, model_provider)
}

fn open_code_reply_metadata(
    session_id: &str,
    message_id: &str,
    timestamp: Option<i64>,
    message: &Value,
    schema: Schema,
    primary: bool,
) -> Option<crate::ReaderReplyMetadata> {
    let (model, model_provider) = open_code_model(message);
    let event_id = match schema {
        Schema::V1 => format!("event:opencode:v1:message:{message_id}"),
        Schema::V2 => format!("event:opencode:v2:{message_id}"),
    };
    let usage = primary
        .then(|| open_code_usage_record(session_id, message_id, timestamp, message, event_id))
        .flatten();
    super::reply_metadata(
        model,
        model_provider,
        Provenance {
            fidelity: Fidelity::Recorded,
            source_type: match schema {
                Schema::V1 => "opencode.message.model",
                Schema::V2 => "opencode.session_message.assistant.model",
            }
            .into(),
            source_id: Some(message_id.into()),
        },
        usage.as_ref(),
    )
}
