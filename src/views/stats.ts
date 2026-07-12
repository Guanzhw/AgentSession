import { escapeHtml } from "../markdown.js";
import { layout } from "./layout.js";
import { t } from "../i18n.js";
import type {
  TokenExplorerData, StatsFilters, TokenDayRow,
  ModelRankEntry, TopSessionEntry, CoverageInfo, StatsCapabilities
} from "../stats-data.js";
import { statsFiltersToParams } from "../stats-data.js";
import type { ComparisonResult } from "../stats-comparison.js";
import type { HeuristicInsight } from "../stats-insights.js";
import type { CostEstimate } from "../stats-cost.js";
import { projectFilterValue } from "../project-filter.js";

// ── Number formatting ───────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}

function fmtExact(n: number): string {
  return (n || 0).toLocaleString();
}

function fmtDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toISOString().slice(0, 10);
}

function shortDir(dir: string): string {
  if (!dir) return "—";
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || dir;
}

// ── Filter bar ──────────────────────────────────────────────────────────────

function renderFilterBar(filters: StatsFilters, modelPairs: Array<{ key: string; model: string; provider: string; totalTokens: number }>, provider: string, projects: Array<{ projectId: string; label: string; count: number }> | null | undefined, capabilities: StatsCapabilities, providers: any[]) {
  const params = statsFiltersToParams(filters);
  const baseParams = new URLSearchParams(params);
  // Remove days so presets aren't duplicated; we'll set it via radio buttons
  baseParams.delete("days");
  baseParams.delete("from");
  baseParams.delete("to");
  const baseQuery = baseParams.toString();
  const baseQS = baseQuery ? "&" + baseQuery : "";

  const presets = [
    { value: "7", label: t("stats.filter_preset_7") },
    { value: "30", label: t("stats.filter_preset_30") },
    { value: "90", label: t("stats.filter_preset_90") },
    { value: "custom", label: t("stats.filter_preset_custom") },
  ];

  const isCustom = filters.rangePreset === "custom" || Boolean(filters.from && filters.to);

  let presetRadios = presets.filter((p) => p.value !== "custom" || capabilities.customRange).map(p => {
    const checked = isCustom ? p.value === "custom" : String(filters.days) === p.value;
    const disabled = p.value === "custom" && !capabilities.customRange;
    return `<label class="stats-preset-label ${checked ? "active" : ""}">
      <input type="radio" name="days" value="${p.value}" ${checked ? "checked" : ""}${disabled ? " disabled" : ""}
        class="stats-preset-radio">
      <span class="stats-preset-btn"${disabled ? ` title="${escapeHtml(t("stats.filter_custom_unavailable"))}"` : ""}>${escapeHtml(p.label)}</span>
    </label>`;
  }).join("");

  const fromVal = filters.from || filters.requestedFrom || "";
  const toVal = filters.to || filters.requestedTo || "";
  const validationMessage = filters.validationError
    ? `<p class="stats-filter-error" role="alert">${escapeHtml(t(`stats.${filters.validationError}`))}</p>`
    : "";

  // Model pairs dropdown
  let modelOptions = capabilities.model
    ? `<option value="">${t("stats.filter_all_models")}</option>`
    : `<option value="">${t("stats.filter_model_unavailable")}</option>`;
  for (const mp of modelPairs) {
    const selected = filters.modelPair === mp.key ? " selected" : "";
    modelOptions += `<option value="${escapeHtml(mp.key)}"${selected}>${escapeHtml(mp.model)} · ${escapeHtml(mp.provider)}</option>`;
  }

  // Project dropdown
  let projectSelect = "";
  if (capabilities.project && projects !== null) {
    let options = `<option value="">${t("stats.filter_all_projects")}</option>`;
    for (const pj of projects || []) {
      const optionValue = projectFilterValue(pj.projectId);
      const selected = filters.project === optionValue ? " selected" : "";
      const label = pj.projectId === "" ? t("stats.filter_global_project") : escapeHtml(pj.label || pj.projectId);
      options += `<option value="${escapeHtml(optionValue)}"${selected}>${label} (${pj.count})</option>`;
    }
    projectSelect = `<div class="stats-filter-group">
      <select name="project" class="stats-filter-select" aria-label="${t("stats.filter_project")}">
        ${options}
      </select>
    </div>`;
  }

  const scopeAllChecked = filters.scope === "all" ? " checked" : "";
  const scopeRootChecked = filters.scope === "root" ? " checked" : "";

  // Two-model compare selectors
  let compareSelects = "";
  if (capabilities.model && modelPairs.length >= 2) {
    const compareAOpts = `<option value="">${t("stats.compare_select")}</option>` + modelPairs.map(mp => {
      const selected = filters.compareA === mp.key ? " selected" : "";
      return `<option value="${escapeHtml(mp.key)}"${selected}>${escapeHtml(mp.model)} · ${escapeHtml(mp.provider)}</option>`;
    }).join("");
    const compareBOpts = `<option value="">${t("stats.compare_select")}</option>` + modelPairs.map(mp => {
      const selected = filters.compareB === mp.key ? " selected" : "";
      return `<option value="${escapeHtml(mp.key)}"${selected}>${escapeHtml(mp.model)} · ${escapeHtml(mp.provider)}</option>`;
    }).join("");
    compareSelects = `<div class="stats-filter-compare" role="group" aria-label="${escapeHtml(t("stats.compare_title"))}">
      <label class="stats-compare-label">
        <span>${t("stats.compare_a")}</span>
        <select name="comparea" class="stats-filter-select stats-compare-select" aria-label="${t("stats.compare_a")}">${compareAOpts}</select>
      </label>
      <span class="stats-compare-vs">vs</span>
      <label class="stats-compare-label">
        <span>${t("stats.compare_b")}</span>
        <select name="compareb" class="stats-filter-select stats-compare-select" aria-label="${t("stats.compare_b")}">${compareBOpts}</select>
      </label>
    </div>`;
  }

  const scopeDisabled = capabilities.scope ? "" : " disabled";
  const limitedNote = Object.values(capabilities).every(Boolean)
    ? ""
    : `<p class="stats-filter-limited">${escapeHtml(t("stats.filters_limited"))}</p>`;

  return `
  <form class="stats-filter-bar" method="GET" action="/${encodeURIComponent(provider)}/stats">
    <div class="stats-filter-row">
      <div class="stats-filter-group stats-filter-presets">
        ${presetRadios}
        <div class="stats-filter-custom-dates${isCustom ? "" : " hidden"}">
          <label class="stats-filter-date-label">
            <span>${t("stats.filter_from")}</span>
            <input type="date" name="from" value="${escapeHtml(fromVal)}" class="stats-filter-date">
          </label>
          <label class="stats-filter-date-label">
            <span>${t("stats.filter_to")}</span>
            <input type="date" name="to" value="${escapeHtml(toVal)}" class="stats-filter-date">
          </label>
        </div>
      </div>
      ${projectSelect}
      ${capabilities.model ? `<div class="stats-filter-group">
        <select name="model" class="stats-filter-select" aria-label="${t("stats.filter_model")}"${capabilities.model ? "" : " disabled"}>
          ${modelOptions}
        </select>
      </div>` : ""}
      ${capabilities.scope ? `<div class="stats-filter-group stats-filter-scope">
        <label class="stats-filter-scope-label${scopeAllChecked ? " active" : ""}">
          <input type="radio" name="scope" value="all"${scopeAllChecked}${scopeDisabled}> ${t("stats.filter_scope_all")}
        </label>
        <label class="stats-filter-scope-label${scopeRootChecked ? " active" : ""}">
          <input type="radio" name="scope" value="root"${scopeRootChecked}${scopeDisabled}> ${t("stats.filter_scope_root")}
        </label>
      </div>` : ""}
      ${compareSelects}
      <div class="stats-filter-actions">
        <button type="submit" class="stats-filter-btn stats-filter-apply">${t("stats.filter_apply")}</button>
        <a href="/${encodeURIComponent(provider)}/stats" class="stats-filter-btn stats-filter-clear">${t("stats.filter_clear")}</a>
      </div>
    </div>
    ${validationMessage}
    <p class="stats-filter-timezone">${escapeHtml(t("stats.timezone_utc"))}</p>
    ${limitedNote}
  </form>`;
}

// ── KPI cards ───────────────────────────────────────────────────────────────

function renderKpiCards(overview: TokenExplorerData["overview"], capabilities: StatsCapabilities, comparison: ComparisonResult | null) {
  const comparisonDelta = comparison
    ? `<div class="stats-summary-sub ${comparison.totalDelta > 0 ? "delta-positive" : comparison.totalDelta < 0 ? "delta-negative" : "delta-neutral"}">${escapeHtml(t("stats.comparison_kpi_delta", {
        value: `${comparison.totalDelta > 0 ? "+" : comparison.totalDelta < 0 ? "−" : ""}${fmtNum(Math.abs(comparison.totalDelta))}`,
        percent: comparison.totalDeltaPercent === null ? "—" : `${comparison.totalDeltaPercent > 0 ? "+" : ""}${comparison.totalDeltaPercent}%`,
      }))}</div>`
    : "";
  return `
  <div class="stats-summary-row">
    <div class="stats-summary-card">
      <div class="stats-summary-label">${t("stats.kpi_total_tokens")}</div>
      <div class="stats-summary-value" data-token-total="${overview.totalTokens}">${fmtNum(overview.totalTokens)}</div>
      <div class="stats-summary-sub">${fmtExact(overview.totalTokens)} ${t("stats.tokens_unit")}</div>
      ${comparisonDelta}
    </div>
    ${capabilities.sessionBreakdown ? `<div class="stats-summary-card">
      <div class="stats-summary-label">${t("stats.kpi_sessions")}</div>
      <div class="stats-summary-value">${fmtNum(overview.totalSessions)}</div>
    </div>` : ""}
    <div class="stats-summary-card">
      <div class="stats-summary-label">${t("stats.kpi_messages")}</div>
      <div class="stats-summary-value">${fmtNum(overview.totalMessages)}</div>
    </div>
    <div class="stats-summary-card">
      <div class="stats-summary-label">${t("stats.kpi_peak_day")}</div>
      <div class="stats-summary-value">${fmtNum(overview.peakDayTokens)}</div>
      ${overview.peakDay ? `<div class="stats-summary-sub">${overview.peakDay}</div>` : ""}
    </div>
    ${capabilities.sessionBreakdown ? `<div class="stats-summary-card">
      <div class="stats-summary-label">${t("stats.kpi_avg_per_session")}</div>
      <div class="stats-summary-value">${fmtNum(overview.avgTokensPerSession)}</div>
    </div>` : ""}
  </div>`;
}

// ── Stacked token trend chart ───────────────────────────────────────────────

const TREND_COLORS: Record<string, string> = {
  total: "#6366f1",
  output: "#10b981",
  input: "#6366f1",
  reasoning: "#8b5cf6",
  cacheRead: "#f59e0b",
  cacheWrite: "#ec4899",
};

const TREND_KEYS: Array<{ key: string; label: string }> = [
  { key: "output", label: "stats.legend_output" },
  { key: "input", label: "stats.legend_input" },
  { key: "reasoning", label: "stats.legend_reasoning" },
  { key: "cacheRead", label: "stats.legend_cache_read" },
  { key: "cacheWrite", label: "stats.legend_cache_write" },
];

function renderTokenTrend(
  rows: TokenDayRow[],
  filters: StatsFilters,
  provider: string,
  missingDimensions: string[],
  allowDayDrill: boolean,
  allowComposition: boolean,
) {
  if (!rows || rows.length === 0) {
    return `<section class="stats-chart-section">
      <h2 class="stats-chart-title">${t("stats.token_trend")}</h2>
      <div class="stats-chart-body"><p class="stats-empty">${t("stats.no_data")}</p></div>
    </section>`;
  }

  const width = 700;
  const height = 260;
  const pad = { top: 10, right: 20, bottom: 36, left: 60 };
  const iw = width - pad.left - pad.right;
  const ih = height - pad.top - pad.bottom;

  // Stack the series
  const trendKeys = allowComposition ? TREND_KEYS : [{ key: "total", label: "stats.legend_total" }];
  const seriesData = trendKeys.map(tk => {
    const mapped = tk.key === "output" ? "output_tokens"
      : tk.key === "input" ? "input_tokens"
      : tk.key === "reasoning" ? "reasoning_tokens"
      : tk.key === "cacheRead" ? "cache_read_tokens"
      : tk.key === "cacheWrite" ? "cache_write_tokens"
      : "total_tokens";
    return rows.map((r: any) => Number(r[mapped]) || 0);
  });

  // Compute cumulative stack top for each day
  const stackTops: number[][] = [];
  for (let day = 0; day < rows.length; day++) {
    let acc = 0;
    const tops: number[] = [];
    for (let s = 0; s < seriesData.length; s++) {
      acc += seriesData[s][day];
      tops.push(acc);
    }
    stackTops.push(tops);
  }

  // Max of the stacked total
  const maxStack = Math.max(...stackTops.map(d => d[d.length - 1]), 1);

  // Helper: y from value
  function yVal(v: number) { return pad.top + ih - (v / maxStack) * ih; }

  // Grid lines
  let gridLines = "";
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (i / 4) * ih;
    const val = maxStack - (i / 4) * maxStack;
    gridLines += `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="var(--border-color)" stroke-dasharray="4 4" />`;
    gridLines += `<text x="${pad.left - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--text-muted)">${fmtNum(val)}</text>`;
  }

  // Build stacked areas (from bottom to top so topmost renders on top)
  let paths = "";
  let interactiveAreas = "";
  const bandW = iw / Math.max(rows.length - 1, 1);

  for (let s = seriesData.length - 1; s >= 0; s--) {
    const color = TREND_COLORS[trendKeys[s].key] || "#999";
    const dimName = trendKeys[s].key === "cacheRead" ? "cache-read"
      : trendKeys[s].key === "cacheWrite" ? "cache-write"
      : trendKeys[s].key;
    const dimMissing = missingDimensions.includes(dimName);

    if (dimMissing) continue;

    // Build SVG path for this series band
    let d = "";
    const baseYs: number[] = s === 0 ? rows.map(() => pad.top + ih) : stackTops.map(t => yVal(t[s - 1]));
    const thisYs = stackTops.map(t => yVal(t[s]));

    // Top line: left to right
    for (let i = 0; i < rows.length; i++) {
      const x = rows.length === 1 ? pad.left + iw / 2 : pad.left + (i / (rows.length - 1)) * iw;
      d += (i === 0 ? "M" : "L") + ` ${x},${thisYs[i]}`;
    }
    // Bottom line: right to left
    for (let i = rows.length - 1; i >= 0; i--) {
      const x = rows.length === 1 ? pad.left + iw / 2 : pad.left + (i / (rows.length - 1)) * iw;
      d += ` L ${x},${baseYs[i]}`;
    }
    d += " Z";

    const opacity = 0.85;
    paths += `<path d="${d}" fill="${color}" opacity="${opacity}" class="trend-band trend-band-${trendKeys[s].key}" />`;

    // Transparent interactive areas for tooltips
    for (let i = 0; i < rows.length; i++) {
      const cx = rows.length === 1 ? pad.left + iw / 2 : pad.left + (i / (rows.length - 1)) * iw;
      const x = cx - bandW / 2;
      const barW = rows.length === 1 ? 12 : Math.max(bandW, 6);
      const topY = thisYs[i];
      const bottomY = baseYs[i];
      const seriesVal = seriesData[s][i];
      if (seriesVal > 0) {
        const drillParams = statsFiltersToParams(filters);
        drillParams.set("day", rows[i].day);
        const drillHref = `/${encodeURIComponent(provider)}/stats?${drillParams.toString()}`;
        const ariaLabel = t("stats.trend_point_aria", {
          day: rows[i].day,
          series: t(trendKeys[s].label),
          value: fmtExact(seriesVal),
          total: fmtExact(stackTops[i][seriesData.length - 1]),
        });
        const hitContent = `<rect x="${x}" y="${topY}" width="${barW}" height="${Math.max(bottomY - topY, 1)}" fill="transparent" />`;
        interactiveAreas += allowDayDrill
          ? `<a href="${drillHref}" class="trend-hit" aria-label="${escapeHtml(ariaLabel)}"
          data-day="${escapeHtml(rows[i].day)}"
          data-series="${trendKeys[s].key}"
          data-val="${seriesVal}"
          data-total="${stackTops[i][seriesData.length - 1]}">${hitContent}</a>`
          : `<g class="trend-hit" role="group" tabindex="0" aria-label="${escapeHtml(ariaLabel)}"
          data-day="${escapeHtml(rows[i].day)}"
          data-series="${trendKeys[s].key}"
          data-val="${seriesVal}"
          data-total="${stackTops[i][seriesData.length - 1]}">${hitContent}</g>`;
      }
    }
  }

  // X-axis labels
  let xLabels = "";
  const step = Math.max(1, Math.ceil(rows.length / 5));
  for (let i = 0; i < rows.length; i += step) {
    const cx = rows.length === 1 ? pad.left + iw / 2 : pad.left + (i / (rows.length - 1)) * iw;
    const anchor = i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle";
    xLabels += `<text x="${cx}" y="${height - 8}" text-anchor="${anchor}" font-size="10" fill="var(--text-muted)">${rows[i].day.substring(5)}</text>`;
  }
  // Last label
  if (rows.length > 1 && (rows.length - 1) % step !== 0) {
    const cx = pad.left + iw;
    xLabels += `<text x="${cx}" y="${height - 8}" text-anchor="end" font-size="10" fill="var(--text-muted)">${rows[rows.length - 1].day.substring(5)}</text>`;
  }

  // Legend
  let legendItems = trendKeys.map(tk => {
    const dimLabel = tk.key === "cacheRead" ? "cache-read" : tk.key === "cacheWrite" ? "cache-write" : tk.key;
    const missing = missingDimensions.includes(dimLabel);
    const style = missing ? "opacity:0.3;text-decoration:line-through" : "";
    const disabledAttr = missing ? " disabled" : "";
    return `<label class="trend-legend-item" style="${style}">
      <input type="checkbox" class="trend-legend-toggle" data-series="${tk.key}" checked${disabledAttr}>
      <span class="trend-legend-swatch" style="background:${TREND_COLORS[tk.key] || "#999"}"></span>
      <span class="trend-legend-label">${t(tk.label)}${missing ? ` (${t("stats.unavailable")})` : ""}</span>
    </label>`;
  }).join("");

  return `
  <section class="stats-chart-section">
    <h2 class="stats-chart-title">${t("stats.token_trend")}</h2>
    <p class="stats-chart-help">${t(allowDayDrill ? "stats.token_trend_help" : "stats.token_trend_help_readonly")}</p>
    <div class="stats-chart-body">
      <div class="trend-legend">${legendItems}</div>
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="chart-svg trend-chart" role="img" aria-label="${escapeHtml(t("stats.trend_aria"))}">
        ${gridLines}
        ${paths}
        ${interactiveAreas}
        ${xLabels}
      </svg>
      <div class="trend-tooltip" id="trend-tooltip" hidden></div>
    </div>
  </section>`;
}

// ── Model ranking ────────────────────────────────────────────────────────────

function renderModelRanking(entries: ModelRankEntry[], totalTokens: number, filters: StatsFilters, provider: string) {
  if (!entries || entries.length === 0) {
    return `<section class="stats-chart-section">
      <h2 class="stats-chart-title">${t("stats.model_ranking")}</h2>
      <div class="stats-chart-body"><p class="stats-empty">${t("stats.no_data")}</p></div>
    </section>`;
  }

  const top8 = entries.slice(0, 8);
  const otherTokens = entries.slice(8).reduce((sum, e) => sum + e.totalTokens, 0);
  const maxTokens = Math.max(...top8.map(e => e.totalTokens), otherTokens, 1);

  function renderBar(entry: ModelRankEntry | { key: string; totalTokens: number; modelId?: string; providerId?: string }, isOther = false) {
    const pct = maxTokens > 0 ? (entry.totalTokens / maxTokens) * 100 : 0;
    const label = isOther
      ? `${t("stats.model_other")} (${entries.length - 8})`
      : `${escapeHtml(entry.modelId || "?")} · ${escapeHtml(entry.providerId || "?")}`;

    // Build a filter link for this model pair
    const modelKey = isOther ? "" : entry.key;
    const filterParams = statsFiltersToParams(filters);
    if (modelKey) {
      filterParams.set("model", modelKey);
    } else {
      filterParams.delete("model");
    }
    const href = `/${encodeURIComponent(provider)}/stats?${filterParams.toString()}`;

    const barContent = `<div class="model-rank-bar-fill" style="width:${pct.toFixed(1)}%"></div>`;
    const barLabel = `<span class="model-rank-name">${label}</span>`;
    const barValue = `<span class="model-rank-value">${fmtNum(entry.totalTokens)} ${t("stats.model_ranking_metric")}</span>`;

    if (modelKey) {
      return `<a href="${href}" class="model-rank-row" title="${escapeHtml(t("stats.model_filter_title", { model: label }))}">
        ${barLabel}
        <div class="model-rank-bar">${barContent}</div>
        ${barValue}
      </a>`;
    }
    return `<div class="model-rank-row">
      ${barLabel}
      <div class="model-rank-bar">${barContent}</div>
      ${barValue}
    </div>`;
  }

  const bars = top8.map(e => renderBar(e)).join("");
  const otherBar = entries.length > 8 ? renderBar({ key: "other", totalTokens: otherTokens }, true) : "";

  return `
  <section class="stats-chart-section">
    <h2 class="stats-chart-title">${t("stats.model_ranking")}</h2>
    <div class="stats-chart-body">
      <p class="stats-scroll-hint">${t("stats.scroll_hint")}</p>
      <div class="model-ranking">
        ${bars}
        ${otherBar}
      </div>
    </div>
  </section>`;
}

// ── Top sessions table ──────────────────────────────────────────────────────

function renderTopSessions(sessions: TopSessionEntry[], provider: string, dayFilter: string | null, filters: StatsFilters) {
  // Validate day filter to prevent XSS
  const safeDay = dayFilter && /^\d{4}-\d{2}-\d{2}$/.test(dayFilter) ? dayFilter : null;
  const dayInfo = safeDay
    ? `<p class="stats-drill-info">
        ${escapeHtml(t("stats.drill_day_title", { day: safeDay }))}
        <a href="/${encodeURIComponent(provider)}/stats?${statsFiltersToParams(filters).toString()}" class="stats-drill-clear">
          ${t("stats.drill_day_clear")}
        </a>
      </p>`
    : "";

  if (!sessions || sessions.length === 0) {
    return `
    <section class="stats-chart-section">
      <h2 class="stats-chart-title">${t("stats.top_sessions")}</h2>
      ${dayInfo}
      <div class="stats-chart-body"><p class="stats-empty">${t("stats.top_sessions_empty")}</p></div>
    </section>`;
  }

  const rows = sessions.map(s => {
    const sessionUrl = `/${encodeURIComponent(provider)}/session/${encodeURIComponent(s.sessionId)}`;
    const modelLabel = s.providerModel === "__multiple__"
      ? t("stats.multiple_models", { count: String(s.modelCount || 0) })
      : s.providerModel === "__unknown__" || !s.providerModel
        ? t("stats.unknown_model")
        : s.providerModel;
    return `<tr>
      <td class="top-sess-title"><a href="${sessionUrl}">${escapeHtml(s.title || s.sessionId)}</a></td>
      <td class="top-sess-dir">${escapeHtml(shortDir(s.directory))}</td>
      <td class="top-sess-model">${escapeHtml(modelLabel)}</td>
      <td class="top-sess-tokens">${fmtNum(s.totalTokens)}</td>
      <td class="top-sess-msgs">${s.messageCount}</td>
      <td class="top-sess-updated">${fmtDate(s.timeUpdated)}</td>
    </tr>`;
  }).join("");

  return `
  <section class="stats-chart-section">
    <h2 class="stats-chart-title">${t("stats.top_sessions")}</h2>
    ${dayInfo}
    <div class="stats-chart-body">
      <p class="stats-scroll-hint">${t("stats.scroll_hint")}</p>
      <table class="top-sessions-table">
        <thead>
          <tr>
            <th>${t("stats.top_sessions_col_session")}</th>
            <th>${t("stats.top_sessions_col_project")}</th>
            <th>${t("stats.top_sessions_col_model")}</th>
            <th class="num">${t("stats.top_sessions_col_tokens")}</th>
            <th class="num">${t("stats.top_sessions_col_messages")}</th>
            <th>${t("stats.top_sessions_col_updated")}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

// ── Coverage info ───────────────────────────────────────────────────────────

function renderCoverage(coverage: CoverageInfo | null) {
  // Null coverage means unavailable (file-based providers)
  if (!coverage || coverage.messagesWithTokens === null) {
    return `<section class="stats-chart-section stats-coverage">
      <h2 class="stats-chart-title">${t("stats.coverage_title")}</h2>
      <div class="stats-chart-body"><p class="stats-empty">${t("stats.coverage_unavailable")}</p></div>
    </section>`;
  }

  const hasData = coverage.totalAssistantMessages != null && coverage.totalAssistantMessages > 0;

  if (!hasData) {
    return `<section class="stats-chart-section stats-coverage">
      <h2 class="stats-chart-title">${t("stats.coverage_title")}</h2>
      <div class="stats-chart-body"><p class="stats-empty">${t("stats.coverage_none")}</p></div>
    </section>`;
  }

  const msgPct = coverage.totalAssistantMessages! > 0
    ? Math.round((coverage.messagesWithTokens! / coverage.totalAssistantMessages!) * 100)
    : 0;

  let dimensionInfo = "";
  if (coverage.availableDimensions.length > 0) {
    dimensionInfo += `<div class="coverage-dim available">${t("stats.coverage_dimensions", { available: coverage.availableDimensions.join(", ") })}</div>`;
  }
  if (coverage.missingDimensions.length > 0) {
    dimensionInfo += `<div class="coverage-dim missing">${t("stats.coverage_missing", { missing: coverage.missingDimensions.join(", ") })}</div>`;
  }

  return `
  <section class="stats-chart-section stats-coverage">
    <h2 class="stats-chart-title">${t("stats.coverage_title")}</h2>
    <div class="stats-chart-body">
      <div class="coverage-bar">
        <div class="coverage-bar-fill" style="width:${msgPct}%"></div>
        <span class="coverage-bar-label">${msgPct}%</span>
      </div>
      <p class="coverage-text">${t("stats.coverage_messages", { withTokens: String(coverage.messagesWithTokens ?? 0), total: String(coverage.totalAssistantMessages ?? 0) })}</p>
      <p class="coverage-text">${t("stats.coverage_sessions", { withTokens: String(coverage.sessionsWithTokens ?? 0), total: String(coverage.totalSessions ?? 0) })}</p>
      ${dimensionInfo}
    </div>
  </section>`;
}

// ── Period comparison ────────────────────────────────────────────────────────

function renderComparison(comparison: ComparisonResult | null, _filters: StatsFilters) {
  if (!comparison) return "";

  const deltaClass = comparison.totalDelta > 0 ? "delta-positive" : comparison.totalDelta < 0 ? "delta-negative" : "delta-neutral";
  const deltaSign = comparison.totalDelta > 0 ? "+" : "";
  const deltaPct = comparison.totalDeltaPercent !== null
    ? ` (${comparison.totalDelta > 0 ? "+" : ""}${comparison.totalDeltaPercent}%)`
    : "";

  return `
  <section class="stats-chart-section stats-comparison">
    <h2 class="stats-chart-title">${t("stats.comparison_title")}</h2>
    <p class="stats-comparison-range">
      ${escapeHtml(t("stats.comparison_range", { from: comparison.previousFrom, to: comparison.previousTo }))}
    </p>
    <div class="stats-comparison-grid">
      <div class="stats-comparison-cell">
        <div class="stats-comparison-label">${t("stats.comparison_total_tokens")}</div>
        <div class="stats-comparison-values">
          <span class="stats-comparison-current">${fmtNum(comparison.currentTotalTokens)}</span>
          <span class="stats-comparison-prev">${t("stats.comparison_vs", { prev: fmtNum(comparison.previousTotalTokens) })}</span>
          <span class="stats-comparison-delta ${deltaClass}">${deltaSign}${fmtNum(Math.abs(comparison.totalDelta))}${deltaPct}</span>
        </div>
      </div>
      <div class="stats-comparison-cell">
        <div class="stats-comparison-label">${t("stats.comparison_usage_sessions")}</div>
        <div class="stats-comparison-values">
          <span class="stats-comparison-current">${fmtNum(comparison.currentUsageSessions)}</span>
          <span class="stats-comparison-prev">${t("stats.comparison_vs", { prev: fmtExact(comparison.previousUsageSessions) })}</span>
        </div>
      </div>
      <div class="stats-comparison-cell">
        <div class="stats-comparison-label">${t("stats.comparison_usage_records")}</div>
        <div class="stats-comparison-values">
          <span class="stats-comparison-current">${fmtNum(comparison.currentUsageRecords)}</span>
          <span class="stats-comparison-prev">${t("stats.comparison_vs", { prev: fmtExact(comparison.previousUsageRecords) })}</span>
        </div>
      </div>
      <div class="stats-comparison-cell">
        <div class="stats-comparison-label">${t("stats.comparison_tokens_per_session")}</div>
        <div class="stats-comparison-values">
          <span class="stats-comparison-current">${comparison.currentTokensPerSession !== null ? fmtNum(comparison.currentTokensPerSession) : "—"}</span>
          <span class="stats-comparison-prev">${comparison.previousTokensPerSession !== null ? t("stats.comparison_vs", { prev: fmtNum(comparison.previousTokensPerSession) }) : ""}</span>
        </div>
      </div>
    </div>
  </section>`;
}

// ── Heuristic insights ──────────────────────────────────────────────────────

function renderInsights(insights: HeuristicInsight[] | undefined) {
  if (!insights || insights.length === 0) return "";
  const items = insights.map(i => {
    const sevClass = `insight-${i.severity}`;
    const localized = i.key === "daily_spike"
      ? {
          title: t("stats.insight_daily_spike_title"),
          description: t("stats.insight_daily_spike_desc", {
            ratio: String(i.evidence.ratio),
            peak: fmtExact(i.evidence.peakTokens),
            median: fmtExact(i.evidence.medianTokens),
          }),
        }
      : i.key === "dominant_session"
        ? {
            title: t("stats.insight_dominant_session_title"),
            description: t("stats.insight_dominant_session_desc", {
              percent: String(Math.round(i.evidence.share * 100)),
              tokens: fmtExact(i.evidence.topSessionTokens),
            }),
          }
        : i.key === "low_coverage"
          ? {
              title: t("stats.insight_low_coverage_title"),
              description: t("stats.insight_low_coverage_desc", {
                percent: String(Math.round(i.evidence.ratio * 100)),
                withTokens: fmtExact(i.evidence.messagesWithTokens),
                total: fmtExact(i.evidence.totalAssistantMessages),
              }),
            }
          : { title: i.title, description: i.description };
    return `<div class="insight-card ${sevClass}">
      <div class="insight-header">
        <span class="insight-severity insight-sev-${i.severity}">${t(`stats.insight_severity_${i.severity}`)}</span>
        <strong class="insight-title">${escapeHtml(localized.title)}</strong>
      </div>
      <p class="insight-desc">${escapeHtml(localized.description)}</p>
    </div>`;
  }).join("");
  return `
  <section class="stats-chart-section stats-insights">
    <h2 class="stats-chart-title">${t("stats.insights_title")}</h2>
    <p class="stats-chart-help">${t("stats.insights_note")}</p>
    <div class="insights-list">${items}</div>
  </section>`;
}

// ── Two-model comparison ─────────────────────────────────────────────────────

function renderModelCompare(compareA: any, compareB: any, _filters: StatsFilters, _provider: string) {
  if (!compareA || !compareB) {
    return `
    <section class="stats-chart-section stats-compare">
      <h2 class="stats-chart-title">${t("stats.compare_title")}</h2>
      <div class="stats-chart-body"><p class="stats-empty">${t("stats.compare_empty")}</p></div>
    </section>`;
  }

  const shareA = Math.round(compareA.share * 100);
  const shareB = Math.round(compareB.share * 100);

  return `
  <section class="stats-chart-section stats-compare">
    <h2 class="stats-chart-title">${t("stats.compare_title")}</h2>
    <p class="stats-chart-help">${t("stats.compare_note")}</p>
    <div class="compare-grid">
      <div class="compare-column">
        <h3 class="compare-model-name">${escapeHtml(compareA.model)} · ${escapeHtml(compareA.provider)}</h3>
        <div class="compare-stat"><span class="compare-label">${t("stats.compare_total_tokens")}</span><span class="compare-value">${fmtNum(compareA.totalTokens)}</span></div>
        <div class="compare-stat"><span class="compare-label">${t("stats.compare_records")}</span><span class="compare-value">${fmtExact(compareA.recordCount)}</span></div>
        <div class="compare-stat"><span class="compare-label">${t("stats.compare_tokens_per_record")}</span><span class="compare-value">${compareA.tokensPerRecord !== null ? fmtNum(compareA.tokensPerRecord) : "—"}</span></div>
        <div class="compare-stat"><span class="compare-label">${t("stats.compare_share")}</span><span class="compare-value">${shareA}%</span></div>
      </div>
      <div class="compare-column">
        <h3 class="compare-model-name">${escapeHtml(compareB.model)} · ${escapeHtml(compareB.provider)}</h3>
        <div class="compare-stat"><span class="compare-label">${t("stats.compare_total_tokens")}</span><span class="compare-value">${fmtNum(compareB.totalTokens)}</span></div>
        <div class="compare-stat"><span class="compare-label">${t("stats.compare_records")}</span><span class="compare-value">${fmtExact(compareB.recordCount)}</span></div>
        <div class="compare-stat"><span class="compare-label">${t("stats.compare_tokens_per_record")}</span><span class="compare-value">${compareB.tokensPerRecord !== null ? fmtNum(compareB.tokensPerRecord) : "—"}</span></div>
        <div class="compare-stat"><span class="compare-label">${t("stats.compare_share")}</span><span class="compare-value">${shareB}%</span></div>
      </div>
    </div>
  </section>`;
}

// ── Cost estimate ────────────────────────────────────────────────────────────

function renderCostEstimate(costEstimate: CostEstimate | null, filters: StatsFilters) {
  if (!filters.modelPair) {
    return `
    <section class="stats-chart-section stats-cost">
      <h2 class="stats-chart-title">${t("stats.cost_title")}</h2>
      <div class="stats-chart-body"><p class="stats-empty">${t("stats.cost_filter_first")}</p></div>
    </section>`;
  }

  if (!costEstimate) {
    return `
    <section class="stats-chart-section stats-cost">
      <h2 class="stats-chart-title">${t("stats.cost_title")}</h2>
      <div class="stats-chart-body"><p class="stats-empty">${t("stats.cost_no_pricing")}</p></div>
    </section>`;
  }

  const breakRows = Object.entries(costEstimate.breakdown).map(([dim, info]) => {
    if (!info) return "";
    return `<tr>
      <td>${t(`stats.cost_dim_${dim}`)}</td>
      <td class="num">${fmtExact(info.tokens)}</td>
      <td class="num">${costEstimate.currency} ${info.cost.toFixed(4)}</td>
    </tr>`;
  }).join("");

  let omittedNote = "";
  if (costEstimate.omittedDimensions.length > 0) {
    omittedNote = `<p class="cost-omitted">${escapeHtml(t("stats.cost_omitted", { dims: costEstimate.omittedDimensions.join(", ") }))}</p>`;
  }

  let sourceInfo = "";
  if (costEstimate.sourceLabel || costEstimate.sourceUrl || costEstimate.asOf) {
    const parts: string[] = [];
    if (costEstimate.sourceLabel) parts.push(escapeHtml(costEstimate.sourceLabel));
    if (costEstimate.sourceUrl) {
      try {
        const parsed = new URL(costEstimate.sourceUrl);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          parts.push(`<a href="${escapeHtml(parsed.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("stats.cost_source_link"))}</a>`);
        }
      } catch {}
    }
    if (costEstimate.asOf) parts.push(t("stats.cost_as_of", { date: costEstimate.asOf }));
    sourceInfo = `<p class="cost-source">${parts.join(" · ")}</p>`;
  }

  return `
  <section class="stats-chart-section stats-cost">
    <h2 class="stats-chart-title">${t("stats.cost_title")}</h2>
    <p class="stats-cost-estimate-label">${t("stats.cost_estimate_label")}</p>
    <p class="stats-cost-total">${escapeHtml(costEstimate.currency)} ${costEstimate.totalCost.toFixed(4)}</p>
    ${sourceInfo}
    <table class="cost-breakdown">
      <thead><tr><th>${t("stats.cost_dimension")}</th><th class="num">${t("stats.cost_tokens")}</th><th class="num">${t("stats.cost_amount")}</th></tr></thead>
      <tbody>${breakRows}</tbody>
    </table>
    ${omittedNote}
  </section>`;
}

// ── Main render ─────────────────────────────────────────────────────────────

export function renderStatsPage(data: TokenExplorerData & { dayDrill?: string | null; modelPairs?: Array<{ key: string; model: string; provider: string; totalTokens: number }>; projects?: Array<{ projectId: string; label: string; count: number }> | null }) {
  const { filters = { days: 30, from: null, to: null, project: "", modelPair: null, scope: "all", compareA: null, compareB: null, rangePreset: "30", requestedFrom: "", requestedTo: "", validationError: null }, tokenStats, modelRanking, topSessions, coverage, overview, provider, providers = [], manageable, comparison = null, insights = [], costEstimate = null, compareA = null, compareB = null } = data;

  // Day drill-down from URL (passed by route handler)
  const dayDrill = data.dayDrill || null;

  // Available model pairs for the filter dropdown
  const modelPairs = data.modelPairs || [];

  // Projects for the filter dropdown (null = unavailable, undefined/[] = empty)
  const projects = data.projects;

  // Safe defaults for optional fields (backward compat with legacy callers)
  const safeOverview = overview || { totalSessions: 0, totalMessages: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, peakDay: "", peakDayTokens: 0, avgTokensPerSession: 0 };
  const safeTokenStats = Array.isArray(tokenStats) ? tokenStats : [];
  const safeModelRanking = Array.isArray(modelRanking) ? modelRanking : [];
  const safeTopSessions = Array.isArray(topSessions) ? topSessions : [];
  const safeCoverage = coverage || null;
  const capabilities: StatsCapabilities = data.capabilities || { customRange: true, project: projects !== null, model: true, scope: true, dayDrill: true, composition: true, modelRanking: true, sessionBreakdown: true, coverage: true };
  const rangeParams = new URLSearchParams();
  if (filters.rangePreset === "custom" && filters.from && filters.to) {
    rangeParams.set("days", "custom");
    rangeParams.set("from", filters.from);
    rangeParams.set("to", filters.to);
  } else {
    rangeParams.set("days", String([7, 30, 90].includes(filters.days) ? filters.days : 30));
  }
  const rangeQuery = rangeParams.toString();
  const exportQuery = statsFiltersToParams(filters).toString();
  const advancedContent = capabilities.model
    ? `${renderComparison(comparison, filters)}${renderInsights(insights)}${renderModelCompare(compareA, compareB, filters, provider)}${renderCostEstimate(costEstimate, filters)}`
    : "";

  const content = `
    <div class="stats-page">
      <h1 class="stats-title">${t("stats.title")}</h1>
      <p class="stats-desc">${t("stats.desc")}</p>

      <div class="stats-provider-bar">
        <span class="stats-provider-label">${t("stats.provider")}:</span>
        <div class="stats-provider-list">
          ${(providers || []).map((p: any) => {
            const isCurrent = p.id === provider;
            const className = `stats-provider-item${isCurrent ? " current" : ""}${p.available === false ? " disabled" : ""}`;
            if (p.available === false) {
              return `<span class="${className}" aria-disabled="true">${escapeHtml(p.name || p.id)}</span>`;
            }
            return `<a href="/${encodeURIComponent(p.id)}/stats?${rangeQuery}" class="${className}"${isCurrent ? ' aria-current="page"' : ""}>${escapeHtml(p.name || p.id)}</a>`;
          }).join("")}
        </div>
      </div>

      ${renderFilterBar(filters, modelPairs, provider, projects, capabilities, providers)}

      <div class="stats-export-bar">
        <a href="/api/${encodeURIComponent(provider)}/stats/export.json?${exportQuery}" class="stats-export-link" download>${t("stats.export_json")}</a>
        <a href="/api/${encodeURIComponent(provider)}/stats/export.csv?${exportQuery}" class="stats-export-link" download>${t("stats.export_csv")}</a>
      </div>

      <div class="stats-saved-views" data-provider="${escapeHtml(provider)}">
        <div class="saved-views-header">
          <span class="saved-views-title">${t("stats.saved_views")}</span>
          <button type="button" class="saved-views-save-btn" id="save-view-btn" aria-label="${escapeHtml(t("stats.saved_views_save"))}">${t("stats.saved_views_save")}</button>
        </div>
        <ul class="saved-views-list" id="saved-views-list"></ul>
        <template id="saved-view-template">
          <li class="saved-view-item">
            <a href="" class="saved-view-link"></a>
            <button type="button" class="saved-view-delete" aria-label="${escapeHtml(t("stats.saved_views_delete"))}">&times;</button>
          </li>
        </template>
      </div>

      ${renderKpiCards(safeOverview, capabilities, comparison)}

      ${renderTokenTrend(safeTokenStats, filters, provider, safeCoverage?.missingDimensions ?? [], capabilities.dayDrill, capabilities.composition)}

      ${capabilities.modelRanking ? renderModelRanking(safeModelRanking, safeOverview.totalTokens, filters, provider) : ""}

      ${capabilities.sessionBreakdown ? renderTopSessions(safeTopSessions, provider, dayDrill, filters) : ""}

      ${capabilities.coverage ? renderCoverage(safeCoverage) : ""}

      ${advancedContent ? `<details class="stats-advanced-details"${filters.compareA && filters.compareB ? " open" : ""}>
        <summary>${escapeHtml(t("stats.advanced_title"))}</summary>
        <div class="stats-advanced-content">${advancedContent}</div>
      </details>` : ""}
    </div>
  `;

  return layout(t("stats.title"), content, "stats", { provider, providers, manageable: manageable === true });
}
