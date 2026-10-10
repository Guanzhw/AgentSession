use agentsession_core::{
    ContentQuery, Core, CoreError, InheritedContentQuery, LibraryChildrenQuery, LibraryQuery,
    ReaderBootstrapQuery, ReaderLocateQuery, ReaderSearchQuery, SearchQuery, StatsQuery,
    StatsReport, TeamMessageContentQuery,
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use include_dir::{Dir, include_dir};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

static UI: Dir<'_> = include_dir!("$OUT_DIR/static");

#[path = "legacy_lists.rs"]
mod legacy_lists;

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl From<CoreError> for ApiError {
    fn from(error: CoreError) -> Self {
        let (status, code) = match error {
            CoreError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "provider_unavailable"),
            CoreError::NotFound { .. } => (StatusCode::NOT_FOUND, "session_not_found"),
            CoreError::EventNotFound(_) => (StatusCode::NOT_FOUND, "event_not_found"),
            CoreError::SourceChanged => (StatusCode::CONFLICT, "source_changed"),
            CoreError::InvalidInput(_) => (StatusCode::BAD_REQUEST, "invalid_request"),
            CoreError::InvalidCursor => (StatusCode::BAD_REQUEST, "invalid_cursor"),
            CoreError::Io { .. } | CoreError::Parse { .. } => {
                (StatusCode::INTERNAL_SERVER_ERROR, "source_error")
            }
            CoreError::Storage(_) => (StatusCode::INTERNAL_SERVER_ERROR, "storage_error"),
            CoreError::Protocol(ref diagnostic) => match diagnostic {
                agentsession_core::protocol::ProtocolError::Unavailable { .. } => {
                    (StatusCode::SERVICE_UNAVAILABLE, "protocol_unavailable")
                }
                agentsession_core::protocol::ProtocolError::Invalid { .. } => {
                    (StatusCode::UNPROCESSABLE_ENTITY, "protocol_invalid")
                }
                agentsession_core::protocol::ProtocolError::InvalidCursor => {
                    (StatusCode::BAD_REQUEST, "invalid_cursor")
                }
                agentsession_core::protocol::ProtocolError::InvalidQuery { .. } => {
                    (StatusCode::BAD_REQUEST, "invalid_request")
                }
            },
        };
        Self {
            status,
            code,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": {"code": self.code, "message": self.message}})),
        )
            .into_response()
    }
}

fn joined_error(error: tokio::task::JoinError) -> ApiError {
    ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "internal_error",
        message: error.to_string(),
    }
}

async fn providers(State(core): State<Arc<Core>>) -> impl IntoResponse {
    Json(core.providers())
}

async fn system_prompts(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    if !core.providers().iter().any(|item| item.id == provider) {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            code: "provider_not_found",
            message: format!("provider {provider} was not found"),
        });
    }
    let evidence =
        tokio::task::spawn_blocking(move || core.system_prompt_evidence(&provider, &session_id))
            .await
            .map_err(joined_error)??;
    Ok(Json(evidence))
}

#[derive(Deserialize)]
struct SessionsQuery {
    provider: String,
}

async fn sessions(
    State(core): State<Arc<Core>>,
    Query(query): Query<SessionsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let rows = tokio::task::spawn_blocking(move || core.viewer_sessions(&query.provider))
        .await
        .map_err(joined_error)??;
    Ok(Json(rows))
}

async fn library_families(
    State(core): State<Arc<Core>>,
    Query(query): Query<LibraryQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let page = tokio::task::spawn_blocking(move || core.library_families(query))
        .await
        .map_err(joined_error)??;
    Ok(Json(page))
}

async fn library_children(
    State(core): State<Arc<Core>>,
    Query(query): Query<LibraryChildrenQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let page = tokio::task::spawn_blocking(move || core.library_children(query))
        .await
        .map_err(joined_error)??;
    Ok(Json(page))
}

async fn source_stats(
    core: Arc<Core>,
    settings: SharedSettings,
    provider: String,
    query: StatsParams,
) -> Result<StatsReport, ApiError> {
    if provider != "all" && !core.providers().iter().any(|item| item.id == provider) {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            code: "provider_not_found",
            message: format!("provider {provider} was not found"),
        });
    }
    let range = StatsQuery::from_params(
        query.days.as_deref(),
        query.from.as_deref(),
        query.to.as_deref(),
        query.scope.as_deref(),
        query.directory.as_deref(),
        query.model.as_deref(),
        query.model_provider.as_deref(),
        query.project.as_deref(),
        query.day.as_deref(),
    )?;
    tokio::task::spawn_blocking(move || {
        let mut report = if provider == "all" {
            let selected = query
                .providers
                .map(|value| value.split(',').map(str::to_owned).collect::<Vec<_>>())
                .unwrap_or_else(|| core.providers().into_iter().map(|row| row.id).collect());
            core.stats_selected(&selected, range)?
        } else {
            if query.providers.is_some() {
                return Err(CoreError::InvalidInput(
                    "stats Harness selection requires the all endpoint".into(),
                ));
            }
            core.stats_filtered(&provider, range)?
        };
        report.apply_token_pricing(
            &settings
                .lock()
                .expect("runtime settings lock")
                .token_pricing,
        )?;
        Ok::<StatsReport, CoreError>(report)
    })
    .await
    .map_err(joined_error)?
    .map_err(ApiError::from)
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct StatsParams {
    providers: Option<String>,
    days: Option<String>,
    from: Option<String>,
    to: Option<String>,
    scope: Option<String>,
    directory: Option<String>,
    model: Option<String>,
    #[serde(rename = "modelProvider")]
    model_provider: Option<String>,
    project: Option<String>,
    day: Option<String>,
}

async fn stats(
    State(core): State<Arc<Core>>,
    axum::Extension(settings): axum::Extension<SharedSettings>,
    Path(provider): Path<String>,
    Query(query): Query<StatsParams>,
) -> Result<Response, ApiError> {
    let report = source_stats(core, settings, provider, query).await?;
    #[cfg(feature = "stats-phase-probe")]
    let phase_started = std::time::Instant::now();
    let response = Json(report).into_response();
    #[cfg(feature = "stats-phase-probe")]
    if std::env::var_os("AGENTSESSION_V3_STATS_PHASE_PROBE").as_deref()
        == Some(std::ffi::OsStr::new("1"))
    {
        eprintln!(
            "{}",
            serde_json::json!({
                "kind": "stats_serialization_probe",
                "serialization_ms": phase_started.elapsed().as_secs_f64() * 1000.0,
            })
        );
    }
    Ok(response)
}

async fn stats_json(
    State(core): State<Arc<Core>>,
    axum::Extension(settings): axum::Extension<SharedSettings>,
    Path(provider): Path<String>,
    Query(query): Query<StatsParams>,
) -> Result<Response, ApiError> {
    let report = source_stats(core, settings, provider, query).await?;
    let filename = format!(
        "attachment; filename=\"token-explorer-{}.json\"",
        report.provider
    );
    let body = serde_json::to_vec_pretty(&report).map_err(|error| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "serialization_error",
        message: error.to_string(),
    })?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CONTENT_DISPOSITION, filename.as_str()),
        ],
        Body::from(body),
    )
        .into_response())
}

async fn stats_csv(
    State(core): State<Arc<Core>>,
    axum::Extension(settings): axum::Extension<SharedSettings>,
    Path(provider): Path<String>,
    Query(query): Query<StatsParams>,
) -> Result<Response, ApiError> {
    let report = source_stats(core, settings, provider, query).await?;
    let filename = format!(
        "attachment; filename=\"token-explorer-{}.csv\"",
        report.provider
    );
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (header::CONTENT_DISPOSITION, filename.as_str()),
        ],
        Body::from(report.to_csv()),
    )
        .into_response())
}

#[derive(Deserialize)]
struct WebSearchQuery {
    q: String,
    provider: Option<String>,
    fields: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}

async fn search(
    State(core): State<Arc<Core>>,
    Query(query): Query<WebSearchQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let request = SearchQuery {
        query: query.q,
        providers: query
            .provider
            .map(|value| value.split(',').map(str::to_owned).collect()),
        fields: query
            .fields
            .map(|value| value.split(',').map(str::to_owned).collect()),
        cursor: query.cursor,
        limit: query.limit,
        lineage: None,
        updated_after: None,
        updated_before: None,
        directory: None,
    };
    let result = tokio::task::spawn_blocking(move || core.viewer_search(request))
        .await
        .map_err(joined_error)??;
    Ok(Json(result))
}

fn trusted_mutation(headers: &HeaderMap) -> Result<(), ApiError> {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let port = host
        .strip_prefix("127.0.0.1:")
        .or_else(|| host.strip_prefix("localhost:"));
    let host_valid = port.is_some_and(|value| value.parse::<u16>().is_ok());
    let origin_valid = headers.get(header::ORIGIN).is_none_or(|value| {
        value
            .to_str()
            .ok()
            .is_some_and(|origin| origin == format!("http://{host}"))
    });
    if !host_valid || !origin_valid {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "untrusted_origin",
            message: "Viewer mutations require a loopback same-origin request".into(),
        });
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MetadataMutation {
    title: Option<String>,
}

async fn mutate(
    State(core): State<Arc<Core>>,
    Path((provider, session_id, action)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<MetadataMutation>,
) -> Result<impl IntoResponse, ApiError> {
    trusted_mutation(&headers)?;
    let result = tokio::task::spawn_blocking(move || {
        core.viewer_mutate(&provider, &session_id, &action, body.title.as_deref())
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}

async fn export_session(
    State(core): State<Arc<Core>>,
    Path((provider, session_id, action)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    if action != "export" {
        return retired_session_api(&core, &provider, &session_id, &action);
    }
    Ok((
        StatusCode::GONE,
        Json(json!({
            "error": {
                "code": "session_export_removed",
                "message": "Session downloads are no longer available in AgentSession 3.0."
            }
        })),
    )
        .into_response())
}

fn encoded_path(segments: &[&str]) -> String {
    let mut url = url::Url::parse("http://localhost").expect("constant base URL");
    url.path_segments_mut()
        .expect("base URL supports paths")
        .extend(segments);
    url.path().to_owned()
}

fn retired_session_api(
    core: &Core,
    provider: &str,
    session_id: &str,
    action: &str,
) -> Result<Response, ApiError> {
    let replacement = match action {
        "reader" => Some(("reader", "bootstrap")),
        "reader/coordination" => Some(("runtime", "coordination")),
        "reader/event" => Some(("runtime", "events")),
        "inherited-context" => Some(("reader", "inherited-context")),
        "context-result" => Some(("runtime", "context")),
        "search" => Some(("reader", "search")),
        "protocol" => Some(("protocol", "")),
        "runtime/summary" => Some(("runtime", "summary")),
        "runtime/events" => Some(("runtime", "events")),
        "runtime/graph" => Some(("runtime", "graph")),
        "runtime/work" => Some(("runtime", "work")),
        "runtime/execution" => Some(("runtime", "execution")),
        "runtime/coordination" => Some(("runtime", "coordination")),
        "runtime/context" => Some(("runtime", "context")),
        _ => None,
    };
    let Some((family, suffix)) =
        replacement.filter(|_| core.providers().iter().any(|item| item.id == provider))
    else {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: "API route not found".into(),
        });
    };
    let mut segments = vec!["api", "v3", family, provider, session_id];
    if !suffix.is_empty() {
        segments.push(suffix);
    }
    Ok((
        StatusCode::GONE,
        Json(json!({
            "error": {
                "code": "http_contract_migrated",
                "message": "AgentSession 3.0 uses versioned Reader, Search, Protocol and Runtime schemas. Obtain a fresh native revision and cursor; legacy query and response shapes have changed."
            },
            "session": {"provider": provider, "sessionId": session_id},
            "migration": {
                "api": encoded_path(&segments),
                "page": encoded_path(&[provider, "session", session_id]),
                "documentation": "v3/README.md#http-contract-migration",
                "restartFromFreshRevision": true
            }
        })),
    )
        .into_response())
}

async fn retired_runtime_api(
    State(core): State<Arc<Core>>,
    Path((provider, session_id, domain)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    retired_session_api(&core, &provider, &session_id, &format!("runtime/{domain}"))
}

async fn retired_coordination_api(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    retired_session_api(&core, &provider, &session_id, "reader/coordination")
}

async fn retired_reader_event_api(
    State(core): State<Arc<Core>>,
    Path((provider, session_id, _event_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    retired_session_api(&core, &provider, &session_id, "reader/event")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchMutation {
    ids: Vec<String>,
    action: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CrossProviderBatchMutation {
    items: Vec<CrossProviderBatchItem>,
    action: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CrossProviderBatchItem {
    provider: String,
    id: String,
}

async fn batch(
    State(core): State<Arc<Core>>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    Json(body): Json<BatchMutation>,
) -> Result<impl IntoResponse, ApiError> {
    trusted_mutation(&headers)?;
    let affected =
        tokio::task::spawn_blocking(move || core.viewer_batch(&provider, &body.ids, &body.action))
            .await
            .map_err(joined_error)??;
    Ok(Json(json!({"ok": true, "affected": affected})))
}

async fn batch_across_providers(
    State(core): State<Arc<Core>>,
    headers: HeaderMap,
    Json(body): Json<CrossProviderBatchMutation>,
) -> Result<impl IntoResponse, ApiError> {
    trusted_mutation(&headers)?;
    if !matches!(
        body.action.as_str(),
        "delete" | "star" | "unstar" | "restore" | "permanent-delete"
    ) {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": "Invalid action"})),
        ));
    }

    let manageable: std::collections::HashSet<_> = core
        .providers()
        .into_iter()
        .filter(|provider| provider.manageable)
        .map(|provider| provider.id)
        .collect();
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for item in body.items {
        if item.provider.is_empty() || item.id.is_empty() {
            continue;
        }
        if let Some((_, ids)) = groups
            .iter_mut()
            .find(|(provider, _)| provider == &item.provider)
        {
            ids.push(item.id);
        } else {
            groups.push((item.provider, vec![item.id]));
        }
    }

    let mut affected = 0;
    let mut skipped = 0;
    for (provider, ids) in groups {
        if !manageable.contains(&provider) {
            skipped += ids.len();
            continue;
        }
        let requested = ids.len();
        let mut seen = std::collections::HashSet::new();
        let unique_ids: Vec<_> = ids
            .into_iter()
            .filter(|id| seen.insert(id.clone()))
            .collect();
        for ids in unique_ids.chunks(100) {
            let action = body.action.clone();
            let provider = provider.clone();
            let ids = ids.to_vec();
            let provider_core = Arc::clone(&core);
            tokio::task::spawn_blocking(move || {
                provider_core.viewer_batch(&provider, &ids, &action)
            })
            .await
            .map_err(joined_error)??;
        }
        affected += requested;
    }

    Ok((
        StatusCode::OK,
        Json(json!({"ok": true, "affected": affected, "skipped": skipped})),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReindexRequest {}

async fn reindex(
    State(core): State<Arc<Core>>,
    headers: HeaderMap,
    Json(_body): Json<ReindexRequest>,
) -> Result<impl IntoResponse, ApiError> {
    trusted_mutation(&headers)?;
    let results = tokio::task::spawn_blocking(move || core.reindex())
        .await
        .map_err(joined_error)?;
    let ok = results.iter().all(|result| result.status != "error");
    Ok((
        if ok {
            StatusCode::OK
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        },
        Json(json!({"ok": ok, "results": results})),
    ))
}

async fn metadata(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || core.viewer_meta(&provider, &session_id))
        .await
        .map_err(joined_error)??;
    Ok(Json(result))
}

async fn metadata_list(
    State(core): State<Arc<Core>>,
    Query(query): Query<SessionsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || core.viewer_meta_list(&query.provider))
        .await
        .map_err(joined_error)??;
    Ok(Json(result))
}

async fn trash(
    State(core): State<Arc<Core>>,
    Query(query): Query<SessionsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || core.viewer_trash(&query.provider))
        .await
        .map_err(joined_error)??;
    Ok(Json(result))
}

async fn bootstrap(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<ReaderBootstrapQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || {
        core.viewer_reader_bootstrap_at(&provider, &session_id, query)
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}

async fn content(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<ContentQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result =
        tokio::task::spawn_blocking(move || core.reader_content(&provider, &session_id, query))
            .await
            .map_err(joined_error)??;
    Ok(Json(result))
}

async fn team_message_content(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<TeamMessageContentQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || {
        core.reader_team_message_content(&provider, &session_id, query)
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}

async fn reader_artifacts(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || core.reader_artifacts(&provider, &session_id))
        .await
        .map_err(joined_error)??;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactContentQuery {
    revision: String,
    offset: usize,
    max_chars: usize,
}

async fn reader_artifact_content(
    State(core): State<Arc<Core>>,
    Path((provider, session_id, artifact_id)): Path<(String, String, String)>,
    Query(query): Query<ArtifactContentQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || {
        core.reader_artifact_content(
            &provider,
            &session_id,
            &artifact_id,
            &query.revision,
            query.offset,
            query.max_chars,
        )
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InheritedContextQuery {
    limit: Option<usize>,
    cursor: Option<String>,
}

async fn inherited_context(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<InheritedContextQuery>,
) -> Result<Response, ApiError> {
    let result = tokio::task::spawn_blocking(move || {
        core.reader_inherited_context(
            &provider,
            &session_id,
            query.limit.unwrap_or(40),
            query.cursor.as_deref(),
        )
    })
    .await
    .map_err(joined_error)??;
    Ok(match result {
        Some(page) => Json(page).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    })
}

async fn inherited_content(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<InheritedContentQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || {
        core.reader_inherited_content(&provider, &session_id, query)
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}

async fn reader_search(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<ReaderSearchQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result =
        tokio::task::spawn_blocking(move || core.reader_search(&provider, &session_id, query))
            .await
            .map_err(joined_error)??;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolEventsQuery {
    category: Option<String>,
    kind: Option<String>,
    #[serde(rename = "executionOnly")]
    execution_only: Option<bool>,
    limit: Option<usize>,
    cursor: Option<String>,
}

async fn protocol_events(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<ProtocolEventsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let page = tokio::task::spawn_blocking(move || {
        let stream = core.protocol_event_stream(&provider, &session_id)?;
        let page = stream
            .events(agentsession_core::protocol::EventQuery {
                category: query.category,
                kind: query.kind,
                execution_only: query.execution_only.unwrap_or(false),
                limit: query.limit.unwrap_or(50),
                cursor: query.cursor,
            })
            .map_err(CoreError::from)?;
        serde_json::to_value(page).map_err(|error| ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "serialization_error",
            message: error.to_string(),
        })
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(page))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolEventDetailQuery {
    revision: String,
}

async fn protocol_event_detail(
    State(core): State<Arc<Core>>,
    Path((provider, session_id, event_id)): Path<(String, String, String)>,
    Query(query): Query<ProtocolEventDetailQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let detail = tokio::task::spawn_blocking(move || {
        core.protocol_event_detail(&provider, &session_id, &event_id, &query.revision)
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(detail))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolDocumentQuery {
    version: Option<u8>,
}

async fn protocol_document(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<ProtocolDocumentQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || {
        core.protocol_document(&provider, &session_id, query.version.unwrap_or(3))
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolWorkQuery {
    kind: Option<String>,
    status: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
}

async fn protocol_work(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<ProtocolWorkQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || {
        core.protocol_work_page(
            &provider,
            &session_id,
            agentsession_core::protocol::WorkQuery {
                kind: query.kind,
                status: query.status,
                limit: query.limit.unwrap_or(50),
                cursor: query.cursor,
            },
        )
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}

async fn protocol_summary(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let result =
        tokio::task::spawn_blocking(move || core.protocol_runtime_summary(&provider, &session_id))
            .await
            .map_err(joined_error)??;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtocolGraphQuery {
    max_nodes: Option<usize>,
}

async fn protocol_graph(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<ProtocolGraphQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result = tokio::task::spawn_blocking(move || {
        core.protocol_runtime_graph(
            &provider,
            &session_id,
            agentsession_core::protocol::GraphQuery {
                max_nodes: query.max_nodes.unwrap_or(100),
            },
        )
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolDomainQuery {
    kind: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
}

async fn protocol_domain(
    State(core): State<Arc<Core>>,
    Path((provider, session_id, domain)): Path<(String, String, String)>,
    Query(query): Query<ProtocolDomainQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let domain = match domain.as_str() {
        "execution" => agentsession_core::protocol::RuntimeDomain::Execution,
        "coordination" => agentsession_core::protocol::RuntimeDomain::Coordination,
        "context" => agentsession_core::protocol::RuntimeDomain::Context,
        _ => {
            return Err(ApiError {
                status: StatusCode::NOT_FOUND,
                code: "runtime_domain_not_found",
                message: "unknown runtime domain".into(),
            });
        }
    };
    let result = tokio::task::spawn_blocking(move || {
        core.protocol_runtime_domain(
            &provider,
            &session_id,
            domain,
            agentsession_core::protocol::DomainQuery {
                kind: query.kind,
                limit: query.limit.unwrap_or(50),
                cursor: query.cursor,
            },
        )
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorQuery {
    cursor: String,
}

async fn segments(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<CursorQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            core.reader_segments(&provider, &session_id, &query.cursor)
        })
        .await
        .map_err(joined_error)??,
    ))
}

async fn relations(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<CursorQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            core.reader_relations(&provider, &session_id, &query.cursor)
        })
        .await
        .map_err(joined_error)??,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReaderExecutionsQuery {
    revision: String,
    cursor: Option<String>,
    limit: Option<usize>,
}

async fn reader_executions(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<ReaderExecutionsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            core.reader_executions(
                &provider,
                &session_id,
                &query.revision,
                query.cursor.as_deref(),
                query.limit.unwrap_or(200),
            )
        })
        .await
        .map_err(joined_error)??,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChildLocationQuery {
    revision: String,
    child_provider: String,
    child_session_id: String,
}

async fn child_location(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<ChildLocationQuery>,
) -> Result<impl IntoResponse, ApiError> {
    if query.revision.is_empty()
        || query.revision.len() > 256
        || query.child_provider.is_empty()
        || query.child_provider.len() > 64
        || query.child_session_id.is_empty()
        || query.child_session_id.len() > 4096
        || query.child_session_id.contains('\0')
    {
        return Err(CoreError::InvalidInput("invalid child location reference".into()).into());
    }
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            core.reader_child_location(
                &provider,
                &session_id,
                &query.revision,
                &agentsession_core::SessionRef {
                    provider: query.child_provider,
                    session_id: query.child_session_id,
                },
            )
        })
        .await
        .map_err(joined_error)??,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TocQuery {
    cursor: String,
    limit: Option<usize>,
}

async fn toc(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<TocQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            core.reader_toc_with_limit(
                &provider,
                &session_id,
                &query.cursor,
                query.limit.unwrap_or(64),
            )
        })
        .await
        .map_err(joined_error)??,
    ))
}

async fn locate(
    State(core): State<Arc<Core>>,
    Path((provider, session_id)): Path<(String, String)>,
    Query(query): Query<ReaderLocateQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        tokio::task::spawn_blocking(move || core.reader_locate(&provider, &session_id, query))
            .await
            .map_err(joined_error)??,
    ))
}

fn asset(path: &str) -> Option<Response> {
    let file = UI.get_file(path)?;
    let content_type = match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    Some(
        (
            [(header::CONTENT_TYPE, content_type)],
            Body::from(file.contents().to_vec()),
        )
            .into_response(),
    )
}

async fn static_files(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": {"code": "not_found", "message": "API route not found"}
            })),
        )
            .into_response();
    }
    if path.starts_with("assets/") {
        return asset(path).unwrap_or_else(|| StatusCode::NOT_FOUND.into_response());
    }
    let reader_route = path.split('/').collect::<Vec<_>>();
    let is_reader = reader_route.len() == 3
        && reader_route[1] == "session"
        && ["opencode", "claude-code", "codex", "pi", "deepseek-harness"]
            .contains(&reader_route[0]);
    let is_provider_page = reader_route.len() == 2
        && ["stats", "search"].contains(&reader_route[1])
        && ["opencode", "claude-code", "codex", "pi", "deepseek-harness"]
            .contains(&reader_route[0]);
    if path.is_empty()
        || path == "sessions"
        || path == "sessions/search"
        || path == "settings"
        || path == "stats"
        || is_provider_page
        || is_reader
    {
        return asset("index.html")
            .unwrap_or_else(|| StatusCode::SERVICE_UNAVAILABLE.into_response());
    }
    StatusCode::NOT_FOUND.into_response()
}

pub async fn serve(
    core: Arc<Core>,
    port: u16,
    mut settings: Value,
    resume_config: crate::resume::ResumeConfig,
    token_pricing: agentsession_core::TokenPricingDocument,
    open_browser: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    settings["startup"]["allowTerminalLaunch"] = json!(resume_config.enabled);
    let runtime_settings = Arc::new(std::sync::Mutex::new(crate::config::RuntimeSettings {
        snapshot: settings,
        resume: resume_config,
        token_pricing,
    }));
    let app = Router::new()
        .route(
            "/api/v3/resume/{provider}/{session_id}",
            get(resume_info).post(resume_launch),
        )
        .route(
            "/api/{provider}/session/{session_id}/resume",
            get(resume_info).post(resume_launch),
        )
        .route("/api/providers", get(providers))
        .route("/api/sessions", get(legacy_lists::sessions))
        .route(
            "/api/{provider}/sessions",
            get(legacy_lists::provider_sessions),
        )
        .route("/api/library/sessions", get(legacy_lists::families))
        .route("/api/library/children", get(legacy_lists::children))
        .route(
            "/api/{provider}/session/{session_id}/system-prompts",
            get(system_prompts),
        )
        .route(
            "/api/{provider}/session/{session_id}/runtime/{domain}",
            get(retired_runtime_api),
        )
        .route(
            "/api/{provider}/session/{session_id}/reader/coordination",
            get(retired_coordination_api),
        )
        .route(
            "/api/{provider}/session/{session_id}/reader/event/{event_id}",
            get(retired_reader_event_api),
        )
        .route("/api/settings", get(settings_info).post(settings_update))
        .route("/api/v3/sessions", get(sessions))
        .route("/api/v3/library/sessions", get(library_families))
        .route("/api/v3/library/children", get(library_children))
        .route("/api/v3/stats/{provider}", get(stats))
        .route("/api/v3/stats/{provider}/export.json", get(stats_json))
        .route("/api/v3/stats/{provider}/export.csv", get(stats_csv))
        .route("/api/v3/search", get(search))
        .route("/api/v3/meta/{provider}/{session_id}", get(metadata))
        .route("/api/v3/meta", get(metadata_list))
        .route("/api/v3/trash", get(trash))
        .route("/api/sessions/batch", post(batch_across_providers))
        .route(
            "/api/{provider}/session/{session_id}/{action}",
            get(export_session).post(mutate),
        )
        .route("/api/{provider}/batch", post(batch))
        .route("/api/reindex", post(reindex))
        .route(
            "/api/v3/reader/{provider}/{session_id}/segments",
            get(segments),
        )
        .route(
            "/api/v3/reader/{provider}/{session_id}/relations",
            get(relations),
        )
        .route(
            "/api/v3/reader/{provider}/{session_id}/executions",
            get(reader_executions),
        )
        .route(
            "/api/v3/reader/{provider}/{session_id}/child-location",
            get(child_location),
        )
        .route(
            "/api/v3/reader/{provider}/{session_id}/inherited-context",
            get(inherited_context),
        )
        .route(
            "/api/v3/reader/{provider}/{session_id}/inherited-context/content",
            get(inherited_content),
        )
        .route("/api/v3/reader/{provider}/{session_id}/toc", get(toc))
        .route("/api/v3/reader/{provider}/{session_id}/locate", get(locate))
        .route(
            "/api/v3/reader/{provider}/{session_id}/search",
            get(reader_search),
        )
        .route(
            "/api/v3/reader/{provider}/{session_id}/bootstrap",
            get(bootstrap),
        )
        .route(
            "/api/v3/reader/{provider}/{session_id}/content",
            get(content),
        )
        .route(
            "/api/v3/reader/{provider}/{session_id}/team-message/content",
            get(team_message_content),
        )
        .route(
            "/api/v3/reader/{provider}/{session_id}/artifacts",
            get(reader_artifacts),
        )
        .route(
            "/api/v3/reader/{provider}/{session_id}/artifacts/{artifact_id}/content",
            get(reader_artifact_content),
        )
        .route(
            "/api/v3/runtime/{provider}/{session_id}/events",
            get(protocol_events),
        )
        .route(
            "/api/v3/runtime/{provider}/{session_id}/events/{event_id}",
            get(protocol_event_detail),
        )
        .route(
            "/api/v3/protocol/{provider}/{session_id}",
            get(protocol_document),
        )
        .route(
            "/api/v3/runtime/{provider}/{session_id}/work",
            get(protocol_work),
        )
        .route(
            "/api/v3/runtime/{provider}/{session_id}/summary",
            get(protocol_summary),
        )
        .route(
            "/api/v3/runtime/{provider}/{session_id}/graph",
            get(protocol_graph),
        )
        .route(
            "/api/v3/runtime/{provider}/{session_id}/{domain}",
            get(protocol_domain),
        )
        .fallback(static_files)
        .layer(axum::Extension(runtime_settings))
        .with_state(core);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("AgentSession 3.0 listening on http://127.0.0.1:{port}");
    if open_browser {
        if let Err(error) = crate::browser::open(port) {
            eprintln!("Could not open the Viewer in the default browser: {error}");
        }
    }
    axum::serve(listener, app).await?;
    Ok(())
}

type SharedSettings = Arc<std::sync::Mutex<crate::config::RuntimeSettings>>;

async fn settings_info(axum::Extension(settings): axum::Extension<SharedSettings>) -> Json<Value> {
    Json(
        settings
            .lock()
            .expect("runtime settings lock")
            .snapshot
            .clone(),
    )
}

async fn settings_update(
    axum::Extension(settings): axum::Extension<SharedSettings>,
    headers: HeaderMap,
    Json(patch): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    trusted_mutation(&headers)?;
    if !headers.contains_key(header::ORIGIN) {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "untrusted_origin",
            message: "Saving settings requires a same-origin request".into(),
        });
    }
    let result = tokio::task::spawn_blocking(move || {
        settings
            .lock()
            .expect("runtime settings lock")
            .update(patch)
    })
    .await
    .map_err(joined_error)?;
    result.map(Json).map_err(|error| match error {
        crate::config::SettingsError::Invalid(message) => ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_settings",
            message,
        },
        crate::config::SettingsError::Save(message) => ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "settings_save_failed",
            message,
        },
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResumeRequest {}
async fn resume_info(
    State(core): State<Arc<Core>>,
    axum::Extension(settings): axum::Extension<SharedSettings>,
    Path((provider, session_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let config = settings
        .lock()
        .expect("runtime settings lock")
        .resume
        .clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::resume::resolve(&core, &config, &provider, &session_id)
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}
async fn resume_launch(
    State(core): State<Arc<Core>>,
    axum::Extension(settings): axum::Extension<SharedSettings>,
    Path((provider, session_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(_body): Json<ResumeRequest>,
) -> Result<impl IntoResponse, ApiError> {
    trusted_mutation(&headers)?;
    let config = settings
        .lock()
        .expect("runtime settings lock")
        .resume
        .clone();
    if !headers.contains_key(header::ORIGIN) || !config.enabled {
        return Err(ApiError {
            status: StatusCode::FORBIDDEN,
            code: "terminal_launch_forbidden",
            message: "Terminal launch requires a same-origin request and startup permission".into(),
        });
    }
    let result = tokio::task::spawn_blocking(move || {
        let info = crate::resume::resolve(&core, &config, &provider, &session_id)?;
        crate::resume::launch(info, &config).map_err(|message| ApiError {
            status: StatusCode::CONFLICT,
            code: "resume_unavailable",
            message,
        })
    })
    .await
    .map_err(joined_error)??;
    Ok(Json(result))
}
