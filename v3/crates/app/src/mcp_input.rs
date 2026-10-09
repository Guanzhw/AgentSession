use rmcp::model::RequestId;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::mpsc;

const MAX_LINE: usize = 32 * 1024 * 1024;
const MAX_PENDING: usize = 128;
pub(super) const SEARCH_MARKER: &str = "__agentsessionUtf16Boundary";
static NEXT_MARKER: AtomicU64 = AtomicU64::new(1);

pub(super) type SearchUnits = Arc<Mutex<HashMap<RequestId, (Vec<u16>, u64, Instant)>>>;

pub(super) fn take_search_units(
    arguments: &mut Map<String, Value>,
    id: &RequestId,
    pending: &SearchUnits,
) -> Result<Option<Vec<u16>>, ()> {
    let marker = arguments.remove(SEARCH_MARKER);
    let sidecar = pending.lock().expect("search unit sidecar").remove(id);
    match (marker, sidecar) {
        (None, None) => Ok(None),
        (Some(value), Some((units, expected, _))) if value.as_u64() == Some(expected) => {
            Ok(Some(units))
        }
        _ => Err(()),
    }
}

fn hex_unit(bytes: &[u8]) -> Option<u16> {
    if bytes.len() != 4 {
        return None;
    }
    bytes.iter().try_fold(0u16, |number, byte| {
        let digit = (*byte as char).to_digit(16)? as u16;
        Some(number * 16 + digit)
    })
}

fn sanitized_line(line: &[u8]) -> (Vec<u8>, Vec<(usize, usize)>) {
    let mut output = line.to_vec();
    let mut affected = Vec::new();
    let mut at = 0;
    while at < line.len() {
        if line[at] != b'"' {
            at += 1;
            continue;
        }
        let start = at;
        at += 1;
        let mut lone = false;
        while at < line.len() && line[at] != b'"' {
            if line[at] == b'\\' && at + 1 < line.len() {
                if line[at + 1] == b'u' && at + 6 <= line.len() {
                    if let Some(unit) = hex_unit(&line[at + 2..at + 6]) {
                        if (0xd800..=0xdbff).contains(&unit)
                            && at + 12 <= line.len()
                            && line[at + 6..at + 8] == *b"\\u"
                            && hex_unit(&line[at + 8..at + 12])
                                .is_some_and(|next| (0xdc00..=0xdfff).contains(&next))
                        {
                            at += 12;
                            continue;
                        }
                        if (0xd800..=0xdfff).contains(&unit) {
                            output[at + 2..at + 6].copy_from_slice(b"FFFD");
                            lone = true;
                        }
                        at += 6;
                        continue;
                    }
                }
                at += 2;
                continue;
            }
            at += 1;
        }
        if at < line.len() {
            at += 1;
        }
        if lone {
            affected.push((start, at));
        }
    }
    (output, affected)
}

fn whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

fn skip_space(bytes: &[u8], at: &mut usize) {
    while bytes.get(*at).is_some_and(|byte| whitespace(*byte)) {
        *at += 1;
    }
}

fn string_end(bytes: &[u8], at: &mut usize) -> Option<(usize, usize)> {
    skip_space(bytes, at);
    let start = *at;
    if bytes.get(*at) != Some(&b'"') {
        return None;
    }
    *at += 1;
    while *at < bytes.len() {
        match bytes[*at] {
            b'"' => {
                *at += 1;
                return Some((start, *at));
            }
            b'\\' => *at += 2,
            _ => *at += 1,
        }
    }
    None
}

fn query_span(bytes: &[u8]) -> Option<(usize, usize)> {
    fn value(
        bytes: &[u8],
        at: &mut usize,
        path: &mut Vec<String>,
        depth: usize,
        found: &mut Option<(usize, usize)>,
    ) -> Option<()> {
        if depth > 32 {
            return None;
        }
        skip_space(bytes, at);
        match bytes.get(*at)? {
            b'{' => {
                *at += 1;
                let mut seen = HashSet::new();
                loop {
                    skip_space(bytes, at);
                    if bytes.get(*at) == Some(&b'}') {
                        *at += 1;
                        break;
                    }
                    let (start, end) = string_end(bytes, at)?;
                    let key: String = serde_json::from_slice(&bytes[start..end]).ok()?;
                    if !seen.insert(key.clone()) {
                        return None;
                    }
                    skip_space(bytes, at);
                    if bytes.get(*at) != Some(&b':') {
                        return None;
                    }
                    *at += 1;
                    path.push(key);
                    value(bytes, at, path, depth + 1, found)?;
                    path.pop();
                    skip_space(bytes, at);
                    match bytes.get(*at)? {
                        b',' => *at += 1,
                        b'}' => {
                            *at += 1;
                            break;
                        }
                        _ => return None,
                    }
                }
            }
            b'[' => {
                *at += 1;
                path.push("[]".into());
                loop {
                    skip_space(bytes, at);
                    if bytes.get(*at) == Some(&b']') {
                        *at += 1;
                        break;
                    }
                    value(bytes, at, path, depth + 1, found)?;
                    skip_space(bytes, at);
                    match bytes.get(*at)? {
                        b',' => *at += 1,
                        b']' => {
                            *at += 1;
                            break;
                        }
                        _ => return None,
                    }
                }
                path.pop();
            }
            b'"' => {
                let span = string_end(bytes, at)?;
                if path
                    .iter()
                    .map(String::as_str)
                    .eq(["params", "arguments", "query"])
                {
                    *found = Some(span);
                }
            }
            _ => {
                while bytes
                    .get(*at)
                    .is_some_and(|byte| !matches!(*byte, b',' | b'}' | b']') && !whitespace(*byte))
                {
                    *at += 1;
                }
            }
        }
        Some(())
    }
    let mut at = 0;
    let mut found = None;
    value(bytes, &mut at, &mut Vec::new(), 0, &mut found)?;
    found
}

fn json_string_units(token: &[u8]) -> Option<Vec<u16>> {
    let mut units = Vec::new();
    let mut at = 1;
    let end = token.len().checked_sub(1)?;
    while at < end {
        if token[at] == b'\\' {
            let escaped = *token.get(at + 1)?;
            match escaped {
                b'u' => {
                    units.push(hex_unit(token.get(at + 2..at + 6)?)?);
                    at += 6;
                }
                b'"' | b'\\' | b'/' => {
                    units.push(escaped as u16);
                    at += 2;
                }
                b'b' => {
                    units.push(8);
                    at += 2;
                }
                b'f' => {
                    units.push(12);
                    at += 2;
                }
                b'n' => {
                    units.push(10);
                    at += 2;
                }
                b'r' => {
                    units.push(13);
                    at += 2;
                }
                b't' => {
                    units.push(9);
                    at += 2;
                }
                _ => return None,
            }
        } else {
            let next = token[at..end]
                .iter()
                .position(|byte| *byte == b'\\')
                .map_or(end, |offset| at + offset);
            units.extend(std::str::from_utf8(&token[at..next]).ok()?.encode_utf16());
            at = next;
        }
    }
    Some(units)
}

enum Normalized {
    Forward(Vec<u8>, Option<(RequestId, Vec<u16>, u64)>),
    Reject(Value),
}

fn normalize(line: &[u8]) -> Normalized {
    if !line.windows(2).any(|part| part == b"\\u")
        && !line
            .windows(SEARCH_MARKER.len())
            .any(|part| part == SEARCH_MARKER.as_bytes())
    {
        return Normalized::Forward(line.to_vec(), None);
    }
    let (sanitized, affected) = sanitized_line(line);
    let mut parsed: Value = match serde_json::from_slice(&sanitized) {
        Ok(value) => value,
        Err(_) => return Normalized::Reject(Value::Null),
    };
    let id = parsed.get("id").cloned().unwrap_or(Value::Null);
    if parsed
        .pointer("/params/arguments")
        .and_then(Value::as_object)
        .is_some_and(|args| args.contains_key(SEARCH_MARKER))
    {
        return Normalized::Reject(id);
    }
    if affected.is_empty() {
        return Normalized::Forward(line.to_vec(), None);
    }
    let valid_search = parsed.get("method").and_then(Value::as_str) == Some("tools/call")
        && parsed.pointer("/params/name").and_then(Value::as_str) == Some("session_search");
    let span = query_span(line);
    if !valid_search || span.is_none() || affected.iter().any(|item| Some(*item) != span) {
        return Normalized::Reject(id);
    }
    let Some((start, end)) = span else {
        return Normalized::Reject(id);
    };
    let Some(units) = json_string_units(&line[start..end]) else {
        return Normalized::Reject(id);
    };
    let Ok(request_id) = serde_json::from_value::<RequestId>(id.clone()) else {
        return Normalized::Reject(id);
    };
    let marker = NEXT_MARKER.fetch_add(1, Ordering::Relaxed);
    let Some(arguments) = parsed
        .pointer_mut("/params/arguments")
        .and_then(Value::as_object_mut)
    else {
        return Normalized::Reject(id);
    };
    arguments.insert(SEARCH_MARKER.into(), json!(marker));
    let Ok(mut normalized) = serde_json::to_vec(&parsed) else {
        return Normalized::Reject(id);
    };
    normalized.push(b'\n');
    Normalized::Forward(normalized, Some((request_id, units, marker)))
}

fn reject(id: Value) -> Vec<u8> {
    let id = if serde_json::from_value::<RequestId>(id.clone()).is_ok() {
        id
    } else {
        Value::Null
    };
    let mut bytes = serde_json::to_vec(&json!({"jsonrpc":"2.0", "id":id,
        "error":{"code":-32600,"message":"Invalid UTF-16 request string"}}))
    .expect("static JSON-RPC error");
    bytes.push(b'\n');
    bytes
}

async fn bounded_line(
    reader: &mut BufReader<tokio::io::Stdin>,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |at| at + 1);
        if line.len() <= MAX_LINE {
            let take = consumed.min(MAX_LINE + 1 - line.len());
            line.extend_from_slice(&available[..take]);
        }
        let newline = available.get(consumed - 1) == Some(&b'\n');
        reader.consume(consumed);
        if newline {
            return Ok(Some(line));
        }
    }
}

pub(super) fn stdio() -> (DuplexStream, DuplexStream, SearchUnits) {
    let units: SearchUnits = Arc::new(Mutex::new(HashMap::new()));
    let (read, mut ingress) = tokio::io::duplex(64 * 1024);
    let (egress, write) = tokio::io::duplex(64 * 1024);
    let (outbound, mut incoming) = mpsc::channel::<Vec<u8>>(32);
    let output = outbound.clone();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = incoming.recv().await {
            if stdout.write_all(&line).await.is_err() {
                break;
            }
            if stdout.flush().await.is_err() {
                break;
            }
        }
    });
    tokio::spawn(async move {
        let mut reader = BufReader::new(egress);
        loop {
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if output.send(line).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    let pending = units.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(tokio::io::stdin());
        while let Ok(Some(line)) = bounded_line(&mut reader).await {
            if line.len() > MAX_LINE {
                let _ = outbound.send(reject(Value::Null)).await;
                continue;
            }
            match normalize(&line) {
                Normalized::Forward(line, sidecar) => {
                    if let Some((id, query, marker)) = sidecar {
                        let inserted = {
                            let mut map = pending.lock().expect("search unit sidecar");
                            map.retain(|_, (_, _, at)| at.elapsed() < Duration::from_secs(60));
                            if map.len() >= MAX_PENDING || map.contains_key(&id) {
                                false
                            } else {
                                map.insert(id.clone(), (query, marker, Instant::now()));
                                true
                            }
                        };
                        if !inserted {
                            let _ = outbound
                                .send(reject(serde_json::to_value(id).unwrap_or(Value::Null)))
                                .await;
                            continue;
                        }
                    }
                    if ingress.write_all(&line).await.is_err() {
                        break;
                    }
                }
                Normalized::Reject(id) => {
                    if outbound.send(reject(id)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    (read, write, units)
}

#[cfg(test)]
mod tests {
    use super::{Normalized, SEARCH_MARKER, SearchUnits, normalize, reject, take_search_units};
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    #[test]
    fn lone_query_units_are_private_and_other_json_is_preserved() {
        let request = br#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"session_search","arguments":{"query":"\uD83D \uE000 \u0000needle","fields":["assistant"]}}}"#;
        let Normalized::Forward(line, Some((id, units, marker))) = normalize(request) else {
            panic!("search query should carry units");
        };
        assert_eq!(serde_json::to_value(id).unwrap(), 7);
        assert_eq!(
            units,
            vec![
                0xd83d, 0x20, 0xe000, 0x20, 0, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65
            ]
        );
        let parsed: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(
            parsed.pointer("/params/arguments/query").unwrap(),
            "� \u{e000} \u{0}needle"
        );
        assert_eq!(
            parsed.pointer(&format!("/params/arguments/{SEARCH_MARKER}")),
            Some(&serde_json::json!(marker))
        );

        for ordinary in [
            br#"{"id":7,"method":"tools/call","params":{"name":"session_search","arguments":{"query":"\uD83D\uDE42"}}}"#.as_slice(),
            br#"{"id":7,"method":"tools/call","params":{"name":"session_search","arguments":{"query":"\\uD83D"}}}"#.as_slice(),
            br#"{"id":7,"id":8,"method":"tools/call","params":{"name":"session_search","arguments":{"query":"needle"}}}"#.as_slice(),
        ] {
            let Normalized::Forward(actual, None) = normalize(ordinary) else { panic!("ordinary JSON changed"); };
            assert_eq!(actual, ordinary);
        }
    }

    #[test]
    fn unrelated_lone_surrogates_are_rejected_with_request_id() {
        let invalid = br#"{"jsonrpc":"2.0","id":"bad","method":"tools/call","params":{"name":"session_get","arguments":{"session":{"provider":"codex","sessionId":"\uD83D"}}}}"#;
        let Normalized::Reject(id) = normalize(invalid) else {
            panic!("non-search surrogate must reject");
        };
        assert_eq!(id, "bad");
        let nested = br#"{"id":8,"method":"tools/call","params":{"name":"session_search","arguments":{"query":"normal","other":[{"query":"\uD83D"}]}}}"#;
        let Normalized::Reject(id) = normalize(nested) else {
            panic!("nested query must reject");
        };
        assert_eq!(id, 8);
        let error: Value =
            serde_json::from_slice(&reject(serde_json::json!({"bad":"id"}))).unwrap();
        assert!(error["id"].is_null(), "invalid JSON-RPC IDs become null");
    }

    #[test]
    fn missing_or_mismatched_sidecar_fails_before_search() {
        let pending: SearchUnits = Arc::new(Mutex::new(HashMap::new()));
        let id = serde_json::from_value(serde_json::json!(12)).unwrap();
        let mut missing = serde_json::json!({SEARCH_MARKER: 9})
            .as_object()
            .unwrap()
            .clone();
        assert!(
            take_search_units(&mut missing, &id, &pending).is_err(),
            "a pruned sidecar must never search the replacement character"
        );
        pending
            .lock()
            .unwrap()
            .insert(id.clone(), (vec![0xd83d], 10, Instant::now()));
        let mut collision = serde_json::json!({SEARCH_MARKER: 9})
            .as_object()
            .unwrap()
            .clone();
        assert!(
            take_search_units(&mut collision, &id, &pending).is_err(),
            "a different marker cannot borrow another request's units"
        );
        assert!(pending.lock().unwrap().is_empty());
        pending
            .lock()
            .unwrap()
            .insert(id.clone(), (vec![0xd83d], 10, Instant::now()));
        let mut unmarked = serde_json::Map::new();
        assert!(
            take_search_units(&mut unmarked, &id, &pending).is_err(),
            "an ordinary request cannot borrow stale units for a reused ID"
        );
        pending
            .lock()
            .unwrap()
            .insert(id.clone(), (vec![0xd83d], 10, Instant::now()));
        let mut owned = serde_json::json!({SEARCH_MARKER: 10})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            take_search_units(&mut owned, &id, &pending).unwrap(),
            Some(vec![0xd83d])
        );
        assert!(!owned.contains_key(SEARCH_MARKER));
    }

    #[test]
    fn duplicate_json_keys_on_exceptional_path_are_rejected() {
        for request in [
            br#"{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"session_search","arguments":{"query":"\uD83D"},"arguments":null}}"#.as_slice(),
            br#"{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"session_search","arguments":{"query":"\uD83D"}},"params":{"name":"session_search","arguments":null}}"#.as_slice(),
            br#"{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"session_search","arguments":{"query":"\uD83D","query":"ordinary"}}}"#.as_slice(),
            br#"{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"session_search","name":"session_search","arguments":{"query":"\uD83D"}}}"#.as_slice(),
            br#"{"jsonrpc":"2.0","id":17,"method":"tools/call","method":"tools/call","params":{"name":"session_search","arguments":{"query":"\uD83D"}}}"#.as_slice(),
        ] {
            let Normalized::Reject(id) = normalize(request) else {
                panic!("ambiguous exceptional request was forwarded: {}", String::from_utf8_lossy(request));
            };
            assert_eq!(id, 17);
        }
    }
}
