//! Readable headers from Codex's recorded execution-tool input contracts.
use serde_json::Value;

#[derive(Default, Debug, PartialEq)]
pub(super) struct ToolPresentation {
    pub(super) summary: Option<String>,
    pub(super) directory: Option<String>,
}

pub(super) fn tool_presentation(payload: &Value) -> ToolPresentation {
    let name = payload["name"].as_str();
    match (payload["type"].as_str(), name) {
        (Some("custom_tool_call"), Some("exec")) => ToolPresentation {
            summary: payload["input"].as_str().and_then(code_summary),
            directory: None,
        },
        (Some("function_call"), Some("exec_command" | "exec")) => {
            let Some(args) = arguments(payload) else {
                return ToolPresentation::default();
            };
            ToolPresentation {
                summary: args["cmd"].as_str().and_then(line_summary),
                directory: nonempty(&args["workdir"]),
            }
        }
        (Some("function_call"), Some("js")) if payload["namespace"] == "mcp__cua_repl" => {
            let Some(args) = arguments(payload) else {
                return ToolPresentation::default();
            };
            ToolPresentation {
                summary: args["title"]
                    .as_str()
                    .and_then(line_summary)
                    .or_else(|| args["code"].as_str().and_then(code_summary)),
                directory: None,
            }
        }
        _ => ToolPresentation::default(),
    }
}

fn arguments(payload: &Value) -> Option<Value> {
    serde_json::from_str(payload["arguments"].as_str()?).ok()
}

fn nonempty(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn line_summary(text: &str) -> Option<String> {
    let first = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    let mut characters = first.chars();
    let mut summary: String = characters.by_ref().take(180).collect();
    if characters.next().is_some() {
        summary.pop();
        summary.push('…');
    }
    Some(summary)
}

fn code_summary(code: &str) -> Option<String> {
    let line = code
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("//"))?;
    // Current functions.exec records these JavaScript orchestration calls as
    // raw input. Decode only a literal cmd in the known exec_command wrapper;
    // expressions and other tool calls retain their recorded code summary.
    let call = line
        .strip_prefix("text(await tools.exec_command(")
        .or_else(|| line.strip_prefix("await tools.exec_command("));
    if let Some(object) = call.and_then(|call| call.trim_start().strip_prefix('{')) {
        let field = object.trim_start();
        let value = field
            .strip_prefix("cmd")
            .or_else(|| field.strip_prefix("\"cmd\""))
            .and_then(|field| field.trim_start().strip_prefix(':'));
        if let Some(command) = value.and_then(|value| {
            serde_json::Deserializer::from_str(value.trim_start())
                .into_iter::<String>()
                .next()?
                .ok()
        }) {
            return line_summary(&command);
        }
    }
    line_summary(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(name: &str, args: Value) -> Value {
        json!({"type":"function_call","name":name,"arguments":args.to_string()})
    }

    #[test]
    fn command_headers_are_distinct_and_preserve_recorded_directory() {
        let first = tool_presentation(&call(
            "exec_command",
            json!({"cmd":"\n  git status --short\n git remote -v", "workdir":"D:\\WorkSpace\\OpenSession"}),
        ));
        let second = tool_presentation(&call("exec", json!({"cmd":"cargo test --locked"})));
        assert_eq!(first.summary.as_deref(), Some("git status --short"));
        assert_eq!(
            first.directory.as_deref(),
            Some("D:\\WorkSpace\\OpenSession")
        );
        assert_eq!(second.summary.as_deref(), Some("cargo test --locked"));
        assert_eq!(second.directory, None);
    }

    #[test]
    fn raw_exec_exposes_literal_command_instead_of_orchestration_prefix() {
        let command = "rg -n '<script>& \"quoted\"' src; Write-Output '$HOME'";
        let code = format!(
            "// @exec: {{\"max_output_tokens\":1000}}\ntext(await tools.exec_command({{cmd:{}}}));",
            serde_json::to_string(command).unwrap()
        );
        let result =
            tool_presentation(&json!({"type":"custom_tool_call","name":"exec","input":code}));
        assert_eq!(result.summary.as_deref(), Some(command));
        assert_eq!(result.directory, None);
        let another = tool_presentation(
            &json!({"type":"custom_tool_call","name":"exec","input":"await tools.exec_command({cmd: \"cargo fmt --check\"});"}),
        );
        assert_eq!(another.summary.as_deref(), Some("cargo fmt --check"));
    }

    #[test]
    fn raw_exec_keeps_expressions_and_other_actions_as_recorded_code() {
        let code = "text(await tools.exec_command({cmd: command}));";
        assert_eq!(code_summary(code).as_deref(), Some(code));
        let action = "const results = await Promise.allSettled([";
        assert_eq!(code_summary(action).as_deref(), Some(action));
    }

    #[test]
    fn browser_js_uses_its_recorded_action_title() {
        let mut payload = call(
            "js",
            json!({"code":"await cua.getState();", "title":"Inspect the current browser"}),
        );
        payload["namespace"] = json!("mcp__cua_repl");
        assert_eq!(
            tool_presentation(&payload).summary.as_deref(),
            Some("Inspect the current browser")
        );
        payload["namespace"] = json!("unrelated");
        assert_eq!(tool_presentation(&payload), ToolPresentation::default());
    }

    #[test]
    fn summaries_bound_unicode_without_cutting_encoded_characters() {
        let result = line_summary(&"测".repeat(181)).unwrap();
        assert_eq!(result.chars().count(), 180);
        assert!(result.ends_with('…'));
        assert_eq!(
            line_summary(&"测".repeat(180)).unwrap().chars().count(),
            180
        );
        assert!(!line_summary(&"测".repeat(180)).unwrap().ends_with('…'));
    }

    #[test]
    fn unknown_or_invalid_recorded_inputs_do_not_invent_commands() {
        assert_eq!(
            tool_presentation(&call("other", json!({"cmd":"not a command contract"}))),
            ToolPresentation::default()
        );
        assert_eq!(
            tool_presentation(
                &json!({"type":"function_call","name":"exec_command","arguments":"broken JSON"})
            ),
            ToolPresentation::default()
        );
        assert_eq!(
            tool_presentation(&call("exec_command", json!({"cmd":42}))).summary,
            None
        );
        assert_eq!(line_summary("  \n\t"), None);
    }
}
