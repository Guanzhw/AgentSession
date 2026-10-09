use super::*;
use serde_json::json;

fn fixture(rows: Vec<Value>) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let sessions = directory.path().join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let path = sessions.join("native.jsonl");
    let mut source = json!({"type":"session_meta","payload":{"id":"native","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent","call_id":"spawn-call"}}}}}).to_string();
    for row in rows {
        source.push('\n');
        source.push_str(&row.to_string());
    }
    source.push('\n');
    fs::write(&path, source).unwrap();
    (directory, path)
}

fn native(directory: &Path) -> Value {
    serde_json::to_value(
        CodexAdapter {
            root: directory,
            scope: "native-test",
        }
        .native_protocol_snapshot("native")
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn native_snapshot_preserves_tasks_runs_relationships_and_context_with_partial_coverage() {
    let (directory, path) = fixture(vec![
        json!({"type":"response_item","payload":{"type":"agent_message","id":"assignment","content":[{"type":"text","text":"Message Type: NEW_TASK\nTask name: worker"}]}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn","started_at":100}}),
        json!({"type":"compacted","payload":{"window_id":"next","previous_window_id":"prior","first_window_id":"first"}}),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn","started_at":100,"completed_at":110}}),
    ]);
    let before = fs::read(&path).unwrap();
    let value = native(directory.path());
    assert_eq!(value["schema"], "agentsession.protocol-observations.v1");
    assert_eq!(value["completeness"], "partial");
    assert_eq!(value["validation"]["status"], "valid");
    assert_eq!(value["tasks"][0]["id"], "assignment");
    assert_eq!(value["tasks"][0]["status"], "unknown");
    assert_eq!(value["agentRuns"][0]["id"], "run:turn:turn:100000");
    assert_eq!(value["agentRuns"][0]["timeEnd"], 110000);
    assert_eq!(value["agentRuns"][0]["status"], "completed");
    assert!(value["agentRuns"][0]["taskId"].is_null());
    assert_eq!(value["relationships"][0]["kind"], "spawned");
    assert_eq!(value["relationships"][0]["from"]["sessionId"], "parent");
    assert_eq!(
        value["relationships"][0]["evidence"]["provenance"]["fidelity"],
        "recorded"
    );
    assert_eq!(value["contextObservations"][0]["windowId"], "next");
    assert_eq!(value["contextObservations"][0]["summaryAvailable"], false);
    assert_eq!(value["coverage"]["usage"]["state"], "not-observed");
    assert_eq!(value["coverage"]["agentRuns"]["state"], "observed");
    assert_eq!(value["sourceRecordCount"], 5);
    assert_eq!(
        value["revision"],
        CodexAdapter {
            root: directory.path(),
            scope: "native-test",
        }
        .reader_revision("native")
        .unwrap()
        .unwrap()
        .revision
    );
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn native_snapshot_does_not_pair_ambiguous_or_unidentified_terminal_records() {
    let (directory, _) = fixture(vec![
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"duplicate","started_at":100}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"duplicate","started_at":100}}),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"duplicate","started_at":100,"completed_at":110}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"legacy","started_at":200}}),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"legacy","completed_at":210}}),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"orphan","started_at":300,"completed_at":310}}),
    ]);
    let value = native(directory.path());
    assert_eq!(value["agentRuns"].as_array().unwrap().len(), 2);
    assert_eq!(value["agentRuns"][0]["pairing"], "ambiguous-start");
    assert_eq!(value["agentRuns"][1]["pairing"], "open");
    for run in value["agentRuns"].as_array().unwrap() {
        assert_eq!(run["status"], "unknown");
        assert!(run["timeEnd"].is_null());
    }
    assert_eq!(value["runObservations"].as_array().unwrap().len(), 6);
    assert_eq!(value["runObservations"][4]["pairing"], "unidentifiable");
    assert_eq!(value["runObservations"][5]["pairing"], "orphan-terminal");
}

#[test]
fn native_snapshot_rejects_malformed_interior_json_while_reader_remains_readable() {
    let (directory, path) = fixture(vec![]);
    let mut source = fs::read_to_string(&path).unwrap();
    source.push_str("{not-json}\n{\"type\":\"turn_context\",\"payload\":{}}\n");
    fs::write(&path, source).unwrap();
    let adapter = CodexAdapter {
        root: directory.path(),
        scope: "invalid-test",
    };
    assert!(adapter.load("native").is_ok());
    assert!(matches!(
        adapter.native_protocol_snapshot("native"),
        Err(CoreError::Protocol(
            crate::protocol::ProtocolError::Invalid { .. }
        ))
    ));
}

#[test]
fn native_snapshot_keeps_failures_cancellations_and_incomplete_tail_explicit() {
    let (directory, path) = fixture(vec![
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"failed","started_at":100}}),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"failed","started_at":100,"completed_at":110,"error":{"codex_error_info":"quota"}}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"cancelled","started_at":200}}),
        json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"cancelled","started_at":200,"completed_at":210}}),
        json!({"type":"response_item","payload":{"type":"agent_message","content":[{"type":"text","text":"Explain the string Message Type: NEW_TASK"}]}}),
        json!({"type":"compacted","payload":{"id":"paired","summary":"recorded result"}}),
        json!({"type":"event_msg","payload":{"type":"context_compacted","id":"paired"}}),
    ]);
    let mut source = fs::read_to_string(&path).unwrap();
    source.push_str("{\"type\":");
    fs::write(&path, source).unwrap();
    let value = native(directory.path());
    assert_eq!(value["agentRuns"][0]["status"], "failed");
    assert_eq!(value["agentRuns"][1]["status"], "cancelled");
    assert_eq!(value["tasks"].as_array().unwrap().len(), 0);
    assert_eq!(
        value["contextObservations"].as_array().unwrap().len(),
        2,
        "raw compaction observations are not deduplicated operations"
    );
    assert_eq!(value["contextObservations"][0]["summaryAvailable"], true);
    assert_eq!(value["contextObservations"][1]["summaryAvailable"], false);
    assert!(
        value["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["code"] == "incomplete_trailing_record")
    );
}

#[test]
#[ignore = "requires explicitly selected frozen private corpus manifest"]
fn native_snapshot_frozen_full_sources_match_manifest_raw_records_and_reader_revision() {
    let manifest_path = std::env::var("CODEX_PRIVATE_MANIFEST").unwrap();
    let manifest: Value = serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    let mut checked = 0;
    for file in manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|file| file["provider"] == "codex")
    {
        let path = Path::new(file["snapshotPath"].as_str().unwrap());
        let id = file["sessionId"].as_str().unwrap();
        let before = fs::read(path).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&before)),
            file["snapshotSha256"].as_str().unwrap()
        );
        let records = before
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
            .map(|line| serde_json::from_slice::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let snapshot = serde_json::to_value(
            codex_observation_snapshot(path, "frozen-observations", id).unwrap(),
        )
        .unwrap();
        let reader = codex_snapshot(path, "frozen-observations", id).unwrap();
        assert_eq!(snapshot["revision"], reader.revision);
        assert_eq!(snapshot["sourceRecordCount"], records.len());
        let lifecycle_count = records
            .iter()
            .filter(|record| {
                record["type"] == "event_msg"
                    && matches!(
                        record["payload"]["type"].as_str(),
                        Some("task_started" | "task_complete" | "turn_aborted")
                    )
            })
            .count();
        let compaction_count = records
            .iter()
            .filter(|record| record["type"] == "compacted")
            .count();
        assert_eq!(
            snapshot["runObservations"].as_array().unwrap().len(),
            lifecycle_count
        );
        assert_eq!(
            snapshot["contextObservations"].as_array().unwrap().len(),
            compaction_count
        );
        assert_eq!(snapshot["coverage"]["ownership"]["state"], "unknown");
        let stream = codex_protocol_stream(path, "frozen-observations", id).unwrap();
        let mut cursor = None;
        let mut count = 0;
        let mut ids = HashSet::new();
        let reader_refs: HashSet<_> = reader
            .events
            .iter()
            .map(|event| (&event.item.event.message_id, &event.item.event.segment))
            .collect();
        loop {
            let page = stream
                .events(crate::protocol::EventQuery {
                    limit: 200,
                    cursor,
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(page.revision, reader.revision);
            for event in page.events {
                assert!(ids.insert(event.id.clone()));
                assert_eq!(event.sequence, count + 1);
                assert_eq!(event.source_order.record as usize, count);
                assert_eq!(event.id, format!("event:codex:{count}"));
                if let Some(reference) = &event.reader_event {
                    assert!(reader_refs.contains(&(&reference.message_id, &reference.segment)));
                }
                count += 1;
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(count, records.len());
        let bundle = codex_protocol_bundle(path, "frozen-observations", id).unwrap();
        let v2 = serde_json::to_value(bundle.document(2).unwrap()).unwrap();
        let v3 = serde_json::to_value(bundle.document(3).unwrap()).unwrap();
        assert_eq!(v2["revision"], reader.revision);
        for key in [
            "session",
            "revision",
            "events",
            "relationships",
            "tasks",
            "agentRuns",
            "contextArtifacts",
            "branches",
        ] {
            assert_eq!(v3[key], v2[key], "v3 changed frozen v2 {key}");
        }
        let mut work_cursor = None;
        let mut work_entries = Vec::new();
        loop {
            let page = serde_json::to_value(
                bundle
                    .work(crate::protocol::WorkQuery {
                        kind: None,
                        status: None,
                        limit: 50,
                        cursor: work_cursor,
                    })
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(page["revision"], reader.revision);
            let entries = page["entries"].as_array().unwrap();
            assert!(entries.len() <= 50);
            work_entries.extend(entries.iter().cloned());
            work_cursor = page["nextCursor"].as_str().map(str::to_owned);
            if work_cursor.is_none() {
                break;
            }
        }
        let lifecycle = work_entries
            .iter()
            .filter(|entry| entry["type"] == "lifecycle")
            .collect::<Vec<_>>();
        assert_eq!(lifecycle.len(), lifecycle_count);
        for entry in &lifecycle {
            let raw_index = entry["evidence"]["provenance"]["sourceId"]
                .as_str()
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let raw = &records[raw_index];
            assert_eq!(raw["type"], "event_msg");
            assert_eq!(entry["kind"], raw["payload"]["type"]);
            assert_eq!(entry["turnId"], raw["payload"]["turn_id"]);
            assert_eq!(
                entry["evidence"]["eventId"],
                format!("event:codex:{raw_index}")
            );
        }
        for run in work_entries
            .iter()
            .filter(|entry| entry["type"] == "agentRun")
        {
            let start_index = run["evidence"]["provenance"]["sourceId"]
                .as_str()
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let start = &records[start_index];
            assert_eq!(start["payload"]["type"], "task_started");
            assert_eq!(start["payload"]["turn_id"], run["turnId"]);
            if let Some(source_id) = run["terminalEvidence"]["provenance"]["sourceId"].as_str() {
                let terminal = &records[source_id.parse::<usize>().unwrap()];
                assert!(matches!(
                    terminal["payload"]["type"].as_str(),
                    Some("task_complete" | "turn_aborted")
                ));
                assert_eq!(terminal["payload"]["turn_id"], run["turnId"]);
                assert_eq!(
                    terminal["payload"]["started_at"],
                    start["payload"]["started_at"]
                );
            }
        }
        assert_eq!(fs::read(path).unwrap(), before);
        eprintln!(
            "native Codex source={id} records={count} reader_items={} tasks={} runs={} lifecycle={} context={} source_sha={}",
            reader.events.len(),
            snapshot["tasks"].as_array().unwrap().len(),
            snapshot["agentRuns"].as_array().unwrap().len(),
            lifecycle_count,
            compaction_count,
            file["snapshotSha256"]
        );
        checked += 1;
    }
    assert_eq!(checked, 2);
}
