//! Bounded MCP search semantics over canonical provider Reader facts.
use crate::meta::ViewerMeta;
use crate::search_index::{self, SearchDocument};
use crate::{
    Core, CoreError, EventRef, Result, SessionSnapshot, SessionSummary, normalize_project_path,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
#[cfg(feature = "search-phase-probe")]
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(feature = "search-phase-probe")]
pub(crate) struct SearchPhaseProbe {
    started: Option<Instant>,
    phases_ms: BTreeMap<&'static str, f64>,
    catalog_rows: usize,
    documents: usize,
    candidates: usize,
    matches: usize,
    providers_attempted: usize,
    completed: bool,
}

#[cfg(feature = "search-phase-probe")]
impl SearchPhaseProbe {
    fn new() -> Self {
        Self {
            started: (std::env::var_os("AGENTSESSION_V3_SEARCH_PHASE_PROBE").as_deref()
                == Some(std::ffi::OsStr::new("1")))
            .then(Instant::now),
            phases_ms: BTreeMap::new(),
            catalog_rows: 0,
            documents: 0,
            candidates: 0,
            matches: 0,
            providers_attempted: 0,
            completed: false,
        }
    }

    pub(crate) fn begin(&self) -> Option<Instant> {
        self.started.map(|_| Instant::now())
    }

    pub(crate) fn add(&mut self, phase: &'static str, started: Option<Instant>) {
        if let Some(started) = started {
            self.add_duration(phase, started.elapsed());
        }
    }

    fn add_duration(&mut self, phase: &'static str, duration: Duration) {
        *self.phases_ms.entry(phase).or_default() += duration.as_secs_f64() * 1000.0;
    }
}

#[cfg(feature = "search-phase-probe")]
impl Drop for SearchPhaseProbe {
    fn drop(&mut self) {
        if let Some(started) = self.started {
            eprintln!(
                "{}",
                json!({
                    "kind": "search_phase_probe",
                    "total_ms": started.elapsed().as_secs_f64() * 1000.0,
                    "phases_ms": self.phases_ms,
                    "providers_attempted": self.providers_attempted,
                    "catalog_rows": self.catalog_rows,
                    "documents": self.documents,
                    "candidates": self.candidates,
                    "matches": self.matches,
                    "completed": self.completed,
                })
            );
        }
    }
}

const PROVIDERS: [&str; 5] = ["opencode", "claude-code", "codex", "pi", "deepseek-harness"];
const FIELDS: [&str; 5] = ["title", "directory", "user", "assistant", "toolName"];
const DEFAULT_FIELDS: [&str; 4] = ["title", "directory", "user", "assistant"];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchQuery {
    pub query: String,
    pub providers: Option<Vec<String>>,
    pub fields: Option<Vec<String>>,
    pub lineage: Option<String>,
    pub updated_after: Option<f64>,
    pub updated_before: Option<f64>,
    pub directory: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchCursor {
    version: u8,
    kind: String,
    scope: String,
    filters: String,
    revision: String,
    snapshot_updated_before: f64,
    after: Position,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Position {
    rank: u8,
    updated_at: i64,
    key: String,
}

struct Candidate {
    position: Position,
    value: Value,
}

fn order(left: &Position, right: &Position) -> Ordering {
    left.rank
        .cmp(&right.rank)
        .then_with(|| right.updated_at.cmp(&left.updated_at))
        .then_with(|| left.key.cmp(&right.key))
}

fn digest(value: &impl Serialize) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("search serialization"))
    )
}

fn matches(text: &str, terms: &[String]) -> bool {
    let lower = text.to_lowercase();
    terms.iter().all(|term| lower.contains(term))
}

#[derive(Clone)]
struct Utf16Query {
    query: Vec<u16>,
    terms: Vec<Vec<u16>>,
}

fn lower_utf16(units: &[u16]) -> Vec<u16> {
    let mut lowered = Vec::new();
    let mut valid_run = String::new();
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(character) => valid_run.push(character),
            Err(unpaired) => {
                lowered.extend(valid_run.to_lowercase().encode_utf16());
                valid_run.clear();
                lowered.push(unpaired.unpaired_surrogate());
            }
        }
    }
    lowered.extend(valid_run.to_lowercase().encode_utf16());
    lowered
}

fn js_whitespace(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a
        | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

impl Utf16Query {
    fn new(units: &[u16]) -> Result<Self> {
        let start = units
            .iter()
            .position(|unit| !js_whitespace(*unit))
            .unwrap_or(units.len());
        let end = units
            .iter()
            .rposition(|unit| !js_whitespace(*unit))
            .map_or(start, |at| at + 1);
        let query = units[start..end].to_vec();
        if query.is_empty() || query.len() > 500 {
            return Err(CoreError::InvalidInput(
                "query must contain between 1 and 500 characters".into(),
            ));
        }
        let terms = query
            .split(|unit| js_whitespace(*unit))
            .filter(|part| !part.is_empty())
            .map(lower_utf16)
            .collect();
        Ok(Self { query, terms })
    }

    fn matches(&self, text: &str) -> bool {
        let lower: Vec<u16> = text.to_lowercase().encode_utf16().collect();
        self.terms
            .iter()
            .all(|term| find_units(&lower, term, 0).is_some())
    }
}

fn matches_query(text: &str, terms: &[String], utf16: Option<&Utf16Query>) -> bool {
    utf16.map_or_else(|| matches(text, terms), |query| query.matches(text))
}

fn bounded(text: &str, max_units: usize) -> String {
    if text.encode_utf16().count() <= max_units {
        return text.into();
    }
    let mut output = String::new();
    let mut units = 0;
    for character in text.chars() {
        if units + character.len_utf16() > max_units {
            break;
        }
        output.push(character);
        units += character.len_utf16();
    }
    output.push('…');
    output
}

#[cfg(test)]
fn snippet(text: &str, query: &str) -> String {
    snippet_with_utf16(text, query, None)
}

fn snippet_with_utf16(text: &str, query: &str, utf16: Option<&Utf16Query>) -> String {
    const LIMIT: usize = 160;
    let source: Vec<u16> = text.encode_utf16().collect();
    if source.is_empty() {
        return String::new();
    }
    if query.is_empty() && utf16.is_none() {
        return String::from_utf16_lossy(&source[..aligned_end(&source, source.len().min(LIMIT))]);
    }

    let (lower, lower_starts, lower_ends) = folded_units(text);
    let lower_query: Vec<u16> = utf16.map_or_else(
        || query.to_lowercase().encode_utf16().collect(),
        |value| lower_utf16(&value.query),
    );
    let terms: Vec<Vec<u16>> = utf16.map_or_else(
        || {
            query
                .split_whitespace()
                .map(|term| term.to_lowercase().encode_utf16().collect())
                .collect()
        },
        |value| value.terms.clone(),
    );
    let exact = find_units(&lower, &lower_query, 0);
    if terms.len() > 1 {
        if let Some(at) = exact {
            let start = lower_starts[at].saturating_sub(40);
            let match_end = lower_ends[at + lower_query.len() - 1];
            let end = (match_end + 80).min(source.len());
            let excerpt = render_window(&source, start, end);
            if excerpt.encode_utf16().count() <= LIMIT {
                return excerpt;
            }
        }

        let mut positions = Vec::new();
        let search_start = exact.unwrap_or(0);
        for term in &terms {
            let Some(start) = find_units(&lower, term, search_start) else {
                positions.clear();
                break;
            };
            positions.push((lower_starts[start], lower_ends[start + term.len() - 1]));
        }
        if positions.len() == terms.len() {
            let spans = merge_windows(positions);
            let first = spans[0].0;
            let last = spans.last().expect("non-empty search windows").1;
            let available = LIMIT - usize::from(first > 0) - usize::from(last < source.len());
            if last - first <= available {
                let budget = available - (last - first);
                let mut before = first.min(40).min(budget / 3);
                let mut after = (source.len() - last).min(80).min(budget - before);
                let mut remaining = budget - before - after;
                let extra_before = (first - before).min(remaining);
                before += extra_before;
                remaining -= extra_before;
                after += (source.len() - last - after).min(remaining);
                return render_window(&source, first - before, last + after);
            }
            for radius in (0..=20).rev() {
                let windows = merge_windows(
                    spans
                        .iter()
                        .map(|(start, end)| {
                            (
                                start.saturating_sub(radius),
                                (end + radius).min(source.len()),
                            )
                        })
                        .collect(),
                );
                let excerpt = render_windows(&source, &windows);
                if excerpt.encode_utf16().count() <= LIMIT {
                    return excerpt;
                }
            }
            return truncate_windows(&source, &spans, LIMIT);
        }
    }

    let first_term = terms.first().map(Vec::as_slice).unwrap_or(&lower_query);
    let Some(lower_at) = exact.or_else(|| find_units(&lower, first_term, 0)) else {
        return String::from_utf16_lossy(&source[..aligned_end(&source, source.len().min(LIMIT))]);
    };
    let at = lower_starts[lower_at];
    let start = at.saturating_sub(40);
    let matched = if exact.is_some() {
        lower_query.len()
    } else {
        first_term.len()
    };
    let match_end = lower_ends[lower_at + matched - 1];
    let end = (match_end + 80).min(source.len());
    let excerpt = render_window(&source, start, end);
    if excerpt.encode_utf16().count() <= LIMIT {
        return excerpt;
    }
    let start = aligned_start(&source, start);
    let visible = LIMIT - usize::from(start > 0) - 1;
    let end = aligned_end(&source, (start + visible).min(source.len()));
    format!(
        "{}{}…",
        if start > 0 { "…" } else { "" },
        String::from_utf16_lossy(&source[start..end])
    )
}

fn folded_units(text: &str) -> (Vec<u16>, Vec<usize>, Vec<usize>) {
    let mut lower = Vec::new();
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    let mut source_at = 0;
    for character in text.chars() {
        let start = source_at;
        source_at += character.len_utf16();
        for folded in character.to_lowercase() {
            let mut buffer = [0; 2];
            for unit in folded.encode_utf16(&mut buffer) {
                lower.push(*unit);
                starts.push(start);
                ends.push(source_at);
            }
        }
    }
    (lower, starts, ends)
}

fn find_units(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

fn merge_windows(mut windows: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    windows.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in windows {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    merged
}

fn aligned_start(source: &[u16], start: usize) -> usize {
    if start > 0
        && start < source.len()
        && (0xdc00..=0xdfff).contains(&source[start])
        && (0xd800..=0xdbff).contains(&source[start - 1])
    {
        start + 1
    } else {
        start
    }
}

fn aligned_end(source: &[u16], end: usize) -> usize {
    if end > 0
        && end < source.len()
        && (0xd800..=0xdbff).contains(&source[end - 1])
        && (0xdc00..=0xdfff).contains(&source[end])
    {
        end - 1
    } else {
        end
    }
}

fn render_window(source: &[u16], start: usize, end: usize) -> String {
    let start = aligned_start(source, start);
    let end = aligned_end(source, end).max(start);
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        String::from_utf16_lossy(&source[start..end]),
        if end < source.len() { "…" } else { "" }
    )
}

fn render_windows(source: &[u16], windows: &[(usize, usize)]) -> String {
    let mut excerpt = String::new();
    for (index, (start, end)) in windows.iter().enumerate() {
        let start = aligned_start(source, *start);
        let end = aligned_end(source, *end).max(start);
        if index > 0 || start > 0 {
            excerpt.push('…');
        }
        excerpt.push_str(&String::from_utf16_lossy(&source[start..end]));
    }
    if windows.last().is_some_and(|(_, end)| *end < source.len()) {
        excerpt.push('…');
    }
    excerpt
}

fn truncate_windows(source: &[u16], windows: &[(usize, usize)], limit: usize) -> String {
    let mut remaining = limit - 1;
    let mut excerpt = String::new();
    for (index, (start, end)) in windows.iter().enumerate() {
        let start = aligned_start(source, *start);
        let end = aligned_end(source, *end).max(start);
        let separator = index > 0 || start > 0;
        if separator {
            if remaining == 0 {
                break;
            }
            excerpt.push('…');
            remaining -= 1;
        }
        let visible = (end - start).min(remaining);
        let visible_end = aligned_end(source, start + visible);
        excerpt.push_str(&String::from_utf16_lossy(&source[start..visible_end]));
        remaining -= visible_end - start;
        if visible_end < end || remaining == 0 {
            break;
        }
    }
    excerpt.push('…');
    excerpt
}

fn candidate(
    summary: &SessionSummary,
    field: &str,
    text: &str,
    event: Option<EventRef>,
    role: Option<&str>,
    query: &str,
    utf16: Option<&Utf16Query>,
) -> Candidate {
    let rank = match field {
        "title" => 0,
        "directory" => 1,
        "message" => 2,
        _ => 3,
    };
    let key = format!(
        "{}\0{}",
        summary.session.provider, summary.session.session_id
    );
    let excerpt = if matches!(field, "title" | "directory") {
        bounded(text, 240)
    } else {
        snippet_with_utf16(text, query, utf16)
    };
    Candidate {
        position: Position {
            rank,
            updated_at: summary.updated_at.unwrap_or(0),
            key,
        },
        value: json!({
            "session": summary.session, "event": event,
            "matchField": field, "matchRole": role, "snippet": excerpt,
            "title": summary.title, "directory": summary.directory,
            "updatedAt": summary.updated_at.unwrap_or(0), "untrustedContent": true,
        }),
    }
}

fn best_match(
    summary: &SessionSummary,
    session: Option<&SessionSnapshot>,
    fields: &[String],
    terms: &[String],
    query: &str,
    utf16: Option<&Utf16Query>,
) -> Option<Candidate> {
    if let Some(title) = summary.search_title.as_deref() {
        if fields.iter().any(|field| field == "title") && matches_query(title, terms, utf16) {
            return Some(candidate(summary, "title", title, None, None, query, utf16));
        }
    }
    if let Some(directory) = summary.directory.as_deref() {
        if fields.iter().any(|field| field == "directory") && matches_query(directory, terms, utf16)
        {
            return Some(candidate(
                summary,
                "directory",
                directory,
                None,
                None,
                query,
                utf16,
            ));
        }
    }
    let session = session?;
    for record in &session.events {
        let field = if record.item.role == "agent" {
            "assistant"
        } else {
            record.item.role.as_str()
        };
        if record.item.event.segment != "message"
            || !matches!(record.item.role.as_str(), "user" | "assistant" | "agent")
            || !fields.iter().any(|selected| selected == field)
            || !matches_query(&record.body, terms, utf16)
        {
            continue;
        }
        return Some(candidate(
            summary,
            "message",
            &record.body,
            Some(record.item.event.clone()),
            Some(&record.item.role),
            query,
            utf16,
        ));
    }
    if fields.iter().any(|field| field == "toolName") {
        for record in &session.events {
            if record.item.event.segment != "tool" {
                continue;
            }
            let Some(name) = record.item.tool_name.as_deref() else {
                continue;
            };
            if matches_query(name, terms, utf16) {
                return Some(candidate(
                    summary,
                    "toolName",
                    name,
                    Some(record.item.event.clone()),
                    Some(&record.item.role),
                    query,
                    utf16,
                ));
            }
        }
    }
    None
}

fn best_match_docs(
    summary: &SessionSummary,
    docs: &[SearchDocument],
    fields: &[String],
    terms: &[String],
    query: &str,
    utf16: Option<&Utf16Query>,
) -> Option<Candidate> {
    for field in ["title", "directory"] {
        if !fields.iter().any(|selected| selected == field) {
            continue;
        }
        if let Some(doc) = docs
            .iter()
            .find(|doc| doc.field == field && matches_query(&doc.text, terms, utf16))
        {
            return Some(candidate(
                summary, field, &doc.text, None, None, query, utf16,
            ));
        }
    }
    if let Some(doc) = docs
        .iter()
        .filter(|doc| {
            matches!(doc.field.as_str(), "user" | "assistant")
                && fields.iter().any(|selected| selected == &doc.field)
                && matches_query(&doc.text, terms, utf16)
        })
        .min_by_key(|doc| doc.position)
    {
        return Some(candidate(
            summary,
            "message",
            &doc.text,
            doc.event.clone(),
            doc.role.as_deref(),
            query,
            utf16,
        ));
    }
    if fields.iter().any(|field| field == "toolName") {
        if let Some(doc) = docs
            .iter()
            .filter(|doc| doc.field == "toolName" && matches_query(&doc.text, terms, utf16))
            .min_by_key(|doc| doc.position)
        {
            return Some(candidate(
                summary,
                "toolName",
                &doc.text,
                doc.event.clone(),
                doc.role.as_deref(),
                query,
                utf16,
            ));
        }
    }
    None
}

impl Core {
    pub fn session_search(&self, query: SearchQuery) -> Result<Value> {
        #[cfg(feature = "search-phase-probe")]
        let mut probe = SearchPhaseProbe::new();
        self.search_impl(
            query,
            None,
            None,
            #[cfg(feature = "search-phase-probe")]
            &mut probe,
        )
    }

    pub fn session_search_utf16(&self, query: SearchQuery, units: Vec<u16>) -> Result<Value> {
        #[cfg(feature = "search-phase-probe")]
        let mut probe = SearchPhaseProbe::new();
        self.search_impl(
            query,
            Some(units),
            None,
            #[cfg(feature = "search-phase-probe")]
            &mut probe,
        )
    }

    pub fn viewer_search(&self, query: SearchQuery) -> Result<Value> {
        #[cfg(feature = "search-phase-probe")]
        let mut probe = SearchPhaseProbe::new();
        #[cfg(feature = "search-phase-probe")]
        let phase_started = probe.begin();
        let metadata = self.viewer_metadata()?;
        #[cfg(feature = "search-phase-probe")]
        probe.add("viewer_metadata", phase_started);
        self.search_impl(
            query,
            None,
            Some(metadata),
            #[cfg(feature = "search-phase-probe")]
            &mut probe,
        )
    }

    fn search_impl(
        &self,
        query: SearchQuery,
        utf16_units: Option<Vec<u16>>,
        viewer_metadata: Option<HashMap<(String, String), ViewerMeta>>,
        #[cfg(feature = "search-phase-probe")] probe: &mut SearchPhaseProbe,
    ) -> Result<Value> {
        let utf16 = utf16_units.as_deref().map(Utf16Query::new).transpose()?;
        let text = query.query.trim();
        if utf16.is_none() && (text.is_empty() || text.encode_utf16().count() > 500) {
            return Err(CoreError::InvalidInput(
                "query must contain between 1 and 500 characters".into(),
            ));
        }
        let terms: Vec<String> = if utf16.is_some() {
            Vec::new()
        } else {
            text.split_whitespace()
                .map(str::to_lowercase)
                .filter(|term| !term.is_empty())
                .collect()
        };
        let mut providers = query
            .providers
            .unwrap_or_else(|| PROVIDERS.map(str::to_owned).to_vec());
        if providers.len() > 5 || providers.iter().any(|id| !PROVIDERS.contains(&id.as_str())) {
            return Err(CoreError::InvalidInput(
                "providers contains an unknown provider".into(),
            ));
        }
        let mut seen = HashSet::new();
        providers.retain(|provider| seen.insert(provider.clone()));
        let mut fields = query
            .fields
            .unwrap_or_else(|| DEFAULT_FIELDS.map(str::to_owned).to_vec());
        if fields.is_empty()
            || fields.len() > 5
            || fields.iter().any(|field| !FIELDS.contains(&field.as_str()))
        {
            return Err(CoreError::InvalidInput(
                "fields contains an unknown or missing field".into(),
            ));
        }
        let mut seen = HashSet::new();
        fields.retain(|field| seen.insert(field.clone()));
        let lineage = query.lineage.unwrap_or_else(|| "all".into());
        if !matches!(lineage.as_str(), "all" | "roots" | "children") {
            return Err(CoreError::InvalidInput(
                "lineage must be all, roots, or children".into(),
            ));
        }
        let limit = query.limit.unwrap_or(20);
        if limit == 0 || limit > 100 {
            return Err(CoreError::InvalidInput(
                "limit must be between 1 and 100".into(),
            ));
        }
        if query.updated_after.is_some_and(|value| !value.is_finite())
            || query.updated_before.is_some_and(|value| !value.is_finite())
            || query
                .updated_after
                .zip(query.updated_before)
                .is_some_and(|(after, before)| after > before)
        {
            return Err(CoreError::InvalidInput(
                "updatedAfter and updatedBefore must be finite and ordered".into(),
            ));
        }
        let directory = query
            .directory
            .as_ref()
            .map(|value| value.trim())
            .map(normalize_project_path);
        if directory.as_deref() == Some("")
            || query
                .directory
                .as_ref()
                .is_some_and(|value| value.encode_utf16().count() > 4000)
        {
            return Err(CoreError::InvalidInput(
                "directory must be a non-empty recorded project path".into(),
            ));
        }
        let filters = digest(
            &json!({"query":utf16.as_ref().map_or_else(|| json!(text), |value| json!({"utf16":value.query})), "providers":providers, "fields":fields,
            "lineage":lineage, "updatedAfter":query.updated_after, "updatedBefore":query.updated_before,
            "directory":directory}),
        );
        let saved = match query.cursor.as_deref() {
            None => None,
            Some(token) if !token.is_empty() && token.len() <= 4000 => {
                let value: SearchCursor =
                    serde_json::from_str(token).map_err(|_| CoreError::InvalidCursor)?;
                if value.version != 1
                    || value.kind != "session_search"
                    || value.scope != self.source_scope
                    || value.filters != filters
                    || value.after.rank > 3
                    || value.after.key.is_empty()
                {
                    return Err(CoreError::InvalidCursor);
                }
                Some(value)
            }
            Some(_) => return Err(CoreError::InvalidCursor),
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64;
        let snapshot_before = saved
            .as_ref()
            .map(|cursor| cursor.snapshot_updated_before)
            .unwrap_or_else(|| query.updated_before.unwrap_or(now));
        if !snapshot_before.is_finite() || snapshot_before < 0.0 {
            return Err(CoreError::InvalidCursor);
        }
        let mut candidates = Vec::new();
        let mut diagnostics = Vec::new();
        let mut revisions = Vec::new();
        if let Some(metadata) = &viewer_metadata {
            let mut relevant: Vec<_> = metadata
                .iter()
                .filter(|((provider, _), _)| providers.contains(provider))
                .map(|((provider, id), row)| {
                    (provider, id, &row.custom_title, row.deleted, row.permanent)
                })
                .collect();
            relevant.sort_by(|left, right| (left.0, left.1).cmp(&(right.0, right.1)));
            revisions.push(json!(["viewer-metadata", digest(&relevant)]));
        }
        let wants_content = fields
            .iter()
            .any(|field| matches!(field.as_str(), "user" | "assistant" | "toolName"));
        for provider in &providers {
            let started = std::time::Instant::now();
            #[cfg(feature = "search-phase-probe")]
            {
                probe.providers_attempted += 1;
            }
            #[cfg(feature = "search-phase-probe")]
            let phase_started = probe.begin();
            #[cfg(feature = "search-phase-probe")]
            let indexed = self.indexed_sessions_with_probe(provider, probe);
            #[cfg(not(feature = "search-phase-probe"))]
            let indexed = self.indexed_sessions_for_search(provider);
            #[cfg(feature = "search-phase-probe")]
            probe.add("indexed_sessions", phase_started);
            let (summaries, catalog_revision, uncertainty) = match indexed {
                Ok(value) => value,
                Err(CoreError::Unavailable(_)) => {
                    diagnostics.push(json!({"provider":provider,"status":"unavailable"}));
                    revisions.push(json!([provider, "unavailable"]));
                    continue;
                }
                Err(error) => {
                    diagnostics.push(
                        json!({"provider":provider,"status":"error","message":error.to_string()}),
                    );
                    revisions.push(json!([provider, "error", error.to_string()]));
                    continue;
                }
            };
            #[cfg(feature = "search-phase-probe")]
            {
                probe.catalog_rows += summaries.len();
            }
            let mut source_diagnostics = BTreeMap::<String, usize>::new();
            for row in &summaries {
                if let Some(code) = &row.diagnostic {
                    *source_diagnostics.entry(code.clone()).or_default() += 1;
                }
            }
            if source_diagnostics.is_empty() {
                if let Some((code, count)) = uncertainty {
                    source_diagnostics.insert(code.into(), count);
                }
            }
            let mut session_revisions = Vec::new();
            let mut provider_candidates = Vec::new();
            let mut error = None;
            let indexed = catalog_revision.starts_with(&format!("{provider}:"));
            let mut docs_by_session: HashMap<String, Vec<SearchDocument>> = HashMap::new();
            if indexed {
                let document_fields: Vec<String> = if viewer_metadata.is_some() {
                    fields
                        .iter()
                        .filter(|field| matches!(field.as_str(), "user" | "assistant" | "toolName"))
                        .cloned()
                        .collect()
                } else {
                    fields.clone()
                };
                #[cfg(feature = "search-phase-probe")]
                let phase_started = probe.begin();
                let read = search_index::read_docs_with_utf16(
                    &self.config.index_dir,
                    &self.source_scope,
                    provider,
                    &catalog_revision,
                    &document_fields,
                    &terms,
                    utf16.as_ref().map(|value| value.terms.as_slice()),
                );
                #[cfg(feature = "search-phase-probe")]
                probe.add("search_index_read_docs", phase_started);
                match read {
                    Ok(docs) => {
                        #[cfg(feature = "search-phase-probe")]
                        {
                            probe.documents += docs.docs.len();
                        }
                        for doc in docs.docs {
                            docs_by_session
                                .entry(doc.session_id.clone())
                                .or_default()
                                .push(doc);
                        }
                    }
                    Err(failure) => error = Some(failure.to_string()),
                }
            }
            #[cfg(feature = "search-phase-probe")]
            let phase_started = probe.begin();
            for mut summary in summaries {
                if error.is_some() {
                    break;
                }
                if let Some(metadata) = &viewer_metadata {
                    if let Some(row) =
                        metadata.get(&(provider.clone(), summary.session.session_id.clone()))
                    {
                        if row.deleted || row.permanent {
                            continue;
                        }
                        if let Some(title) = &row.custom_title {
                            summary.title = title.clone();
                            summary.search_title = Some(title.clone());
                        }
                    }
                }
                let updated = summary.updated_at.unwrap_or(0) as f64;
                if query.updated_after.is_some_and(|bound| updated < bound)
                    || updated > snapshot_before
                    || directory.as_ref().is_some_and(|path| {
                        normalize_project_path(summary.directory.as_deref().unwrap_or("")) != *path
                    })
                    || lineage == "roots" && summary.parent.is_some()
                    || lineage == "children" && summary.parent.is_none()
                {
                    continue;
                }
                if indexed {
                    let docs = docs_by_session
                        .get(&summary.session.session_id)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]);
                    let found = if viewer_metadata.is_some() {
                        let content_fields: Vec<_> = fields
                            .iter()
                            .filter(|field| !matches!(field.as_str(), "title" | "directory"))
                            .cloned()
                            .collect();
                        best_match(&summary, None, &fields, &terms, text, utf16.as_ref()).or_else(
                            || {
                                best_match_docs(
                                    &summary,
                                    docs,
                                    &content_fields,
                                    &terms,
                                    text,
                                    utf16.as_ref(),
                                )
                            },
                        )
                    } else {
                        best_match_docs(&summary, docs, &fields, &terms, text, utf16.as_ref())
                    };
                    if let Some(found) = found {
                        provider_candidates.push(found);
                    }
                    continue;
                }
                let snapshot = if wants_content {
                    match self.load_session(provider, &summary.session.session_id) {
                        Ok(value) => {
                            session_revisions
                                .push((summary.session.session_id.clone(), value.revision.clone()));
                            Some(value)
                        }
                        Err(failure) => {
                            error = Some(failure.to_string());
                            break;
                        }
                    }
                } else {
                    None
                };
                if let Some(found) = best_match(
                    &summary,
                    snapshot.as_ref(),
                    &fields,
                    &terms,
                    text,
                    utf16.as_ref(),
                ) {
                    provider_candidates.push(found);
                }
            }
            #[cfg(feature = "search-phase-probe")]
            probe.add("candidate_projection", phase_started);
            if let Some(message) = error {
                diagnostics.push(
                    json!({"provider":provider,"status":"error","message":message,
                    "durationMs":started.elapsed().as_millis()}),
                );
                revisions.push(json!([provider, "error", message]));
            } else {
                diagnostics.push(json!({"provider":provider,
                    "status": if source_diagnostics.is_empty() { "ok" } else { "partial" },
                    "sourceDiagnostics": source_diagnostics.into_iter()
                        .map(|(code, count)| json!({"code":code,"affectedSessions":count}))
                        .collect::<Vec<_>>(),
                    "durationMs":started.elapsed().as_millis()}));
                revisions.push(json!([provider, catalog_revision, session_revisions]));
                candidates.extend(provider_candidates);
            }
        }
        #[cfg(feature = "search-phase-probe")]
        {
            probe.candidates = candidates.len();
        }
        #[cfg(feature = "search-phase-probe")]
        let phase_started = probe.begin();
        let revision = digest(&revisions);
        if saved
            .as_ref()
            .is_some_and(|cursor| cursor.revision != revision)
        {
            return Err(CoreError::SourceChanged);
        }
        candidates.sort_by(|left, right| order(&left.position, &right.position));
        let after = saved.as_ref().map(|cursor| &cursor.after);
        let mut page = candidates.into_iter().filter(|candidate| {
            after.is_none_or(|position| order(&candidate.position, position) == Ordering::Greater)
        });
        let selected: Vec<_> = page.by_ref().take(limit).collect();
        #[cfg(feature = "search-phase-probe")]
        {
            probe.matches = selected.len();
        }
        let more = page.next().is_some();
        let next_cursor = if more {
            selected.last().map(|candidate| {
                serde_json::to_string(&SearchCursor {
                    version: 1,
                    kind: "session_search".into(),
                    scope: self.source_scope.clone(),
                    filters,
                    revision,
                    snapshot_updated_before: snapshot_before,
                    after: Position {
                        rank: candidate.position.rank,
                        updated_at: candidate.position.updated_at,
                        key: candidate.position.key.clone(),
                    },
                })
                .expect("search cursor serialization")
            })
        } else {
            None
        };
        let result = json!({"matches":selected.into_iter().map(|candidate| candidate.value).collect::<Vec<_>>(),
            "diagnostics":diagnostics, "nextCursor":next_cursor,
            "snapshotUpdatedBefore":snapshot_before, "truncated":more, "untrustedContent":true});
        #[cfg(feature = "search-phase-probe")]
        {
            probe.add("sort_page", phase_started);
            probe.completed = true;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::{Utf16Query, best_match, bounded, matches, snippet, snippet_with_utf16};
    use crate::{Core, SessionRef, SessionSummary, SourceConfig, providers};
    use std::fs;
    use std::path::Path;

    #[test]
    fn lone_surrogate_matches_utf16_units_without_matching_literal_pua() {
        let high = Utf16Query::new(&[0xd83d]).unwrap();
        let low = Utf16Query::new(&[0xde42]).unwrap();
        let pua = Utf16Query::new(&[0xe000]).unwrap();
        assert!(high.matches("🙂ab"));
        assert!(low.matches("🙂ab"));
        assert!(!high.matches("\u{e000}"));
        assert!(!pua.matches("🙂ab"));
        assert!(pua.matches("\u{e000}"));
        assert_eq!(
            snippet_with_utf16("prefix 🙂ab suffix", "�", Some(&low)),
            "prefix 🙂ab suffix"
        );
        let and = Utf16Query::new(&[0xd83d, 0x0020, b'a' as u16, b'b' as u16]).unwrap();
        assert!(and.matches("🙂ab"));
        assert!(!and.matches("🙂ac"));
        let sigma = Utf16Query::new(&[0xd83d, 0x0020, 0x039f, 0x03a3]).unwrap();
        assert!(
            sigma.matches("🙂 ΟΣ"),
            "query lowering keeps final-sigma context"
        );
        assert!(!sigma.matches("🙂 ΟΤ"));
    }

    fn codex_search(root: &Path) -> serde_json::Value {
        let core = Core::new(SourceConfig {
            codex_dir: root.join("codex"),
            opencode_db: root.join("opencode.db"),
            claude_dir: root.join("claude"),
            pi_dir: root.join("pi"),
            dsh_dir: root.join("dsh"),
            meta_dir: root.join("meta"),
            index_dir: root.join("index"),
            cache_dir: root.join("cache"),
        })
        .unwrap();
        core.session_search(super::SearchQuery {
            query: "absent-term".into(),
            providers: Some(vec!["codex".into()]),
            fields: Some(vec!["title".into()]),
            lineage: None,
            updated_after: None,
            updated_before: None,
            directory: None,
            cursor: None,
            limit: None,
        })
        .unwrap()
    }

    #[test]
    fn unchanged_codex_search_observes_inventory_once_with_or_without_resolved_sessions() {
        for source in [None, Some("valid"), Some("unresolved")] {
            let root = tempfile::tempdir().unwrap();
            fs::create_dir_all(root.path().join("codex/sessions")).unwrap();
            match source {
                Some("valid") => fs::write(
                    root.path().join("codex/sessions/rollout.jsonl"),
                    "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session\"}}\n",
                )
                .unwrap(),
                Some("unresolved") => fs::write(
                    root.path().join("codex/sessions/rollout.jsonl"),
                    "{invalid}\n",
                )
                .unwrap(),
                _ => {}
            }
            codex_search(root.path());
            let before = providers::codex_inventory_walks();
            let result = codex_search(root.path());
            assert_eq!(
                providers::codex_inventory_walks() - before,
                1,
                "source={source:?}"
            );
            assert_eq!(result["matches"].as_array().unwrap().len(), 0);
            assert_eq!(
                result["diagnostics"][0]["status"],
                if source == Some("unresolved") {
                    "partial"
                } else {
                    "ok"
                }
            );
            if source == Some("unresolved") {
                assert_eq!(
                    result["diagnostics"][0]["sourceDiagnostics"],
                    serde_json::json!([{
                        "code": "codex_source_inventory_incomplete",
                        "affectedSessions": 1
                    }])
                );
            }
        }
    }

    #[test]
    fn display_only_canonical_title_is_not_a_source_title_hit() {
        let mut summary = SessionSummary {
            diagnostic: None,
            session: SessionRef {
                provider: "codex".into(),
                session_id: "canonical-id".into(),
            },
            title: "canonical-id".into(),
            search_title: None,
            directory: None,
            created_at: None,
            updated_at: Some(10),
            message_count: 0,
            conversation_message_count: None,
            token_count: None,
            duration_ms: None,
            summary_files: None,
            summary_additions: None,
            summary_deletions: None,
            parent: None,
        };
        let fields = vec!["title".into()];
        let terms = vec!["canonical-id".into()];
        assert!(best_match(&summary, None, &fields, &terms, "canonical-id", None).is_none());
        summary.search_title = Some("canonical-id".into());
        assert!(best_match(&summary, None, &fields, &terms, "canonical-id", None).is_some());
    }

    #[test]
    fn metadata_excerpt_uses_the_full_240_unit_boundary() {
        assert_eq!(
            bounded(&"x".repeat(241), 240),
            format!("{}…", "x".repeat(240))
        );
        assert_eq!(
            bounded(&format!("{}a", "🙂".repeat(120)), 240),
            format!("{}…", "🙂".repeat(120))
        );
    }

    #[test]
    fn search_excerpt_preserves_the_frozen_single_term_window_and_distant_terms() {
        let ascii = format!("{}codex{}", "x".repeat(70), "y".repeat(100));
        assert_eq!(
            snippet(&ascii, "codex"),
            format!("…{}codex{}…", "x".repeat(40), "y".repeat(80))
        );

        let unicode = format!("{}codex{}", "🙂".repeat(50), "z".repeat(100));
        assert_eq!(
            snippet(&unicode, "codex"),
            format!("…{}codex{}…", "🙂".repeat(20), "z".repeat(80))
        );

        let separated = format!("codex{}session", "x".repeat(300));
        let excerpt = snippet(&separated, "codex session");
        assert!(excerpt.contains("codex"));
        assert!(excerpt.contains("session"));
        assert!(excerpt.encode_utf16().count() <= 160);
    }

    #[test]
    fn unicode_and_late_matches_keep_a_bounded_readable_excerpt() {
        let terms = vec!["频道".into(), "🙂".into()];
        let body = format!("{}频道记录🙂后续", "背景".repeat(180));
        assert!(matches(&body, &terms));
        let excerpt = snippet(&body, "频道 🙂");
        assert!(excerpt.contains("频道记录🙂"));
        assert!(excerpt.encode_utf16().count() <= 160);
        assert!(excerpt.starts_with('…'));
        assert!(!matches(&body, &["频道".into(), "缺失".into()]));
        let expanded = format!("{}ALPHA{}", "İ".repeat(80), "🙂".repeat(80));
        let excerpt = snippet(&expanded, "alpha");
        assert!(
            excerpt.contains("ALPHA"),
            "the excerpt must retain a hit after lowercase expansion"
        );
        assert!(excerpt.encode_utf16().count() <= 160);
    }

    #[test]
    fn excerpt_windows_never_split_unicode_scalar_values() {
        for body in [
            format!("{}aneedle{}", "🙂".repeat(21), "🙂".repeat(70)),
            format!("needleX{}", "🙂".repeat(70)),
            format!("{}first{}second", "🙂".repeat(21), "🙂".repeat(100)),
        ] {
            let query = if body.contains("first") {
                "first second"
            } else {
                "needle"
            };
            let excerpt = snippet(&body, query);
            assert!(!excerpt.contains('�'), "split surrogate in {excerpt}");
            assert!(excerpt.encode_utf16().count() <= 160);
            for term in query.split_whitespace() {
                assert!(excerpt.contains(term));
            }
        }
    }
}
