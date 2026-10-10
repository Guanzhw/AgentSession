use super::*;

// The prior borrowed projection is the full-content oracle for the ownership change.
fn copied_snapshot(session: LoadedSession) -> SessionSnapshot {
    let fields = session.messages.iter().flat_map(|message| {
        message_segments(message)
            .into_iter()
            .map(move |segment| (message, segment))
    });
    let events = project_items(&session)
        .into_iter()
        .zip(fields)
        .map(|(item, (message, segment))| NormalizedEvent {
            body: if segment == "tool" {
                String::new()
            } else {
                segment_content(message, segment).into()
            },
            tool_input: message.tool_input.clone(),
            tool_output: message.tool_output.clone(),
            tool_status: None,
            item,
        })
        .collect();
    SessionSnapshot {
        summary: summarize(&session),
        revision: session.revision,
        events,
        relations: session.relations,
    }
}

fn snapshot_digest(snapshot: &SessionSnapshot) -> String {
    let mut digest = Sha256::new();
    for field in [
        serde_json::to_vec(&snapshot.summary).unwrap(),
        snapshot.revision.as_bytes().to_vec(),
        serde_json::to_vec(&snapshot.relations).unwrap(),
    ] {
        digest.update((field.len() as u64).to_le_bytes());
        digest.update(field);
    }
    for event in &snapshot.events {
        let item = serde_json::to_vec(&event.item).unwrap();
        let status = serde_json::to_vec(&event.tool_status).unwrap();
        for field in [
            item.as_slice(),
            event.body.as_bytes(),
            event.tool_input.as_bytes(),
            event.tool_output.as_bytes(),
            status.as_slice(),
        ] {
            digest.update((field.len() as u64).to_le_bytes());
            digest.update(field);
        }
    }
    format!("{:x}", digest.finalize())
}

#[test]
fn snapshot_moves_complete_payloads_and_matches_borrowed_projection() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.jsonl");
    let long_text = "Full recorded content 中文 🦀\n".repeat(20_000);
    let rows = [
        serde_json::json!({"type":"session_meta","payload":{"id":"move-test","cwd":"/work"}}),
        serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","id":"user","content":[{"type":"input_text","text":"Request"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text"]}}}),
        serde_json::json!({"type":"response_item","payload":{"type":"reasoning","id":"reasoning","summary":[{"type":"summary_text","text":long_text}]}}),
        serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","id":"answer","phase":"final_answer","content":[{"type":"output_text","text":long_text}]}}),
        serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"call","name":"exec_command","arguments":long_text}}),
        serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":long_text}}),
        serde_json::json!({"type":"compacted","payload":{"message":long_text}}),
    ];
    let source = rows
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(&path, source.as_bytes()).unwrap();
    let before_hash = format!("{:x}", Sha256::digest(source.as_bytes()));
    let session = load_codex(&path, "move-test", "move-test").unwrap();
    let expected = copied_snapshot(session);
    let session = load_codex(&path, "move-test", "move-test").unwrap();
    let allocations: Vec<_> = session
        .messages
        .iter()
        .flat_map(|message| {
            [
                (&message.body, "body"),
                (&message.thinking, "body"),
                (&message.tool_input, "tool_input"),
                (&message.tool_output, "tool_output"),
            ]
            .into_iter()
            .filter(|(text, _)| !text.is_empty())
            .map(|(text, field)| (text.as_ptr(), text.len(), field))
        })
        .collect();
    let actual = codex_snapshot_from_loaded(session).unwrap();
    assert_eq!(snapshot_digest(&actual), snapshot_digest(&expected));
    assert_eq!(actual.events.len(), 5);
    for (pointer, length, field) in allocations {
        assert!(
            actual.events.iter().any(|event| {
                let value = match field {
                    "body" => &event.body,
                    "tool_input" => &event.tool_input,
                    "tool_output" => &event.tool_output,
                    _ => unreachable!(),
                };
                value.as_ptr() == pointer && value.len() == length
            }),
            "{field} allocation was copied"
        );
    }
    assert_eq!(
        format!("{:x}", Sha256::digest(fs::read(&path).unwrap())),
        before_hash
    );
}

#[test]
#[ignore = "requires explicitly selected frozen read-only Codex source"]
fn frozen_source_projection_benchmark() {
    let path = PathBuf::from(std::env::var("CODEX_PRIVATE_SOURCE").unwrap());
    let mode = std::env::var("CODEX_PROJECTION_MODE").unwrap();
    let id = read_header(&path).unwrap().unwrap().0;
    let source_revision = codex_revision_file(&path, "projection-benchmark").unwrap();
    let started = std::time::Instant::now();
    let session = load_codex(&path, "projection-benchmark", &id).unwrap();
    let load_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let projected_bytes: usize = session
        .messages
        .iter()
        .map(|message| {
            message.body.len()
                + message.thinking.len()
                + message.tool_input.len()
                + message.tool_output.len()
        })
        .sum();
    let started = std::time::Instant::now();
    let snapshot = match mode.as_str() {
        "copied" => copied_snapshot(session),
        "moved" => codex_snapshot_from_loaded(session).unwrap(),
        _ => panic!("unknown projection mode"),
    };
    let projection_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let digest = snapshot_digest(&snapshot);
    assert_eq!(snapshot.revision, source_revision);
    assert_eq!(
        codex_revision_file(&path, "projection-benchmark").unwrap(),
        source_revision
    );
    eprintln!(
        "projection mode={mode} load_ms={load_ms:.3} projection_ms={projection_ms:.3} payload_bytes={projected_bytes} events={} digest={digest}",
        snapshot.events.len()
    );
}
