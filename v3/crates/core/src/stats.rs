//! Source-backed statistics over complete active provider session inventories.
use crate::protocol::{Diagnostic, ProtocolError, UsageObservation, UsageRecord};
use crate::{Core, CoreError, Result, SessionRef, normalize_project_path};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::path::Path;
#[cfg(feature = "stats-phase-probe")]
use std::time::{Duration, Instant};

#[cfg(feature = "stats-phase-probe")]
struct StatsPhaseProbe {
    enabled: bool,
    started: Instant,
    phases_ms: BTreeMap<&'static str, f64>,
    observed_sessions: usize,
    cached_sessions: usize,
}

#[cfg(feature = "stats-phase-probe")]
impl StatsPhaseProbe {
    fn new() -> Self {
        Self {
            enabled: std::env::var_os("AGENTSESSION_V3_STATS_PHASE_PROBE").as_deref()
                == Some(std::ffi::OsStr::new("1")),
            started: Instant::now(),
            phases_ms: BTreeMap::new(),
            observed_sessions: 0,
            cached_sessions: 0,
        }
    }

    fn add(&mut self, phase: &'static str, duration: Duration) {
        if self.enabled {
            *self.phases_ms.entry(phase).or_default() += duration.as_secs_f64() * 1000.0;
        }
    }

    fn finish(self, response_sessions: usize, captured_sessions: usize) {
        if self.enabled {
            eprintln!(
                "{}",
                serde_json::json!({
                    "kind": "stats_phase_probe",
                    "total_ms": self.started.elapsed().as_secs_f64() * 1000.0,
                    "phases_ms": self.phases_ms,
                    "response_sessions": response_sessions,
                    "cached_sessions": self.cached_sessions,
                    "observed_sessions": self.observed_sessions,
                    "captured_sessions": captured_sessions,
                })
            );
        }
    }
}

#[cfg(test)]
thread_local! {
    static STATS_PROTOCOL_LOADS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static STATS_BEFORE_FINAL_REVISION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
    static STATS_AFTER_FINAL_REVISION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

// Request attribution and recorded dimension presence changes recapture cached rows.
const STATS_PROJECTION_VERSION: i64 = 8;

#[path = "stats_overview.rs"]
mod overview;
pub use overview::StatsHarnessSource;

#[cfg(test)]
fn stats_protocol_loads() -> usize {
    STATS_PROTOCOL_LOADS.with(std::cell::Cell::get)
}

/// Only fields read by statistics are persisted; the provider's validated
/// observation snapshot remains the owner of the full protocol record.
#[derive(Clone, Deserialize, Serialize)]
struct StatsUsage {
    session_ref: SessionRef,
    timestamp: Option<i64>,
    model: Option<String>,
    model_provider: Option<String>,
    event_id: Option<String>,
    tokens: StatsUsageTokens,
}

#[derive(Clone, Deserialize, Serialize)]
struct StatsUsageTokens {
    input: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    output: Option<u64>,
    reasoning: Option<u64>,
    total: Option<u64>,
}

impl From<&UsageRecord> for StatsUsage {
    fn from(record: &UsageRecord) -> Self {
        Self {
            session_ref: record.session_ref.clone(),
            timestamp: record.timestamp,
            model: record.model.clone(),
            model_provider: record.model_provider.clone(),
            event_id: record.event_id.clone(),
            tokens: StatsUsageTokens {
                input: record.tokens.input,
                cache_read: record.tokens.cache_read,
                cache_write: record.tokens.cache_write,
                output: record.tokens.output,
                reasoning: record.tokens.reasoning,
                total: record.tokens.total,
            },
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct StatsUsageObservation {
    session_ref: SessionRef,
    timestamp: Option<i64>,
}

impl From<&UsageObservation> for StatsUsageObservation {
    fn from(observation: &UsageObservation) -> Self {
        Self {
            session_ref: observation.session_ref.clone(),
            timestamp: observation.timestamp,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct StatsUsageProjection {
    requests: Vec<StatsUsage>,
    observations: Vec<StatsUsageObservation>,
}

struct StatsUsageCache {
    db: Connection,
}

impl StatsUsageCache {
    fn open(cache_dir: &Path, scope: &str) -> Result<Self> {
        fs::create_dir_all(cache_dir).map_err(|source| CoreError::Io {
            path: cache_dir.to_owned(),
            source,
        })?;
        let db = Connection::open(cache_dir.join(format!("{scope}.stats-v2.sqlite")))
            .map_err(stats_storage)?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS stats_usage (
                projection_version INTEGER NOT NULL,
                provider TEXT NOT NULL,
                revision TEXT NOT NULL,
                source_revision TEXT NOT NULL,
                session_id TEXT NOT NULL,
                usage_json TEXT NOT NULL,
                PRIMARY KEY (projection_version, provider, revision, source_revision, session_id)
             );",
        )
        .map_err(stats_storage)?;
        Ok(Self { db })
    }

    fn load(
        &self,
        provider: &str,
        revision: &str,
        source_revision: &str,
    ) -> Result<HashMap<String, StatsUsageProjection>> {
        let mut query = self
            .db
            .prepare(
                "SELECT session_id, usage_json FROM stats_usage
             WHERE projection_version = ?1 AND provider = ?2 AND revision = ?3
               AND source_revision = ?4",
            )
            .map_err(stats_storage)?;
        let rows = query
            .query_map(
                params![
                    STATS_PROJECTION_VERSION,
                    provider,
                    revision,
                    source_revision
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(stats_storage)?;
        let mut cached = HashMap::new();
        for row in rows {
            let (id, json) = row.map_err(stats_storage)?;
            let projection: StatsUsageProjection =
                serde_json::from_str(&json).map_err(stats_storage)?;
            if projection.requests.iter().any(|record| {
                record.session_ref.provider != provider || record.session_ref.session_id != id
            }) || projection.observations.iter().any(|observation| {
                observation.session_ref.provider != provider
                    || observation.session_ref.session_id != id
            }) {
                return Err(CoreError::Storage(format!(
                    "stats usage identity differs from {provider}/{id} cache key"
                )));
            }
            cached.insert(id, projection);
        }
        Ok(cached)
    }

    fn publish(
        &mut self,
        provider: &str,
        revision: &str,
        source_revision: &str,
        captured: &[String],
        usage: &HashMap<String, StatsUsageProjection>,
    ) -> Result<()> {
        let stale: i64 = self
            .db
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM stats_usage WHERE provider = ?1
             AND (projection_version <> ?2 OR revision <> ?3 OR source_revision <> ?4))",
                params![
                    provider,
                    STATS_PROJECTION_VERSION,
                    revision,
                    source_revision
                ],
                |row| row.get(0),
            )
            .map_err(stats_storage)?;
        if captured.is_empty() && stale == 0 {
            return Ok(());
        }
        let tx = self.db.transaction().map_err(stats_storage)?;
        tx.execute(
            "DELETE FROM stats_usage WHERE provider = ?1
                    AND (projection_version <> ?2 OR revision <> ?3 OR source_revision <> ?4)",
            params![
                provider,
                STATS_PROJECTION_VERSION,
                revision,
                source_revision
            ],
        )
        .map_err(stats_storage)?;
        for id in captured {
            let json = serde_json::to_string(&usage[id]).map_err(stats_storage)?;
            tx.execute(
                "INSERT OR REPLACE INTO stats_usage
                 (projection_version, provider, revision, source_revision, session_id, usage_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    STATS_PROJECTION_VERSION,
                    provider,
                    revision,
                    source_revision,
                    id,
                    json
                ],
            )
            .map_err(stats_storage)?;
        }
        tx.commit().map_err(stats_storage)
    }
}

fn publish_with_catalog_revision(
    cache: &mut StatsUsageCache,
    index_dir: &Path,
    scope: &str,
    provider: &str,
    revision: &str,
    source_revision: &str,
    captured: &[String],
    usage: &HashMap<String, StatsUsageProjection>,
) -> Result<()> {
    // The catalog publisher uses this same scope lock. Recheck under it so a
    // concurrent publisher cannot advance the revision before cache commit.
    let lock_path = index_dir.join(format!("{scope}.lock"));
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)
        .map_err(|source| CoreError::Io {
            path: lock_path,
            source,
        })?;
    lock.lock().map_err(stats_storage)?;
    let catalog =
        Connection::open(index_dir.join(format!("{scope}.sqlite"))).map_err(stats_storage)?;
    let current: Option<i64> = catalog
        .query_row(
            "SELECT revision FROM catalog_state WHERE provider = ?1",
            [provider],
            |row| row.get(0),
        )
        .optional()
        .map_err(stats_storage)?;
    if format!("{provider}:{}", current.unwrap_or(0)) != revision {
        return Err(CoreError::SourceChanged);
    }
    cache.publish(provider, revision, source_revision, captured, usage)
}

fn stats_storage(error: impl std::fmt::Display) -> CoreError {
    CoreError::Storage(error.to_string())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsOverview {
    pub total_sessions: usize,
    pub total_messages: usize,
    /// Canonical source rows omitted because their history cannot be established.
    pub excluded_source_session_count: usize,
    /// Full-source token totals remain unknown when a request can lack usage.
    pub total_tokens: Option<u64>,
    pub recorded_request_count: usize,
    pub known_token_count: u64,
    pub unknown_token_request_count: usize,
    pub untimed_request_count: usize,
    pub unresolved_usage_observation_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSourceDiagnostic {
    pub code: String,
    pub affected_sessions: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSession {
    pub session: SessionRef,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub message_count: usize,
    pub token_count: Option<u64>,
    pub recorded_request_count: usize,
    pub known_token_count: u64,
    pub unknown_token_request_count: usize,
    pub unresolved_usage_observation_count: usize,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsDay {
    pub day: String,
    pub recorded_request_count: usize,
    pub known_token_count: u64,
    pub unknown_token_request_count: usize,
    pub unresolved_usage_observation_count: usize,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub sessions: Vec<StatsDaySession>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsDaySession {
    pub session: SessionRef,
    pub recorded_request_count: usize,
    pub known_token_count: u64,
    pub unknown_token_request_count: usize,
    pub unresolved_usage_observation_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsModelRank {
    /// None is the explicit bucket for requests with no recorded model attribution.
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    pub recorded_request_count: usize,
    pub known_token_count: u64,
    pub unknown_token_request_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsModelOption {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsReport {
    pub provider: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<StatsHarnessSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insights: Option<overview::StatsInsights>,
    pub scope: &'static str,
    pub revision: String,
    pub coverage: &'static str,
    pub usage_coverage: &'static str,
    pub overview: StatsOverview,
    pub source_diagnostics: Vec<StatsSourceDiagnostic>,
    pub source_diagnostics_truncated: bool,
    pub sessions: Vec<StatsSession>,
    pub daily_usage: Vec<StatsDay>,
    pub model_ranking: Vec<StatsModelRank>,
    pub usage_range: StatsQuery,
    pub available_directories: Vec<String>,
    pub available_models: Vec<StatsModelOption>,
    pub available_projects: Vec<String>,
    pub cost_estimate: Option<crate::CostEstimate>,
    #[serde(skip)]
    pricing_tokens: crate::stats_cost::CostTokenTotals,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsQuery {
    pub from_day: Option<String>,
    pub to_day: Option<String>,
    pub selected_day: Option<String>,
    pub scope: &'static str,
    pub directory: Option<String>,
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    pub project: Option<String>,
}

impl StatsQuery {
    pub fn all() -> Self {
        Self {
            from_day: None,
            to_day: None,
            selected_day: None,
            scope: "all",
            directory: None,
            model: None,
            model_provider: None,
            project: None,
        }
    }

    pub fn from_params(
        days: Option<&str>,
        from: Option<&str>,
        to: Option<&str>,
        scope: Option<&str>,
        directory: Option<&str>,
        model: Option<&str>,
        model_provider: Option<&str>,
        project: Option<&str>,
        selected_day: Option<&str>,
    ) -> Result<Self> {
        let scope = match scope.unwrap_or("all") {
            "all" => "all",
            "root" => "root",
            _ => return Err(CoreError::InvalidInput("unsupported stats scope".into())),
        };
        let (from_day, to_day) = match days.unwrap_or("30") {
            preset @ ("7" | "30" | "90") if from.is_none() && to.is_none() => {
                let count = preset.parse::<i64>().expect("validated preset");
                let today = jiff::Timestamp::now()
                    .to_zoned(jiff::tz::TimeZone::UTC)
                    .date()
                    .to_string();
                let today_ms = day_millis(&today)?;
                let start = utc_day(today_ms - (count - 1) * 86_400_000)
                    .ok_or_else(|| CoreError::InvalidInput("invalid stats date range".into()))?;
                (start, today)
            }
            "custom" => {
                let from =
                    from.ok_or_else(|| CoreError::InvalidInput("missing stats from date".into()))?;
                let to =
                    to.ok_or_else(|| CoreError::InvalidInput("missing stats to date".into()))?;
                let start = day_millis(from)?;
                let end = day_millis(to)?;
                if end < start || end - start >= 366 * 86_400_000 {
                    return Err(CoreError::InvalidInput("invalid stats date range".into()));
                }
                (from.into(), to.into())
            }
            _ => {
                return Err(CoreError::InvalidInput(
                    "unsupported stats date range".into(),
                ));
            }
        };
        let selected_day = selected_day
            .map(|day| {
                let millis = day_millis(day)?;
                let normalized = utc_day(millis)
                    .ok_or_else(|| CoreError::InvalidInput("invalid stats date".into()))?;
                if normalized != day || normalized < from_day || normalized > to_day {
                    return Err(CoreError::InvalidInput(
                        "selected stats day is outside the date range".into(),
                    ));
                }
                Ok(normalized)
            })
            .transpose()?;
        if model_provider.is_some() && model.is_none_or(|value| value.trim().is_empty()) {
            return Err(CoreError::InvalidInput(
                "stats model provider requires a model".into(),
            ));
        }
        Ok(Self {
            from_day: Some(from_day),
            to_day: Some(to_day),
            selected_day,
            scope,
            directory: directory
                .filter(|value| !value.trim().is_empty())
                .map(normalize_project_path),
            model: model
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned),
            model_provider: model_provider.map(str::to_owned),
            project: project
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned),
        })
    }

    fn contains(&self, timestamp: Option<i64>) -> bool {
        let day = timestamp.and_then(utc_day);
        if self
            .selected_day
            .as_deref()
            .is_some_and(|selected| day.as_deref() != Some(selected))
        {
            return false;
        }
        let Some(day) = day else {
            return self.from_day.is_none() && self.to_day.is_none();
        };
        self.from_day
            .as_deref()
            .is_none_or(|from| day.as_str() >= from)
            && self.to_day.as_deref().is_none_or(|to| day.as_str() <= to)
    }

    fn pad_days(&self, days: &mut BTreeMap<String, StatsDay>) -> Result<()> {
        if let Some(day) = &self.selected_day {
            days.entry(day.clone()).or_insert_with(|| StatsDay {
                day: day.clone(),
                ..StatsDay::default()
            });
            return Ok(());
        }
        let (Some(from), Some(to)) = (&self.from_day, &self.to_day) else {
            return Ok(());
        };
        let start = day_millis(from)?;
        let end = day_millis(to)?;
        for millis in (start..=end).step_by(86_400_000) {
            let day = utc_day(millis).expect("validated date range has representable UTC days");
            days.entry(day.clone()).or_insert_with(|| StatsDay {
                day,
                ..StatsDay::default()
            });
        }
        Ok(())
    }
}

fn day_millis(day: &str) -> Result<i64> {
    let date = day
        .parse::<jiff::civil::Date>()
        .map_err(|_| CoreError::InvalidInput("invalid stats date".into()))?;
    format!("{date}T00:00:00Z")
        .parse::<jiff::Timestamp>()
        .map(jiff::Timestamp::as_millisecond)
        .map_err(|_| CoreError::InvalidInput("invalid stats date".into()))
}

impl Core {
    pub fn stats(&self, provider: &str) -> Result<StatsReport> {
        self.stats_filtered(provider, StatsQuery::all())
    }

    pub fn stats_filtered(&self, provider: &str, query: StatsQuery) -> Result<StatsReport> {
        if provider == "all" {
            return self.stats_selected(
                &self
                    .providers()
                    .into_iter()
                    .map(|row| row.id)
                    .collect::<Vec<_>>(),
                query,
            );
        }
        #[cfg(feature = "stats-phase-probe")]
        let mut probe = StatsPhaseProbe::new();
        #[cfg(feature = "stats-phase-probe")]
        let phase_started = Instant::now();
        let (mut rows, revision) = self.indexed_sessions(provider)?;
        #[cfg(feature = "stats-phase-probe")]
        probe.add("indexed_sessions", phase_started.elapsed());
        if query.scope == "root" {
            rows.retain(|row| row.parent.is_none());
        }
        let adapter = crate::providers::adapter(&self.config, &self.source_scope, provider)?;
        // Unfiltered captures check the full source inventory below; filtered or
        // empty catalogs need a separate preflight before rows can be skipped.
        if (rows.is_empty()
            || query.scope != "all"
            || query.directory.is_some()
            || query.project.is_some())
            && let Some((diagnostic, _)) = adapter.source_uncertainty()?
        {
            return Err(CoreError::Protocol(ProtocolError::Unavailable {
                diagnostic: diagnostic.into(),
            }));
        }
        #[cfg(feature = "stats-phase-probe")]
        let phase_started = Instant::now();
        let project_ids = adapter.stats_project_ids()?;
        #[cfg(feature = "stats-phase-probe")]
        probe.add("project_ids", phase_started.elapsed());
        if query.project.is_some() && project_ids.is_none() {
            return Err(CoreError::InvalidInput(
                "stats project filter unavailable".into(),
            ));
        }
        #[cfg(feature = "stats-phase-probe")]
        let phase_started = Instant::now();
        let source_revision =
            if query.scope == "all" && query.directory.is_none() && query.project.is_none() {
                adapter.stats_usage_source_revision()?
            } else {
                None
            };
        #[cfg(feature = "stats-phase-probe")]
        probe.add("first_source_revision", phase_started.elapsed());
        #[cfg(feature = "stats-phase-probe")]
        let phase_started = Instant::now();
        let mut cache = source_revision
            .as_ref()
            .map(|_| StatsUsageCache::open(&self.config.cache_dir, &self.source_scope))
            .transpose()?;
        let mut cached_usage = match (&cache, &source_revision) {
            (Some(cache), Some(source_revision)) => {
                cache.load(provider, &revision, source_revision)?
            }
            _ => HashMap::new(),
        };
        #[cfg(feature = "stats-phase-probe")]
        probe.add("cache_open_load", phase_started.elapsed());
        let mut observation_batch: Option<Box<dyn crate::providers::StatsObservationBatch + '_>> =
            None;
        let mut batch_initialized = false;
        let mut captured_usage = Vec::new();
        let mut overview = StatsOverview {
            total_sessions: 0,
            total_messages: 0,
            excluded_source_session_count: 0,
            total_tokens: None,
            recorded_request_count: 0,
            known_token_count: 0,
            unknown_token_request_count: 0,
            untimed_request_count: 0,
            unresolved_usage_observation_count: 0,
        };
        let mut days = BTreeMap::<String, StatsDay>::new();
        let mut pricing_tokens = crate::stats_cost::CostTokenTotals::default();
        let mut day_sessions = BTreeMap::<String, BTreeMap<String, StatsDaySession>>::new();
        let mut models = BTreeMap::<(Option<String>, Option<String>), StatsModelRank>::new();
        let mut sessions = Vec::with_capacity(rows.len());
        let mut available_directories = BTreeSet::new();
        let mut available_models = BTreeSet::new();
        let mut available_projects = BTreeSet::new();
        let mut source_diagnostic_counts = BTreeMap::<String, usize>::new();
        let mut observed_any = false;
        #[cfg(feature = "stats-phase-probe")]
        let row_loop_started = Instant::now();
        for row in rows {
            let project_id = project_ids
                .as_ref()
                .and_then(|projects| projects.get(&row.session.session_id));
            if let Some(project_id) = project_id {
                available_projects.insert(if project_id.is_empty() {
                    "__opensession_empty_project__".to_owned()
                } else {
                    project_id.clone()
                });
            }
            let directory = row.directory.as_deref().map(normalize_project_path);
            if let Some(directory) = directory.as_ref() {
                available_directories.insert(directory.clone());
            }
            if let Some(diagnostic) = row.diagnostic.as_deref() {
                let outside_selected_directory = query.directory.as_ref().is_some_and(|selected| {
                    directory
                        .as_ref()
                        .is_some_and(|recorded| recorded != selected)
                });
                let outside_selected_project = query.project.as_ref().is_some_and(|selected| {
                    project_id.is_some_and(|actual| {
                        if selected == "__opensession_empty_project__" {
                            !actual.is_empty()
                        } else {
                            actual != selected
                        }
                    })
                });
                if !outside_selected_directory && !outside_selected_project {
                    overview.excluded_source_session_count += 1;
                    *source_diagnostic_counts
                        .entry(diagnostic.to_owned())
                        .or_default() += 1;
                }
                continue;
            }
            if query
                .directory
                .as_ref()
                .is_some_and(|selected| directory.as_ref() != Some(selected))
            {
                continue;
            }
            if query.project.as_ref().is_some_and(|selected| {
                project_id.is_none_or(|actual| {
                    if selected == "__opensession_empty_project__" {
                        !actual.is_empty()
                    } else {
                        actual != selected
                    }
                })
            }) {
                continue;
            }
            let session_id = row.session.session_id.clone();
            #[cfg(feature = "stats-phase-probe")]
            if cached_usage.contains_key(&session_id) {
                probe.cached_sessions += 1;
            }
            if !cached_usage.contains_key(&session_id) {
                #[cfg(test)]
                STATS_PROTOCOL_LOADS.with(|loads| loads.set(loads.get() + 1));
                if !batch_initialized {
                    #[cfg(feature = "stats-phase-probe")]
                    let phase_started = Instant::now();
                    observation_batch =
                        adapter.stats_observation_batch(source_revision.as_deref())?;
                    #[cfg(feature = "stats-phase-probe")]
                    probe.add("batch_init", phase_started.elapsed());
                    batch_initialized = true;
                }
                #[cfg(feature = "stats-phase-probe")]
                let phase_started = Instant::now();
                let observations = match &observation_batch {
                    Some(batch) => batch.observations(&session_id)?,
                    None => self.protocol_observations(provider, &session_id)?,
                };
                #[cfg(feature = "stats-phase-probe")]
                {
                    probe.add("observations", phase_started.elapsed());
                    probe.observed_sessions += 1;
                }
                let projection = StatsUsageProjection {
                    requests: observations
                        .usage_records()
                        .iter()
                        .map(StatsUsage::from)
                        .collect(),
                    observations: observations
                        .usage_observations()
                        .iter()
                        .map(StatsUsageObservation::from)
                        .collect(),
                };
                cached_usage.insert(session_id.clone(), projection);
                captured_usage.push(session_id.clone());
            }
            let projection = &cached_usage[&session_id];
            let usage = &projection.requests;
            let usage_observations = &projection.observations;
            for request in usage {
                if let Some(model) = &request.model {
                    available_models.insert((request.model_provider.clone(), model.clone()));
                }
            }
            let selected_usage: Vec<_> = usage
                .iter()
                .filter(|request| {
                    query
                        .model
                        .as_deref()
                        .is_none_or(|model| request.model.as_deref() == Some(model))
                        && match query.model_provider.as_deref() {
                            None => true,
                            Some("") => request.model_provider.is_none(),
                            Some(provider) => request.model_provider.as_deref() == Some(provider),
                        }
                })
                .collect();
            let selected_observations: Vec<_> = usage_observations
                .iter()
                // Observations have no proved model attribution; preserve them under model filters.
                .filter(|observation| query.contains(observation.timestamp))
                .collect();
            let precounted_untimed_requests = query.model.is_some()
                && !selected_usage
                    .iter()
                    .any(|request| query.contains(request.timestamp));
            if precounted_untimed_requests {
                overview.untimed_request_count += selected_usage
                    .iter()
                    .filter(|request| request.timestamp.is_none())
                    .count();
                if selected_observations.is_empty() {
                    continue;
                }
            }
            observed_any |= selected_usage
                .iter()
                .any(|request| query.contains(request.timestamp));
            observed_any |= !selected_observations.is_empty();
            let mut session = StatsSession {
                session: row.session,
                created_at: row.created_at,
                updated_at: row.updated_at,
                message_count: row.message_count,
                token_count: None,
                recorded_request_count: 0,
                known_token_count: 0,
                unknown_token_request_count: 0,
                unresolved_usage_observation_count: selected_observations.len(),
            };
            overview.unresolved_usage_observation_count += selected_observations.len();
            for observation in selected_observations {
                if let Some(day) = observation.timestamp.and_then(utc_day) {
                    let entry = days.entry(day.clone()).or_insert_with(|| StatsDay {
                        day,
                        ..StatsDay::default()
                    });
                    entry.unresolved_usage_observation_count += 1;
                    if query.selected_day.is_some() {
                        let day_session = day_sessions
                            .entry(entry.day.clone())
                            .or_default()
                            .entry(observation.session_ref.session_id.clone())
                            .or_insert_with(|| StatsDaySession {
                                session: observation.session_ref.clone(),
                                recorded_request_count: 0,
                                known_token_count: 0,
                                unknown_token_request_count: 0,
                                unresolved_usage_observation_count: 0,
                            });
                        day_session.unresolved_usage_observation_count += 1;
                    }
                }
            }
            for request in selected_usage {
                if !query.contains(request.timestamp) {
                    if request.timestamp.is_none() && !precounted_untimed_requests {
                        overview.untimed_request_count += 1;
                    }
                    continue;
                }
                let model = models
                    .entry((request.model_provider.clone(), request.model.clone()))
                    .or_insert_with(|| StatsModelRank {
                        model: request.model.clone(),
                        model_provider: request.model_provider.clone(),
                        recorded_request_count: 0,
                        known_token_count: 0,
                        unknown_token_request_count: 0,
                    });
                model.recorded_request_count += 1;
                if let Some(total) = request.tokens.total {
                    model.known_token_count =
                        checked_total(model.known_token_count, total, request)?;
                } else {
                    model.unknown_token_request_count += 1;
                }
                session.recorded_request_count += 1;
                overview.recorded_request_count += 1;
                for (sum, value) in [
                    (&mut pricing_tokens.input, request.tokens.input),
                    (&mut pricing_tokens.output, request.tokens.output),
                    (&mut pricing_tokens.reasoning, request.tokens.reasoning),
                    (&mut pricing_tokens.cache_read, request.tokens.cache_read),
                    (&mut pricing_tokens.cache_write, request.tokens.cache_write),
                ] {
                    add_component(sum, value, overview.recorded_request_count, request)?;
                }
                if let Some(total) = request.tokens.total {
                    session.known_token_count =
                        checked_total(session.known_token_count, total, request)?;
                    overview.known_token_count =
                        checked_total(overview.known_token_count, total, request)?;
                } else {
                    session.unknown_token_request_count += 1;
                    overview.unknown_token_request_count += 1;
                }
                if let Some(day) = request.timestamp.and_then(utc_day) {
                    let entry = days.entry(day.clone()).or_insert_with(|| StatsDay {
                        day,
                        ..StatsDay::default()
                    });
                    entry.add(request)?;
                    if query.selected_day.is_some() {
                        let day_session = day_sessions
                            .entry(entry.day.clone())
                            .or_default()
                            .entry(request.session_ref.session_id.clone())
                            .or_insert_with(|| StatsDaySession {
                                session: request.session_ref.clone(),
                                recorded_request_count: 0,
                                known_token_count: 0,
                                unknown_token_request_count: 0,
                                unresolved_usage_observation_count: 0,
                            });
                        day_session.add(request)?;
                    }
                } else {
                    overview.untimed_request_count += 1;
                }
            }
            sessions.push(session);
        }
        #[cfg(feature = "stats-phase-probe")]
        probe.add(
            "row_loop_including_observations",
            row_loop_started.elapsed(),
        );
        #[cfg(feature = "stats-phase-probe")]
        let phase_started = Instant::now();
        overview.total_sessions = sessions.len();
        overview.total_messages = sessions.iter().map(|row| row.message_count).sum();
        query.pad_days(&mut days)?;
        for (day, row) in &mut days {
            row.sessions = day_sessions
                .remove(day)
                .unwrap_or_default()
                .into_values()
                .collect();
            row.sessions.sort_by(|left, right| {
                right
                    .known_token_count
                    .cmp(&left.known_token_count)
                    .then_with(|| {
                        right
                            .recorded_request_count
                            .cmp(&left.recorded_request_count)
                    })
                    .then_with(|| left.session.session_id.cmp(&right.session.session_id))
            });
        }
        let mut model_ranking = models.into_values().collect::<Vec<_>>();
        model_ranking.sort_by(|left, right| {
            right
                .known_token_count
                .cmp(&left.known_token_count)
                .then_with(|| {
                    right
                        .recorded_request_count
                        .cmp(&left.recorded_request_count)
                })
                .then_with(|| left.model.cmp(&right.model))
                .then_with(|| left.model_provider.cmp(&right.model_provider))
        });
        #[cfg(feature = "stats-phase-probe")]
        probe.add("projection_after_rows", phase_started.elapsed());
        if observation_batch.is_some()
            || cache.is_some()
            || overview.excluded_source_session_count > 0
        {
            #[cfg(test)]
            STATS_BEFORE_FINAL_REVISION.with(|hook| {
                if let Some(hook) = hook.borrow_mut().take() {
                    hook();
                }
            });
            #[cfg(feature = "stats-phase-probe")]
            let phase_started = Instant::now();
            if self.indexed_sessions(provider)?.1 != revision {
                return Err(CoreError::SourceChanged);
            }
            #[cfg(feature = "stats-phase-probe")]
            probe.add("final_indexed_sessions", phase_started.elapsed());
            #[cfg(feature = "stats-phase-probe")]
            let phase_started = Instant::now();
            match &observation_batch {
                Some(batch) => batch.validate_source_revision()?,
                None if cache.is_some() => {
                    if adapter.stats_usage_source_revision()?.as_deref()
                        != source_revision.as_deref()
                    {
                        return Err(CoreError::SourceChanged);
                    }
                }
                None => {
                    if let Some((diagnostic, _)) = adapter.source_uncertainty()? {
                        return Err(CoreError::Protocol(ProtocolError::Unavailable {
                            diagnostic: diagnostic.into(),
                        }));
                    }
                }
            }
            #[cfg(feature = "stats-phase-probe")]
            probe.add("final_source_revision", phase_started.elapsed());
            #[cfg(test)]
            STATS_AFTER_FINAL_REVISION.with(|hook| {
                if let Some(hook) = hook.borrow_mut().take() {
                    hook();
                }
            });
            if let (Some(cache), Some(source_revision)) = (&mut cache, &source_revision) {
                #[cfg(feature = "stats-phase-probe")]
                let phase_started = Instant::now();
                publish_with_catalog_revision(
                    cache,
                    &self.config.index_dir,
                    &self.source_scope,
                    provider,
                    &revision,
                    source_revision,
                    &captured_usage,
                    &cached_usage,
                )?;
                #[cfg(feature = "stats-phase-probe")]
                probe.add("cache_publish", phase_started.elapsed());
            }
        }
        #[cfg(feature = "stats-phase-probe")]
        let phase_started = Instant::now();
        let report = StatsReport {
            provider: provider.into(),
            sources: vec![],
            insights: None,
            scope: "active_source_sessions",
            revision,
            coverage: "partial",
            usage_coverage: if !observed_any && overview.excluded_source_session_count == 0 {
                "not-observed"
            } else {
                "partial"
            },
            overview,
            source_diagnostics: source_diagnostic_counts
                .iter()
                .take(20)
                .map(|(code, affected_sessions)| StatsSourceDiagnostic {
                    code: code.clone(),
                    affected_sessions: *affected_sessions,
                })
                .collect(),
            source_diagnostics_truncated: source_diagnostic_counts.len() > 20,
            sessions,
            daily_usage: days.into_values().collect(),
            model_ranking,
            usage_range: query,
            available_directories: available_directories.into_iter().collect(),
            available_models: available_models
                .into_iter()
                .map(|(model_provider, model)| StatsModelOption {
                    model,
                    model_provider,
                })
                .collect(),
            available_projects: available_projects.into_iter().collect(),
            cost_estimate: None,
            pricing_tokens,
        };
        #[cfg(feature = "stats-phase-probe")]
        {
            probe.add("report_finalize", phase_started.elapsed());
            probe.finish(report.sessions.len(), captured_usage.len());
        }
        Ok(report)
    }
}

impl StatsDay {
    fn add(&mut self, request: &StatsUsage) -> Result<()> {
        self.recorded_request_count += 1;
        if let Some(total) = request.tokens.total {
            self.known_token_count = checked_total(self.known_token_count, total, request)?;
        } else {
            self.unknown_token_request_count += 1;
        }
        let tokens = &request.tokens;
        add_component(
            &mut self.input_tokens,
            tokens.input,
            self.recorded_request_count,
            request,
        )?;
        add_component(
            &mut self.output_tokens,
            tokens.output,
            self.recorded_request_count,
            request,
        )?;
        add_component(
            &mut self.reasoning_tokens,
            tokens.reasoning,
            self.recorded_request_count,
            request,
        )?;
        add_component(
            &mut self.cache_read_tokens,
            tokens.cache_read,
            self.recorded_request_count,
            request,
        )?;
        add_component(
            &mut self.cache_write_tokens,
            tokens.cache_write,
            self.recorded_request_count,
            request,
        )?;
        add_component(
            &mut self.total_tokens,
            tokens.total,
            self.recorded_request_count,
            request,
        )?;
        Ok(())
    }
}

impl StatsDaySession {
    fn add(&mut self, request: &StatsUsage) -> Result<()> {
        self.recorded_request_count += 1;
        if let Some(total) = request.tokens.total {
            self.known_token_count = checked_total(self.known_token_count, total, request)?;
        } else {
            self.unknown_token_request_count += 1;
        }
        Ok(())
    }
}

fn add_component(
    sum: &mut Option<u64>,
    value: Option<u64>,
    count: usize,
    request: &StatsUsage,
) -> Result<()> {
    *sum = if count == 1 {
        value
    } else {
        match (*sum, value) {
            (Some(previous), Some(current)) => Some(checked_total(previous, current, request)?),
            _ => None,
        }
    };
    Ok(())
}

fn checked_total(sum: u64, value: u64, request: &StatsUsage) -> Result<u64> {
    sum.checked_add(value).ok_or_else(|| {
        CoreError::Protocol(ProtocolError::Invalid {
            diagnostics: vec![Diagnostic {
                code: "usage_aggregate_overflow",
                event_id: request.event_id.clone(),
            }],
        })
    })
}

fn utc_day(timestamp: i64) -> Option<String> {
    Some(
        jiff::Timestamp::from_millisecond(timestamp)
            .ok()?
            .to_zoned(jiff::tz::TimeZone::UTC)
            .date()
            .to_string(),
    )
}

impl StatsReport {
    pub fn apply_token_pricing(&mut self, pricing: &crate::TokenPricingDocument) -> Result<()> {
        self.cost_estimate = self
            .usage_range
            .model_provider
            .as_deref()
            .filter(|provider| !provider.is_empty())
            .zip(self.usage_range.model.as_deref())
            .and_then(|(provider, model)| pricing.get(&format!("{provider}/{model}")))
            .map(|entry| crate::stats_cost::compute_cost_estimate(entry, &self.pricing_tokens))
            .transpose()?;
        Ok(())
    }

    pub fn to_csv(&self) -> String {
        let mut csv = String::from(
            "Provider,Composition Mode,Day (UTC),Total Tokens,Input Tokens,Output Tokens,Reasoning Tokens,Cache Read Tokens,Cache Write Tokens,Requests,Usage Range Scope,Coverage,Usage Coverage,Known Token Count,Unknown Token Request Count,Unresolved Usage Observation Count,Excluded Source Session Count,Source Diagnostic Codes,Source Diagnostics Truncated,Working Directory Filter,Request Model Filter,Project ID Filter,Request Model Provider Filter,Request Model Provider Filter Mode\n",
        );
        let empty_day = StatsDay::default();
        if !self.sources.is_empty() {
            csv.pop();
            csv.push_str(",Selected Harnesses,Source Status\n");
        }
        for row in self
            .daily_usage
            .iter()
            .chain(std::iter::once(&empty_day).filter(|_| {
                self.daily_usage.is_empty() && self.overview.excluded_source_session_count > 0
            }))
        {
            csv.push_str(&csv_cell(&self.provider));
            csv.push(',');
            csv.push_str(&csv_cell("exclusive-partial"));
            csv.push(',');
            csv.push_str(&csv_cell(&row.day));
            for value in [
                row.total_tokens,
                row.input_tokens,
                row.output_tokens,
                row.reasoning_tokens,
                row.cache_read_tokens,
                row.cache_write_tokens,
            ] {
                csv.push(',');
                if let Some(value) = value {
                    csv.push_str(&value.to_string());
                }
            }
            csv.push(',');
            csv.push_str(&row.recorded_request_count.to_string());
            csv.push(',');
            csv.push_str(&csv_cell(self.usage_range.scope));
            csv.push(',');
            csv.push_str(&csv_cell(self.coverage));
            csv.push(',');
            csv.push_str(&csv_cell(self.usage_coverage));
            csv.push(',');
            csv.push_str(&row.known_token_count.to_string());
            csv.push(',');
            csv.push_str(&row.unknown_token_request_count.to_string());
            csv.push(',');
            csv.push_str(&row.unresolved_usage_observation_count.to_string());
            csv.push(',');
            csv.push_str(&self.overview.excluded_source_session_count.to_string());
            csv.push(',');
            csv.push_str(&csv_cell(
                &self
                    .source_diagnostics
                    .iter()
                    .map(|diagnostic| {
                        format!("{}: {}", diagnostic.code, diagnostic.affected_sessions)
                    })
                    .collect::<Vec<_>>()
                    .join("; "),
            ));
            csv.push(',');
            csv.push_str(&self.source_diagnostics_truncated.to_string());
            csv.push(',');
            csv.push_str(&csv_cell(
                self.usage_range.directory.as_deref().unwrap_or(""),
            ));
            csv.push(',');
            csv.push_str(&csv_cell(self.usage_range.model.as_deref().unwrap_or("")));
            csv.push(',');
            csv.push_str(&csv_cell(self.usage_range.project.as_deref().unwrap_or("")));
            csv.push(',');
            csv.push_str(&csv_cell(
                self.usage_range.model_provider.as_deref().unwrap_or(""),
            ));
            csv.push(',');
            csv.push_str(&csv_cell(
                match self.usage_range.model_provider.as_deref() {
                    None => "any",
                    Some("") => "missing",
                    Some(_) => "exact",
                },
            ));
            if !self.sources.is_empty() {
                csv.push(',');
                csv.push_str(&csv_cell(
                    &self
                        .sources
                        .iter()
                        .map(|row| row.provider.as_str())
                        .collect::<Vec<_>>()
                        .join("; "),
                ));
                csv.push(',');
                csv.push_str(&csv_cell(
                    &self
                        .sources
                        .iter()
                        .map(|row| {
                            format!(
                                "{}: {}{}",
                                row.provider,
                                row.status,
                                row.diagnostic
                                    .as_ref()
                                    .map(|value| format!(" ({value})"))
                                    .unwrap_or_default()
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("; "),
                ));
            }
            csv.push('\n');
        }
        csv
    }
}

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    #[test]
    fn all_harness_stats_preserve_usage_and_unavailable_sources() {
        let root = tempfile::tempdir().unwrap();
        let config = source_config(root.path());
        write_untimed_codex_session(
            &config.codex_dir,
            "11111111-1111-4111-8111-111111111111",
            "model-selected",
        );
        let core = Core::new(config).unwrap();
        let single = core.stats("codex").unwrap();
        let aggregate = core.stats("all").unwrap();
        assert_eq!(
            aggregate.overview.recorded_request_count,
            single.overview.recorded_request_count
        );
        assert_eq!(
            aggregate.overview.known_token_count,
            single.overview.known_token_count
        );
        assert_eq!(aggregate.overview.total_tokens, None);
        let json = serde_json::to_value(aggregate).unwrap();
        assert_eq!(json["sources"].as_array().unwrap().len(), 5);
        assert!(
            json["sources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["status"] == "unavailable")
        );
        assert_eq!(json["sessions"][0]["session"]["provider"], "codex");
    }
    use super::{StatsQuery, *};
    use crate::SourceConfig;
    use rusqlite::Connection;
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    fn source_config(root: &Path) -> SourceConfig {
        let config = SourceConfig {
            codex_dir: root.join("codex"),
            opencode_db: root.join("opencode.db"),
            claude_dir: root.join("claude"),
            pi_dir: root.join("pi"),
            dsh_dir: root.join("dsh"),
            meta_dir: root.join("meta"),
            index_dir: root.join("index"),
            cache_dir: root.join("cache"),
        };
        for directory in [
            &config.codex_dir,
            &config.claude_dir,
            &config.pi_dir,
            &config.dsh_dir,
            &config.meta_dir,
            &config.index_dir,
            &config.cache_dir,
        ] {
            fs::create_dir_all(directory).unwrap();
        }
        config
    }

    fn write_untimed_codex_session(root: &Path, session_id: &str, model: &str) {
        let directory = root.join("sessions/2026/09/28");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("rollout-{session_id}.jsonl"));
        let records = [
            serde_json::json!({
                "timestamp": "2026-09-28T00:00:00.000Z",
                "ordinal": 0,
                "type": "session_meta",
                "payload": {"id": session_id, "cwd": "/synthetic"}
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "thread_settings_applied",
                    "thread_settings": {"model": model}
                }
            }),
            serde_json::json!({
                "type": "token_usage_record",
                "payload": {
                    "thread_id": session_id,
                    "response_id": "proved-response-a",
                    "usage": {
                        "input_tokens": 12,
                        "cached_input_tokens": 2,
                        "output_tokens": 4,
                        "reasoning_output_tokens": 1,
                        "total_tokens": 15
                    }
                }
            }),
            serde_json::json!({
                "type": "token_usage_record",
                "payload": {
                    "thread_id": session_id,
                    "response_id": "proved-response-b",
                    "usage": {"input_tokens": 5}
                }
            }),
        ];
        fs::write(
            path,
            records
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
    }

    fn collide_codex_session(root: &Path, session_id: &str) {
        let directory = root.join("sessions/2026/09/28");
        let original = directory.join(format!("rollout-{session_id}.jsonl"));
        let second = directory.join(format!("rollout-{session_id}_window.jsonl"));
        let mut content = fs::read_to_string(original).unwrap();
        content.push('\n');
        fs::write(second, content).unwrap();
    }

    #[test]
    fn codex_stats_reports_healthy_usage_and_counts_excluded_source_sessions() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let healthy = "11111111-1111-4111-8111-111111111111";
        let collided = "22222222-2222-4222-8222-222222222222";
        write_untimed_codex_session(&config.codex_dir, healthy, "model-selected");
        write_untimed_codex_session(&config.codex_dir, collided, "model-selected");
        collide_codex_session(&config.codex_dir, collided);
        let core = Core::new(config).unwrap();

        let report = core.stats("codex").unwrap();
        assert_eq!(report.overview.total_sessions, 1);
        assert_eq!(report.overview.recorded_request_count, 2);
        assert_eq!(report.overview.excluded_source_session_count, 1);
        assert_eq!(report.usage_coverage, "partial");
        assert_eq!(report.sessions[0].session.session_id, healthy);
        assert_eq!(report.source_diagnostics.len(), 1);
        assert_eq!(
            report.source_diagnostics[0].code,
            "codex_multiple_source_files_unmerged"
        );
        assert_eq!(report.source_diagnostics[0].affected_sessions, 1);
        let csv = report.to_csv();
        assert_eq!(
            csv.lines().count(),
            2,
            "all-time untimed usage still needs a coverage row"
        );
        assert!(csv.contains("codex_multiple_source_files_unmerged: 1"));
    }

    #[test]
    fn codex_stats_keeps_unattributed_exclusions_under_model_and_date_filters() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let healthy = "11111111-1111-4111-8111-111111111111";
        let collided = "22222222-2222-4222-8222-222222222222";
        write_untimed_codex_session(&config.codex_dir, healthy, "model-other");
        write_untimed_codex_session(&config.codex_dir, collided, "model-selected");
        collide_codex_session(&config.codex_dir, collided);
        let core = Core::new(config).unwrap();
        let query = StatsQuery::from_params(
            Some("custom"),
            Some("2026-09-20"),
            Some("2026-09-20"),
            None,
            None,
            Some("model-selected"),
            None,
            None,
            None,
        )
        .unwrap();

        let report = core.stats_filtered("codex", query).unwrap();
        assert_eq!(report.overview.recorded_request_count, 0);
        assert_eq!(report.overview.excluded_source_session_count, 1);
        assert_eq!(report.usage_coverage, "partial");
        assert_eq!(report.source_diagnostics[0].affected_sessions, 1);
        assert!(report.to_csv().contains("Excluded Source Session Count"));
    }

    #[test]
    fn codex_stats_keeps_collision_with_unknown_directory_under_directory_filter() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let healthy = "11111111-1111-4111-8111-111111111111";
        let collided = "22222222-2222-4222-8222-222222222222";
        write_untimed_codex_session(&config.codex_dir, healthy, "model-selected");
        write_untimed_codex_session(&config.codex_dir, collided, "model-selected");
        collide_codex_session(&config.codex_dir, collided);
        let second = config
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{collided}_window.jsonl"));
        let content = fs::read_to_string(&second).unwrap();
        fs::write(
            second,
            content.replace("\"cwd\":\"/synthetic\"", "\"cwd\":\"/other\""),
        )
        .unwrap();
        let core = Core::new(config).unwrap();
        let mut query = StatsQuery::all();
        query.directory = Some("/synthetic".into());

        let report = core.stats_filtered("codex", query).unwrap();
        assert_eq!(report.overview.total_sessions, 1);
        assert_eq!(report.overview.excluded_source_session_count, 1);
        assert_eq!(report.source_diagnostics[0].affected_sessions, 1);
    }

    fn opencode_fixture(root: &Path) -> SourceConfig {
        let config = source_config(root);
        let db = Connection::open(&config.opencode_db).unwrap();
        db.execute_batch(
            "CREATE TABLE session_v2 (
                id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT,
                title TEXT, slug TEXT, directory TEXT, project_id TEXT, time_created INTEGER,
                time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER,
                tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER,
                tokens_cache_write INTEGER
            );
            CREATE TABLE session_message (
                id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
                time_created INTEGER, time_updated INTEGER, data TEXT
            );
            INSERT INTO session_v2 VALUES
                ('selected', NULL, NULL, NULL, 'Selected', 'selected', '/selected', 'keep', 1, 2, NULL, 0, 0, 0, 0, 0),
                ('unrelated', NULL, NULL, NULL, 'Unrelated', 'unrelated', '/unrelated', 'other', 1, 3, NULL, 0, 0, 0, 0, 0);
            INSERT INTO session_message VALUES
                ('invalid-kind', 'unrelated', 'bad/type', 1, 1, 1, '{}');",
        )
        .unwrap();
        config
    }

    fn stats_cached_session_count(cache_dir: &Path, scope: &str, provider: &str) -> usize {
        let path = cache_dir.join(format!("{scope}.stats-v2.sqlite"));
        if !path.exists() {
            return 0;
        }
        Connection::open(path)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM stats_usage WHERE provider = ?1",
                [provider],
                |row| row.get::<_, usize>(0),
            )
            .unwrap()
    }

    #[test]
    fn untimed_requests_have_all_time_coverage_but_no_dated_bucket() {
        assert!(StatsQuery::all().contains(None));
        let dated = StatsQuery::from_params(
            Some("custom"),
            Some("2026-09-20"),
            Some("2026-09-20"),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("one UTC day");
        assert!(!dated.contains(None));
        assert!(dated.contains(Some(1_789_862_401_000)));
        assert!(!dated.contains(Some(1_789_776_001_000)));
    }

    #[test]
    fn selected_day_is_canonical_and_inside_the_requested_range() {
        let selected = StatsQuery::from_params(
            Some("custom"),
            Some("2026-09-19"),
            Some("2026-09-20"),
            None,
            None,
            None,
            None,
            None,
            Some("2026-09-20"),
        )
        .expect("selected day in range");
        assert_eq!(selected.selected_day.as_deref(), Some("2026-09-20"));
        assert!(selected.contains(Some(1_789_862_401_000)));
        assert!(!selected.contains(Some(1_789_776_001_000)));
        assert!(
            StatsQuery::from_params(
                Some("custom"),
                Some("2026-09-19"),
                Some("2026-09-20"),
                None,
                None,
                None,
                None,
                None,
                Some("2026-09-21"),
            )
            .is_err()
        );
        assert!(
            StatsQuery::from_params(
                Some("custom"),
                Some("2026-09-19"),
                Some("2026-09-20"),
                None,
                None,
                None,
                None,
                None,
                Some("2026-02-30"),
            )
            .is_err()
        );
    }

    #[test]
    fn model_filter_counts_untimed_requests_without_emitting_empty_sessions() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        write_untimed_codex_session(
            &config.codex_dir,
            "11111111-1111-4111-8111-111111111111",
            "model-selected",
        );
        write_untimed_codex_session(
            &config.codex_dir,
            "22222222-2222-4222-8222-222222222222",
            "model-other",
        );
        let core = Core::new(config).unwrap();
        let query = StatsQuery::from_params(
            Some("custom"),
            Some("2026-09-19"),
            Some("2026-09-20"),
            None,
            None,
            Some("model-selected"),
            None,
            None,
            None,
        )
        .unwrap();

        let report = core.stats_filtered("codex", query).unwrap();

        assert_eq!(report.overview.untimed_request_count, 2);
        assert_eq!(report.overview.recorded_request_count, 0);
        assert_eq!(report.overview.known_token_count, 0);
        assert_eq!(report.overview.unknown_token_request_count, 0);
        assert!(report.sessions.is_empty());
    }

    #[test]
    fn directory_filter_skips_protocol_loading_for_unrelated_sessions() {
        let root = tempdir().unwrap();
        let core = Core::new(opencode_fixture(root.path())).unwrap();
        let mut query = StatsQuery::all();
        query.directory = Some("/selected".into());

        let report = core.stats_filtered("opencode", query).unwrap();

        assert_eq!(
            report
                .sessions
                .iter()
                .map(|row| row.session.session_id.as_str())
                .collect::<Vec<_>>(),
            ["selected"]
        );
    }

    #[test]
    fn project_filter_skips_protocol_loading_for_unrelated_sessions() {
        let root = tempdir().unwrap();
        let core = Core::new(opencode_fixture(root.path())).unwrap();
        let mut query = StatsQuery::all();
        query.project = Some("keep".into());

        let report = core.stats_filtered("opencode", query).unwrap();

        assert_eq!(
            report
                .sessions
                .iter()
                .map(|row| row.session.session_id.as_str())
                .collect::<Vec<_>>(),
            ["selected"]
        );
    }

    #[test]
    fn usage_cache_reuses_validated_projections_across_filters_and_core_restart() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let id = "11111111-1111-4111-8111-111111111111";
        write_untimed_codex_session(&config.codex_dir, id, "model-selected");
        let core = Core::new(config.clone()).unwrap();
        let baseline = serde_json::to_value(core.stats("codex").unwrap()).unwrap();
        assert_eq!(stats_protocol_loads(), 1);

        let mut filtered = StatsQuery::all();
        filtered.model = Some("model-selected".into());
        let selected_query = filtered.clone();
        let selected = serde_json::to_value(
            core.stats_filtered("codex", selected_query.clone())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            stats_protocol_loads(),
            1,
            "filtering must reuse normalized usage"
        );
        assert_eq!(selected["overview"]["recordedRequestCount"], 2);
        filtered.from_day = Some("2026-09-20".into());
        filtered.to_day = Some("2026-09-20".into());
        let dated =
            serde_json::to_value(core.stats_filtered("codex", filtered.clone()).unwrap()).unwrap();
        assert_eq!(stats_protocol_loads(), 1);
        assert_eq!(dated["overview"]["recordedRequestCount"], 0);

        let restarted = Core::new(config.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(restarted.stats("codex").unwrap()).unwrap(),
            baseline
        );
        assert_eq!(
            stats_protocol_loads(),
            1,
            "new Core must reuse durable projections"
        );

        let mut fresh_config = config;
        fresh_config.cache_dir = root.path().join("fresh-cache");
        let fresh = Core::new(fresh_config).unwrap();
        assert_eq!(
            serde_json::to_value(fresh.stats_filtered("codex", selected_query).unwrap()).unwrap(),
            selected
        );
        assert_eq!(
            serde_json::to_value(fresh.stats_filtered("codex", filtered).unwrap()).unwrap(),
            dated
        );
    }

    #[test]
    fn usage_cache_recaptures_rows_from_an_older_projection_version() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        write_untimed_codex_session(
            &config.codex_dir,
            "11111111-1111-4111-8111-111111111111",
            "model-selected",
        );
        let first = Core::new(config.clone()).unwrap();
        let baseline = serde_json::to_value(first.stats("codex").unwrap()).unwrap();
        assert_eq!(stats_protocol_loads(), 1);

        let db_path = config
            .cache_dir
            .join(format!("{}.stats-v2.sqlite", first.source_scope));
        let db = Connection::open(db_path).unwrap();
        db.execute(
            "UPDATE stats_usage SET projection_version = 5, usage_json = '[]'",
            [],
        )
        .unwrap();
        drop(db);

        let restarted = Core::new(config).unwrap();
        assert_eq!(
            serde_json::to_value(restarted.stats("codex").unwrap()).unwrap(),
            baseline
        );
        assert_eq!(
            stats_protocol_loads(),
            2,
            "old projections must be recaptured"
        );
        let db = Connection::open(
            restarted
                .config
                .cache_dir
                .join(format!("{}.stats-v2.sqlite", restarted.source_scope)),
        )
        .unwrap();
        let stored_version: i64 = db
            .query_row("SELECT projection_version FROM stats_usage", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(stored_version, STATS_PROJECTION_VERSION);
    }

    #[test]
    fn usage_cache_invalidates_on_catalog_change_and_isolates_source_scopes() {
        let root = tempdir().unwrap();
        let left = source_config(&root.path().join("left"));
        let mut right = source_config(&root.path().join("right"));
        right.cache_dir = left.cache_dir.clone();
        let id = "11111111-1111-4111-8111-111111111111";
        write_untimed_codex_session(&left.codex_dir, id, "left-model");
        write_untimed_codex_session(&right.codex_dir, id, "right-model");
        let left_core = Core::new(left.clone()).unwrap();
        let right_core = Core::new(right).unwrap();
        let left_first = serde_json::to_value(left_core.stats("codex").unwrap()).unwrap();
        assert_eq!(stats_protocol_loads(), 1);
        let right_first = serde_json::to_value(right_core.stats("codex").unwrap()).unwrap();
        assert_eq!(stats_protocol_loads(), 2);
        assert_ne!(
            left_first["availableModels"],
            right_first["availableModels"]
        );
        assert_eq!(
            serde_json::to_value(left_core.stats("codex").unwrap()).unwrap(),
            left_first
        );
        assert_eq!(stats_protocol_loads(), 2);

        let session = left
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{id}.jsonl"));
        let mut content = fs::read_to_string(&session).unwrap();
        content.push('\n');
        fs::write(session, content).unwrap();
        let changed = serde_json::to_value(left_core.stats("codex").unwrap()).unwrap();
        assert_ne!(changed["revision"], left_first["revision"]);
        assert_eq!(
            stats_protocol_loads(),
            3,
            "changed provider revision must recapture"
        );
        assert_eq!(changed["overview"], left_first["overview"]);
        assert_eq!(
            serde_json::to_value(right_core.stats("codex").unwrap()).unwrap(),
            right_first
        );
        assert_eq!(stats_protocol_loads(), 3);
    }

    #[test]
    fn uncached_provider_keeps_protocol_failure_and_filtered_success() {
        let root = tempdir().unwrap();
        let config = opencode_fixture(root.path());
        let core = Core::new(config.clone()).unwrap();
        assert!(core.stats("opencode").is_err());
        assert_eq!(
            stats_protocol_loads(),
            2,
            "a successful capture preceded the failure"
        );
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "opencode"),
            0
        );
        let mut selected = StatsQuery::all();
        selected.directory = Some("/selected".into());
        assert!(core.stats_filtered("opencode", selected).is_ok());
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "opencode"),
            0
        );
    }

    #[test]
    fn usage_cache_rejects_source_change_during_capture_without_publication() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let id = "11111111-1111-4111-8111-111111111111";
        write_untimed_codex_session(&config.codex_dir, id, "model-selected");
        let source = config
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{id}.jsonl"));
        STATS_BEFORE_FINAL_REVISION.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                let mut content = fs::read_to_string(&source).unwrap();
                content.push('\n');
                fs::write(&source, content).unwrap();
            }));
        });
        let core = Core::new(config.clone()).unwrap();
        assert!(matches!(core.stats("codex"), Err(CoreError::SourceChanged)));
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "codex"),
            0
        );
        assert!(core.stats("codex").is_ok());
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "codex"),
            1
        );
    }

    #[test]
    fn codex_stats_enumerates_sources_once_per_capture_batch() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        for id in [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            "44444444-4444-4444-8444-444444444444",
            "55555555-5555-4555-8555-555555555555",
            "66666666-6666-4666-8666-666666666666",
        ] {
            write_untimed_codex_session(&config.codex_dir, id, "model-selected");
        }
        let core = Core::new(config).unwrap();
        let before = crate::providers::codex_inventory_walks();
        let report = core.stats("codex").unwrap();
        assert_eq!(report.sessions.len(), 6);
        assert_eq!(report.overview.recorded_request_count, 12);
        let walks = crate::providers::codex_inventory_walks() - before;
        assert!(
            walks <= 6,
            "six uncached sessions must share bounded inventory and source-revision walks; observed {walks} walks"
        );
    }

    #[test]
    fn filtered_codex_stats_rejects_source_change_during_batch() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let id = "11111111-1111-4111-8111-111111111111";
        write_untimed_codex_session(&config.codex_dir, id, "model-selected");
        let source = config
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{id}.jsonl"));
        let core = Core::new(config.clone()).unwrap();
        let mut query = StatsQuery::all();
        query.directory = Some("/synthetic".into());
        STATS_BEFORE_FINAL_REVISION.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                let mut content = fs::read_to_string(&source).unwrap();
                content.push('\n');
                fs::write(&source, content).unwrap();
            }));
        });
        assert!(matches!(
            core.stats_filtered("codex", query.clone()),
            Err(CoreError::SourceChanged)
        ));
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "codex"),
            0
        );
        assert_eq!(
            core.stats_filtered("codex", query).unwrap().sessions.len(),
            1
        );
    }

    #[test]
    fn usage_cache_prunes_old_revision_when_provider_becomes_empty() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let id = "11111111-1111-4111-8111-111111111111";
        write_untimed_codex_session(&config.codex_dir, id, "model-selected");
        let core = Core::new(config.clone()).unwrap();
        core.stats("codex").unwrap();
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "codex"),
            1
        );

        let source = config
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{id}.jsonl"));
        fs::remove_file(source).unwrap();
        let report = core.stats("codex").unwrap();
        assert!(report.sessions.is_empty());
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "codex"),
            0
        );
    }

    #[test]
    fn usage_cache_rejects_catalog_advance_between_refresh_and_publish() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let id = "11111111-1111-4111-8111-111111111111";
        write_untimed_codex_session(&config.codex_dir, id, "model-selected");
        let core = Core::new(config.clone()).unwrap();
        let concurrent = core.clone();
        STATS_AFTER_FINAL_REVISION.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                assert_eq!(
                    concurrent
                        .reindex()
                        .into_iter()
                        .find(|row| row.provider == "codex")
                        .unwrap()
                        .status,
                    "rebuilt"
                );
            }));
        });
        assert!(matches!(core.stats("codex"), Err(CoreError::SourceChanged)));
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "codex"),
            0
        );
    }

    #[test]
    fn usage_cache_rejects_reused_ordinal_from_a_fresh_index_directory() {
        let root = tempdir().unwrap();
        let mut config = source_config(root.path());
        let id = "11111111-1111-4111-8111-111111111111";
        write_untimed_codex_session(&config.codex_dir, id, "model-selected");
        let first = Core::new(config.clone()).unwrap().stats("codex").unwrap();
        assert_eq!(first.revision, "codex:1");

        let source = config
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{id}.jsonl"));
        let content = fs::read_to_string(&source).unwrap();
        fs::write(
            &source,
            content.replace("\"total_tokens\":15", "\"total_tokens\":16"),
        )
        .unwrap();
        config.index_dir = root.path().join("new-index");
        fs::create_dir_all(&config.index_dir).unwrap();
        let second = Core::new(config).unwrap().stats("codex").unwrap();
        assert_eq!(second.revision, "codex:1");
        assert_eq!(
            second.overview.known_token_count,
            first.overview.known_token_count + 1
        );
    }

    #[test]
    fn usage_cache_rejects_same_size_same_mtime_codex_rewrite() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let id = "11111111-1111-4111-8111-111111111111";
        write_untimed_codex_session(&config.codex_dir, id, "model-selected");
        let core = Core::new(config.clone()).unwrap();
        let first = core.stats("codex").unwrap();
        let source = config
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{id}.jsonl"));
        let before = fs::metadata(&source).unwrap();
        let content = fs::read_to_string(&source).unwrap();
        fs::write(
            &source,
            content.replace("\"total_tokens\":15", "\"total_tokens\":16"),
        )
        .unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(before.modified().unwrap()))
            .unwrap();
        let after = fs::metadata(&source).unwrap();
        assert_eq!(after.len(), before.len());
        assert_eq!(after.modified().unwrap(), before.modified().unwrap());

        let second = core.stats("codex").unwrap();
        assert_eq!(
            second.overview.known_token_count,
            first.overview.known_token_count + 1
        );
    }

    #[test]
    fn usage_cache_invalidates_child_usage_when_parent_source_changes() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let parent = "11111111-1111-4111-8111-111111111111";
        let child = "22222222-2222-4222-8222-222222222222";
        write_untimed_codex_session(&config.codex_dir, parent, "model-selected");
        write_untimed_codex_session(&config.codex_dir, child, "model-selected");
        let child_source = config
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{child}.jsonl"));
        let child_rows = [
            serde_json::json!({"type":"session_meta","payload":{
                "id":child,"cwd":"/synthetic","parent_thread_id":parent}}),
            serde_json::json!({"type":"event_msg","payload":{
                "type":"token_count","info":{"last_token_usage":{"total_tokens":15}}}}),
            serde_json::json!({"type":"event_msg","payload":{
                "type":"token_count","info":{"last_token_usage":{"total_tokens":15}}}}),
        ];
        fs::write(
            &child_source,
            child_rows
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let core = Core::new(config.clone()).unwrap();
        let first = core.stats("codex").unwrap();
        let child_first = first
            .sessions
            .iter()
            .find(|row| row.session.session_id == child)
            .unwrap();
        assert_eq!(child_first.recorded_request_count, 0);
        assert_eq!(child_first.unresolved_usage_observation_count, 2);
        let first_loads = stats_protocol_loads();

        let parent_source = config
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{parent}.jsonl"));
        let content = fs::read_to_string(&parent_source).unwrap();
        fs::write(
            parent_source,
            content.replace("\"total_tokens\":15", "\"total_tokens\":16"),
        )
        .unwrap();
        let second = core.stats("codex").unwrap();
        let child_second = second
            .sessions
            .iter()
            .find(|row| row.session.session_id == child)
            .unwrap();
        assert_eq!(child_second.recorded_request_count, 0);
        assert_eq!(child_second.unresolved_usage_observation_count, 2);
        assert_eq!(stats_protocol_loads(), first_loads + 2);
    }

    #[test]
    fn usage_cache_does_not_publish_partial_codex_capture_after_protocol_failure() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let first = "11111111-1111-4111-8111-111111111111";
        let second = "22222222-2222-4222-8222-222222222222";
        write_untimed_codex_session(&config.codex_dir, first, "model-selected");
        write_untimed_codex_session(&config.codex_dir, second, "model-selected");
        let second_source = config
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{second}.jsonl"));
        let valid = fs::read_to_string(&second_source).unwrap();
        fs::write(&second_source, format!("{valid}not-json\n")).unwrap();
        let core = Core::new(config.clone()).unwrap();
        assert!(core.stats("codex").is_err());
        assert_eq!(stats_protocol_loads(), 2);
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "codex"),
            0
        );
        fs::write(second_source, valid).unwrap();
        assert!(core.stats("codex").is_ok());
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "codex"),
            2
        );
    }

    #[test]
    fn excluded_bad_codex_source_does_not_block_filtered_stats() {
        let root = tempdir().unwrap();
        let config = source_config(root.path());
        let selected = "11111111-1111-4111-8111-111111111111";
        let excluded = "22222222-2222-4222-8222-222222222222";
        write_untimed_codex_session(&config.codex_dir, selected, "model-selected");
        write_untimed_codex_session(&config.codex_dir, excluded, "model-other");
        let excluded_source = config
            .codex_dir
            .join("sessions/2026/09/28")
            .join(format!("rollout-{excluded}.jsonl"));
        let content = fs::read_to_string(&excluded_source).unwrap();
        fs::write(
            &excluded_source,
            format!("{}not-json\n", content.replace("/synthetic", "/excluded")),
        )
        .unwrap();
        let core = Core::new(config.clone()).unwrap();
        let mut query = StatsQuery::all();
        query.directory = Some("/synthetic".into());
        let report = core.stats_filtered("codex", query).unwrap();
        assert_eq!(report.sessions.len(), 1);
        assert_eq!(report.sessions[0].session.session_id, selected);
        assert_eq!(
            stats_cached_session_count(&config.cache_dir, core.source_scope(), "codex"),
            0
        );
        assert!(core.stats("codex").is_err());
    }
}
