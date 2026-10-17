use crate::config::McpLimits;
use agentsession_core::{
    BrowseQuery, ContentPage, Core, CoreError, EventDetail, EventReadOptions, EventRef,
    SearchQuery, SessionRef, TeamMessageRef, TimelineFilters,
};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler, ServiceExt,
    model::{
        CacheScope, CallToolRequestMethod, CallToolRequestParams, CallToolResponse, CallToolResult,
        ContentBlock, Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities,
        ServerConfig, Tool,
    },
    service::RequestContext,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, LazyLock};

static TOOLS: LazyLock<Vec<Tool>> = LazyLock::new(|| {
    let definitions: Value = serde_json::from_str(include_str!("../mcp-tools.json"))
        .expect("MCP schema definitions must parse");
    serde_json::from_value(definitions["tools"].clone())
        .expect("MCP tool definitions must fit rmcp")
});

#[derive(Clone)]
struct HistoryServer {
    core: Arc<Core>,
    limits: McpLimits,
    pending_search_utf16: crate::mcp_input::SearchUnits,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetEventArgs {
    #[serde(default)]
    event: Value,
    revision: Option<String>,
    #[serde(default)]
    offset: usize,
    max_chars: Option<usize>,
    #[serde(default)]
    include_thinking: bool,
    #[serde(default)]
    include_tool_input: bool,
    #[serde(default)]
    include_tool_output: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetSessionArgs {
    #[serde(default)]
    session: Value,
    child_limit: Option<usize>,
    child_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimelineArgs {
    #[serde(default)]
    session: Value,
    query: Option<String>,
    segments: Option<Vec<String>>,
    roles: Option<Vec<String>>,
    tool_names: Option<Vec<String>>,
    statuses: Option<Vec<String>>,
    cursor: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextArgs {
    #[serde(default)]
    event: Value,
    #[serde(default)]
    include_thinking: bool,
    before: Option<usize>,
    after: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TeamMessagesArgs {
    action: String,
    session: Option<Value>,
    message: Option<Value>,
    revision: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
    offset: Option<usize>,
    max_chars: Option<usize>,
}

fn page_value(page: &ContentPage) -> Value {
    json!({
        "text": page.text,
        "offset": page.offset,
        "totalChars": page.total_chars,
        "nextOffset": page.next_offset,
        "truncated": page.truncated,
        "untrustedContent": true,
    })
}

fn continuation(
    event: &EventRef,
    revision: &str,
    page: &ContentPage,
    max_chars: usize,
    opt_in: Value,
) -> Value {
    match page.next_offset {
        Some(offset) => {
            let mut args = json!({"event": event, "revision": revision, "offset": offset, "maxChars": max_chars});
            if let (Some(args), Some(opt_in)) = (args.as_object_mut(), opt_in.as_object()) {
                args.extend(opt_in.clone());
            }
            args
        }
        None => Value::Null,
    }
}

fn event_result(detail: EventDetail, max_chars: usize) -> Value {
    let EventDetail {
        event,
        revision,
        role,
        timestamp,
        content,
        tool_name,
        status,
        tool_input,
        tool_output,
        ..
    } = detail;
    match event.segment.as_str() {
        "tool" => json!({
            "event": event,
            "revision": revision,
            "role": role,
            "timestamp": timestamp,
            "untrustedContent": true,
            "toolName": tool_name,
            "status": status,
            "toolInput": tool_input.as_ref().map(page_value),
            "toolOutput": tool_output.as_ref().map(page_value),
            "continuations": {
                "toolInput": tool_input.as_ref().map(|page| continuation(&event, &revision, page, max_chars, json!({"includeToolInput": true}))),
                "toolOutput": tool_output.as_ref().map(|page| continuation(&event, &revision, page, max_chars, json!({"includeToolOutput": true}))),
            },
        }),
        "thinking" => json!({
            "event": event,
            "revision": revision,
            "role": role,
            "timestamp": timestamp,
            "untrustedContent": true,
            "content": page_value(content.as_ref().expect("thinking event has content")),
            "continuation": continuation(&event, &revision, content.as_ref().expect("thinking event has content"), max_chars, json!({"includeThinking": true})),
        }),
        _ => json!({
            "event": event,
            "revision": revision,
            "role": role,
            "timestamp": timestamp,
            "untrustedContent": true,
            "content": page_value(content.as_ref().expect("message event has content")),
            "continuation": continuation(&event, &revision, content.as_ref().expect("message event has content"), max_chars, json!({})),
        }),
    }
}

fn tool_error(code: &str, message: &str) -> CallToolResponse {
    CallToolResult::error(vec![ContentBlock::text(format!("{code}: {message}"))]).into()
}

fn tool_success(summary: impl Into<String>, result: impl Serialize) -> CallToolResponse {
    let mut response = CallToolResult::success(vec![ContentBlock::text(summary.into())]);
    response.structured_content = Some(json!({
        "result": result,
        "untrustedContent": true,
    }));
    response.into()
}

fn core_diagnostic(tool: &str, error: &CoreError) -> Option<Value> {
    let mut diagnostic = json!({"kind": "mcp_operation_error", "tool": tool});
    match error {
        CoreError::Io { path, source } => {
            diagnostic["stage"] = json!("source_io");
            diagnostic["path"] = json!(path);
            diagnostic["cause"] = json!(source.to_string());
        }
        CoreError::Parse {
            path,
            diagnostic: parse,
            ..
        } => {
            diagnostic["stage"] = json!("source_parse");
            diagnostic["path"] = json!(path);
            diagnostic["cause"] = json!(parse.cause);
            if let Some(line) = parse.line {
                diagnostic["line"] = json!(line);
            }
            if let Some(column) = parse.column {
                diagnostic["column"] = json!(column);
            }
        }
        CoreError::Storage(cause) => {
            diagnostic["stage"] = json!("storage");
            diagnostic["cause"] = json!(cause);
        }
        _ => return None,
    }
    Some(diagnostic)
}

fn blocking_diagnostic(tool: &str, error: &tokio::task::JoinError) -> Value {
    json!({
        "kind": "mcp_operation_error", "tool": tool, "stage": "spawn_blocking",
        "cause": if error.is_panic() { "blocking task panicked" } else { "blocking task cancelled" },
    })
}

fn blocking_error(tool: &str, error: tokio::task::JoinError) -> CallToolResponse {
    eprintln!("{}", blocking_diagnostic(tool, &error));
    tool_error("internal_error", "MCP operation failed.")
}

fn core_error(tool: &str, error: CoreError) -> CallToolResponse {
    if let Some(diagnostic) = core_diagnostic(tool, &error) {
        eprintln!("{diagnostic}");
    }
    match error {
        CoreError::Unavailable(_) => tool_error("provider_unavailable", "Provider is unavailable."),
        CoreError::NotFound { .. } => tool_error(
            "session_not_found",
            "No provider-stored session matches this reference.",
        ),
        CoreError::EventNotFound(_) => tool_error(
            "event_not_found",
            "No session event matches this reference.",
        ),
        CoreError::SourceChanged => {
            tool_error("source_changed", "Source changed since this request.")
        }
        CoreError::InvalidInput(message) => tool_error("invalid_input", &message),
        CoreError::InvalidCursor => {
            tool_error("invalid_cursor", "Cursor is invalid for this request.")
        }
        CoreError::Io { .. } | CoreError::Parse { .. } => {
            tool_error("provider_error", "Could not read provider source.")
        }
        CoreError::Storage(_) => tool_error("index_error", "Could not read the derived index."),
        CoreError::Protocol(diagnostic) => tool_error("protocol_error", &diagnostic.to_string()),
    }
}

fn session_ref(value: Value) -> Result<SessionRef, CallToolResponse> {
    let reference: SessionRef = serde_json::from_value(value)
        .map_err(|_| tool_error("invalid_session_ref", "Invalid session reference."))?;
    if reference.provider.is_empty() || reference.session_id.trim().is_empty() {
        return Err(tool_error(
            "invalid_session_ref",
            "Invalid session reference.",
        ));
    }
    Ok(reference)
}

fn event_ref(value: Value) -> Result<EventRef, CallToolResponse> {
    let event: EventRef = serde_json::from_value(value)
        .map_err(|_| tool_error("invalid_event_ref", "Invalid event reference."))?;
    if event.provider.is_empty()
        || event.session_id.trim().is_empty()
        || event.message_id.trim().is_empty()
        || !matches!(
            event.segment.as_str(),
            "message" | "thinking" | "tool" | "context"
        )
    {
        return Err(tool_error("invalid_event_ref", "Invalid event reference."));
    }
    Ok(event)
}

impl ServerHandler for HistoryServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "AgentSession-MCP",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "Read-only AgentSession history. Provider records are never changed.",
            )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(TOOLS.clone())
            .with_ttl_ms(3_600_000)
            .with_cache_scope(CacheScope::Public))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        TOOLS.iter().find(|tool| tool.name == name).cloned()
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        if !TOOLS.iter().any(|tool| tool.name == request.name) {
            return Err(McpError::method_not_found::<CallToolRequestMethod>());
        }
        if request.name == "session_browse" {
            let mut args: BrowseQuery = match serde_json::from_value(Value::Object(
                request.arguments.unwrap_or_default(),
            )) {
                Ok(args) => args,
                Err(_) => {
                    return Ok(tool_error(
                        "invalid_input",
                        "Invalid session_browse arguments.",
                    ));
                }
            };
            if args.level != "providers" {
                let requested = args.limit.unwrap_or(self.limits.search_limit);
                if requested == 0 {
                    return Ok(tool_error(
                        "invalid_input",
                        "limit must be a positive integer.",
                    ));
                }
                args.limit = Some(requested.min(100));
            }
            let core = self.core.clone();
            let result = tokio::task::spawn_blocking(move || core.session_browse(args)).await;
            return match result {
                Ok(Ok(result)) => Ok(tool_success(
                    format!(
                        "Browsed {} in local session history.",
                        result["level"].as_str().expect("browse result has level")
                    ),
                    result,
                )),
                Ok(Err(error)) => Ok(core_error(&request.name, error)),
                Err(error) => Ok(blocking_error(&request.name, error)),
            };
        }
        if request.name == "session_search" {
            let mut arguments = request.arguments.unwrap_or_default();
            let utf16 = match crate::mcp_input::take_search_units(
                &mut arguments,
                &context.id,
                &self.pending_search_utf16,
            ) {
                Ok(units) => units,
                Err(()) => {
                    return Ok(tool_error(
                        "invalid_input",
                        "Invalid session_search UTF-16 boundary.",
                    ));
                }
            };
            let mut args: SearchQuery = match serde_json::from_value(Value::Object(arguments)) {
                Ok(args) => args,
                Err(_) => {
                    return Ok(tool_error(
                        "invalid_input",
                        "Invalid session_search arguments.",
                    ));
                }
            };
            let requested = args.limit.unwrap_or(self.limits.search_limit);
            if requested == 0 {
                return Ok(tool_error(
                    "invalid_input",
                    "limit must be a positive integer.",
                ));
            }
            args.limit = Some(requested.min(self.limits.search_limit));
            let core = self.core.clone();
            let result = tokio::task::spawn_blocking(move || match utf16 {
                Some(units) => core.session_search_utf16(args, units),
                None => core.session_search(args),
            })
            .await;
            return match result {
                Ok(Ok(result)) => {
                    let count = result["matches"]
                        .as_array()
                        .expect("session_search result has matches")
                        .len();
                    let more = !result["nextCursor"].is_null();
                    Ok(tool_success(
                        format!(
                            "Search returned {count} matches{}.",
                            if more { " with more available" } else { "" }
                        ),
                        result,
                    ))
                }
                Ok(Err(error)) => Ok(core_error(&request.name, error)),
                Err(error) => Ok(blocking_error(&request.name, error)),
            };
        }
        if request.name == "session_get" {
            let args: GetSessionArgs = match serde_json::from_value(Value::Object(
                request.arguments.unwrap_or_default(),
            )) {
                Ok(args) => args,
                Err(_) => {
                    return Ok(tool_error(
                        "invalid_input",
                        "Invalid session_get arguments.",
                    ));
                }
            };
            let session = match session_ref(args.session) {
                Ok(session) => session,
                Err(error) => return Ok(error),
            };
            let core = self.core.clone();
            let result = tokio::task::spawn_blocking(move || {
                core.session_get(
                    &session.provider,
                    &session.session_id,
                    args.child_limit.unwrap_or(50),
                    args.child_cursor.as_deref(),
                )
            })
            .await;
            return match result {
                Ok(Ok(result)) => Ok(tool_success(
                    format!(
                        "Loaded session overview with {} direct child summary(s).",
                        result.children.len()
                    ),
                    result,
                )),
                Ok(Err(error)) => Ok(core_error(&request.name, error)),
                Err(error) => Ok(blocking_error(&request.name, error)),
            };
        }
        if request.name == "session_timeline" {
            let args: TimelineArgs = match serde_json::from_value(Value::Object(
                request.arguments.unwrap_or_default(),
            )) {
                Ok(args) => args,
                Err(_) => {
                    return Ok(tool_error(
                        "invalid_input",
                        "Invalid session_timeline arguments.",
                    ));
                }
            };
            let session = match session_ref(args.session) {
                Ok(session) => session,
                Err(error) => return Ok(error),
            };
            let requested = args.limit.unwrap_or(self.limits.timeline_limit);
            if requested == 0 {
                return Ok(tool_error(
                    "invalid_input",
                    "limit must be a positive integer.",
                ));
            }
            let limit = requested.min(self.limits.timeline_limit);
            let core = self.core.clone();
            let result = tokio::task::spawn_blocking(move || {
                core.session_timeline(
                    &session.provider,
                    &session.session_id,
                    TimelineFilters {
                        segments: args.segments,
                        roles: args.roles,
                        tool_names: args.tool_names,
                        statuses: args.statuses,
                        query: args.query,
                    },
                    limit,
                    args.cursor.as_deref(),
                )
            })
            .await;
            return match result {
                Ok(Ok(result)) => Ok(tool_success(
                    format!("Loaded {} session event summary(s).", result.events.len()),
                    result,
                )),
                Ok(Err(error)) => Ok(core_error(&request.name, error)),
                Err(error) => Ok(blocking_error(&request.name, error)),
            };
        }
        if request.name == "session_get_context" {
            let args: ContextArgs = match serde_json::from_value(Value::Object(
                request.arguments.unwrap_or_default(),
            )) {
                Ok(args) => args,
                Err(_) => {
                    return Ok(tool_error(
                        "invalid_input",
                        "Invalid session_get_context arguments.",
                    ));
                }
            };
            let event = match event_ref(args.event) {
                Ok(event) => event,
                Err(error) => return Ok(error),
            };
            if event.segment == "thinking" && !args.include_thinking {
                return Ok(tool_error(
                    "thinking_opt_in_required",
                    "Set includeThinking to true before reading a thinking event.",
                ));
            }
            let before = args
                .before
                .unwrap_or(self.limits.context_window)
                .min(self.limits.context_window);
            let after = args
                .after
                .unwrap_or(self.limits.context_window)
                .min(self.limits.context_window);
            let core = self.core.clone();
            let result = tokio::task::spawn_blocking(move || {
                core.session_context(&event, before, after, args.include_thinking)
            })
            .await;
            return match result {
                Ok(Ok(result)) => Ok(tool_success(
                    format!(
                        "Loaded {} contextual event summary(s).",
                        result.events.len()
                    ),
                    result,
                )),
                Ok(Err(error)) => Ok(core_error(&request.name, error)),
                Err(error) => Ok(blocking_error(&request.name, error)),
            };
        }
        if request.name == "session_team_messages" {
            let args: TeamMessagesArgs = match serde_json::from_value(Value::Object(
                request.arguments.unwrap_or_default(),
            )) {
                Ok(args) => args,
                Err(_) => {
                    return Ok(tool_error(
                        "invalid_input",
                        "Invalid session_team_messages arguments.",
                    ));
                }
            };
            if args.action == "list" {
                if args.message.is_some()
                    || args.revision.is_some()
                    || args.offset.is_some()
                    || args.max_chars.is_some()
                    || args.session.is_none()
                {
                    return Ok(tool_error(
                        "invalid_input",
                        "Invalid team message list arguments.",
                    ));
                }
                let session = match session_ref(args.session.expect("checked")) {
                    Ok(session) => session,
                    Err(error) => return Ok(error),
                };
                let requested = args.limit.unwrap_or(self.limits.timeline_limit);
                if requested == 0 {
                    return Ok(tool_error(
                        "invalid_input",
                        "limit must be a positive integer.",
                    ));
                }
                let limit = requested.min(100);
                let core = self.core.clone();
                let result = tokio::task::spawn_blocking(move || {
                    core.session_team_messages(&session, limit, args.cursor.as_deref())
                })
                .await;
                return match result {
                    Ok(Ok(page)) => Ok(tool_success(
                        format!("Listed {} queued team message(s).", page.messages.len()),
                        page,
                    )),
                    Ok(Err(CoreError::Unavailable(reason)))
                        if reason == "native team messages are unavailable for this provider" =>
                    {
                        Ok(tool_error(
                            "content_unavailable",
                            "Native team messages are unavailable for this provider.",
                        ))
                    }
                    Ok(Err(error)) => Ok(core_error(&request.name, error)),
                    Err(error) => Ok(blocking_error(&request.name, error)),
                };
            }
            if args.action == "read" {
                if args.session.is_some()
                    || args.limit.is_some()
                    || args.cursor.is_some()
                    || args.message.is_none()
                    || args.revision.is_none()
                {
                    return Ok(tool_error(
                        "invalid_input",
                        "Invalid team message read arguments.",
                    ));
                }
                let message: TeamMessageRef =
                    match serde_json::from_value(args.message.expect("checked")) {
                        Ok(message) => message,
                        Err(_) => {
                            return Ok(tool_error(
                                "invalid_input",
                                "Invalid team message reference.",
                            ));
                        }
                    };
                let revision = args.revision.expect("checked");
                let offset = args.offset.unwrap_or(0);
                let max_chars = args
                    .max_chars
                    .unwrap_or(self.limits.event_max_chars)
                    .min(self.limits.event_max_chars);
                let core = self.core.clone();
                let result = tokio::task::spawn_blocking({
                    let message = message.clone();
                    let revision = revision.clone();
                    move || core.session_team_message_read(&message, &revision, offset, max_chars)
                })
                .await;
                return match result {
                    Ok(Ok(page)) => {
                        let continuation = page.next_offset.map(|next| {
                            json!({
                                "action": "read", "message": message, "revision": revision,
                                "offset": next, "maxChars": max_chars,
                            })
                        });
                        Ok(tool_success(
                            "Read queued team message content.",
                            json!({
                                "message": message, "revision": revision,
                                "content": page_value(&page), "continuation": continuation,
                            }),
                        ))
                    }
                    Ok(Err(CoreError::Unavailable(reason)))
                        if reason == "native team messages are unavailable for this provider" =>
                    {
                        Ok(tool_error(
                            "content_unavailable",
                            "Native team messages are unavailable for this provider.",
                        ))
                    }
                    Ok(Err(error)) => Ok(core_error(&request.name, error)),
                    Err(error) => Ok(blocking_error(&request.name, error)),
                };
            }
            return Ok(tool_error("invalid_input", "action must be list or read."));
        }
        if request.name != "session_get_event" {
            return Ok(CallToolResult::structured_error(json!({
                "result": {"error": {"code": "not_implemented", "message": format!("{} is not implemented in the S2 slice", request.name)}},
                "untrustedContent": true,
            })).into());
        }
        let arguments = Value::Object(request.arguments.unwrap_or_default());
        let args: GetEventArgs = match serde_json::from_value(arguments) {
            Ok(args) => args,
            Err(_) => {
                return Ok(tool_error(
                    "invalid_input",
                    "Invalid session_get_event arguments.",
                ));
            }
        };
        let event = match event_ref(args.event) {
            Ok(event) => event,
            Err(error) => return Ok(error),
        };
        if args.revision.as_deref() == Some("") {
            return Ok(tool_error("invalid_input", "revision must not be empty"));
        }
        if event.segment == "thinking" && !args.include_thinking {
            return Ok(tool_error(
                "thinking_opt_in_required",
                "Set includeThinking to true before reading a thinking event.",
            ));
        }
        let requested = args.max_chars.unwrap_or(self.limits.event_max_chars);
        if requested == 0 || args.offset > 9_007_199_254_740_991 {
            return Ok(tool_error(
                "invalid_input",
                "offset or maxChars exceeds the allowed bound",
            ));
        }
        let max_chars = requested.min(self.limits.event_max_chars);
        let options = EventReadOptions {
            include_thinking: args.include_thinking,
            include_tool_input: args.include_tool_input,
            include_tool_output: args.include_tool_output,
        };
        let core = self.core.clone();
        let result = match tokio::task::spawn_blocking(move || {
            core.get_event_with_revision(
                &event,
                args.offset,
                max_chars,
                options,
                args.revision.as_deref(),
            )
        })
        .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => return Ok(core_error(&request.name, error)),
            Err(error) => return Ok(blocking_error(&request.name, error)),
        };
        Ok(tool_success(
            "Loaded one bounded session event.",
            event_result(result, max_chars),
        ))
    }
}

pub async fn serve(core: Arc<Core>, limits: McpLimits) -> Result<(), Box<dyn std::error::Error>> {
    let (read, write, pending_search_utf16) = crate::mcp_input::stdio();
    let service = HistoryServer {
        core,
        limits,
        pending_search_utf16,
    }
    .serve((read, write))
    .await?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_diagnostic_keeps_source_path_without_untrusted_reason() {
        let error = CoreError::Parse {
            diagnostic: agentsession_core::ParseDiagnostic::new("invalid provider source"),
            path: "fixture/source.jsonl".into(),
            reason: "unknown record PRIVATE_RECORD_SENTINEL at line 2 column 9".into(),
        };
        let diagnostic = core_diagnostic("session_get", &error).unwrap();
        assert_eq!(diagnostic["tool"], "session_get");
        assert_eq!(diagnostic["stage"], "source_parse");
        assert_eq!(diagnostic["path"], "fixture/source.jsonl");
        assert_eq!(diagnostic["cause"], "invalid provider source");
        assert!(!diagnostic.to_string().contains("PRIVATE_RECORD_SENTINEL"));
    }

    #[tokio::test]
    async fn blocking_panic_keeps_internal_wire_error_and_safe_diagnostic() {
        let error = tokio::task::spawn_blocking(|| {
            std::panic::panic_any(("PRIVATE_PANIC_SENTINEL",));
        })
        .await
        .unwrap_err();
        let diagnostic = blocking_diagnostic("session_get", &error);
        assert_eq!(diagnostic["stage"], "spawn_blocking");
        assert_eq!(diagnostic["tool"], "session_get");
        assert_eq!(diagnostic["cause"], "blocking task panicked");
        assert!(!diagnostic.to_string().contains("PRIVATE_PANIC_SENTINEL"));
        let CallToolResponse::Complete(response) = blocking_error("session_get", error) else {
            panic!("blocking failure must complete with a tool error");
        };
        let response = serde_json::to_value(response).unwrap();
        assert_eq!(response["isError"], true);
        assert_eq!(
            response["content"],
            json!([{"type": "text", "text": "internal_error: MCP operation failed."}])
        );
        assert!(response.get("structuredContent").is_none());
    }

    #[tokio::test]
    async fn blocking_cancellation_has_a_distinct_diagnostic() {
        let (ready, started) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started.await.unwrap();
        task.abort();
        let error = task.await.unwrap_err();
        let diagnostic = blocking_diagnostic("session_browse", &error);
        assert_eq!(diagnostic["cause"], "blocking task cancelled");
    }
}
