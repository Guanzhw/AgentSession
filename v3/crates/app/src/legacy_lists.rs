//! The documented list endpoints keep their offset and filter behavior while
//! returning structured Core facts for the 3.0 reader.
use super::{ApiError, SharedSettings, joined_error};
use agentsession_core::{
    Core, CoreError, LibraryChildrenQuery, LibraryNode, LibraryQuery, SearchQuery, SessionSummary,
    list_range_cutoff, normalize_project_path,
};
use axum::{
    Json,
    extract::{Extension, Path, RawQuery, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

const PROVIDERS: [&str; 5] = ["opencode", "claude-code", "codex", "pi", "deepseek-harness"];
const MAX_SOURCE_DIAGNOSTICS: usize = 8;

struct Params(Vec<(String, String)>);

impl Params {
    fn parse(raw: Option<String>) -> Result<Self, ApiError> {
        serde_urlencoded::from_str(raw.as_deref().unwrap_or(""))
            .map(Self)
            .map_err(|_| CoreError::InvalidInput("invalid list query".into()).into())
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn has(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    fn providers(&self) -> Vec<String> {
        let requested: Vec<_> = self
            .0
            .iter()
            .filter(|(key, _)| key == "provider")
            .flat_map(|(_, value)| value.split(','))
            .filter(|value| !value.is_empty())
            .collect();
        if requested.is_empty() {
            return PROVIDERS.iter().map(|id| (*id).into()).collect();
        }
        let mut seen = HashSet::new();
        requested
            .into_iter()
            .filter(|id| PROVIDERS.contains(id) && seen.insert(*id))
            .map(str::to_owned)
            .collect()
    }

    fn limit(&self) -> usize {
        self.get("limit")
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| *value != 0)
            .unwrap_or(30)
            .clamp(1, 100) as usize
    }

    fn offset(&self, strict: bool) -> Result<usize, ApiError> {
        let Some(raw) = self.get("offset").filter(|raw| !raw.is_empty()) else {
            return Ok(0);
        };
        let offset = match raw.parse::<usize>() {
            Ok(offset) => offset,
            Err(_) if !strict => return Ok(0),
            Err(_) => return Err(CoreError::InvalidInput("invalid list offset".into()).into()),
        };
        if strict && offset > 100_000 {
            return Err(CoreError::InvalidInput("list offset exceeds 100000".into()).into());
        }
        Ok(offset)
    }

    fn sort(&self) -> &str {
        match self.get("sort") {
            Some(sort @ ("updated-asc" | "title-asc" | "title-desc")) => sort,
            _ => "updated-desc",
        }
    }

    fn starred(&self) -> bool {
        matches!(self.get("starred"), Some("1" | "true"))
    }
}

fn encode(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            result.push(char::from(byte));
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

fn link(session: &SessionSummary, return_to: &str) -> String {
    let reference = &session.session;
    let mut href = format!(
        "/{}/session/{}",
        encode(&reference.provider),
        encode(&reference.session_id)
    );
    if !return_to.is_empty() {
        href.push_str("?from=");
        href.push_str(&encode(return_to));
    }
    href
}

fn family_value(node: &LibraryNode, return_to: &str) -> Value {
    let row = &node.session;
    let mut value = json!({
        "id": row.session.session_id,
        "provider": row.session.provider,
        "title": row.title,
        "directory": row.directory.clone().unwrap_or_default(),
        "time_created": row.created_at.unwrap_or(0),
        "time_updated": row.updated_at.unwrap_or(0),
        "parent": row.parent,
        "href": link(row, return_to),
        "matched": node.matched,
        "matchingCount": node.matching_count,
        "childCount": node.child_count,
        "totalChildCount": node.total_child_count,
        "familyRootId": node.family_root_id,
        "familyUpdated": node.family_updated,
        "parentBoundary": node.parent_boundary,
    });
    if let Some(diagnostic) = &row.diagnostic {
        value["diagnostic"] = json!(diagnostic);
    }
    value
}

fn source_diagnostics(core: &Core, selected: &[String]) -> Vec<Value> {
    let statuses = core.providers();
    selected
        .iter()
        .filter_map(|provider| {
            let status = statuses.iter().find(|status| status.id == *provider)?;
            let source_diagnostics = status
                .storage_diagnostic
                .as_ref()?
                .get("sourceDiagnostics")?
                .as_array()?;
            let source_diagnostics = source_diagnostics
                .iter()
                .filter_map(|problem| {
                    let code = problem.get("code")?.as_str()?;
                    let mut diagnostic = json!({"code": code});
                    for field in ["affectedSessions", "affectedSources"] {
                        if let Some(count) = problem.get(field).and_then(Value::as_u64) {
                            diagnostic[field] = json!(count);
                        }
                    }
                    Some(diagnostic)
                })
                .take(MAX_SOURCE_DIAGNOSTICS)
                .collect::<Vec<_>>();
            (!source_diagnostics.is_empty()).then(|| {
                json!({"provider": provider, "status": "partial", "sourceDiagnostics": source_diagnostics})
            })
        })
        .collect()
}

fn attach_source_diagnostics(mut response: Value, diagnostics: Vec<Value>) -> Value {
    if !diagnostics.is_empty() {
        response["diagnostics"] = json!(diagnostics);
    }
    response
}

fn stats_diagnostic(error: CoreError) -> Value {
    let retryable = matches!(error, CoreError::SourceChanged);
    let error = ApiError::from(error);
    json!({"code": error.code, "message": error.message, "retryable": retryable})
}

fn base_stats(core: &Core, session: &SessionSummary) -> Value {
    let duration = session
        .created_at
        .zip(session.updated_at)
        .filter(|(start, end)| *start > 0 && *end >= *start)
        .map(|(start, end)| end - start);
    // Availability describes the protocol projection; summary facts retain their source.
    let mut stats = json!({"provider": session.session.provider, "sessionId": session.session.session_id,
        "messageCount": session.conversation_message_count.unwrap_or(session.message_count), "tokenCount": session.token_count,
        "durationMs": duration, "durationSource": duration.map(|_| "raw"),
        "availability": "unavailable", "diagnostic": null,
        "protocol": false, "compactions": null, "lastCompactionAt": null,
        "taskCount": null, "agentRunCount": null, "subagentRunCount": null,
        "backgroundRunCount": null, "activeStatuses": null, "contextArtifactCount": null,
        "memoryCount": null});
    if let Some(diagnostic) = &session.diagnostic {
        stats["diagnostic"] =
            json!({"code": diagnostic, "message": diagnostic, "retryable": false});
        stats["messageCount"] = Value::Null;
        stats["tokenCount"] = Value::Null;
        stats["durationMs"] = Value::Null;
        stats["durationSource"] = Value::Null;
        stats["protocol"] = Value::Null;
        return stats;
    }
    match core.protocol_list_stats(&session.session.provider, &session.session.session_id) {
        Ok(protocol) => {
            stats["availability"] = json!("available");
            stats["protocol"] = json!(true);
            stats["compactions"] = json!(protocol.compactions);
            stats["lastCompactionAt"] = json!(protocol.last_compaction_at);
            stats["taskCount"] = json!(protocol.task_count);
            stats["agentRunCount"] = json!(protocol.agent_run_count);
            stats["subagentRunCount"] = json!(protocol.subagent_run_count);
            stats["backgroundRunCount"] = json!(protocol.background_run_count);
            stats["activeStatuses"] = json!(protocol.active_statuses);
            stats["contextArtifactCount"] = json!(protocol.context_artifact_count);
            stats["memoryCount"] = json!(protocol.memory_count);
            if let Some(duration_ms) = protocol.duration_ms {
                stats["durationMs"] = json!(duration_ms);
                stats["durationSource"] = json!("protocol");
            }
        }
        Err(error) => {
            eprintln!(
                "legacy list stats: protocol unavailable for {}/{}: {error}",
                session.session.provider, session.session.session_id
            );
            stats["diagnostic"] = stats_diagnostic(error);
        }
    }
    stats
}

fn session_value(
    core: &Core,
    row: SessionSummary,
    starred: bool,
    return_to: &str,
    search_match: Option<Value>,
) -> Value {
    let stats = base_stats(core, &row);
    let href = link(&row, return_to);
    let mut value = json!({"id": row.session.session_id, "provider": row.session.provider,
        "title": row.title, "directory": row.directory.unwrap_or_default(),
        "time_updated": row.updated_at.unwrap_or(0), "summary_files": row.summary_files,
        "summary_additions": row.summary_additions, "summary_deletions": row.summary_deletions,
        "starred": starred,
        "stats": stats, "href": href});
    if let Some(diagnostic) = row.diagnostic {
        value["diagnostic"] = json!(diagnostic);
    }
    if let Some(search_match) = search_match {
        value["searchMatch"] = search_match;
    }
    value
}

fn legacy_provider_data_path(provider: &str, settings: &Value) -> String {
    let sources = &settings["startup"]["sources"];
    let (source_key, sessions_dir) = match provider {
        "opencode" => ("dbPath", false),
        "claude-code" => ("claudeDir", false),
        "codex" => ("codexDir", true),
        "pi" => ("piDir", true),
        "deepseek-harness" => ("dshDir", true),
        _ => unreachable!("provider-scoped routes validate known providers"),
    };
    let path = sources[source_key]
        .as_str()
        .expect("startup settings contain every provider source path");
    if sessions_dir {
        std::path::Path::new(path)
            .join("sessions")
            .to_string_lossy()
            .into_owned()
    } else {
        path.to_owned()
    }
}

fn content_sessions(
    core: &Core,
    params: &Params,
    limit: usize,
    offset: usize,
) -> Result<Value, CoreError> {
    let query = params.get("q").unwrap_or("").trim();
    let selected = params.providers();
    let diagnostics = source_diagnostics(core, &selected);
    if query.is_empty() {
        return Ok(attach_source_diagnostics(
            json!({"sessions": [], "total": 0, "offset": offset, "hasMore": false}),
            diagnostics,
        ));
    }
    let needed = offset.saturating_add(limit).saturating_add(1);
    let mut per_provider = Vec::new();
    let mut more = false;
    let mut summaries = HashMap::new();
    let mut stars = HashSet::new();
    for provider in selected {
        if !core
            .providers()
            .iter()
            .any(|status| status.id == provider && status.available)
        {
            continue;
        }
        summaries.extend(core.viewer_sessions(&provider)?.into_iter().map(|row| {
            (
                (row.session.provider.clone(), row.session.session_id.clone()),
                row,
            )
        }));
        stars.extend(
            core.viewer_meta_list(&provider)?
                .into_iter()
                .filter(|meta| meta.starred)
                .map(|meta| (provider.clone(), meta.session_id)),
        );
        let mut found = Vec::new();
        let mut cursor = None;
        while found.len() < needed {
            let result = core.viewer_search(SearchQuery {
                query: query.into(),
                providers: Some(vec![provider.clone()]),
                fields: Some(vec!["user".into(), "assistant".into()]),
                lineage: None,
                updated_after: None,
                updated_before: None,
                directory: None,
                cursor,
                limit: Some(needed.saturating_sub(found.len()).min(100)),
            })?;
            found.extend(result["matches"].as_array().into_iter().flatten().cloned());
            cursor = result["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        more |= cursor.is_some();
        per_provider.push(found);
    }
    let mut selected_rows = Vec::new();
    let longest = per_provider.iter().map(Vec::len).max().unwrap_or(0);
    let mut seen = HashSet::new();
    for rank in 0..longest {
        for matches in &per_provider {
            let Some(value) = matches.get(rank) else {
                continue;
            };
            let Some(provider) = value["session"]["provider"].as_str() else {
                continue;
            };
            let Some(id) = value["session"]["sessionId"].as_str() else {
                continue;
            };
            let key = (provider.to_owned(), id.to_owned());
            if !seen.insert(key.clone()) {
                continue;
            }
            let Some(summary) = summaries.get(&key) else {
                continue;
            };
            let search_match = json!({"messageId": value["event"]["messageId"],
                "role": value["matchRole"], "snippet": value["snippet"]});
            selected_rows.push((summary.clone(), stars.contains(&key), search_match));
        }
        if selected_rows.len() >= needed {
            break;
        }
    }
    let has_more = more || selected_rows.len() > offset.saturating_add(limit);
    let total = (!has_more).then_some(selected_rows.len());
    let sessions = selected_rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(summary, starred, search_match)| {
            session_value(
                core,
                summary,
                starred,
                params.get("returnTo").unwrap_or(""),
                Some(search_match),
            )
        })
        .collect::<Vec<_>>();
    Ok(attach_source_diagnostics(
        json!({"sessions": sessions, "total": total, "offset": offset, "hasMore": has_more}),
        diagnostics,
    ))
}

fn provider_content_sessions(
    core: &Core,
    params: &Params,
    limit: usize,
    offset: usize,
) -> Result<Value, CoreError> {
    let provider = params.get("provider").expect("provider-scoped route");
    let query = params.get("q").unwrap_or("").trim();
    let diagnostics = source_diagnostics(core, &[provider.to_owned()]);
    let summaries = core.viewer_sessions(provider)?;
    let by_id: HashMap<_, _> = summaries
        .iter()
        .map(|row| (row.session.session_id.clone(), row.clone()))
        .collect();
    let stars: HashSet<_> = core
        .viewer_meta_list(provider)?
        .into_iter()
        .filter(|meta| meta.starred)
        .map(|meta| meta.session_id)
        .collect();
    let mut title_hits = if core.legacy_content_title_first(provider)? {
        let term = query.to_lowercase();
        summaries
            .iter()
            .filter(|row| {
                row.parent.is_none()
                    && (row.title.to_lowercase().contains(&term)
                        || row
                            .directory
                            .as_deref()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&term))
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    title_hits.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
            .then_with(|| left.session.session_id.cmp(&right.session.session_id))
    });
    let mut seen: HashSet<String> = title_hits
        .iter()
        .map(|row| row.session.session_id.clone())
        .collect();
    let mut rows: Vec<_> = title_hits.into_iter().map(|row| (row, None)).collect();
    let needed = offset.saturating_add(limit).saturating_add(1);
    let mut cursor = None;
    while rows.len() < needed {
        let result = core.viewer_search(SearchQuery {
            query: query.into(),
            providers: Some(vec![provider.into()]),
            fields: Some(vec!["user".into(), "assistant".into()]),
            lineage: None,
            updated_after: None,
            updated_before: None,
            directory: None,
            cursor,
            limit: Some(100),
        })?;
        for matched in result["matches"].as_array().into_iter().flatten() {
            let Some(id) = matched["session"]["sessionId"].as_str() else {
                continue;
            };
            if !seen.insert(id.into()) {
                continue;
            }
            let Some(summary) = by_id.get(id) else {
                continue;
            };
            let search_match = json!({"messageId": matched["event"]["messageId"],
                "role": matched["matchRole"], "snippet": matched["snippet"]});
            rows.push((summary.clone(), Some(search_match)));
            if rows.len() >= needed {
                break;
            }
        }
        cursor = result["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    let has_more = rows.len() > offset.saturating_add(limit) || cursor.is_some();
    let total = (!has_more).then_some(rows.len());
    let sessions = rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(row, search_match)| {
            let starred = stars.contains(&row.session.session_id);
            session_value(
                core,
                row,
                starred,
                params.get("returnTo").unwrap_or(""),
                search_match,
            )
        })
        .collect::<Vec<_>>();
    Ok(attach_source_diagnostics(
        json!({"sessions": sessions, "total": total, "offset": offset, "hasMore": has_more}),
        diagnostics,
    ))
}

pub(super) async fn sessions(
    State(core): State<Arc<Core>>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let params = Params::parse(raw)?;
    sessions_with_params(core, params, false).await
}

pub(super) async fn provider_sessions(
    State(core): State<Arc<Core>>,
    Path(provider): Path<String>,
    RawQuery(raw): RawQuery,
    Extension(settings): Extension<SharedSettings>,
) -> Result<impl IntoResponse, ApiError> {
    if !PROVIDERS.contains(&provider.as_str()) {
        return Err(CoreError::NotFound {
            provider,
            session_id: String::new(),
        }
        .into());
    }
    let status = core
        .providers()
        .into_iter()
        .find(|status| status.id == provider)
        .expect("supported provider has a registered status");
    if !status.available {
        let settings = settings.lock().expect("runtime settings are not poisoned");
        return Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "ok": false,
                "error": "Provider not detected",
                "provider": status.id,
                "name": status.name,
                "dataPath": legacy_provider_data_path(&provider, &settings.snapshot),
            })),
        )
            .into_response());
    }
    let mut params = Params::parse(raw)?;
    params.0.retain(|(key, _)| key != "provider");
    params.0.push(("provider".into(), provider));
    Ok(sessions_with_params(core, params, true)
        .await?
        .into_response())
}

async fn sessions_with_params(
    core: Arc<Core>,
    params: Params,
    scoped: bool,
) -> Result<Json<Value>, ApiError> {
    let limit = params.limit();
    let content_requested = matches!(
        params.get("mode").or_else(|| params.get("searchMode")),
        Some("content")
    );
    let content =
        content_requested && (!scoped || !params.get("q").unwrap_or("").trim().is_empty());
    let offset = params.offset(content_requested)?;
    if content {
        let result = tokio::task::spawn_blocking(move || {
            if scoped {
                provider_content_sessions(&core, &params, limit, offset)
            } else {
                content_sessions(&core, &params, limit, offset)
            }
        })
        .await
        .map_err(joined_error)??;
        return Ok(Json(result));
    }
    let result = tokio::task::spawn_blocking(move || -> Result<Value, CoreError> {
        let selected = params.providers();
        let diagnostics = source_diagnostics(&core, &selected);
        let statuses = core.providers();
        let mut rows = Vec::new();
        let mut stars = HashSet::new();
        for provider in selected {
            if !statuses
                .iter()
                .any(|status| status.id == provider && status.available)
            {
                continue;
            }
            rows.extend(core.viewer_sessions(&provider)?);
            stars.extend(
                core.viewer_meta_list(&provider)?
                    .into_iter()
                    .filter(|meta| meta.starred)
                    .map(|meta| (provider.clone(), meta.session_id)),
            );
        }
        let search = params.get("q").unwrap_or("").to_lowercase();
        let project = params.get("project").unwrap_or("");
        let normalized_project = normalize_project_path(project);
        let range = params.get("range").unwrap_or("");
        let cutoff = list_range_cutoff(range);
        let parents: HashSet<_> = rows.iter().filter_map(|row| row.parent.clone()).collect();
        rows.retain(|row| {
            (params.starred() || row.parent.is_none())
                && (search.is_empty()
                    || row.title.to_lowercase().contains(&search)
                    || row
                        .directory
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&search))
                && (project.is_empty()
                    || (project == "__opensession_empty_project__"
                        && row.directory.as_deref().is_none_or(str::is_empty))
                    || (!project.is_empty()
                        && project != "__opensession_empty_project__"
                        && normalize_project_path(row.directory.as_deref().unwrap_or(""))
                            == normalized_project))
                && cutoff.is_none_or(|cutoff| row.updated_at.is_some_and(|time| time >= cutoff))
                && (!params.starred()
                    || stars
                        .contains(&(row.session.provider.clone(), row.session.session_id.clone())))
                && (!params.has("has-subagent") || parents.contains(&row.session))
        });
        rows.sort_by(|left, right| {
            let order = match params.sort() {
                "updated-asc" => left
                    .updated_at
                    .cmp(&right.updated_at)
                    .then_with(|| left.created_at.cmp(&right.created_at)),
                "title-asc" => left
                    .title
                    .to_lowercase()
                    .cmp(&right.title.to_lowercase())
                    .then_with(|| right.updated_at.cmp(&left.updated_at)),
                "title-desc" => right
                    .title
                    .to_lowercase()
                    .cmp(&left.title.to_lowercase())
                    .then_with(|| right.updated_at.cmp(&left.updated_at)),
                _ => right
                    .updated_at
                    .cmp(&left.updated_at)
                    .then_with(|| right.created_at.cmp(&left.created_at)),
            };
            order
                .then_with(|| left.session.provider.cmp(&right.session.provider))
                .then_with(|| left.session.session_id.cmp(&right.session.session_id))
        });
        let total = rows.len();
        let return_to = params.get("returnTo").unwrap_or("");
        let sessions = rows
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|row| {
                let starred =
                    stars.contains(&(row.session.provider.clone(), row.session.session_id.clone()));
                session_value(&core, row, starred, return_to, None)
            })
            .collect::<Vec<_>>();
        Ok(attach_source_diagnostics(
            json!({"sessions": sessions, "total": total, "offset": offset,
            "hasMore": offset.saturating_add(sessions.len()) < total}),
            diagnostics,
        ))
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}

pub(super) async fn families(
    State(core): State<Arc<Core>>,
    RawQuery(raw): RawQuery,
) -> Result<impl IntoResponse, ApiError> {
    let params = Params::parse(raw)?;
    let offset = params.offset(false)?;
    let selected = params.providers();
    let query = LibraryQuery {
        provider: None,
        providers: Some(selected.clone()),
        project: params.get("project").map(str::to_owned),
        search: params.get("q").map(str::to_owned),
        sort: Some(params.sort().into()),
        limit: Some(params.limit()),
        cursor: None,
        offset: Some(offset),
        range: params.get("range").map(str::to_owned),
        starred_only: Some(params.starred()),
        has_subagent: Some(params.has("has-subagent")),
        legacy_search: Some(true),
    };
    let (page, diagnostics) = tokio::task::spawn_blocking(move || {
        let page = core.library_families(query)?;
        let diagnostics = source_diagnostics(&core, &selected);
        Ok::<_, CoreError>((page, diagnostics))
    })
    .await
    .map_err(joined_error)??;
    let return_to = params.get("returnTo").unwrap_or("/sessions");
    let sessions = page
        .families
        .iter()
        .map(|node| family_value(node, return_to))
        .collect::<Vec<_>>();
    Ok(Json(attach_source_diagnostics(
        json!({"sessions": sessions, "total": page.total, "offset": offset,
        "hasMore": page.next_cursor.is_some(), "matchingSessions": page.matching_sessions}),
        diagnostics,
    )))
}

pub(super) async fn children(
    State(core): State<Arc<Core>>,
    RawQuery(raw): RawQuery,
) -> Result<impl IntoResponse, ApiError> {
    let params = Params::parse(raw)?;
    let offset = params.offset(false)?;
    let provider = params.get("parentProvider").unwrap_or("");
    let parent_id = params.get("parentId").unwrap_or("");
    if !PROVIDERS.contains(&provider) || !params.providers().iter().any(|value| value == provider) {
        return Err(CoreError::NotFound {
            provider: provider.into(),
            session_id: parent_id.into(),
        }
        .into());
    }
    let query = LibraryChildrenQuery {
        provider: provider.into(),
        parent_id: parent_id.into(),
        project: params.get("project").map(str::to_owned),
        search: params.get("q").map(str::to_owned),
        sort: Some(params.sort().into()),
        limit: Some(20),
        cursor: None,
        offset: Some(offset),
        range: params.get("range").map(str::to_owned),
        starred_only: Some(params.starred()),
        has_subagent: Some(params.has("has-subagent")),
        legacy_search: Some(true),
    };
    let selected = vec![provider.to_owned()];
    let (page, diagnostics) = tokio::task::spawn_blocking(move || {
        let page = core.library_children(query)?;
        let diagnostics = source_diagnostics(&core, &selected);
        Ok::<_, CoreError>((page, diagnostics))
    })
    .await
    .map_err(joined_error)??;
    let return_to = params.get("returnTo").unwrap_or("/sessions");
    let children = page
        .children
        .iter()
        .map(|node| family_value(node, return_to))
        .collect::<Vec<_>>();
    let shown = page.children.len();
    Ok(Json(attach_source_diagnostics(
        json!({"children": children, "total": page.total, "offset": offset, "shown": shown,
        "nextOffset": page.next_cursor.map(|_| offset + shown)}),
        diagnostics,
    )))
}

#[cfg(test)]
mod stats_diagnostic_tests {
    use super::*;

    #[test]
    fn source_change_is_retryable_and_retains_the_http_error_contract() {
        let diagnostic = stats_diagnostic(CoreError::SourceChanged);
        assert_eq!(diagnostic["code"], "source_changed");
        assert_eq!(diagnostic["retryable"], true);
        assert_eq!(diagnostic["message"], CoreError::SourceChanged.to_string());
    }

    #[test]
    fn source_failure_keeps_its_actual_code_and_message() {
        let diagnostic = stats_diagnostic(CoreError::Storage("fixture SQL failure".into()));
        assert_eq!(diagnostic["code"], "storage_error");
        assert_eq!(diagnostic["retryable"], false);
        assert_eq!(
            diagnostic["message"],
            "derived catalog storage: fixture SQL failure"
        );
    }
}
