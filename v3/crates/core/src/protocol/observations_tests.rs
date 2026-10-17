use super::*;
use crate::protocol::{EventCandidate, Fidelity, SourceOrder, finalize_events};

fn stream() -> EventStream {
    let session = SessionRef {
        provider: "test".into(),
        session_id: "session".into(),
    };
    finalize_events(
        session.clone(),
        "scope".into(),
        "revision".into(),
        vec![EventCandidate {
            id: "event".into(),
            session,
            source_order: SourceOrder {
                record: 3,
                ordinal: 0,
            },
            timestamp: None,
            category: "run".into(),
            kind: "run.started".into(),
            reader_event: None,
            execution: None,
            provenance: evidence().provenance,
        }],
    )
    .unwrap()
}

fn evidence() -> Evidence {
    Evidence {
        event_id: "event".into(),
        provenance: Provenance {
            fidelity: Fidelity::Recorded,
            source_type: "test.native".into(),
            source_id: Some("3".into()),
        },
    }
}

fn errors(input: ObservationCandidates) -> Vec<String> {
    let ProtocolError::Invalid { diagnostics } =
        finalize_observations(&stream(), input).unwrap_err()
    else {
        panic!("expected invalid observations");
    };
    diagnostics.into_iter().map(|item| item.code).collect()
}

fn usage_observation(id: &str, record: u64) -> UsageObservation {
    UsageObservation {
        id: id.into(),
        session_ref: SessionRef {
            provider: "test".into(),
            session_id: "session".into(),
        },
        timestamp: Some(record as i64),
        event_id: format!("event-{record}"),
        tokens: UsageTokenComponents {
            input: Some(1),
            cache_read: Some(0),
            cache_write: Some(0),
            output: Some(1),
            reasoning: Some(0),
            total: Some(2),
        },
        cumulative_tokens: None,
        consumption_tokens: None,
        model: None,
        model_provider: None,
        provenance: Provenance {
            fidelity: Fidelity::Recorded,
            source_type: "test.usage".into(),
            source_id: Some(record.to_string()),
        },
    }
}

#[test]
fn usage_observations_require_unique_source_anchored_occurrences() {
    let mut first = usage_observation("first", 3);
    first.event_id = "event".into();
    let mut duplicate = first.clone();
    duplicate.id = "second".into();
    let codes = errors(ObservationCandidates {
        usage_observations: vec![first, duplicate],
        ..Default::default()
    });
    assert!(
        codes
            .iter()
            .any(|code| code == "duplicate_or_missing_usage_observation_id")
    );

    let mut wrong = usage_observation("wrong", 3);
    wrong.event_id = "event".into();
    wrong.provenance.source_id = Some("other".into());
    assert!(
        errors(ObservationCandidates {
            usage_observations: vec![wrong],
            ..Default::default()
        })
        .iter()
        .any(|code| code == "invalid_usage_observation_anchor")
    );
}

#[test]
fn usage_observations_paginate_in_execution_and_reject_prior_revision_cursor() {
    let session = SessionRef {
        provider: "test".into(),
        session_id: "session".into(),
    };
    let build = |revision: &str| {
        let events = [3, 4]
            .into_iter()
            .map(|record| EventCandidate {
                id: format!("event-{record}"),
                session: session.clone(),
                source_order: SourceOrder { record, ordinal: 0 },
                timestamp: Some(record as i64),
                category: "usage".into(),
                kind: "token-count".into(),
                provenance: Provenance {
                    fidelity: Fidelity::Recorded,
                    source_type: "test.usage".into(),
                    source_id: Some(record.to_string()),
                },
                reader_event: None,
                execution: None,
            })
            .collect();
        let stream =
            finalize_events(session.clone(), "scope".into(), revision.into(), events).unwrap();
        finalize_protocol_bundle(
            stream,
            ObservationCandidates {
                usage_observations: vec![
                    usage_observation("first", 3),
                    usage_observation("second", 4),
                ],
                ..Default::default()
            },
        )
        .unwrap()
    };
    let first = build("revision-one")
        .domain_page(
            RuntimeDomain::Execution,
            DomainQuery {
                kind: None,
                limit: 1,
                cursor: None,
            },
        )
        .unwrap();
    let first = serde_json::to_value(first).unwrap();
    assert_eq!(first["entries"][0]["type"], "usageObservation");
    assert_eq!(first["entries"][0]["sourceOrder"]["record"], 3);
    let cursor = first["nextCursor"].as_str().unwrap();
    let second = build("revision-one")
        .domain_page(
            RuntimeDomain::Execution,
            DomainQuery {
                kind: None,
                limit: 1,
                cursor: Some(cursor.into()),
            },
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(second).unwrap()["entries"][0]["fact"]["id"],
        "second"
    );
    assert!(matches!(
        build("revision-two").domain_page(
            RuntimeDomain::Execution,
            DomainQuery {
                kind: None,
                limit: 1,
                cursor: Some(cursor.into()),
            }
        ),
        Err(ProtocolError::InvalidCursor)
    ));
}

#[test]
fn observation_validator_rejects_wrong_source_anchor_and_duplicate_task_ids() {
    let task = TaskObservation {
        id: "task".into(),
        kind: "assignment".into(),
        status: RunStatus::Unknown,
        time_created: None,
        evidence: evidence(),
    };
    let mut incorrect = task.clone();
    incorrect.evidence.provenance.source_id = Some("other-record".into());
    let codes = errors(ObservationCandidates {
        tasks: vec![task, incorrect],
        ..Default::default()
    });
    assert!(
        codes
            .iter()
            .any(|code| code == "duplicate_or_missing_observation_id")
    );
    assert!(codes.iter().any(|code| code == "evidence_source_mismatch"));
}

#[test]
fn observation_validator_rejects_dangling_work_and_relationship_identity() {
    let mut missing = evidence();
    missing.event_id = "absent".into();
    let codes = errors(ObservationCandidates {
        agent_runs: vec![AgentRunObservation {
            id: "run".into(),
            kind: "session-turn".into(),
            task_id: Some("absent-task".into()),
            turn_id: Some("turn".into()),
            child_session_ref: None,
            status: RunStatus::Unknown,
            pairing: Pairing::Open,
            time_start: Some(20),
            time_end: Some(10),
            evidence: evidence(),
            terminal_evidence: None,
        }],
        run_observations: vec![RunObservation {
            id: "orphan".into(),
            kind: "run.started".into(),
            turn_id: Some("turn".into()),
            run_id: Some("absent-run".into()),
            pairing: Pairing::UniqueStart,
            time_start: None,
            time_end: None,
            timestamp: None,
            status: RunStatus::Unknown,
            evidence: missing,
        }],
        relationships: vec![RelationshipObservation {
            id: "relation".into(),
            kind: "parent".into(),
            from: SessionRef {
                provider: "test".into(),
                session_id: "unrelated".into(),
            },
            to: SessionRef {
                provider: "test".into(),
                session_id: "other".into(),
            },
            correlation_id: None,
            evidence: evidence(),
        }],
        ..Default::default()
    });
    for expected in [
        "unknown_evidence_event",
        "unknown_run_task",
        "run_end_before_start",
        "unknown_observation_run",
        "invalid_relationship_identity",
    ] {
        assert!(
            codes.iter().any(|code| code == expected),
            "missing {expected}"
        );
    }
}

#[test]
fn legacy_list_counts_delegated_runs_without_session_turns() {
    let run = |id: &str, kind: &str, child_session_ref: Option<SessionRef>| AgentRunObservation {
        id: id.into(),
        kind: kind.into(),
        task_id: None,
        turn_id: (kind == "session-turn").then(|| "turn".into()),
        child_session_ref,
        status: RunStatus::Completed,
        pairing: Pairing::Matched,
        time_start: Some(20),
        time_end: Some(30),
        evidence: evidence(),
        terminal_evidence: None,
    };
    let bundle = finalize_protocol_bundle(
        stream(),
        ObservationCandidates {
            agent_runs: vec![
                run("turn", "session-turn", None),
                run(
                    "child",
                    "subagent",
                    Some(SessionRef {
                        provider: "test".into(),
                        session_id: "child".into(),
                    }),
                ),
            ],
            ..Default::default()
        },
    )
    .unwrap();
    let stats = bundle.list_stats();
    assert_eq!(stats.agent_run_count, Some(1));
    assert_eq!(stats.subagent_run_count, Some(1));
    assert_eq!(stats.background_run_count, Some(0));
    assert_eq!(stats.active_statuses, Some(vec![]));
    assert_eq!(bundle.summary().counts.agent_runs, 2);
}

#[test]
fn legacy_activity_status_preserves_unknown_work_coverage() {
    let unknown = finalize_protocol_bundle(stream(), ObservationCandidates::default())
        .unwrap()
        .list_stats();
    assert_eq!(unknown.active_statuses, None);
    assert_eq!(unknown.task_count, None);
    assert_eq!(unknown.agent_run_count, None);

    let known_absent = finalize_protocol_bundle(
        stream(),
        ObservationCandidates {
            coverage: BTreeMap::from([(
                "work".into(),
                DomainCoverage {
                    state: ObservationState::NotObserved,
                    details: "No work observations in this source.".into(),
                },
            )]),
            ..Default::default()
        },
    )
    .unwrap()
    .list_stats();
    assert_eq!(known_absent.active_statuses, Some(vec![]));
    assert_eq!(known_absent.task_count, Some(0));
    assert_eq!(known_absent.agent_run_count, Some(0));
}

#[test]
fn legacy_duration_spans_conversation_events_without_session_metadata() {
    let session = SessionRef {
        provider: "test".into(),
        session_id: "session".into(),
    };
    let events = [
        ("header", "session", 0),
        ("config", "config", 1_000),
        ("developer", "message", 1_900),
        ("request", "message", 2_000),
        ("reply", "message", 7_000),
        ("late-config", "session", 120_000),
        ("native-turn-terminal", "source", 180_000),
    ]
    .into_iter()
    .enumerate()
    .map(|(record, (id, category, timestamp))| EventCandidate {
        id: id.into(),
        session: session.clone(),
        source_order: SourceOrder {
            record: record as u64,
            ordinal: 0,
        },
        timestamp: Some(timestamp),
        category: category.into(),
        kind: if id == "developer" {
            "message.developer".into()
        } else {
            id.into()
        },
        reader_event: None,
        execution: None,
        provenance: Provenance {
            fidelity: Fidelity::Recorded,
            source_type: "test.native".into(),
            source_id: Some(id.into()),
        },
    });
    let stream = finalize_events(
        session.clone(),
        "scope".into(),
        "revision".into(),
        events.collect(),
    )
    .unwrap();
    let stats = finalize_protocol_bundle(stream, ObservationCandidates::default())
        .unwrap()
        .list_stats();
    assert_eq!(stats.duration_ms, Some(5_000));
}

#[test]
fn provider_normalized_duration_excludes_an_earlier_duplicate_native_message() {
    let session = SessionRef {
        provider: "test".into(),
        session_id: "session".into(),
    };
    let events = [
        ("duplicate-user", 1_935),
        ("canonical-user", 2_000),
        ("reply", 7_000),
    ]
    .into_iter()
    .enumerate()
    .map(|(record, (id, timestamp))| EventCandidate {
        id: id.into(),
        session: session.clone(),
        source_order: SourceOrder {
            record: record as u64,
            ordinal: 0,
        },
        timestamp: Some(timestamp),
        category: "message".into(),
        kind: "message.user".into(),
        reader_event: None,
        execution: None,
        provenance: Provenance {
            fidelity: Fidelity::Recorded,
            source_type: "test.native".into(),
            source_id: Some(id.into()),
        },
    });
    let stream = finalize_events(
        session.clone(),
        "scope".into(),
        "revision".into(),
        events.collect(),
    )
    .unwrap();
    let stats = finalize_protocol_bundle(
        stream,
        ObservationCandidates {
            list_duration_range: Some((2_000, 7_000)),
            ..Default::default()
        },
    )
    .unwrap()
    .list_stats();
    assert_eq!(stats.duration_ms, Some(5_000));
}

#[test]
fn provider_single_message_duration_does_not_fall_back_to_legacy_mirror() {
    let session = SessionRef {
        provider: "test".into(),
        session_id: "session".into(),
    };
    let events = [("duplicate-user", 1_935), ("canonical-user", 2_000)]
        .into_iter()
        .enumerate()
        .map(|(record, (id, timestamp))| EventCandidate {
            id: id.into(),
            session: session.clone(),
            source_order: SourceOrder {
                record: record as u64,
                ordinal: 0,
            },
            timestamp: Some(timestamp),
            category: "message".into(),
            kind: "message.user".into(),
            reader_event: None,
            execution: None,
            provenance: Provenance {
                fidelity: Fidelity::Recorded,
                source_type: "test.native".into(),
                source_id: Some(id.into()),
            },
        });
    let stream = finalize_events(
        session.clone(),
        "scope".into(),
        "revision".into(),
        events.collect(),
    )
    .unwrap();
    let stats = finalize_protocol_bundle(
        stream,
        ObservationCandidates {
            list_duration_range: Some((2_000, 2_000)),
            ..Default::default()
        },
    )
    .unwrap()
    .list_stats();
    assert_eq!(stats.duration_ms, None);
}

#[test]
fn branch_observation_rejects_head_without_a_matching_source_event() {
    let codes = errors(ObservationCandidates {
        branches: vec![BranchObservation {
            id: "branch:active".into(),
            fork_entry_id: None,
            fork_event_id: None,
            head_entry_id: "different".into(),
            head_event_id: "event".into(),
            selected: true,
            evidence: Evidence {
                event_id: "event".into(),
                provenance: Provenance {
                    fidelity: Fidelity::Derived,
                    source_type: "test.active-file".into(),
                    source_id: Some("3".into()),
                },
            },
        }],
        ..Default::default()
    });
    assert!(
        codes
            .iter()
            .any(|code| code == "invalid_branch_topology_anchor")
    );
}

#[test]
fn request_usage_rejects_duplicate_identity_and_wrong_record_anchor() {
    let usage = UsageRecord {
        id: "request-1".into(),
        scope: "request",
        session_ref: SessionRef {
            provider: "test".into(),
            session_id: "session".into(),
        },
        timestamp: None,
        model: None,
        model_provider: None,
        run_id: None,
        event_id: Some("event".into()),
        turn_id: None,
        tokens: UsageTokenComponents {
            input: Some(1),
            cache_read: Some(0),
            cache_write: Some(0),
            output: Some(1),
            reasoning: Some(0),
            total: Some(2),
        },
        context_origin_slices: vec![],
        provenance: evidence().provenance,
    };
    let mut wrong = usage.clone();
    wrong.provenance.source_id = Some("other-record".into());
    let codes = errors(ObservationCandidates {
        usage_records: vec![usage, wrong],
        ..Default::default()
    });
    assert!(
        codes
            .iter()
            .any(|code| code == "duplicate_or_missing_usage_id")
    );
    assert!(
        codes
            .iter()
            .any(|code| code == "invalid_usage_event_anchor")
    );
}

#[test]
fn context_result_requires_same_session_version_and_recorded_reader_anchor() {
    let version = ContextVersion {
        id: "context-version:1".into(),
        session_id: "session".into(),
        sequence: 1,
        parent_version_ids: vec![],
        artifact_ids: vec![],
        created_at: None,
        reader_event: None,
        provenance: evidence().provenance,
    };
    let transformation = ContextTransformation {
        id: "context-transformation:1".into(),
        session_id: "session".into(),
        kind: "compaction",
        source_version_ids: vec![],
        source_artifact_ids: vec![],
        result_artifact_ids: vec![],
        result_version_id: "missing".into(),
        event_id: "event".into(),
        run_id: None,
        turn_id: None,
        timestamp: None,
        retained_from: None,
        retained_tail_count: None,
        shadowed_range: None,
        shadowed_seqs: None,
        shadowed_token_count: None,
        provenance: evidence().provenance,
    };
    let codes = errors(ObservationCandidates {
        context_versions: vec![version],
        context_transformations: vec![transformation],
        ..Default::default()
    });
    assert!(
        codes
            .iter()
            .any(|code| code == "unknown_context_result_version")
    );
    assert!(
        codes
            .iter()
            .any(|code| code == "invalid_context_version_anchor")
    );
}

#[test]
fn context_observation_rejects_reader_ref_absent_from_its_source_event() {
    let codes = errors(ObservationCandidates {
        context_observations: vec![ContextObservation {
            id: "context".into(),
            kind: "compaction-record".into(),
            timestamp: None,
            trigger: None,
            pre_compact_tokens: None,
            window_id: None,
            previous_window_id: None,
            first_window_id: None,
            summary_available: true,
            reader_event: Some(EventRef {
                provider: "test".into(),
                session_id: "session".into(),
                message_id: "summary".into(),
                segment: "context".into(),
            }),
            evidence: evidence(),
        }],
        ..Default::default()
    });
    assert!(
        codes
            .iter()
            .any(|code| code == "context_reader_anchor_mismatch")
    );
}

#[test]
fn context_result_rejects_cross_event_version_reference() {
    let session = SessionRef {
        provider: "test".into(),
        session_id: "session".into(),
    };
    let reader = EventRef {
        provider: "test".into(),
        session_id: "session".into(),
        message_id: "summary".into(),
        segment: "message".into(),
    };
    let candidates = ["first", "second"]
        .into_iter()
        .enumerate()
        .map(|(index, id)| EventCandidate {
            id: id.into(),
            session: session.clone(),
            source_order: SourceOrder {
                record: index as u64,
                ordinal: 0,
            },
            timestamp: None,
            category: "context".into(),
            kind: "context.compact".into(),
            provenance: Provenance {
                fidelity: Fidelity::Recorded,
                source_type: "test.compaction".into(),
                source_id: Some(id.into()),
            },
            reader_event: Some(reader.clone()),
            execution: None,
        })
        .collect();
    let stream = finalize_events(session, "scope".into(), "revision".into(), candidates).unwrap();
    let version = ContextVersion {
        id: "result".into(),
        session_id: "session".into(),
        sequence: 1,
        parent_version_ids: vec![],
        artifact_ids: vec![],
        created_at: None,
        reader_event: Some(reader),
        provenance: stream.events[0].provenance.clone(),
    };
    let transformation = ContextTransformation {
        id: "compact".into(),
        session_id: "session".into(),
        kind: "compaction",
        source_version_ids: vec![],
        source_artifact_ids: vec![],
        result_artifact_ids: vec![],
        result_version_id: "result".into(),
        event_id: "second".into(),
        run_id: None,
        turn_id: None,
        timestamp: None,
        retained_from: None,
        retained_tail_count: None,
        shadowed_range: None,
        shadowed_seqs: None,
        shadowed_token_count: None,
        provenance: stream.events[1].provenance.clone(),
    };
    let ProtocolError::Invalid { diagnostics } = finalize_observations(
        &stream,
        ObservationCandidates {
            context_versions: vec![version],
            context_transformations: vec![transformation],
            ..Default::default()
        },
    )
    .unwrap_err() else {
        panic!("cross-event context result must be invalid")
    };
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "context_result_anchor_mismatch")
    );
}
