use super::{
    Core, CoreError, Result, SessionRef, SessionSummary, browse_revision, normalize_project_path,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryQuery {
    pub provider: Option<String>,
    pub providers: Option<Vec<String>>,
    pub project: Option<String>,
    pub search: Option<String>,
    pub sort: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
    pub offset: Option<usize>,
    pub range: Option<String>,
    pub starred_only: Option<bool>,
    pub has_subagent: Option<bool>,
    pub legacy_search: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryChildrenQuery {
    pub provider: String,
    pub parent_id: String,
    pub project: Option<String>,
    pub search: Option<String>,
    pub sort: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
    pub offset: Option<usize>,
    pub range: Option<String>,
    pub starred_only: Option<bool>,
    pub has_subagent: Option<bool>,
    pub legacy_search: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNode {
    pub session: SessionSummary,
    pub matched: bool,
    pub matching_count: usize,
    pub child_count: usize,
    pub total_child_count: usize,
    pub family_root_id: String,
    pub family_updated: Option<i64>,
    pub parent_boundary: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPage {
    pub families: Vec<LibraryNode>,
    pub total: usize,
    pub matching_sessions: usize,
    pub source_diagnostics: Vec<LibrarySourceDiagnostic>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct LibrarySourceDiagnostic {
    pub provider: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChildrenPage {
    pub parent: LibraryNode,
    pub children: Vec<LibraryNode>,
    pub total: usize,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LibraryCursor {
    version: u8,
    kind: String,
    scope: String,
    filters: String,
    revision: String,
    offset: usize,
}

struct Record {
    session: SessionSummary,
    parent: Option<usize>,
    children: Vec<usize>,
    boundary: Option<&'static str>,
    root: usize,
    matched: bool,
    matching: usize,
    updated: Option<i64>,
}

struct Prepared {
    records: Vec<Record>,
    by_ref: HashMap<SessionRef, usize>,
    revision: String,
    matching_sessions: usize,
    source_diagnostics: Vec<LibrarySourceDiagnostic>,
}

fn page_limit(limit: Option<usize>, default: usize) -> Result<usize> {
    let limit = limit.unwrap_or(default);
    if !(1..=100).contains(&limit) {
        return Err(CoreError::InvalidInput(
            "limit must be between 1 and 100".into(),
        ));
    }
    Ok(limit)
}

fn checked_sort(sort: Option<&str>) -> Result<&str> {
    let sort = sort.unwrap_or("updated-desc");
    if !matches!(
        sort,
        "updated-desc" | "updated-asc" | "title-asc" | "title-desc"
    ) {
        return Err(CoreError::InvalidInput("invalid library sort".into()));
    }
    Ok(sort)
}

fn range_cutoff_at(range: &str, now: jiff::Timestamp, zone: jiff::tz::TimeZone) -> Option<i64> {
    match range {
        "today" => now
            .to_zoned(zone)
            .start_of_day()
            .ok()
            .map(|day| day.timestamp().as_millisecond()),
        "week" => Some(now.as_millisecond() - 7 * 86_400_000),
        "month" => Some(now.as_millisecond() - 30 * 86_400_000),
        _ => None,
    }
}

pub fn list_range_cutoff(range: &str) -> Option<i64> {
    range_cutoff_at(range, jiff::Timestamp::now(), jiff::tz::TimeZone::system())
}

fn page_offset(
    core: &Core,
    token: Option<&str>,
    kind: &str,
    filters: &str,
    revision: &str,
    len: usize,
) -> Result<usize> {
    let Some(token) = token else { return Ok(0) };
    if token.is_empty() || token.len() > 4000 {
        return Err(CoreError::InvalidCursor);
    }
    let cursor: LibraryCursor =
        serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
    if cursor.version != 1
        || cursor.kind != kind
        || cursor.scope != core.source_scope
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

fn next_cursor(
    core: &Core,
    kind: &str,
    filters: &str,
    revision: &str,
    end: usize,
    len: usize,
) -> Option<String> {
    (end < len).then(|| {
        serde_json::to_string(&LibraryCursor {
            version: 1,
            kind: kind.into(),
            scope: core.source_scope.clone(),
            filters: filters.into(),
            revision: revision.into(),
            offset: end,
        })
        .expect("library cursor serialization")
    })
}

impl Prepared {
    fn node(&self, index: usize) -> LibraryNode {
        let record = &self.records[index];
        LibraryNode {
            session: record.session.clone(),
            matched: record.matched,
            matching_count: record.matching,
            child_count: record
                .children
                .iter()
                .filter(|&&child| self.records[child].matching > 0)
                .count(),
            total_child_count: record.children.len(),
            family_root_id: self.records[record.root].session.session.session_id.clone(),
            family_updated: self.records[record.root].updated,
            parent_boundary: record.boundary,
        }
    }

    fn ordered(
        &self,
        items: &mut [usize],
        sort: &str,
        collation: &super::collation::LibraryCollation,
    ) {
        items.sort_by(|&a, &b| {
            let left = &self.records[a];
            let right = &self.records[b];
            let primary = match sort {
                "title-asc" => collation
                    .title(&left.session.title, &right.session.title)
                    .then_with(|| right.updated.cmp(&left.updated)),
                "title-desc" => collation
                    .title(&right.session.title, &left.session.title)
                    .then_with(|| right.updated.cmp(&left.updated)),
                "updated-asc" => left.updated.cmp(&right.updated),
                _ => right.updated.cmp(&left.updated),
            };
            primary
                .then_with(|| {
                    collation.canonical(
                        &left.session.session.provider,
                        &right.session.session.provider,
                    )
                })
                .then_with(|| {
                    collation.canonical(
                        &left.session.session.session_id,
                        &right.session.session.session_id,
                    )
                })
        });
    }
}

impl Core {
    fn prepare_library(
        &self,
        provider: Option<&str>,
        providers: Option<&[String]>,
        project: Option<&str>,
        search: Option<&str>,
        range: Option<&str>,
        starred_only: bool,
        has_subagent: bool,
        legacy_search: bool,
    ) -> Result<Prepared> {
        if provider.is_some_and(|id| !super::PROVIDERS.contains(&id)) {
            return Err(CoreError::InvalidInput("unknown provider".into()));
        }
        if provider.is_some() && providers.is_some() {
            return Err(CoreError::InvalidInput(
                "provider and providers cannot be combined".into(),
            ));
        }
        let selected: Vec<&str> = match (provider, providers) {
            (Some(id), _) => vec![id],
            (_, Some(ids)) => {
                if ids
                    .iter()
                    .any(|id| !super::PROVIDERS.contains(&id.as_str()))
                {
                    return Err(CoreError::InvalidInput("unknown provider".into()));
                }
                super::PROVIDERS
                    .iter()
                    .copied()
                    .filter(|id| ids.iter().any(|selected| selected == id))
                    .collect()
            }
            _ => super::PROVIDERS.to_vec(),
        };
        let mut rows = Vec::new();
        let mut source_revisions = Vec::new();
        let mut source_diagnostics = Vec::new();
        let mut hidden = HashSet::new();
        let mut starred = HashSet::new();
        let statuses = self.providers();
        for id in selected {
            if starred_only {
                starred.extend(
                    self.viewer_meta_list(id)?
                        .into_iter()
                        .filter(|meta| meta.starred)
                        .map(|meta| SessionRef {
                            provider: meta.provider,
                            session_id: meta.session_id,
                        }),
                );
            }
            let status = statuses
                .iter()
                .find(|status| status.id == id)
                .expect("selected provider is registered");
            if !status.available {
                if provider.is_some() {
                    return Err(CoreError::Unavailable(id.into()));
                }
                let message = status
                    .storage_diagnostic
                    .as_ref()
                    .and_then(|diagnostic| diagnostic.get("note"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        crate::providers::adapter(&self.config, &self.source_scope, id)
                            .ok()
                            .map(|adapter| adapter.unavailable_diagnostic().to_owned())
                    })
                    .unwrap_or_else(|| "Provider source is unavailable".into());
                source_revisions.push((id, format!("unavailable:{message}")));
                source_diagnostics.push(LibrarySourceDiagnostic {
                    provider: id.into(),
                    message,
                });
                continue;
            }
            if let Some(diagnostic) = status.storage_diagnostic.as_ref()
                && diagnostic.get("code").is_some()
            {
                let message = diagnostic
                    .get("note")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Provider source identity is incomplete")
                    .to_owned();
                source_diagnostics.push(LibrarySourceDiagnostic {
                    provider: id.into(),
                    message,
                });
            }
            let (all, source_revision) = match self.indexed_sessions(id) {
                Ok(value) => value,
                Err(error) if provider.is_some() => return Err(error),
                Err(error) => {
                    let message = error.to_string();
                    source_revisions.push((id, format!("error:{message}")));
                    source_diagnostics.push(LibrarySourceDiagnostic {
                        provider: id.into(),
                        message,
                    });
                    continue;
                }
            };
            source_revisions.push((id, source_revision));
            let all_ids: HashSet<_> = all.iter().map(|row| row.session.clone()).collect();
            let visible = self.visible_sessions(id, all)?;
            let visible_ids: HashSet<_> = visible.iter().map(|row| row.session.clone()).collect();
            hidden.extend(all_ids.difference(&visible_ids).cloned());
            rows.extend(visible);
        }
        let revision = browse_revision(&(
            &source_revisions,
            &rows,
            &source_diagnostics,
            self.library_collation.identity(),
        ));
        let by_ref: HashMap<_, _> = rows
            .iter()
            .enumerate()
            .map(|(index, row)| (row.session.clone(), index))
            .collect();
        let mut records: Vec<Record> = rows
            .into_iter()
            .enumerate()
            .map(|(index, session)| Record {
                updated: session.updated_at,
                session,
                parent: None,
                children: Vec::new(),
                boundary: None,
                root: index,
                matched: false,
                matching: 0,
            })
            .collect();
        for index in 0..records.len() {
            let Some(parent_ref) = records[index].session.parent.clone() else {
                continue;
            };
            records[index].parent = by_ref.get(&parent_ref).copied();
            if records[index].parent.is_none() {
                records[index].boundary = Some(if hidden.contains(&parent_ref) {
                    "hidden-parent"
                } else {
                    "missing-parent"
                });
            }
        }
        // Provider parent references are external facts. Break each cycle at its members.
        let mut resolved = HashSet::new();
        for start in 0..records.len() {
            let mut path: Vec<usize> = Vec::new();
            let mut positions: HashMap<usize, usize> = HashMap::new();
            let mut current = Some(start);
            while let Some(index) = current {
                if resolved.contains(&index) {
                    break;
                }
                if let Some(&at) = positions.get(&index) {
                    for &cycle in &path[at..] {
                        records[cycle].parent = None;
                        records[cycle].boundary = Some("cyclic-parent");
                    }
                    break;
                }
                positions.insert(index, path.len());
                path.push(index);
                current = records[index].parent;
            }
            resolved.extend(path);
        }
        for index in 0..records.len() {
            if let Some(parent) = records[index].parent {
                records[parent].children.push(index);
            }
        }
        let project = project
            .filter(|value| !value.trim().is_empty())
            .map(normalize_project_path);
        let term = if legacy_search {
            search.unwrap_or("").to_lowercase()
        } else {
            search.unwrap_or("").trim().to_lowercase()
        };
        let cutoff = range.and_then(list_range_cutoff);
        for record in &mut records {
            record.matched = project.as_ref().is_none_or(|project| {
                if project == "__opensession_empty_project__" {
                    record
                        .session
                        .directory
                        .as_deref()
                        .is_none_or(str::is_empty)
                } else {
                    record
                        .session
                        .directory
                        .as_deref()
                        .is_some_and(|dir| normalize_project_path(dir) == *project)
                }
            }) && (term.is_empty()
                || record.session.title.to_lowercase().contains(&term)
                || (!legacy_search
                    && (record
                        .session
                        .session
                        .session_id
                        .to_lowercase()
                        .contains(&term)
                        || record
                            .session
                            .session
                            .provider
                            .to_lowercase()
                            .contains(&term)))
                || record
                    .session
                    .directory
                    .as_deref()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&term));
            record.matched &= cutoff
                .is_none_or(|cutoff| record.session.updated_at.is_some_and(|time| time >= cutoff))
                && (!starred_only || starred.contains(&record.session.session))
                && (!has_subagent || !record.children.is_empty());
            record.matching = usize::from(record.matched);
        }
        let matching_sessions = records.iter().filter(|record| record.matched).count();
        let mut queue: Vec<usize> = (0..records.len())
            .filter(|&index| records[index].parent.is_none())
            .collect();
        let mut order = Vec::new();
        let mut position = 0;
        while position < queue.len() {
            let index = queue[position];
            let children = records[index].children.clone();
            for child in children {
                records[child].root = records[index].root;
                queue.push(child);
            }
            order.push(index);
            position += 1;
        }
        for &index in order.iter().rev() {
            if let Some(parent) = records[index].parent {
                records[parent].matching += records[index].matching;
                records[parent].updated = records[parent].updated.max(records[index].updated);
            }
        }
        Ok(Prepared {
            records,
            by_ref,
            revision,
            matching_sessions,
            source_diagnostics,
        })
    }

    pub fn library_families(&self, query: LibraryQuery) -> Result<LibraryPage> {
        let limit = page_limit(query.limit, 30)?;
        let sort = checked_sort(query.sort.as_deref())?;
        let prepared = self.prepare_library(
            query.provider.as_deref(),
            query.providers.as_deref(),
            query.project.as_deref(),
            query.search.as_deref(),
            query.range.as_deref(),
            query.starred_only.unwrap_or(false),
            query.has_subagent.unwrap_or(false),
            query.legacy_search.unwrap_or(false),
        )?;
        let mut roots: Vec<_> = prepared
            .records
            .iter()
            .enumerate()
            .filter_map(|(index, record)| {
                (record.parent.is_none() && record.matching > 0).then_some(index)
            })
            .collect();
        prepared.ordered(&mut roots, sort, &self.library_collation);
        let filters = browse_revision(&(
            &query.provider,
            &query.providers,
            &query.project.as_deref().map(normalize_project_path),
            &query.search.as_deref().map(str::to_lowercase),
            &query.range,
            query.starred_only,
            query.has_subagent,
            query.legacy_search,
            sort,
        ));
        let offset = if let Some(offset) = query.offset {
            if query.cursor.is_some() {
                return Err(CoreError::InvalidInput("invalid library offset".into()));
            }
            offset
        } else {
            page_offset(
                self,
                query.cursor.as_deref(),
                "library.families",
                &filters,
                &prepared.revision,
                roots.len(),
            )?
        };
        let start = offset.min(roots.len());
        let end = start.saturating_add(limit).min(roots.len());
        Ok(LibraryPage {
            families: roots[start..end]
                .iter()
                .map(|&index| prepared.node(index))
                .collect(),
            total: roots.len(),
            matching_sessions: prepared.matching_sessions,
            source_diagnostics: prepared.source_diagnostics,
            next_cursor: next_cursor(
                self,
                "library.families",
                &filters,
                &prepared.revision,
                end,
                roots.len(),
            ),
        })
    }

    pub fn library_children(&self, query: LibraryChildrenQuery) -> Result<LibraryChildrenPage> {
        let limit = page_limit(query.limit, 20)?;
        let sort = checked_sort(query.sort.as_deref())?;
        let prepared = self.prepare_library(
            Some(&query.provider),
            None,
            query.project.as_deref(),
            query.search.as_deref(),
            query.range.as_deref(),
            query.starred_only.unwrap_or(false),
            query.has_subagent.unwrap_or(false),
            query.legacy_search.unwrap_or(false),
        )?;
        let reference = SessionRef {
            provider: query.provider.clone(),
            session_id: query.parent_id.clone(),
        };
        let parent =
            prepared
                .by_ref
                .get(&reference)
                .copied()
                .ok_or_else(|| CoreError::NotFound {
                    provider: query.provider.clone(),
                    session_id: query.parent_id.clone(),
                })?;
        if prepared.records[parent].matching == 0 {
            return Err(CoreError::NotFound {
                provider: query.provider,
                session_id: query.parent_id,
            });
        }
        let mut children: Vec<_> = prepared.records[parent]
            .children
            .iter()
            .copied()
            .filter(|&index| prepared.records[index].matching > 0)
            .collect();
        prepared.ordered(&mut children, sort, &self.library_collation);
        let filters = browse_revision(&(
            &reference,
            &query.project.as_deref().map(normalize_project_path),
            &query.search.as_deref().map(str::to_lowercase),
            &query.range,
            query.starred_only,
            query.has_subagent,
            query.legacy_search,
            sort,
        ));
        let offset = if let Some(offset) = query.offset {
            if query.cursor.is_some() {
                return Err(CoreError::InvalidInput("invalid library offset".into()));
            }
            offset
        } else {
            page_offset(
                self,
                query.cursor.as_deref(),
                "library.children",
                &filters,
                &prepared.revision,
                children.len(),
            )?
        };
        let start = offset.min(children.len());
        let end = start.saturating_add(limit).min(children.len());
        Ok(LibraryChildrenPage {
            parent: prepared.node(parent),
            children: children[start..end]
                .iter()
                .map(|&index| prepared.node(index))
                .collect(),
            total: children.len(),
            next_cursor: next_cursor(
                self,
                "library.children",
                &filters,
                &prepared.revision,
                end,
                children.len(),
            ),
        })
    }
}

#[cfg(test)]
mod range_tests {
    use super::range_cutoff_at;
    use jiff::{
        Timestamp,
        tz::{Offset, TimeZone},
    };

    #[test]
    fn today_uses_local_calendar_midnight_in_non_utc_zone() {
        let now: Timestamp = "2026-09-27T00:30:00Z".parse().unwrap();
        let shanghai = TimeZone::fixed(Offset::from_hours(8).unwrap());
        assert_eq!(
            range_cutoff_at("today", now, shanghai),
            Some(1_790_438_400_000)
        );
    }

    #[test]
    fn configured_system_zone_uses_its_calendar_midnight() {
        let Ok(expected) = std::env::var("AGENTSESSION_TEST_SYSTEM_ZONE_CUTOFF_MS") else {
            return;
        };
        let now: Timestamp = "2026-09-27T00:30:00Z".parse().unwrap();
        let system = TimeZone::try_system().expect("system time zone resolves");
        assert_eq!(
            range_cutoff_at("today", now, system),
            Some(expected.parse().unwrap())
        );
    }
}

#[cfg(test)]
mod collation_tests {
    use super::*;

    #[test]
    fn family_and_child_cursors_cannot_cross_server_collation_locales() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path();
        let db = path.join("opencode.db");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection.execute_batch("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT,
            directory TEXT, time_created INTEGER, time_updated INTEGER, fork_session_id TEXT,
            fork_boundary TEXT, slug TEXT, time_archived INTEGER, tokens_input INTEGER,
            tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
            CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
            time_created INTEGER, time_updated INTEGER, data TEXT);
            INSERT INTO session_v2 (id,parent_id,title,directory,time_created,time_updated) VALUES ('root',NULL,'Alpha','/public',1,1),
            ('other',NULL,'北京','/public',1,1), ('child-a','root','Alpha','/public',1,1),
            ('child-b','root','北京','/public',1,1);").unwrap();
        drop(connection);
        let mut core = Core::new(super::super::SourceConfig {
            codex_dir: path.join("codex"),
            opencode_db: db,
            claude_dir: path.join("claude"),
            pi_dir: path.join("pi"),
            dsh_dir: path.join("dsh"),
            meta_dir: path.join("meta"),
            index_dir: path.join("index"),
            cache_dir: path.join("cache"),
        })
        .unwrap();
        core.library_collation = std::sync::Arc::new(
            super::super::collation::LibraryCollation::for_locale("zh-CN").unwrap(),
        );
        let family: LibraryQuery = serde_json::from_value(
            serde_json::json!({"provider":"opencode","sort":"title-asc","limit":1}),
        )
        .unwrap();
        let child: LibraryChildrenQuery = serde_json::from_value(serde_json::json!({"provider":"opencode","parentId":"root","sort":"title-asc","limit":1})).unwrap();
        let family_cursor = core
            .library_families(family.clone())
            .unwrap()
            .next_cursor
            .unwrap();
        let child_cursor = core
            .library_children(child.clone())
            .unwrap()
            .next_cursor
            .unwrap();
        assert!(matches!(
            core.library_families(LibraryQuery {
                offset: Some(0),
                cursor: Some(family_cursor.clone()),
                ..family.clone()
            }),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            core.library_children(LibraryChildrenQuery {
                offset: Some(0),
                cursor: Some(child_cursor.clone()),
                ..child.clone()
            }),
            Err(CoreError::InvalidInput(_))
        ));
        core.library_collation = std::sync::Arc::new(
            super::super::collation::LibraryCollation::for_locale("en-US").unwrap(),
        );
        assert!(matches!(
            core.library_families(LibraryQuery {
                cursor: Some(family_cursor),
                ..family
            }),
            Err(CoreError::SourceChanged)
        ));
        assert!(matches!(
            core.library_children(LibraryChildrenQuery {
                cursor: Some(child_cursor),
                ..child
            }),
            Err(CoreError::SourceChanged)
        ));
    }
}
