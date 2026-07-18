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

function renderFilterBar(filters: StatsFilters, modelPairs: Array<{ key: string; model: string; provider: string; totalTokens: number }>, provider: string, projects: Array<{ projectId: string; label: string; count: number }> | null | undefined, capabilities: StatsCapabilities, providers: any[], pagePath = `/${encodeURIComponent(provider)}/stats`, selectedProviders: string[] = []) {
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
    : `<p class="stats-filter-limited">${escapeHtml(t(pagePath === "/stats" ? "stats.filters_limited_global" : "stats.filters_limited"))}</p>`;

  return `
  <form class="stats-filter-bar" method="GET" action="${escapeHtml(pagePath)}">
    ${selectedProviders.map((id) => `<input type="hidden" name="provider" value="${escapeHtml(id)}">`).join("")}
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
        <a href="${escapeHtml(pagePath)}${selectedProviders.length ? `?${selectedProviders.map((id) => `provider=${encodeURIComponent(id)}`).join("&")}` : ""}" class="stats-filter-btn stats-filter-clear">${t("stats.filter_clear")}</a>
      </div>
    </div>
    ${validationMessage}
    <p class="stats-filter-timezone">${escapeHtml(t("stats.timezone_utc"))}</p>
    ${limitedNote}
  </form>`;
}

function hrefWithParams(path: string, params: URLSearchParams, hash = "") {
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}${hash}`;
}

function renderProviderBreakdown(entries: NonNullable<TokenExplorerData["providerBreakdown"]>, totalTokens: number, filters: StatsFilters) {
  if (!entries.length) return "";
  return `<section class="stats-provider-breakdown">
    <div class="stats-section-heading"><div><h2>${escapeHtml(t("stats.provider_breakdown"))}</h2><p>${escapeHtml(t("stats.provider_breakdown_help"))}</p></div></div>
    <div class="stats-provider-breakdown-grid">
      ${entries.map((entry) => {
        const share = totalTokens > 0 ? Math.round(entry.totalTokens / totalTokens * 1000) / 10 : 0;
        const rangeParams = new URLSearchParams();
        if (filters.rangePreset === "custom" && filters.from && filters.to) {
          rangeParams.set("days", "custom");
          rangeParams.set("from", filters.from);
          rangeParams.set("to", filters.to);
        } else {
          rangeParams.set("days", String(filters.days));
        }
        return `<a class="stats-provider-breakdown-card" href="${escapeHtml(hrefWithParams(`/${encodeURIComponent(entry.provider)}/stats`, rangeParams))}">
          <span class="stats-provider-breakdown-heading"><span class="stats-provider-breakdown-name">${escapeHtml(entry.name)}</span><span class="stats-provider-capability ${entry.advancedDetails ? "advanced" : "aggregate"}">${escapeHtml(t(entry.advancedDetails ? "stats.provider_advanced" : "stats.provider_aggregate"))}</span></span>
          <strong>${fmtNum(entry.totalTokens)}</strong>
          <span>${share}% · ${fmtExact(entry.totalMessages)} ${escapeHtml(t("stats.messages_unit"))}</span>
          <span class="stats-provider-open">${escapeHtml(t(entry.advancedDetails ? "stats.provider_open_advanced" : "stats.provider_open_focused"))} →</span>
          <i style="--provider-share:${Math.min(100, share)}%"></i>
        </a>`;
      }).join("")}
    </div>
  </section>`;
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

// ── Stacked daily token chart ───────────────────────────────────────────────

const TREND_COLORS: Record<string, string> = {
  total: "#60a5fa",
  input: "#60a5fa",
  cacheRead: "#34d399",
  cacheWrite: "#14b8a6",
  output: "#a78bfa",
  reasoning: "#fbbf24",
  other: "#64748b",
};

const TREND_KEYS: Array<{ key: string; label: string }> = [
  { key: "input", label: "stats.legend_input" },
  { key: "cacheRead", label: "stats.legend_cache_read" },
  { key: "cacheWrite", label: "stats.legend_cache_write" },
  { key: "output", label: "stats.legend_output" },
  { key: "reasoning", label: "stats.legend_reasoning" },
  { key: "other", label: "stats.legend_other" },
];

function trendValue(row: TokenDayRow, key: string): number {
  if (key === "input") return Math.max(0, Number(row.input_tokens) || 0);
  if (key === "output") return Math.max(0, Number(row.output_tokens) || 0);
  if (key === "reasoning") return Math.max(0, Number(row.reasoning_tokens) || 0);
  if (key === "cacheRead") return Math.max(0, Number(row.cache_read_tokens) || 0);
  if (key === "cacheWrite") return Math.max(0, Number(row.cache_write_tokens) || 0);
  if (key === "other") {
    const known = trendValue(row, "input") + trendValue(row, "output")
      + trendValue(row, "reasoning") + trendValue(row, "cacheRead")
      + trendValue(row, "cacheWrite");
    return Math.max(0, (Number(row.total_tokens) || 0) - known);
  }
  return Math.max(0, Number(row.total_tokens) || 0);
}

function renderTokenTrend(
  rows: TokenDayRow[],
  filters: StatsFilters,
  provider: string,
  missingDimensions: string[],
  allowDayDrill: boolean,
  allowComposition: boolean,
  selectedDay: string | null = null,
) {
  if (!rows || rows.length === 0) {
    return `<section class="stats-chart-section">
      <h2 class="stats-chart-title">${t("stats.token_trend")}</h2>
      <div class="stats-chart-body"><p class="stats-empty">${t("stats.no_data")}</p></div>
    </section>`;
  }

  const width = 960;
  const height = 300;
  const pad = { top: 22, right: 18, bottom: 40, left: 64 };
  const iw = width - pad.left - pad.right;
  const ih = height - pad.top - pad.bottom;

  const trendKeys = allowComposition ? TREND_KEYS : [{ key: "total", label: "stats.legend_total" }];
  const totals = rows.map(row => trendKeys.reduce((sum, key) => sum + trendValue(row, key.key), 0));
  const positiveTotals = totals.filter(Boolean).sort((a, b) => b - a);
  const maxTotal = Math.max(...totals, 1);
  const secondTotal = positiveTotals[1] || 0;
  const clippedScale = secondTotal > 0 && maxTotal > secondTotal * 4;
  const chartMax = clippedScale ? Math.max(1, secondTotal * 1.25) : maxTotal;
  const yVal = (value: number) => pad.top + ih - (Math.min(value, chartMax) / chartMax) * ih;

  let gridLines = "";
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (i / 4) * ih;
    const val = chartMax - (i / 4) * chartMax;
    gridLines += `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="trend-grid-line" />`;
    gridLines += `<text x="${pad.left - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--text-muted)" class="trend-y-label" data-grid-index="${i}">${fmtNum(val)}</text>`;
  }

  let bars = "";
  let interactiveAreas = "";
  const slotWidth = iw / Math.max(rows.length, 1);
  const barWidth = Math.max(4, Math.min(48, slotWidth * 0.68));

  for (let dayIndex = 0; dayIndex < rows.length; dayIndex++) {
    const row = rows[dayIndex];
    const centerX = pad.left + slotWidth * dayIndex + slotWidth / 2;
    const x = centerX - barWidth / 2;
    let cumulative = 0;
    for (const key of trendKeys) {
      const value = trendValue(row, key.key);
      if (value <= 0) continue;
      const baseY = yVal(cumulative);
      cumulative += value;
      const topY = yVal(cumulative);
      const rectHeight = Math.max(0, baseY - topY);
      if (rectHeight <= 0) continue;
      bars += `<rect x="${x}" y="${topY}" width="${barWidth}" height="${rectHeight}"
        fill="${TREND_COLORS[key.key] || "#64748b"}" class="trend-bar trend-band-${key.key}" rx="${Math.min(3, barWidth / 5)}"
        data-day-index="${dayIndex}" data-series="${key.key}" data-value="${value}" />`;
    }

    const total = totals[dayIndex];
    const drillParams = statsFiltersToParams(filters);
    drillParams.set("day", row.day);
    const drillHref = hrefWithParams(`/${encodeURIComponent(provider)}/stats`, drillParams, "#stats-session-results");
    const ariaLabel = t("stats.trend_day_aria", { day: row.day, total: fmtExact(total) });
    const data = `data-day="${escapeHtml(row.day)}" data-total="${total}"
      data-input="${trendValue(row, "input")}" data-output="${trendValue(row, "output")}"
      data-reasoning="${trendValue(row, "reasoning")}" data-cache-read="${trendValue(row, "cacheRead")}"
      data-cache-write="${trendValue(row, "cacheWrite")}" data-other="${trendValue(row, "other")}"`;
    const hitRect = `<rect x="${pad.left + slotWidth * dayIndex}" y="${pad.top}" width="${slotWidth}" height="${ih}" fill="transparent" />`;
    interactiveAreas += allowDayDrill
      ? `<a href="${drillHref}" class="trend-hit trend-day-hit${selectedDay === row.day ? " is-selected" : ""}" aria-label="${escapeHtml(ariaLabel)}"${selectedDay === row.day ? ' aria-current="true"' : ""} ${data}>${hitRect}</a>`
      : `<g class="trend-hit trend-day-hit" role="group" tabindex="0" aria-label="${escapeHtml(ariaLabel)}" ${data}>${hitRect}</g>`;
    const peakHidden = clippedScale && total > chartMax ? "" : " hidden";
    bars += `<path d="M ${centerX - 5} ${pad.top + 7} L ${centerX} ${pad.top + 1} L ${centerX + 5} ${pad.top + 7}"
      class="trend-clipped-marker${peakHidden}" data-day-index="${dayIndex}" />`;
    bars += `<text x="${centerX}" y="${pad.top + 18}" text-anchor="middle"
      class="trend-clipped-label${peakHidden}" data-day-index="${dayIndex}">${fmtNum(total)}</text>`;
  }

  // X-axis labels
  let xLabels = "";
  const step = Math.max(1, Math.ceil(rows.length / 5));
  for (let i = 0; i < rows.length; i += step) {
    const cx = pad.left + slotWidth * i + slotWidth / 2;
    xLabels += `<text x="${cx}" y="${height - 9}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${rows[i].day.substring(5)}</text>`;
  }
  // Last label
  if (rows.length > 1 && (rows.length - 1) % step !== 0) {
    const cx = pad.left + slotWidth * (rows.length - 1) + slotWidth / 2;
    xLabels += `<text x="${cx}" y="${height - 9}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${rows[rows.length - 1].day.substring(5)}</text>`;
  }

  // Legend
  const grandTotal = totals.reduce((sum, value) => sum + value, 0);
  let legendItems = trendKeys.map(tk => {
    const dimLabel = tk.key === "cacheRead" ? "cache-read" : tk.key === "cacheWrite" ? "cache-write" : tk.key;
    const seriesTotal = rows.reduce((sum, row) => sum + trendValue(row, tk.key), 0);
    const missing = seriesTotal === 0 || (tk.key !== "other" && missingDimensions.includes(dimLabel));
    const style = missing ? "opacity:0.3;text-decoration:line-through" : "";
    const disabledAttr = missing ? " disabled" : "";
    return `<label class="trend-legend-item" style="${style}">
      <input type="checkbox" class="trend-legend-toggle" data-series="${tk.key}" checked${disabledAttr}>
      <span class="trend-legend-swatch" style="background:${TREND_COLORS[tk.key] || "#999"}"></span>
      <span class="trend-legend-copy"><span class="trend-legend-label">${t(tk.label)}${missing ? ` (${t("stats.unavailable")})` : ""}</span>
      ${missing ? "" : `<span class="trend-legend-value">${fmtNum(seriesTotal)} · ${grandTotal > 0 ? Math.round(seriesTotal / grandTotal * 100) : 0}%</span>`}</span>
    </label>`;
  }).join("");

  return `
  <section class="stats-chart-section">
    <div class="stats-chart-heading">
      <div><h2 class="stats-chart-title">${t("stats.token_trend")}</h2>
      <p class="stats-chart-help">${t(allowDayDrill ? "stats.token_trend_help" : "stats.token_trend_help_readonly")}</p></div>
      <span class="trend-scale-note${clippedScale ? "" : " hidden"}">${t("stats.peak_compressed")}</span>
    </div>
    <div class="stats-chart-body">
      <div class="trend-legend">${legendItems}</div>
      <p class="stats-scroll-hint">${t("stats.scroll_hint")}</p>
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="chart-svg trend-chart" role="img"
        data-plot-top="${pad.top}" data-plot-height="${ih}" aria-label="${escapeHtml(t("stats.trend_aria"))}">
        ${gridLines}
        ${bars}
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
        <a href="${escapeHtml(hrefWithParams(`/${encodeURIComponent(provider)}/stats`, statsFiltersToParams(filters)))}" class="stats-drill-clear">
          ${t("stats.drill_day_clear")}
        </a>
      </p>`
    : "";

  if (!sessions || sessions.length === 0) {
    return `
    <section class="stats-chart-section" id="stats-session-results" tabindex="-1">
      <h2 class="stats-chart-title">${t("stats.top_sessions")}</h2>
      ${dayInfo}
      <div class="stats-chart-body"><p class="stats-empty">${t("stats.top_sessions_empty")}</p></div>
    </section>`;
  }

  const rows = sessions.map(s => {
    const returnParams = statsFiltersToParams(filters);
    if (safeDay) returnParams.set("day", safeDay);
    const returnTo = hrefWithParams(`/${encodeURIComponent(provider)}/stats`, returnParams, "#stats-session-results");
    const sessionUrl = `/${encodeURIComponent(provider)}/session/${encodeURIComponent(s.sessionId)}?from=${encodeURIComponent(returnTo)}`;
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
  <section class="stats-chart-section" id="stats-session-results" tabindex="-1">
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

/** Render a lazily requested Token Explorer fragment without page chrome. */
export function renderStatsDeferredSection(data: Omit<TokenExplorerData, "providers" | "manageable"> & { dayDrill?: string | null }, section: "secondary" | "advanced") {
  const capabilities: StatsCapabilities = data.capabilities || { customRange: true, project: true, model: true, scope: true, dayDrill: true, composition: true, modelRanking: true, sessionBreakdown: true, coverage: true };
  if (section === "secondary") {
    return `${capabilities.sessionBreakdown ? renderTopSessions(data.topSessions || [], data.provider, data.dayDrill || null, data.filters) : ""}
      ${capabilities.coverage ? renderCoverage(data.coverage || null) : ""}`;
  }
  if (!capabilities.model) return "";
  return `${renderComparison(data.comparison || null, data.filters)}
    ${renderInsights(data.insights || [])}
    ${renderModelCompare(data.compareA || null, data.compareB || null, data.filters, data.provider)}
    ${renderCostEstimate(data.costEstimate || null, data.filters)}`;
}

// ── Main render ─────────────────────────────────────────────────────────────

export function renderStatsPage(data: TokenExplorerData & { dayDrill?: string | null; modelPairs?: Array<{ key: string; model: string; provider: string; totalTokens: number }>; projects?: Array<{ projectId: string; label: string; count: number }> | null; deferredUrl?: string | null }) {
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
  const deferredUrl = data.deferredUrl || null;
  const isGlobal = data.global === true;
  const selectedProviders = data.selectedProviders || [];
  const pagePath = isGlobal ? "/stats" : `/${encodeURIComponent(provider)}/stats`;
  const advancedContent = !deferredUrl && capabilities.model
    ? `${renderComparison(comparison, filters)}${renderInsights(insights)}${renderModelCompare(compareA, compareB, filters, provider)}${renderCostEstimate(costEstimate, filters)}`
    : "";
  const secondaryContent = deferredUrl && !dayDrill
    ? `<div class="stats-deferred-section" data-stats-deferred-url="${escapeHtml(deferredUrl)}" data-stats-deferred-section="secondary" aria-busy="true"><p class="stats-deferred-loading">${escapeHtml(t("stats.loading"))}</p></div>`
    : `${capabilities.sessionBreakdown ? renderTopSessions(safeTopSessions, provider, dayDrill, filters) : ""}
      ${capabilities.coverage ? renderCoverage(safeCoverage) : ""}`;
  const advancedSection = deferredUrl && capabilities.model
    ? `<details class="stats-advanced-details"${filters.compareA && filters.compareB ? " open" : ""}>
        <summary>${escapeHtml(t("stats.advanced_title"))}</summary>
        <div class="stats-advanced-content stats-deferred-section" data-stats-deferred-url="${escapeHtml(deferredUrl)}" data-stats-deferred-section="advanced" aria-busy="true"><p class="stats-deferred-loading">${escapeHtml(t("stats.loading"))}</p></div>
      </details>`
    : advancedContent ? `<details class="stats-advanced-details"${filters.compareA && filters.compareB ? " open" : ""}>
        <summary>${escapeHtml(t("stats.advanced_title"))}</summary>
        <div class="stats-advanced-content">${advancedContent}</div>
      </details>` : "";

  const content = `
    <div class="stats-page">
      <h1 class="stats-title">${t("stats.title")}</h1>
      <p class="stats-desc">${t("stats.desc")}</p>

      <div class="stats-provider-bar">
        <span class="stats-provider-label">${t("stats.provider")}:</span>
        ${isGlobal ? `<form class="stats-provider-list stats-provider-selector" action="/stats" method="GET">
          ${[...statsFiltersToParams(filters).entries()].filter(([key]) => !["project", "model", "scope", "comparea", "compareb"].includes(key)).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("")}
          ${(providers || []).map((p: any) => `<label class="stats-provider-item${p.available === false ? " disabled" : ""}">
            <input type="checkbox" name="provider" value="${escapeHtml(p.id)}" ${selectedProviders.includes(p.id) ? "checked" : ""} ${p.available === false ? "disabled" : ""}>
            <span>${escapeHtml(p.name || p.id)}</span>
          </label>`).join("")}
          <button class="stats-filter-btn stats-filter-apply" type="submit">${escapeHtml(t("stats.filter_apply"))}</button>
        </form>` : `<div class="stats-provider-list">
          ${(providers || []).map((p: any) => {
            const isCurrent = p.id === provider;
            const className = `stats-provider-item${isCurrent ? " current" : ""}${p.available === false ? " disabled" : ""}`;
            if (p.available === false) {
              return `<span class="${className}" aria-disabled="true">${escapeHtml(p.name || p.id)}</span>`;
            }
            return `<a href="/stats?provider=${encodeURIComponent(p.id)}&${rangeQuery}" class="${className}"${isCurrent ? ' aria-current="page"' : ""}>${escapeHtml(p.name || p.id)}</a>`;
          }).join("")}
        </div>`}
      </div>

      ${renderFilterBar(filters, modelPairs, provider, projects, capabilities, providers, pagePath, selectedProviders)}

      <div class="stats-export-bar">
        <a href="${isGlobal ? "/api/stats/export.json" : `/api/${encodeURIComponent(provider)}/stats/export.json`}?${isGlobal ? selectedProviders.map((id) => `provider=${encodeURIComponent(id)}`).join("&") + (exportQuery ? "&" : "") : ""}${exportQuery}" class="stats-export-link" download>${t("stats.export_json")}</a>
        ${isGlobal ? "" : `<a href="/api/${encodeURIComponent(provider)}/stats/export.csv?${exportQuery}" class="stats-export-link" download>${t("stats.export_csv")}</a>`}
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

      ${renderProviderBreakdown(data.providerBreakdown || [], safeOverview.totalTokens, filters)}

      ${renderTokenTrend(safeTokenStats, filters, provider, safeCoverage?.missingDimensions ?? [], capabilities.dayDrill, capabilities.composition, dayDrill)}

      ${dayDrill ? secondaryContent : ""}

      ${capabilities.modelRanking ? renderModelRanking(safeModelRanking, safeOverview.totalTokens, filters, provider) : ""}

      ${dayDrill ? "" : secondaryContent}

      ${advancedSection}
    </div>
  `;

  return layout(t("stats.title"), content, "stats", { provider: isGlobal ? null : provider, providers, manageable: manageable === true });
}
