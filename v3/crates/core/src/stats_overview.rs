//! Cross-Harness composition of provider-owned statistics projections.
use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsHarnessSource {
    pub provider: String,
    pub status: &'static str,
    pub diagnostic: Option<String>,
    pub overview: Option<StatsOverview>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsInsights {
    pub average_daily_requests: f64,
    pub active_days: usize,
    pub selected_days: usize,
    pub unusual_days: Vec<String>,
    pub recent_week_requests: Option<usize>,
    pub preceding_week_requests: Option<usize>,
    pub recent_week_from: Option<String>,
    pub recent_week_to: Option<String>,
    pub preceding_week_from: Option<String>,
    pub preceding_week_to: Option<String>,
    pub unattributed_model_requests: usize,
}

fn insights(days: &[StatsDay], models: &[StatsModelRank]) -> StatsInsights {
    let average = if days.is_empty() {
        0.0
    } else {
        days.iter()
            .map(|row| row.recorded_request_count as f64)
            .sum::<f64>()
            / days.len() as f64
    };
    let today = jiff::Timestamp::now()
        .to_zoned(jiff::tz::TimeZone::UTC)
        .date()
        .to_string();
    let completed = days
        .iter()
        .take_while(|row| row.day < today)
        .collect::<Vec<_>>();
    let (recent, preceding) = if completed.len() >= 14 {
        (
            Some(&completed[completed.len() - 7..]),
            Some(&completed[completed.len() - 14..completed.len() - 7]),
        )
    } else {
        (None, None)
    };
    StatsInsights {
        average_daily_requests: average,
        active_days: days
            .iter()
            .filter(|row| row.recorded_request_count > 0)
            .count(),
        selected_days: days.len(),
        unusual_days: days
            .iter()
            .filter(|row| days.len() >= 7 && row.recorded_request_count as f64 > average * 2.0)
            .map(|row| row.day.clone())
            .collect(),
        recent_week_requests: recent
            .map(|rows| rows.iter().map(|row| row.recorded_request_count).sum()),
        preceding_week_requests: preceding
            .map(|rows| rows.iter().map(|row| row.recorded_request_count).sum()),
        recent_week_from: recent.map(|rows| rows[0].day.clone()),
        recent_week_to: recent.map(|rows| rows[6].day.clone()),
        preceding_week_from: preceding.map(|rows| rows[0].day.clone()),
        preceding_week_to: preceding.map(|rows| rows[6].day.clone()),
        unattributed_model_requests: models
            .iter()
            .filter(|row| row.model.is_none())
            .map(|row| row.recorded_request_count)
            .sum(),
    }
}

fn sum(left: u64, right: u64) -> Result<u64> {
    left.checked_add(right)
        .ok_or_else(|| CoreError::InvalidInput("aggregate token count overflow".into()))
}

// A dimension is complete only when every request-bearing source records it.
fn complete_dimension(
    left: Option<u64>,
    right: Option<u64>,
    left_requests: usize,
    right_requests: usize,
) -> Result<Option<u64>> {
    if right_requests == 0 {
        return Ok(left);
    }
    if left_requests == 0 {
        return Ok(right);
    }
    left.zip(right).map(|(a, b)| sum(a, b)).transpose()
}

impl Core {
    pub fn stats_selected(&self, selected: &[String], query: StatsQuery) -> Result<StatsReport> {
        let registered = self.providers();
        let selected: BTreeSet<_> = selected.iter().map(String::as_str).collect();
        if selected.is_empty()
            || selected
                .iter()
                .any(|id| !registered.iter().any(|row| row.id == *id))
        {
            return Err(CoreError::InvalidInput(
                "select at least one registered stats Harness".into(),
            ));
        }
        if query.project.is_some() && selected.len() != 1 {
            return Err(CoreError::InvalidInput(
                "stats project filter requires one Harness".into(),
            ));
        }
        let mut reports = vec![];
        let mut sources = vec![];
        for source in registered
            .into_iter()
            .filter(|row| selected.contains(row.id.as_str()))
        {
            if !source.available {
                sources.push(StatsHarnessSource {
                    provider: source.id,
                    status: "unavailable",
                    diagnostic: Some("Provider source is unavailable".into()),
                    overview: None,
                });
                continue;
            }
            match self.stats_filtered(&source.id, query.clone()) {
                Ok(report) => {
                    sources.push(StatsHarnessSource {
                        provider: source.id,
                        status: "readable",
                        diagnostic: None,
                        overview: Some(report.overview.clone()),
                    });
                    reports.push(report);
                }
                Err(error) => sources.push(StatsHarnessSource {
                    provider: source.id,
                    status: "failed",
                    diagnostic: Some(error.to_string()),
                    overview: None,
                }),
            }
        }
        compose(reports, sources, query)
    }
}

fn compose(
    reports: Vec<StatsReport>,
    sources: Vec<StatsHarnessSource>,
    query: StatsQuery,
) -> Result<StatsReport> {
    let mut report = StatsReport {
        provider: "all".into(),
        sources,
        insights: None,
        scope: "active_source_sessions",
        revision: String::new(),
        coverage: "partial",
        usage_coverage: "not-observed",
        overview: StatsOverview {
            total_sessions: 0,
            total_messages: 0,
            excluded_source_session_count: 0,
            total_tokens: None,
            recorded_request_count: 0,
            known_token_count: 0,
            unknown_token_request_count: 0,
            untimed_request_count: 0,
            unresolved_usage_observation_count: 0,
        },
        source_diagnostics: vec![],
        source_diagnostics_truncated: false,
        sessions: vec![],
        daily_usage: vec![],
        model_ranking: vec![],
        usage_range: query,
        available_directories: vec![],
        available_models: vec![],
        available_projects: vec![],
        cost_estimate: None,
        pricing_tokens: crate::stats_cost::CostTokenTotals::default(),
        usage_amount_count: 0,
    };
    let mut days: BTreeMap<String, StatsDay> = BTreeMap::new();
    let mut models: BTreeMap<(Option<String>, Option<String>), StatsModelRank> = BTreeMap::new();
    let mut model_options = BTreeSet::new();
    let mut directories = BTreeSet::new();
    let mut projects = BTreeSet::new();
    let mut revisions = vec![];
    let mut diagnostics = BTreeMap::new();
    for next in reports {
        revisions.push(format!("{}={}", next.provider, next.revision));
        let prior_requests = report.usage_amount_count;
        let next_requests = next.usage_amount_count;
        report.usage_amount_count += next_requests;
        let overview = &mut report.overview;
        overview.total_sessions += next.overview.total_sessions;
        overview.total_messages += next.overview.total_messages;
        overview.excluded_source_session_count += next.overview.excluded_source_session_count;
        overview.recorded_request_count += next.overview.recorded_request_count;
        overview.known_token_count =
            sum(overview.known_token_count, next.overview.known_token_count)?;
        overview.unknown_token_request_count += next.overview.unknown_token_request_count;
        overview.untimed_request_count += next.overview.untimed_request_count;
        overview.unresolved_usage_observation_count +=
            next.overview.unresolved_usage_observation_count;
        if next.usage_coverage != "not-observed" {
            report.usage_coverage = "partial";
        }
        report.sessions.extend(next.sessions);
        directories.extend(next.available_directories);
        projects.extend(next.available_projects);
        for option in next.available_models {
            model_options.insert((option.model_provider, option.model));
        }
        for diagnostic in next.source_diagnostics {
            *diagnostics.entry(diagnostic.code).or_insert(0) += diagnostic.affected_sessions;
        }
        report.source_diagnostics_truncated |= next.source_diagnostics_truncated;
        for (left, right) in [
            (&mut report.pricing_tokens.input, next.pricing_tokens.input),
            (
                &mut report.pricing_tokens.output,
                next.pricing_tokens.output,
            ),
            (
                &mut report.pricing_tokens.reasoning,
                next.pricing_tokens.reasoning,
            ),
            (
                &mut report.pricing_tokens.cache_read,
                next.pricing_tokens.cache_read,
            ),
            (
                &mut report.pricing_tokens.cache_write,
                next.pricing_tokens.cache_write,
            ),
        ] {
            *left = complete_dimension(*left, right, prior_requests, next_requests)?;
        }
        for row in next.daily_usage {
            let entry = days.entry(row.day.clone()).or_insert_with(|| StatsDay {
                day: row.day.clone(),
                ..StatsDay::default()
            });
            let a = entry.usage_amount_count;
            let b = row.usage_amount_count;
            for (left, right) in [
                (&mut entry.total_tokens, row.total_tokens),
                (&mut entry.input_tokens, row.input_tokens),
                (&mut entry.output_tokens, row.output_tokens),
                (&mut entry.reasoning_tokens, row.reasoning_tokens),
                (&mut entry.cache_read_tokens, row.cache_read_tokens),
                (&mut entry.cache_write_tokens, row.cache_write_tokens),
            ] {
                *left = complete_dimension(*left, right, a, b)?;
            }
            entry.recorded_request_count += row.recorded_request_count;
            entry.usage_amount_count += b;
            entry.known_token_count = sum(entry.known_token_count, row.known_token_count)?;
            entry.unknown_token_request_count += row.unknown_token_request_count;
            entry.unresolved_usage_observation_count += row.unresolved_usage_observation_count;
            entry.sessions.extend(row.sessions);
        }
        for row in next.model_ranking {
            let entry = models
                .entry((row.model_provider.clone(), row.model.clone()))
                .or_insert_with(|| StatsModelRank {
                    model: row.model.clone(),
                    model_provider: row.model_provider.clone(),
                    recorded_request_count: 0,
                    known_token_count: 0,
                    unknown_token_request_count: 0,
                });
            entry.recorded_request_count += row.recorded_request_count;
            entry.known_token_count = sum(entry.known_token_count, row.known_token_count)?;
            entry.unknown_token_request_count += row.unknown_token_request_count;
        }
    }
    // Include failure state in revision identity so a day drill cannot reuse a report
    // whose source coverage has changed.
    for source in &report.sources {
        revisions.push(format!(
            "{}:{}:{:?}",
            source.provider, source.status, source.diagnostic
        ));
    }
    report.revision = revisions.join(";");
    if report.sources.iter().any(|row| row.status != "readable") {
        report.usage_coverage = "partial";
    }
    report.usage_range.pad_days(&mut days)?;
    report.daily_usage = days.into_values().collect();
    report.model_ranking = models.into_values().collect();
    report.model_ranking.sort_by(|a, b| {
        b.known_token_count
            .cmp(&a.known_token_count)
            .then(b.recorded_request_count.cmp(&a.recorded_request_count))
    });
    report.available_directories = directories.into_iter().collect();
    report.available_projects = projects.into_iter().collect();
    report.available_models = model_options
        .into_iter()
        .map(|(model_provider, model)| StatsModelOption {
            model,
            model_provider,
        })
        .collect();
    report.source_diagnostics = diagnostics
        .into_iter()
        .map(|(code, affected_sessions)| StatsSourceDiagnostic {
            code,
            affected_sessions,
        })
        .collect();
    report.insights = Some(insights(&report.daily_usage, &report.model_ranking));
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty() -> StatsReport {
        compose(vec![], vec![], StatsQuery::all()).unwrap()
    }
    #[test]
    fn composition_keeps_unknown_dimensions_and_canonical_cross_provider_sessions() {
        let mut a = empty();
        a.provider = "codex".into();
        a.daily_usage.push(StatsDay {
            day: "2026-10-01".into(),
            recorded_request_count: 2,
            known_token_count: 30,
            total_tokens: Some(30),
            input_tokens: Some(20),
            ..StatsDay::default()
        });
        a.overview.recorded_request_count = 2;
        a.usage_amount_count = 2;
        a.daily_usage[0].usage_amount_count = 2;
        a.overview.known_token_count = 30;
        a.pricing_tokens.input = Some(20);
        a.daily_usage[0].sessions.push(StatsDaySession {
            session: SessionRef {
                provider: "codex".into(),
                session_id: "same-id".into(),
            },
            recorded_request_count: 2,
            known_token_count: 30,
            unknown_token_request_count: 0,
            unresolved_usage_observation_count: 0,
        });
        let mut b = empty();
        b.provider = "opencode".into();
        b.daily_usage.push(StatsDay {
            day: "2026-10-01".into(),
            recorded_request_count: 1,
            unknown_token_request_count: 1,
            unresolved_usage_observation_count: 4,
            ..StatsDay::default()
        });
        b.overview.recorded_request_count = 1;
        b.usage_amount_count = 1;
        b.daily_usage[0].usage_amount_count = 1;
        b.overview.unknown_token_request_count = 1;
        b.overview.unresolved_usage_observation_count = 4;
        b.daily_usage[0].sessions.push(StatsDaySession {
            session: SessionRef {
                provider: "opencode".into(),
                session_id: "same-id".into(),
            },
            recorded_request_count: 1,
            known_token_count: 0,
            unknown_token_request_count: 1,
            unresolved_usage_observation_count: 4,
        });
        let merged = compose(vec![a, b], vec![], StatsQuery::all()).unwrap();
        assert_eq!(merged.overview.recorded_request_count, 3);
        assert_eq!(merged.overview.known_token_count, 30);
        assert_eq!(merged.overview.unknown_token_request_count, 1);
        assert_eq!(merged.overview.unresolved_usage_observation_count, 4);
        assert_eq!(merged.daily_usage[0].total_tokens, None);
        assert_eq!(merged.daily_usage[0].input_tokens, None);
        assert_eq!(
            merged.pricing_tokens.input, None,
            "an unknown source dimension must stay omitted from aggregate pricing"
        );
        assert_eq!(merged.daily_usage[0].sessions.len(), 2);
        assert_ne!(
            merged.daily_usage[0].sessions[0].session.provider,
            merged.daily_usage[0].sessions[1].session.provider
        );
    }
    #[test]
    fn zero_readable_sources_have_explicit_missing_coverage() {
        let merged = compose(
            vec![],
            vec![StatsHarnessSource {
                provider: "codex".into(),
                status: "failed",
                diagnostic: Some("source corrupt".into()),
                overview: None,
            }],
            StatsQuery::all(),
        )
        .unwrap();
        assert!(merged.sources[0].overview.is_none());
        assert_eq!(merged.sources[0].status, "failed");
        assert_eq!(merged.overview.total_tokens, None);
        assert_eq!(merged.usage_coverage, "partial");
    }
    #[test]
    fn insights_compare_recorded_weeks_and_label_unusual_days_by_mean() {
        let days = (1..=14)
            .map(|day| StatsDay {
                day: format!("2026-09-{day:02}"),
                recorded_request_count: if day == 14 { 100 } else { 2 },
                ..StatsDay::default()
            })
            .collect::<Vec<_>>();
        let result = insights(&days, &[]);
        assert_eq!(result.recent_week_requests, Some(112));
        assert_eq!(result.preceding_week_requests, Some(14));
        assert_eq!(result.unusual_days, ["2026-09-14"]);
        assert_eq!(insights(&days[..7], &[]).recent_week_requests, None);
    }
}
