//! Rebuildable, scope-isolated Reader projection. A source probe precedes each
//! lookup; published rows are visible only after one SQLite transaction.
use crate::providers::SessionSnapshot;
use crate::{
    ContentPage, ContentQuery, Core, CoreError, EventRef, ReaderBootstrap, ReaderChildLocation,
    ReaderChildPlacement, ReaderCursor, ReaderItem, ReaderLocateQuery, ReaderLocation,
    ReaderPageResponse, ReaderRelationsPage, ReaderSearchCursor, ReaderSearchMatch,
    ReaderSearchPage, ReaderSegment, ReaderTocEntry, ReaderTocPage, ReaderTocResponse,
    RelationEntry, RelationSummary, Result, SessionRef, SessionSummary,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::time::Duration;

const PROJECTION: i64 = 7;
const SCHEMA_VERSION: i64 = 1;
const CHUNK_UNITS: usize = 4096;

pub(crate) fn project_process_items(
    snapshot: &SessionSnapshot,
    boundaries: &HashSet<EventRef>,
) -> Vec<ReaderItem> {
    let owned_work: HashSet<&EventRef> = snapshot
        .events
        .iter()
        .filter(|entry| matches!(entry.item.event.segment.as_str(), "thinking" | "tool"))
        .filter_map(|entry| entry.item.owner.as_ref())
        .collect();
    let work_only_messages: HashSet<&EventRef> = snapshot
        .events
        .iter()
        .filter(|entry| {
            entry.item.role == "assistant"
                && entry.item.event.segment == "message"
                && entry.body.is_empty()
                && owned_work.contains(&entry.item.event)
        })
        .map(|entry| &entry.item.event)
        .collect();
    let mut later_final = vec![false; snapshot.events.len()];
    let mut final_in_turn = false;
    for (index, entry) in snapshot.events.iter().enumerate().rev() {
        let item = &entry.item;
        if matches!(item.role.as_str(), "user" | "agent") || item.event.segment == "context" {
            final_in_turn = false;
        }
        later_final[index] = final_in_turn;
        if item.presentation_phase.as_deref() == Some("final_answer") {
            final_in_turn = true;
        }
    }
    let mut process = None;
    let mut items: Vec<ReaderItem> = snapshot
        .events
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let mut item = entry.item.clone();
            let eligible = if boundaries.contains(&item.event) {
                false
            } else {
                match item.event.segment.as_str() {
                    "tool" => !matches!(entry.tool_status.as_deref(), Some("error" | "failed")),
                    "message" => {
                        work_only_messages.contains(&item.event)
                            || (item.presentation_phase.as_deref() == Some("commentary")
                                && later_final[index])
                    }
                    "thinking" => {
                        later_final[index]
                            || item
                                .owner
                                .as_ref()
                                .is_some_and(|owner| work_only_messages.contains(owner))
                    }
                    _ => false,
                }
            };
            if eligible {
                let id = *process.get_or_insert(item.ordinal);
                item.process_id = Some(id);
            } else {
                process = None;
            }
            item
        })
        .collect();
    let mut counts = HashMap::new();
    for item in &items {
        if let Some(id) = item.process_id {
            *counts.entry(id).or_insert(0usize) += 1;
        }
    }
    for item in &mut items {
        item.process_count = item.process_id.map(|id| counts[&id]);
    }
    items
}

fn search_fields(segment: &str) -> &'static [&'static str] {
    match segment {
        "message" | "thinking" | "context" => &["body"],
        "tool" => &["toolInput", "toolOutput"],
        _ => &[],
    }
}

struct SearchWindow {
    text: String,
    lower_base: usize,
    units_base: usize,
    next_lower: usize,
}

impl SearchWindow {
    fn new(next_lower: usize) -> Self {
        Self {
            text: String::new(),
            lower_base: 0,
            units_base: 0,
            next_lower,
        }
    }

    fn scan(
        &mut self,
        final_chunk: bool,
        needle: &str,
        item: &ReaderItem,
        field: &'static str,
        total_chars: usize,
        limit: usize,
        matches: &mut Vec<ReaderSearchMatch>,
    ) -> Result<Option<usize>> {
        // Keep enough source characters for a match spanning the next chunk and
        // the 96-unit excerpt after it. The window stays independent of field size.
        let retain = needle.chars().count() + 96;
        let safe_byte = if final_chunk {
            self.text.len()
        } else {
            self.text
                .char_indices()
                .rev()
                .nth(retain.saturating_sub(1))
                .map_or(0, |(byte, _)| byte)
        };
        let lower = self.text.to_lowercase();
        let safe_lower = self.text[..safe_byte].to_lowercase().len();
        let from = self.next_lower.saturating_sub(self.lower_base);
        if final_chunk && (from > lower.len() || !lower.is_char_boundary(from)) {
            return Err(CoreError::InvalidCursor);
        }
        if from <= lower.len() {
            if !lower.is_char_boundary(from) {
                return Err(CoreError::InvalidCursor);
            }
            let mut position = from;
            while let Some(relative) = lower[position..].find(needle) {
                let start = position + relative;
                if start >= safe_lower {
                    break;
                }
                let end = start + needle.len();
                if matches.len() == limit {
                    return Ok(Some(self.lower_base + start));
                }
                let span = crate::reader_search_original_spans(&self.text, &[(start, end)])?
                    .into_iter()
                    .next()
                    .expect("one search span");
                let (offset, match_length, start_byte, end_byte) = span;
                let (excerpt_start, excerpt) =
                    crate::reader_search_excerpt(&self.text, start_byte, end_byte, offset);
                matches.push(ReaderSearchMatch {
                    event: item.event.clone(),
                    owner: item.owner.clone(),
                    ordinal: item.ordinal,
                    field,
                    offset: self.units_base + offset,
                    match_length,
                    excerpt,
                    excerpt_start: self.units_base + excerpt_start,
                    total_chars,
                });
                position = end;
                self.next_lower = self.lower_base + end;
            }
        }
        if !final_chunk && safe_byte > 0 {
            let mut keep_units = 0;
            let mut trim_byte = safe_byte;
            for (byte, ch) in self.text[..safe_byte].char_indices().rev() {
                if keep_units + ch.len_utf16() > 96 {
                    break;
                }
                trim_byte = byte;
                keep_units += ch.len_utf16();
            }
            let removed = &self.text[..trim_byte];
            self.lower_base += removed.to_lowercase().len();
            self.units_base += removed.encode_utf16().count();
            self.next_lower = self.next_lower.max(self.lower_base);
            self.text.replace_range(..trim_byte, "");
        }
        Ok(None)
    }
}

fn storage(error: impl std::fmt::Display) -> CoreError {
    CoreError::Storage(error.to_string())
}

fn cache_lock(path: std::path::PathBuf) -> Result<std::fs::File> {
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .open(&path)
        .map_err(|source| CoreError::Io { path, source })?;
    file.lock().map_err(storage)?;
    Ok(file)
}

fn encode(value: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string(value).map_err(storage)
}

fn decode<T: DeserializeOwned>(value: String) -> Result<T> {
    serde_json::from_str(&value).map_err(storage)
}

fn placement_pages(
    core: &Core,
    snapshot: &SessionSnapshot,
    captured_stream: Option<&Option<crate::protocol::EventStream>>,
) -> Vec<Vec<ReaderChildPlacement>> {
    let mut pages = Vec::new();
    let mut exact = Vec::new();
    let mut parents: HashMap<SessionRef, Option<Option<SessionRef>>> = HashMap::new();
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for entry in &snapshot.relations {
        let RelationEntry::Coordination { observation } = entry else {
            continue;
        };
        if observation.from_session_ref.as_ref() != Some(&snapshot.summary.session)
            || !matches!(observation.state.as_str(), "requested" | "started")
        {
            continue;
        }
        let Some(child) = observation.to_session_ref.as_ref() else {
            continue;
        };
        if child == &snapshot.summary.session {
            continue;
        }
        let ids = children.entry(child.provider.clone()).or_default();
        if !ids.contains(&child.session_id) {
            ids.push(child.session_id.clone());
        }
    }
    for (provider, ids) in children {
        let facts = crate::providers::adapter(&core.config, &core.source_scope, &provider)
            .map(|adapter| adapter.reader_parent_facts(&ids));
        for id in ids {
            let fact = facts
                .as_ref()
                .ok()
                .and_then(|facts| facts.get(&id))
                .cloned()
                .flatten();
            parents.insert(
                SessionRef {
                    provider: provider.clone(),
                    session_id: id,
                },
                fact,
            );
        }
    }
    for entries in snapshot.relations.chunks(32) {
        let mut placements = Vec::new();
        let mut page_exact = HashMap::new();
        for entry in entries {
            let RelationEntry::Coordination { observation } = entry else {
                continue;
            };
            if let Some(reference) = &observation.reader_event {
                page_exact.insert(observation.event_id.clone(), reference.clone());
            }
            if observation.from_session_ref.as_ref() != Some(&snapshot.summary.session)
                || !matches!(observation.state.as_str(), "requested" | "started")
            {
                continue;
            }
            let Some(child) = observation.to_session_ref.as_ref() else {
                continue;
            };
            if child == &snapshot.summary.session
                || placements
                    .iter()
                    .any(|placement: &ReaderChildPlacement| placement.child == *child)
            {
                continue;
            }
            let parent = parents.get(child).cloned().flatten();
            let Some(parent) = parent else {
                placements.push(ReaderChildPlacement {
                    child: child.clone(),
                    after_event: None,
                    source_event_id: observation.event_id.clone(),
                    diagnostic: Some("child_parent_unverified".into()),
                });
                continue;
            };
            if parent.as_ref() != Some(&snapshot.summary.session) {
                continue;
            }
            placements.push(ReaderChildPlacement {
                child: child.clone(),
                after_event: None,
                source_event_id: observation.event_id.clone(),
                diagnostic: Some("source_anchor_unavailable".into()),
            });
        }
        pages.push(placements);
        exact.push(page_exact);
    }
    if pages.iter().all(Vec::is_empty) {
        return pages;
    }
    let loaded_stream = if captured_stream.is_none() {
        core.protocol_event_stream(
            &snapshot.summary.session.provider,
            &snapshot.summary.session.session_id,
        )
        .ok()
    } else {
        None
    };
    let Some(stream) = captured_stream
        .and_then(Option::as_ref)
        .or(loaded_stream.as_ref())
    else {
        return pages;
    };
    if stream.revision() != snapshot.revision {
        return pages;
    }
    let reader_anchors: HashMap<EventRef, EventRef> = snapshot
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
    let mut targets: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    for (page_index, placements) in pages.iter().enumerate() {
        for (index, placement) in placements.iter().enumerate() {
            if placement.diagnostic.as_deref() != Some("child_parent_unverified") {
                targets
                    .entry(placement.source_event_id.clone())
                    .or_default()
                    .push((page_index, index));
            }
        }
    }
    let mut last_reader: Option<EventRef> = None;
    let mut cursor = None;
    loop {
        let Ok(page) = stream.events(crate::protocol::EventQuery {
            limit: 200,
            cursor,
            ..Default::default()
        }) else {
            break;
        };
        for event in page.events {
            if let Some(locations) = targets.remove(&event.id) {
                for (page_index, index) in locations {
                    let placement = &mut pages[page_index][index];
                    let anchor = if let Some(reference) =
                        exact[page_index].get(&placement.source_event_id)
                    {
                        (event.reader_event.as_ref() == Some(reference)
                            && reader_anchors.contains_key(reference))
                        .then(|| reference.clone())
                    } else {
                        last_reader.clone()
                    };
                    if let Some(anchor) = anchor {
                        placement.after_event = Some(anchor);
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
    pages
}

pub(crate) struct ReaderModel {
    db: Connection,
    scope: String,
    summary: SessionSummary,
    revision: String,
    dependencies: String,
    item_count: usize,
    relation_count: usize,
    task_count: usize,
}

impl ReaderModel {
    pub(crate) fn open(core: &Core, provider: &str, session_id: &str) -> Result<Option<Self>> {
        let adapter = crate::providers::adapter(&core.config, &core.source_scope, provider)?;
        if !adapter.available() {
            return Err(CoreError::Unavailable(provider.into()));
        }
        let Some(stamp) = adapter.reader_revision(session_id)? else {
            return Ok(None);
        };
        let revision = &stamp.revision;
        fs::create_dir_all(&core.config.cache_dir).map_err(|source| CoreError::Io {
            path: core.config.cache_dir.clone(),
            source,
        })?;
        // WAL/schema initialization must be serialized across processes, but
        // hot readers should not wait behind a cold session publication.
        let schema_lock = cache_lock(
            core.config
                .cache_dir
                .join(format!("reader-{}.schema.lock", core.source_scope)),
        )?;
        let db_path = core
            .config
            .cache_dir
            .join(format!("reader-{}.sqlite", core.source_scope));
        let mut db = Connection::open(db_path).map_err(storage)?;
        db.busy_timeout(Duration::from_secs(30)).map_err(storage)?;
        let schema_version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(storage)?;
        if schema_version > SCHEMA_VERSION {
            return Err(CoreError::Storage(
                "Reader cache schema is newer than this binary".into(),
            ));
        }
        if schema_version < SCHEMA_VERSION {
            db.pragma_update(None, "journal_mode", "WAL")
                .map_err(storage)?;
            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS reader_session (
                provider TEXT NOT NULL, session_id TEXT NOT NULL,
                projection INTEGER NOT NULL, revision TEXT NOT NULL,
                dependencies TEXT NOT NULL,
                summary_json TEXT NOT NULL, item_count INTEGER NOT NULL,
                relation_count INTEGER NOT NULL, task_count INTEGER NOT NULL,
                PRIMARY KEY(provider, session_id)
            );
            CREATE TABLE IF NOT EXISTS reader_item (
                provider TEXT NOT NULL, session_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL, message_id TEXT NOT NULL, segment TEXT NOT NULL,
                item_json TEXT NOT NULL,
                PRIMARY KEY(provider, session_id, ordinal)
            );
            CREATE INDEX IF NOT EXISTS reader_item_ref ON reader_item
                (provider, session_id, message_id, segment, ordinal);
            CREATE TABLE IF NOT EXISTS reader_relation (
                provider TEXT NOT NULL, session_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL, entry_json TEXT NOT NULL,
                PRIMARY KEY(provider, session_id, ordinal)
            );
            CREATE TABLE IF NOT EXISTS reader_placement (
                provider TEXT NOT NULL, session_id TEXT NOT NULL,
                page_start INTEGER NOT NULL, placement_json TEXT NOT NULL,
                PRIMARY KEY(provider, session_id, page_start)
            );
            CREATE TABLE IF NOT EXISTS reader_content (
                provider TEXT NOT NULL, session_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL, field TEXT NOT NULL,
                chunk_index INTEGER NOT NULL, start_units INTEGER NOT NULL,
                total_units INTEGER NOT NULL, text TEXT NOT NULL,
                PRIMARY KEY(provider, session_id, ordinal, field, chunk_index)
            );
            CREATE INDEX IF NOT EXISTS reader_content_offset ON reader_content
                (provider, session_id, ordinal, field, start_units);",
            )
            .map_err(storage)?;
            db.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(storage)?;
        }
        drop(schema_lock);
        if !Self::published(&db, provider, session_id, &stamp)? {
            let publication_lock = cache_lock(
                core.config
                    .cache_dir
                    .join(format!("reader-{}.lock", core.source_scope)),
            )?;
            if !Self::published(&db, provider, session_id, &stamp)? {
                let capture = adapter.reader_capture(session_id)?;
                if capture.snapshot.revision != *revision {
                    return Err(CoreError::SourceChanged);
                }
                Self::publish(core, &mut db, &capture, adapter.as_ref(), &stamp)?;
            }
            drop(publication_lock);
        }
        // Keep one WAL snapshot from generation validation through the final
        // page query. A concurrent publisher cannot mix new rows with this
        // request's revision and summary.
        db.execute_batch("BEGIN DEFERRED TRANSACTION")
            .map_err(storage)?;
        let (stored_revision, stored_dependencies, summary, item_count, relation_count, task_count): (String, String, String, i64, i64, i64) = db.query_row(
            "SELECT revision, dependencies, summary_json, item_count, relation_count, task_count
             FROM reader_session WHERE provider=?1 AND session_id=?2 AND projection=?3",
            params![provider, session_id, PROJECTION],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).map_err(storage)?;
        if stored_revision != *revision || stored_dependencies != stamp.dependencies {
            return Err(CoreError::SourceChanged);
        }
        Ok(Some(Self {
            db,
            scope: core.source_scope.clone(),
            summary: decode(summary)?,
            revision: revision.clone(),
            dependencies: stamp.dependencies,
            item_count: item_count as usize,
            relation_count: relation_count as usize,
            task_count: task_count as usize,
        }))
    }

    fn published(
        db: &Connection,
        provider: &str,
        session_id: &str,
        stamp: &crate::providers::ReaderStamp,
    ) -> Result<bool> {
        let found: Option<(String, String)> = db.query_row(
            "SELECT revision, dependencies FROM reader_session WHERE provider=?1 AND session_id=?2 AND projection=?3",
            params![provider, session_id, PROJECTION], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(storage)?;
        Ok(found.as_ref().is_some_and(|(revision, dependencies)| {
            revision == &stamp.revision && dependencies == &stamp.dependencies
        }))
    }

    fn publish(
        core: &Core,
        db: &mut Connection,
        capture: &crate::providers::ReaderCapture,
        adapter: &dyn crate::providers::ProviderAdapter,
        stamp: &crate::providers::ReaderStamp,
    ) -> Result<()> {
        let snapshot = &capture.snapshot;
        let provider = &snapshot.summary.session.provider;
        let session_id = &snapshot.summary.session.session_id;
        // Placement resolution is a cold-generation operation. Existing rules
        // verify the child's canonical parent and preserve source anchors.
        let placements = placement_pages(core, snapshot, capture.protocol_stream.as_ref());
        let mut boundaries = HashSet::new();
        for relation in &snapshot.relations {
            let RelationEntry::Coordination { observation } = relation else {
                continue;
            };
            if (observation.kind == "spawn"
                || observation.kind == "result"
                || observation.state == "completed")
                && let Some(reference) = &observation.reader_event
            {
                boundaries.insert(reference.clone());
            }
        }
        if let Some(Some(stream)) = capture.protocol_stream.as_ref() {
            boundaries.extend(stream.execution_boundary_refs());
        }
        let projected_items = project_process_items(snapshot, &boundaries);
        if adapter.reader_revision(session_id)?.as_ref() != Some(stamp) {
            return Err(CoreError::SourceChanged);
        }
        let tx = db.transaction().map_err(storage)?;
        for table in [
            "reader_session",
            "reader_item",
            "reader_relation",
            "reader_placement",
            "reader_content",
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE provider=?1 AND session_id=?2"),
                params![provider, session_id],
            )
            .map_err(storage)?;
        }
        {
            let mut item_insert = tx
                .prepare("INSERT INTO reader_item VALUES (?1,?2,?3,?4,?5,?6)")
                .map_err(storage)?;
            let mut content_insert = tx
                .prepare("INSERT INTO reader_content VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")
                .map_err(storage)?;
            for (ordinal, event) in snapshot.events.iter().enumerate() {
                item_insert
                    .execute(params![
                        provider,
                        session_id,
                        ordinal as i64,
                        &event.item.event.message_id,
                        &event.item.event.segment,
                        encode(&projected_items[ordinal])?
                    ])
                    .map_err(storage)?;
                let fields: &[(&str, &str)] = match event.item.event.segment.as_str() {
                    "tool" => &[
                        ("toolInput", &event.tool_input),
                        ("toolOutput", &event.tool_output),
                    ],
                    _ => &[("body", &event.body)],
                };
                for (field, content) in fields {
                    Self::store_content(
                        &mut content_insert,
                        provider,
                        session_id,
                        ordinal,
                        field,
                        content,
                    )?;
                }
            }
        }
        {
            let mut relation_insert = tx
                .prepare("INSERT INTO reader_relation VALUES (?1,?2,?3,?4)")
                .map_err(storage)?;
            for (ordinal, entry) in snapshot.relations.iter().enumerate() {
                relation_insert
                    .execute(params![
                        provider,
                        session_id,
                        ordinal as i64,
                        encode(entry)?
                    ])
                    .map_err(storage)?;
            }
        }
        {
            let mut placement_insert = tx
                .prepare("INSERT INTO reader_placement VALUES (?1,?2,?3,?4)")
                .map_err(storage)?;
            for (page, rows) in placements.iter().enumerate() {
                placement_insert
                    .execute(params![
                        provider,
                        session_id,
                        (page * 32) as i64,
                        encode(rows)?
                    ])
                    .map_err(storage)?;
            }
        }
        let task_count = snapshot
            .relations
            .iter()
            .filter(|entry| matches!(entry, RelationEntry::Task { .. }))
            .count();
        tx.execute(
            "INSERT INTO reader_session VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                provider,
                session_id,
                PROJECTION,
                &snapshot.revision,
                &stamp.dependencies,
                encode(&snapshot.summary)?,
                snapshot.events.len() as i64,
                snapshot.relations.len() as i64,
                task_count as i64
            ],
        )
        .map_err(storage)?;
        tx.commit().map_err(storage)
    }

    fn store_content(
        insert: &mut rusqlite::Statement<'_>,
        provider: &str,
        session_id: &str,
        ordinal: usize,
        field: &str,
        content: &str,
    ) -> Result<()> {
        let total = content.encode_utf16().count();
        let mut start_byte = 0;
        let mut start_units = 0;
        let mut chunk_index = 0;
        let mut chunk_units = 0;
        for (byte, ch) in content.char_indices() {
            if chunk_units + ch.len_utf16() > CHUNK_UNITS && byte > start_byte {
                let text = &content[start_byte..byte];
                insert
                    .execute(params![
                        provider,
                        session_id,
                        ordinal as i64,
                        field,
                        chunk_index,
                        start_units as i64,
                        total as i64,
                        text
                    ])
                    .map_err(storage)?;
                start_units += chunk_units;
                start_byte = byte;
                chunk_index += 1;
                chunk_units = 0;
            }
            chunk_units += ch.len_utf16();
        }
        insert
            .execute(params![
                provider,
                session_id,
                ordinal as i64,
                field,
                chunk_index,
                start_units as i64,
                total as i64,
                &content[start_byte..]
            ])
            .map_err(storage)?;
        Ok(())
    }

    fn reference(&self) -> SessionRef {
        self.summary.session.clone()
    }
    fn cursor(&self, kind: &str, position: usize) -> String {
        serde_json::to_string(&ReaderCursor {
            version: 1,
            kind: kind.into(),
            scope: self.scope.clone(),
            session: self.reference(),
            revision: self.revision.clone(),
            dependency: Some(self.dependencies.clone()),
            projection: 1,
            position,
        })
        .expect("Reader cursor serialization")
    }
    pub(crate) fn check_cursor(
        &self,
        provider: &str,
        session_id: &str,
        kind: &str,
        token: &str,
    ) -> Result<usize> {
        if token.len() > 4096 {
            return Err(CoreError::InvalidCursor);
        }
        let cursor: ReaderCursor =
            serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
        if cursor.version != 1
            || cursor.projection != 1
            || cursor.kind != kind
            || cursor.scope != self.scope
            || cursor.session.provider != provider
            || cursor.session.session_id != session_id
        {
            return Err(CoreError::InvalidCursor);
        }
        if cursor.revision != self.revision
            || cursor.dependency.as_deref() != Some(&self.dependencies)
        {
            return Err(CoreError::SourceChanged);
        }
        Ok(cursor.position)
    }
    fn items(&self, start: usize, size: usize) -> Result<Vec<ReaderItem>> {
        let mut stmt = self.db.prepare(
            "SELECT item_json FROM reader_item WHERE provider=?1 AND session_id=?2 AND ordinal>=?3 ORDER BY ordinal LIMIT ?4"
        ).map_err(storage)?;
        let rows = stmt
            .query_map(
                params![
                    self.summary.session.provider,
                    self.summary.session.session_id,
                    start as i64,
                    size as i64
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(storage)?;
        rows.map(|row| decode(row.map_err(storage)?)).collect()
    }
    fn item_by_ref(&self, message_id: &str, segment: &str) -> Result<Option<ReaderItem>> {
        let encoded: Option<String> = self.db.query_row(
            "SELECT item_json FROM reader_item WHERE provider=?1 AND session_id=?2 AND message_id=?3 AND segment=?4 ORDER BY ordinal LIMIT 1",
            params![self.summary.session.provider, self.summary.session.session_id, message_id, segment], |row| row.get(0)
        ).optional().map_err(storage)?;
        encoded.map(decode).transpose()
    }
    fn item_at(&self, ordinal: usize) -> Result<Option<ReaderItem>> {
        let encoded: Option<String> = self.db.query_row(
            "SELECT item_json FROM reader_item WHERE provider=?1 AND session_id=?2 AND ordinal=?3",
            params![self.summary.session.provider, self.summary.session.session_id, ordinal as i64], |row| row.get(0)
        ).optional().map_err(storage)?;
        encoded.map(decode).transpose()
    }
    fn reader_page(&self, start: usize) -> Result<ReaderSegment> {
        let items = self.items(start, 32)?;
        let end = start + items.len();
        let owner_context = match items.first().and_then(|item| item.owner.as_ref()) {
            Some(owner) => self
                .item_by_ref(&owner.message_id, &owner.segment)?
                .filter(|item| item.ordinal < start),
            None => None,
        };
        Ok(ReaderSegment {
            id: format!("page-{start}"),
            page_id: format!("page-{start}"),
            start_ordinal: start,
            items,
            owner_context,
            previous_cursor: (start > 0).then(|| self.cursor("segments", start.saturating_sub(32))),
            next_cursor: (end < self.item_count).then(|| self.cursor("segments", end)),
        })
    }
    fn toc_page(&self, start: usize) -> Result<ReaderTocPage> {
        let items = self.items(start, 64)?;
        let end = start + items.len();
        Ok(ReaderTocPage {
            entries: items
                .into_iter()
                .map(|item| ReaderTocEntry {
                    process_id: item.process_id,
                    process_count: item.process_count,
                    event: item.event,
                    ordinal: item.ordinal,
                    owner: item.owner,
                    role: item.role,
                    label: item.preview.chars().take(80).collect(),
                })
                .collect(),
            previous_cursor: (start > 0).then(|| self.cursor("toc", start.saturating_sub(64))),
            next_cursor: (end < self.item_count).then(|| self.cursor("toc", end)),
        })
    }
    pub(crate) fn bootstrap(&self) -> Result<ReaderBootstrap> {
        Ok(ReaderBootstrap {
            session: self.summary.clone(),
            revision: self.revision.clone(),
            segments: vec![self.reader_page(0)?],
            total_items: self.item_count,
            toc: self.toc_page(0)?,
            relations: RelationSummary {
                task_count: self.task_count,
                observation_count: self.relation_count - self.task_count,
                first_cursor: (self.relation_count > 0).then(|| self.cursor("relations", 0)),
            },
            target_location: None,
            opening_toc: None,
        })
    }
    pub(crate) fn bootstrap_at(
        &self,
        query: crate::ReaderBootstrapQuery,
    ) -> Result<ReaderBootstrap> {
        let mut bootstrap = self.bootstrap()?;
        if let Some(query) = query.location_query(&self.revision) {
            let location = self.locate(query)?;
            let page_start = location.ordinal / 32 * 32;
            let toc_start = location.ordinal / 64 * 64;
            if page_start > 0 {
                bootstrap.segments.push(self.reader_page(page_start)?);
            }
            if toc_start > 0 {
                bootstrap.opening_toc = Some(std::mem::replace(
                    &mut bootstrap.toc,
                    self.toc_page(toc_start)?,
                ));
            }
            bootstrap.target_location = Some(location);
        }
        Ok(bootstrap)
    }
    pub(crate) fn child_location(
        &self,
        revision: &str,
        child: &SessionRef,
    ) -> Result<ReaderChildLocation> {
        if revision != self.revision {
            return Err(CoreError::SourceChanged);
        }
        // Placements were parent-verified when this generation was published.
        // Scan small cached pages once, retaining the UI's first-placement rule;
        // no provider reread is needed for each preceding relation page.
        let mut stmt = self.db.prepare(
            "SELECT placement_json FROM reader_placement WHERE provider=?1 AND session_id=?2 ORDER BY page_start"
        ).map_err(storage)?;
        let rows = stmt
            .query_map(
                params![
                    self.summary.session.provider,
                    self.summary.session.session_id
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(storage)?;
        let mut placement = None;
        for row in rows {
            placement = decode::<Vec<ReaderChildPlacement>>(row.map_err(storage)?)?
                .into_iter()
                .find(|placement| &placement.child == child);
            if placement.is_some() {
                break;
            }
        }
        let location = placement
            .as_ref()
            .and_then(|row| row.after_event.as_ref())
            .map(|event| {
                self.locate(ReaderLocateQuery {
                    revision: revision.into(),
                    message_id: Some(event.message_id.clone()),
                    segment: Some(event.segment.clone()),
                    edge: None,
                })
            })
            .transpose()?;
        let diagnostic = placement.as_ref().map_or_else(
            || Some("child_placement_unavailable".into()),
            |row| row.diagnostic.clone(),
        );
        Ok(ReaderChildLocation {
            session: self.reference(),
            revision: self.revision.clone(),
            placement,
            location,
            diagnostic,
        })
    }

    pub(crate) fn relations(&self, start: usize) -> Result<ReaderRelationsPage> {
        if start % 32 != 0 || start >= self.relation_count {
            return Err(CoreError::InvalidCursor);
        }
        let mut stmt = self.db.prepare(
            "SELECT entry_json FROM reader_relation WHERE provider=?1 AND session_id=?2 AND ordinal>=?3 ORDER BY ordinal LIMIT 32"
        ).map_err(storage)?;
        let rows = stmt
            .query_map(
                params![
                    self.summary.session.provider,
                    self.summary.session.session_id,
                    start as i64
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(storage)?;
        let entries: Vec<RelationEntry> = rows
            .map(|row| decode(row.map_err(storage)?))
            .collect::<Result<_>>()?;
        let placement: Option<String> = self.db.query_row(
            "SELECT placement_json FROM reader_placement WHERE provider=?1 AND session_id=?2 AND page_start=?3",
            params![self.summary.session.provider, self.summary.session.session_id, start as i64], |row| row.get(0)
        ).optional().map_err(storage)?;
        let end = start + entries.len();
        Ok(ReaderRelationsPage {
            session: self.reference(),
            revision: self.revision.clone(),
            entries,
            child_placements: placement
                .map(decode::<Vec<ReaderChildPlacement>>)
                .transpose()?
                .unwrap_or_default(),
            next_cursor: (end < self.relation_count).then(|| self.cursor("relations", end)),
        })
    }
    pub(crate) fn segments(&self, start: usize) -> Result<ReaderPageResponse> {
        if start % 32 != 0 || start >= self.item_count.max(1) {
            return Err(CoreError::InvalidCursor);
        }
        Ok(ReaderPageResponse {
            session: self.reference(),
            revision: self.revision.clone(),
            page: self.reader_page(start)?,
        })
    }
    pub(crate) fn toc(&self, start: usize) -> Result<ReaderTocResponse> {
        if start % 64 != 0 || start >= self.item_count.max(1) {
            return Err(CoreError::InvalidCursor);
        }
        Ok(ReaderTocResponse {
            session: self.reference(),
            revision: self.revision.clone(),
            toc: self.toc_page(start)?,
        })
    }
    pub(crate) fn locate(&self, query: ReaderLocateQuery) -> Result<ReaderLocation> {
        if query.revision != self.revision {
            return Err(CoreError::SourceChanged);
        }
        let item = match (
            query.edge.as_deref(),
            query.message_id.as_deref(),
            query.segment.as_deref(),
        ) {
            (Some("end"), None, None) => self
                .item_count
                .checked_sub(1)
                .map(|at| self.item_at(at))
                .transpose()?
                .flatten(),
            (None, Some(message_id), Some(segment)) => self.item_by_ref(message_id, segment)?,
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
            session: self.reference(),
            revision: self.revision.clone(),
            event: item.event,
            ordinal: item.ordinal,
            owner: item.owner,
            page_cursor: self.cursor("segments", item.ordinal / 32 * 32),
            toc_cursor: self.cursor("toc", item.ordinal / 64 * 64),
        })
    }

    pub(crate) fn search(
        &self,
        needle: &str,
        revision: &str,
        limit: usize,
        token: Option<&str>,
    ) -> Result<ReaderSearchPage> {
        if revision != self.revision {
            return Err(CoreError::SourceChanged);
        }
        let (start_event, start_field, start_offset) = if let Some(token) = token {
            if token.len() > 8192 {
                return Err(CoreError::InvalidCursor);
            }
            let cursor: ReaderSearchCursor =
                serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
            if cursor.version != 2
                || cursor.kind != "reader.search"
                || cursor.scope != self.scope
                || cursor.session != self.reference()
                || cursor.query != needle
                || cursor.event_index >= self.item_count
                || cursor.field_index
                    >= self
                        .item_at(cursor.event_index)?
                        .as_ref()
                        .map_or(0, |item| search_fields(&item.event.segment).len())
            {
                return Err(CoreError::InvalidCursor);
            }
            if cursor.revision != self.revision
                || cursor.dependency.as_deref() != Some(&self.dependencies)
            {
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
        for ordinal in start_event..self.item_count {
            let item = self
                .item_at(ordinal)?
                .ok_or_else(|| CoreError::Storage("Reader item is missing".into()))?;
            for (field_index, &field) in search_fields(&item.event.segment).iter().enumerate().skip(
                if ordinal == start_event {
                    start_field
                } else {
                    0
                },
            ) {
                let start_lower = if ordinal == start_event && field_index == start_field {
                    start_offset
                } else {
                    0
                };
                if let Some(next_lower) = self.search_field(
                    &item,
                    field,
                    start_lower,
                    &lower_needle,
                    limit,
                    &mut matches,
                )? {
                    let cursor = ReaderSearchCursor {
                        version: 2,
                        kind: "reader.search".into(),
                        scope: self.scope.clone(),
                        session: self.reference(),
                        revision: self.revision.clone(),
                        dependency: Some(self.dependencies.clone()),
                        query: needle.into(),
                        event_index: ordinal,
                        field_index,
                        lower_byte_offset: next_lower,
                    };
                    return Ok(ReaderSearchPage {
                        session: self.reference(),
                        revision: self.revision.clone(),
                        scope: "owned",
                        coverage: "complete-owned-content",
                        matches,
                        next_cursor: Some(encode(&cursor)?),
                    });
                }
            }
        }
        Ok(ReaderSearchPage {
            session: self.reference(),
            revision: self.revision.clone(),
            scope: "owned",
            coverage: "complete-owned-content",
            matches,
            next_cursor: None,
        })
    }

    fn search_field(
        &self,
        item: &ReaderItem,
        field: &'static str,
        start_lower: usize,
        lower_needle: &str,
        limit: usize,
        matches: &mut Vec<ReaderSearchMatch>,
    ) -> Result<Option<usize>> {
        let mut stmt = self
            .db
            .prepare(
                "SELECT text,total_units FROM reader_content WHERE provider=?1 AND session_id=?2 \
             AND ordinal=?3 AND field=?4 ORDER BY chunk_index",
            )
            .map_err(storage)?;
        let rows = stmt
            .query_map(
                params![
                    self.summary.session.provider,
                    self.summary.session.session_id,
                    item.ordinal as i64,
                    field,
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(storage)?;
        let mut window = SearchWindow::new(start_lower);
        let mut total = None;
        for row in rows {
            let (chunk, units) = row.map_err(storage)?;
            total = Some(units as usize);
            window.text.push_str(&chunk);
            if let Some(offset) = window.scan(
                false,
                lower_needle,
                item,
                field,
                units as usize,
                limit,
                matches,
            )? {
                return Ok(Some(offset));
            }
        }
        let total =
            total.ok_or_else(|| CoreError::Storage("Reader content field is missing".into()))?;
        window.scan(true, lower_needle, item, field, total, limit, matches)
    }

    pub(crate) fn content(
        &self,
        provider: &str,
        session_id: &str,
        query: ContentQuery,
    ) -> Result<ContentPage> {
        if query.revision != self.revision {
            return Err(CoreError::SourceChanged);
        }
        let item = self
            .item_by_ref(&query.message_id, &query.segment)?
            .ok_or_else(|| CoreError::EventNotFound(query.message_id.clone()))?;
        let valid = match (query.segment.as_str(), query.field.as_str()) {
            ("message" | "thinking" | "context", "body") | ("tool", "toolInput" | "toolOutput") => {
                true
            }
            _ => false,
        };
        if !valid {
            return Err(CoreError::InvalidInput(
                "unsupported content field for event segment".into(),
            ));
        }
        if query.max_chars == 0 || query.max_chars > 100_000 {
            return Err(CoreError::InvalidInput(
                "maxChars must be between 1 and 100000".into(),
            ));
        }
        let offset = i64::try_from(query.offset)
            .map_err(|_| CoreError::InvalidInput("offset exceeds content length".into()))?;
        let first: Option<(i64, i64, i64)> = self.db.query_row(
            "SELECT chunk_index,start_units,total_units FROM reader_content WHERE provider=?1 AND session_id=?2 AND ordinal=?3 AND field=?4 AND start_units<=?5 ORDER BY start_units DESC LIMIT 1",
            params![provider, session_id, item.ordinal as i64, query.field, offset],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        ).optional().map_err(storage)?;
        let Some((first_index, first_start, total)) = first else {
            return Err(CoreError::Storage("Reader content field is missing".into()));
        };
        if query.offset > total as usize {
            return Err(CoreError::InvalidInput(
                "offset exceeds content length".into(),
            ));
        }
        let mut stmt = self.db.prepare(
            "SELECT text FROM reader_content WHERE provider=?1 AND session_id=?2 AND ordinal=?3 AND field=?4 AND chunk_index>=?5 ORDER BY chunk_index"
        ).map_err(storage)?;
        let rows = stmt
            .query_map(
                params![
                    provider,
                    session_id,
                    item.ordinal as i64,
                    query.field,
                    first_index
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(storage)?;
        let mut text = String::new();
        for row in rows {
            text.push_str(&row.map_err(storage)?);
            if first_start as usize + text.encode_utf16().count()
                > query.offset.saturating_add(query.max_chars)
            {
                break;
            }
        }
        let mut page =
            crate::page_text(&text, query.offset - first_start as usize, query.max_chars)?;
        page.offset = query.offset;
        page.total_chars = total as usize;
        page.next_offset = (query.offset + page.text.encode_utf16().count() < total as usize)
            .then_some(query.offset + page.text.encode_utf16().count());
        page.truncated = page.next_offset.is_some();
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceConfig;
    use std::path::Path;

    fn source(id: &str, body: &str) -> String {
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"{body}\"}}}}\n"
        )
    }

    fn core(root: &Path) -> Core {
        Core::new(SourceConfig {
            codex_dir: root.join("codex"),
            opencode_db: root.join("opencode.db"),
            claude_dir: root.join("claude"),
            pi_dir: root.join("pi"),
            dsh_dir: root.join("dsh"),
            meta_dir: root.join("meta"),
            index_dir: root.join("index"),
            cache_dir: root.join("cache"),
        })
        .unwrap()
    }

    #[test]
    fn wal_reader_holds_one_generation_during_concurrent_publication() {
        let root = tempfile::tempdir().unwrap();
        let id = "abababab-abab-4bab-8bab-abababababab";
        let source_dir = root.path().join("codex/sessions");
        fs::create_dir_all(&source_dir).unwrap();
        let path = source_dir.join(format!("rollout-{id}.jsonl"));
        fs::write(&path, source(id, "original answer")).unwrap();
        let core = core(root.path());
        let initial = core.reader_bootstrap("codex", id).unwrap();
        let held = ReaderModel::open(&core, "codex", id).unwrap().unwrap();
        let old = held.item_at(0).unwrap().unwrap();
        fs::write(&path, source(id, "updated answer")).unwrap();
        let (sent, received) = std::sync::mpsc::channel();
        let writer = core.clone();
        let id_owned = id.to_string();
        let thread = std::thread::spawn(move || {
            sent.send(writer.reader_bootstrap("codex", &id_owned))
                .unwrap();
        });
        let updated = received
            .recv_timeout(Duration::from_secs(10))
            .expect("WAL publisher must complete while the old Reader snapshot is active")
            .unwrap();
        thread.join().unwrap();
        assert_ne!(updated.revision, initial.revision);
        assert_eq!(held.revision, initial.revision);
        assert_eq!(held.item_at(0).unwrap().unwrap().preview, old.preview);
        assert_ne!(updated.segments[0].items[0].preview, old.preview);
    }

    #[test]
    fn content_offset_seek_uses_a_bounded_index_order() {
        let root = tempfile::tempdir().unwrap();
        let id = "abababab-abab-4bab-8bab-bcbcbcbcbcbc";
        let source_dir = root.path().join("codex/sessions");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(
            source_dir.join(format!("rollout-{id}.jsonl")),
            source(id, &"x".repeat(40_000)),
        )
        .unwrap();
        let core = core(root.path());
        let model = ReaderModel::open(&core, "codex", id).unwrap().unwrap();
        let mut statement = model
            .db
            .prepare(
                "EXPLAIN QUERY PLAN SELECT chunk_index,start_units,total_units FROM reader_content \
             WHERE provider=?1 AND session_id=?2 AND ordinal=?3 AND field=?4 AND start_units<=?5 \
             ORDER BY start_units DESC LIMIT 1",
            )
            .unwrap();
        let plan: Vec<String> = statement
            .query_map(params!["codex", id, 0, "body", 0], |row| row.get(3))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert!(
            plan.iter().any(|step| step.contains("start_units<?")),
            "{plan:?}"
        );
        assert!(
            !plan.iter().any(|step| step.contains("USE TEMP B-TREE")),
            "{plan:?}"
        );
    }

    #[test]
    fn existing_reader_cache_receives_the_offset_index_on_open() {
        let root = tempfile::tempdir().unwrap();
        let id = "abababab-abab-4bab-8bab-cdcdcdcdcdcd";
        let source_dir = root.path().join("codex/sessions");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(
            source_dir.join(format!("rollout-{id}.jsonl")),
            source(id, "unchanged content"),
        )
        .unwrap();
        let core = core(root.path());
        let original = core.reader_bootstrap("codex", id).unwrap();
        let db_path = core
            .config
            .cache_dir
            .join(format!("reader-{}.sqlite", core.source_scope));
        let db = Connection::open(&db_path).unwrap();
        db.execute_batch("DROP INDEX reader_content_offset; PRAGMA user_version=0;")
            .unwrap();
        drop(db);

        let reopened = ReaderModel::open(&core, "codex", id).unwrap().unwrap();
        assert_eq!(reopened.revision, original.revision);
        let version: i64 = reopened
            .db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let index_count: i64 = reopened
            .db
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='reader_content_offset'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 1);
        assert_eq!(
            reopened.item_at(0).unwrap().unwrap().preview,
            "unchanged content"
        );
    }

    #[test]
    #[ignore = "requires an explicit frozen or generated Codex root and isolated derived-state directory"]
    fn selected_reader_load_probe() {
        let root = std::path::PathBuf::from(
            std::env::var("AGENTSESSION_READER_PROBE_SOURCE_ROOT").unwrap(),
        );
        let state =
            std::path::PathBuf::from(std::env::var("AGENTSESSION_READER_PROBE_STATE").unwrap());
        let id = std::env::var("AGENTSESSION_READER_PROBE_ID").unwrap();
        let core = Core::new(SourceConfig {
            codex_dir: root,
            opencode_db: state.join("absent.db"),
            claude_dir: state.join("claude"),
            pi_dir: state.join("pi"),
            dsh_dir: state.join("dsh"),
            meta_dir: state.join("meta"),
            index_dir: state.join("index"),
            cache_dir: state.join("cache"),
        })
        .unwrap();
        let started = std::time::Instant::now();
        let bootstrap = core.reader_bootstrap("codex", &id).unwrap();
        let bootstrap_ms = started.elapsed().as_millis();
        let relation_started = std::time::Instant::now();
        let relations = bootstrap
            .relations
            .first_cursor
            .as_ref()
            .map(|cursor| core.reader_relations("codex", &id, cursor).unwrap());
        let relations_ms = relation_started.elapsed().as_millis();
        let segment_started = std::time::Instant::now();
        let segment = bootstrap.segments[0]
            .next_cursor
            .as_ref()
            .map(|cursor| core.reader_segments("codex", &id, cursor).unwrap());
        let segment_ms = segment_started.elapsed().as_millis();
        let content_started = std::time::Instant::now();
        let item = segment
            .as_ref()
            .and_then(|page| page.page.items.first())
            .or_else(|| bootstrap.segments[0].items.first())
            .unwrap();
        let field = if item.event.segment == "tool" {
            "toolOutput"
        } else {
            "body"
        };
        let content = core
            .reader_content(
                "codex",
                &id,
                ContentQuery {
                    message_id: item.event.message_id.clone(),
                    segment: item.event.segment.clone(),
                    field: field.into(),
                    offset: 0,
                    max_chars: 1000,
                    revision: bootstrap.revision.clone(),
                },
            )
            .unwrap();
        let content_ms = content_started.elapsed().as_millis();
        let cache = state
            .join("cache")
            .join(format!("reader-{}.sqlite", core.source_scope()));
        let disk_bytes = fs::metadata(&cache).unwrap().len();
        let (normalizations, copied_child_parses) = crate::providers::reader_probe_counts();
        println!(
            "reader_probe pid={} bootstrap_ms={} relations_ms={} segment_ms={} content_ms={} total_items={} relation_total={} first_relation_items={} content_chars={} sqlite_bytes={} normalizations={} copied_child_parses={}",
            std::process::id(),
            bootstrap_ms,
            relations_ms,
            segment_ms,
            content_ms,
            bootstrap.total_items,
            bootstrap.relations.task_count + bootstrap.relations.observation_count,
            relations.as_ref().map_or(0, |page| page.entries.len()),
            content.text.encode_utf16().count(),
            disk_bytes,
            normalizations,
            copied_child_parses
        );
    }
}
