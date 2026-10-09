use super::*;
use crate::{EventRef, SessionRef};

fn session(provider: &str) -> SessionRef {
    SessionRef {
        provider: provider.into(),
        session_id: "canonical-root".into(),
    }
}

// Hand-authored provider-normalized evidence, not a real transcript claim.
fn candidate(provider: &str, record: u64, timestamp: i64) -> EventCandidate {
    let source_type = if provider == "codex" {
        "codex.response_item"
    } else {
        "dsh.session-event:team/message/queued"
    };
    EventCandidate {
        id: format!("event-{record}"),
        session: session(provider),
        source_order: SourceOrder { record, ordinal: 0 },
        timestamp: Some(timestamp),
        category: "message".into(),
        kind: "message.recorded".into(),
        provenance: Provenance {
            fidelity: Fidelity::Recorded,
            source_type: source_type.into(),
            source_id: Some(record.to_string()),
        },
        reader_event: Some(EventRef {
            provider: provider.into(),
            session_id: "canonical-root".into(),
            message_id: format!("msg-{record}"),
            segment: "message".into(),
        }),
        execution: None,
    }
}
fn stream(provider: &str, revision: &str) -> EventStream {
    finalize_events(
        session(provider),
        "scope-a".into(),
        revision.into(),
        vec![
            candidate(provider, 4, 100),
            candidate(provider, 2, 900),
            candidate(provider, 3, 500),
        ],
    )
    .unwrap()
}

#[test]
fn codex_and_dsh_keep_source_order_and_recorded_provenance() {
    for provider in ["codex", "deepseek-harness"] {
        let stream = stream(provider, "r1");
        let page = stream.events(EventQuery::default()).unwrap();
        assert_eq!(
            page.events
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            ["event-2", "event-3", "event-4"]
        );
        assert_eq!(
            page.events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert_eq!(
            page.events.iter().map(|e| e.timestamp).collect::<Vec<_>>(),
            [Some(900), Some(500), Some(100)]
        );
        assert!(
            page.events
                .iter()
                .all(|e| e.provenance.fidelity == Fidelity::Recorded)
        );
        assert_eq!(page.coverage, Coverage::Partial);
    }
}
#[test]
fn derived_evidence_is_not_promoted_to_recorded() {
    let mut event = candidate("codex", 1, 50);
    event.provenance.fidelity = Fidelity::Derived;
    let stream =
        finalize_events(session("codex"), "scope".into(), "r".into(), vec![event]).unwrap();
    assert_eq!(
        stream.events(EventQuery::default()).unwrap().events[0]
            .provenance
            .fidelity,
        Fidelity::Derived
    );
}

#[test]
fn execution_detail_requires_recorded_tool_source_and_reader_anchor() {
    for fault in 0..4 {
        let mut event = candidate("codex", 1, 50);
        event.category = "tool".into();
        event.reader_event.as_mut().unwrap().segment = "tool".into();
        event.execution = Some(ExecutionObservation {
            id: "outer".into(),
            kind: ExecutionKind::AsyncTool,
            phase: ExecutionPhase::Started,
            handle: "65".into(),
            tool_name: "exec".into(),
            label: None,
        });
        match fault {
            0 => event.reader_event = None,
            1 => event.provenance.fidelity = Fidelity::Derived,
            2 => event.execution.as_mut().unwrap().handle.clear(),
            _ => event.category = "message".into(),
        }
        let Err(ProtocolError::Invalid { diagnostics }) =
            finalize_events(session("codex"), "scope".into(), "r".into(), vec![event])
        else {
            panic!("expected invalid execution evidence")
        };
        assert!(
            diagnostics
                .iter()
                .any(|issue| issue.code == "invalid_execution_observation")
        );
    }
}
#[test]
fn invalid_identity_duplicate_ids_and_ambiguous_source_order_are_explicit() {
    for (fault, expected) in [
        (0, "event_session_mismatch"),
        (1, "duplicate_event_id"),
        (2, "duplicate_source_order"),
        (3, "reader_session_mismatch"),
        (4, "missing_provenance_source"),
    ] {
        let a = candidate("codex", 1, 10);
        let mut b = candidate("codex", 2, 20);
        match fault {
            0 => b.session.session_id = "other".into(),
            1 => b.id = a.id.clone(),
            2 => b.source_order = a.source_order,
            3 => b.reader_event.as_mut().unwrap().session_id = "other".into(),
            _ => b.provenance.source_type.clear(),
        }
        let Err(ProtocolError::Invalid { diagnostics }) =
            finalize_events(session("codex"), "scope".into(), "r".into(), vec![a, b])
        else {
            panic!("expected invalid")
        };
        assert!(
            diagnostics.iter().any(|d| d.code == expected),
            "{diagnostics:?}"
        );
    }
}
#[test]
fn event_cursor_binds_scope_session_revision_and_filters() {
    let s = stream("codex", "r1");
    let cursor = s
        .events(EventQuery {
            limit: 1,
            ..Default::default()
        })
        .unwrap()
        .next_cursor
        .unwrap();
    let page = s
        .events(EventQuery {
            cursor: Some(cursor.clone()),
            limit: 2,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        page.events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
        [2, 3]
    );
    assert!(page.next_cursor.is_none());
    for other in [
        stream("codex", "r2"),
        stream("deepseek-harness", "r1"),
        finalize_events(
            session("codex"),
            "scope-b".into(),
            "r1".into(),
            vec![candidate("codex", 1, 1)],
        )
        .unwrap(),
    ] {
        assert!(matches!(
            other.events(EventQuery {
                cursor: Some(cursor.clone()),
                ..Default::default()
            }),
            Err(ProtocolError::InvalidCursor)
        ));
    }
    assert!(matches!(
        s.events(EventQuery {
            category: Some("tool".into()),
            cursor: Some(cursor),
            ..Default::default()
        }),
        Err(ProtocolError::InvalidCursor)
    ));
}

#[test]
fn execution_only_filter_paginates_recorded_facts_and_binds_cursor_identity() {
    let mut ordinary = candidate("codex", 1, 1);
    ordinary.category = "tool".into();
    ordinary.reader_event.as_mut().unwrap().segment = "tool".into();

    let mut first_execution = candidate("codex", 2, 2);
    first_execution.category = "tool".into();
    first_execution.reader_event.as_mut().unwrap().segment = "tool".into();
    first_execution.execution = Some(ExecutionObservation {
        id: "exec-a".into(),
        kind: ExecutionKind::AsyncTool,
        phase: ExecutionPhase::Yielded,
        handle: "65".into(),
        tool_name: "exec".into(),
        label: None,
    });

    let mut second_ordinary = candidate("codex", 3, 3);
    second_ordinary.category = "tool".into();
    second_ordinary.reader_event.as_mut().unwrap().segment = "tool".into();

    let mut second_execution = candidate("codex", 4, 4);
    second_execution.category = "tool".into();
    second_execution.reader_event.as_mut().unwrap().segment = "tool".into();
    second_execution.execution = Some(ExecutionObservation {
        id: "exec-b".into(),
        kind: ExecutionKind::Process,
        phase: ExecutionPhase::Completed,
        handle: "42".into(),
        tool_name: "write_stdin".into(),
        label: None,
    });

    let stream = finalize_events(
        session("codex"),
        "scope".into(),
        "revision".into(),
        vec![ordinary, first_execution, second_ordinary, second_execution],
    )
    .unwrap();
    let first = stream
        .events(EventQuery {
            category: Some("tool".into()),
            execution_only: true,
            limit: 1,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        first
            .events
            .iter()
            .map(|event| event.id.as_str())
            .collect::<Vec<_>>(),
        ["event-2"]
    );
    assert_eq!(first.scanned_events, 2);
    let cursor = first.next_cursor.unwrap();

    let last = stream
        .events(EventQuery {
            category: Some("tool".into()),
            execution_only: true,
            limit: 1,
            cursor: Some(cursor.clone()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        last.events
            .iter()
            .map(|event| event.id.as_str())
            .collect::<Vec<_>>(),
        ["event-4"]
    );
    assert_eq!(last.scanned_events, 2);
    assert!(last.next_cursor.is_none());

    assert!(matches!(
        stream.events(EventQuery {
            category: Some("tool".into()),
            execution_only: false,
            cursor: Some(cursor),
            ..Default::default()
        }),
        Err(ProtocolError::InvalidCursor)
    ));
}
#[test]
fn filters_and_bounds_preserve_dense_unfiltered_sequences() {
    let mut a = candidate("codex", 1, 1);
    a.category = "tool".into();
    let s = finalize_events(
        session("codex"),
        "scope".into(),
        "r".into(),
        vec![a, candidate("codex", 2, 2)],
    )
    .unwrap();
    let p = s
        .events(EventQuery {
            category: Some("message".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(p.events[0].sequence, 2);
    for limit in [0, 201] {
        assert!(matches!(
            s.events(EventQuery {
                limit,
                ..Default::default()
            }),
            Err(ProtocolError::InvalidQuery { .. })
        ));
    }
    assert!(matches!(
        s.events(EventQuery {
            cursor: Some("broken".into()),
            ..Default::default()
        }),
        Err(ProtocolError::InvalidCursor)
    ));
}
#[test]
fn unavailable_remains_distinct_from_empty_partial_stream() {
    let unavailable = ProtocolError::Unavailable {
        diagnostic: "provider builder not implemented".into(),
    };
    assert_eq!(
        serde_json::to_value(unavailable).unwrap()["status"],
        "unavailable"
    );
    let empty = finalize_events(session("codex"), "scope".into(), "r".into(), vec![]).unwrap();
    assert!(
        empty
            .events(EventQuery::default())
            .unwrap()
            .events
            .is_empty()
    );
}

#[test]
fn sparse_filter_bounds_scan_work_and_continues_through_empty_pages() {
    let mut candidates: Vec<_> = (0..1025).map(|i| candidate("codex", i, 0)).collect();
    candidates[1024].category = "context".into();
    let s = finalize_events(session("codex"), "scope".into(), "r".into(), candidates).unwrap();
    let first = s
        .events(EventQuery {
            category: Some("context".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(first.events.is_empty());
    assert_eq!(first.scanned_events, 1024);
    let last = s
        .events(EventQuery {
            category: Some("context".into()),
            cursor: first.next_cursor,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(last.events[0].sequence, 1025);
    assert_eq!(last.scanned_events, 1);
    assert!(last.next_cursor.is_none());
}
