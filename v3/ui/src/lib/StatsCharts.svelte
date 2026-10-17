<script lang="ts">
  import type { StatsReport, ProviderSummary } from './api';
  import { language, t } from './i18n';

  export let report: StatsReport;
  export let providers: ProviderSummary[];
  export let onDay: (day: string) => void;
  export let selectedDay: string | null = null;
  let metric: 'requests' | 'tokens' = 'tokens';
  $: rows = report.dailyUsage;
  $: sources = report.sources ?? [];
  $: maximum = Math.max(1, ...rows.map(row => metric === 'requests' ? row.recordedRequestCount : row.knownTokenCount));
  $: comparisonMaximum = Math.max(1, ...sources.map(row => row.overview ? metricValue(row.overview) : 0));
  $: readable = sources.filter(row => row.status === 'readable').length;
  $: unknownOnly = report.overview.recordedRequestCount > 0 && report.overview.unknownTokenRequestCount === report.overview.recordedRequestCount;
  $: modelRows = [...report.modelRanking].sort((a, b) => metricValue(b) - metricValue(a));
  $: leadingModel = modelRows.find(row => row.model !== null);
  $: leadingHarness = [...sources].filter(row => row.overview).sort((a, b) => metricValue(b.overview!) - metricValue(a.overview!))[0];
  $: metricValue = (row: { recordedRequestCount: number; knownTokenCount: number }): number =>
    metric === 'tokens' ? row.knownTokenCount : row.recordedRequestCount;
  $: share = (value: number): string => {
    const total = metricValue(report.overview);
    return total ? (value / total * 100).toFixed(1) + '%' : '—';
  };
  const width = 920;
  const height = 240;
  const baseline = 194;
  $: slot = 848 / Math.max(1, rows.length);
  $: count = (value: number) => new Intl.NumberFormat($language === 'zh' ? 'zh-CN' : 'en', { notation: value >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
  $: dayLabel = (row: StatsReport['dailyUsage'][number]): string => {
    return `${row.day}: ${count(row.recordedRequestCount)} ${t($language, 'requests')}, ${count(row.knownTokenCount)} ${t($language, 'known tokens')}, ${count(row.unknownTokenRequestCount)} ${t($language, 'unknown')}, ${count(row.unresolvedUsageObservationCount)} ${t($language, 'unresolved observations')}`;
  };
  function keyDay(event: KeyboardEvent, day: string): void {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onDay(day); }
  }
</script>

<div class="usage-charts">
  <section class="usage-trend" aria-label={t($language, 'Daily usage trend')}>
    <div class="chart-heading">
      <div><p class="chart-kicker">{t($language, 'Over time')}</p><h2>{t($language, 'Daily usage trend')}</h2></div>
      <div class="chart-metrics" role="group" aria-label={t($language, 'Chart metric')}>
        <button type="button" aria-pressed={metric === 'requests'} onclick={() => metric = 'requests'}>{t($language, 'Requests')}</button>
        <button type="button" aria-pressed={metric === 'tokens'} onclick={() => metric = 'tokens'}>{t($language, 'Known tokens')}</button>
      </div>
    </div>
    <p class="chart-caption">{metric === 'requests' ? t($language, 'Recorded requests by UTC day. Shaded portions have unknown token totals.') : t($language, 'Known token subtotal by UTC day. Missing totals are excluded.')}</p>
    {#if metric === 'tokens' && unknownOnly}
      <p class="unknown-state">{t($language, 'Token totals are unknown for every recorded request in this selection.')}</p>
    {/if}
    {#if readable === 0}
      <p class="unknown-state">{t($language, 'No selected Harness source could be read. Usage totals are unavailable.')}</p>
    {:else}
      <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t($language, metric === 'requests' ? 'Daily recorded requests chart' : 'Daily known token subtotal chart')}>
        <defs><pattern id="stats-unknown-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="currentColor" opacity=".32"/><path d="M0 0 V5" stroke="currentColor" stroke-width="2"/></pattern></defs>
        {#each [0, .5, 1] as tick}
          <line x1="48" x2="900" y1={baseline - tick * 158} y2={baseline - tick * 158} class="chart-grid"/>
          <text x="38" y={baseline - tick * 158 + 4} text-anchor="end" class="axis-text">{count(maximum * tick)}</text>
        {/each}
        {#each rows as row, index (row.day)}
          {@const value = metric === 'requests' ? row.recordedRequestCount : row.knownTokenCount}
          {@const barHeight = value / maximum * 158}
          {@const unknownHeight = metric === 'requests' ? row.unknownTokenRequestCount / maximum * 158 : 0}
          <g role="button" tabindex="0" aria-label={dayLabel(row)} aria-expanded={selectedDay === row.day}
            aria-controls={selectedDay === row.day ? 'stats-selected-day' : undefined} data-day={row.day}
            onclick={() => onDay(row.day)} onkeydown={(event) => keyDay(event, row.day)} class="chart-day stats-day-toggle">
            <title>{dayLabel(row)}</title>
            <rect x={52 + index * slot} y="30" width={Math.max(2, slot - 3)} height="172" fill="transparent"/>
            <rect x={52 + index * slot} y={baseline - barHeight} width={Math.max(2, slot - 3)} height={barHeight} rx="2" class="chart-bar"/>
            {#if unknownHeight > 0}<rect x={52 + index * slot} y={baseline - barHeight} width={Math.max(2, slot - 3)} height={unknownHeight} fill="url(#stats-unknown-hatch)" class="unknown-bar"/>{/if}
            {#if row.unresolvedUsageObservationCount > 0}<circle cx={52 + index * slot + Math.max(2, slot - 3) / 2} cy="205" r="2.5" class="observation-dot"/>{/if}
          </g>
          {#if index === 0 || index === rows.length - 1 || (index > 0 && index % Math.max(1, Math.ceil(rows.length / 6)) === 0)}
            <text x={52 + index * slot + slot / 2} y="228" text-anchor="middle" class="axis-text">{row.day.slice(5)}</text>
          {/if}
        {/each}
      </svg>
      <div class="chart-legend"><span><i class="legend-known"></i>{t($language, metric === 'requests' ? 'Recorded requests' : 'Known token subtotal')}</span>{#if metric === 'requests'}<span><i class="legend-unknown"></i>{t($language, 'Requests with unknown total')}</span>{/if}<span><i class="legend-observation"></i>{t($language, 'Unresolved observations')}</span></div>
      <p class="chart-help">{t($language, 'Choose a day to inspect its sessions below.')}</p>
    {/if}
  </section>
  <section class="usage-comparison" aria-label={t($language, 'Usage by Harness')}>
    <div class="chart-heading"><div><p class="chart-kicker">{t($language, 'Across Harnesses')}</p><h2>{t($language, 'Usage by Harness')}</h2></div></div>
    <p class="chart-caption">{t($language, metric === 'tokens' ? 'Known token subtotals by Harness. Missing totals are excluded.' : 'Recorded requests with known token subtotals and missing totals.')}</p>
    {#each sources as source (source.provider)}
      <div class="harness-comparison-row" data-harness={source.provider}>
        <div class="harness-comparison-title"><strong>{providers.find(item => item.id === source.provider)?.name || source.provider}</strong><span>{source.overview ? `${count(metricValue(source.overview))} ${t($language, metric === 'tokens' ? 'known tokens' : 'requests')}` : t($language, source.status === 'failed' ? 'Source could not be read' : 'Unavailable')}</span></div>
        {#if source.overview}
          <div class="comparison-track" role="img" aria-label={`${source.provider}: ${count(metricValue(source.overview))} ${t($language, metric === 'tokens' ? 'known tokens' : 'requests')}`}><div class="comparison-fill" style:width={(metricValue(source.overview) / comparisonMaximum * 100) + '%'}></div></div>
        <p class="comparison-detail">{share(metricValue(source.overview))} · {count(source.overview.recordedRequestCount)} {t($language, 'requests')} · {count(source.overview.knownTokenCount)} {t($language, 'known tokens')} · {count(source.overview.unknownTokenRequestCount)} {t($language, 'unknown totals')} · {count(source.overview.unresolvedUsageObservationCount)} {t($language, 'unresolved')}</p>
        {:else}
          <p class="comparison-detail">{t($language, 'Excluded from totals.')}</p>
        {/if}
      </div>
    {/each}
  </section>
</div>

{#if readable > 0 && report.insights}
  <section class="usage-insights" aria-label={t($language, 'Usage insights')}>
    <div class="chart-heading"><div><p class="chart-kicker">{t($language, 'What the records show')}</p><h2>{t($language, 'Usage insights')}</h2></div></div>
    <p class="chart-caption">{t($language, 'Model and Harness shares follow the selected metric. Activity comparisons use recorded requests.')}</p>
    <div class="insight-grid">
      <article><h3>{t($language, 'Recent request activity')}</h3>
        {#if report.insights.recentWeekRequests !== null && report.insights.precedingWeekRequests !== null}
          {@const difference = report.insights.recentWeekRequests - report.insights.precedingWeekRequests}
          <strong>{difference > 0 ? '+' : ''}{count(difference)} {t($language, 'requests')}</strong>
          <p>{count(report.insights.recentWeekRequests)} vs {count(report.insights.precedingWeekRequests)} · {t($language, 'two complete UTC weeks')}</p>
          <small>{report.insights.recentWeekFrom}–{report.insights.recentWeekTo}<br/>{t($language, 'compared with')} {report.insights.precedingWeekFrom}–{report.insights.precedingWeekTo}</small>
        {:else}<p>{t($language, 'Select at least 14 complete UTC days to compare recent weeks.')}</p>{/if}
      </article>
      <article><h3>{t($language, 'Most-used recorded model')}</h3>
        {#if leadingModel && metricValue(leadingModel) > 0}<strong class="model-insight">{leadingModel.modelProvider ? leadingModel.modelProvider + ' · ' : ''}{leadingModel.model}</strong><p>{count(metricValue(leadingModel))} {t($language, metric === 'tokens' ? 'known tokens' : 'requests')} · {share(metricValue(leadingModel))}</p>{:else}<p>{t($language, 'No model attribution was recorded.')}</p>{/if}
        <small>{count(report.insights.unattributedModelRequests)} {t($language, metric === 'tokens' ? 'requests have no recorded model. Token shares include their known totals.' : 'requests have no recorded model. Shares include these requests.')}</small>
      </article>
      <article><h3>{t($language, 'Most-used Harness')}</h3>
        {#if leadingHarness?.overview && metricValue(leadingHarness.overview) > 0}<strong>{providers.find(row => row.id === leadingHarness.provider)?.name || leadingHarness.provider}</strong><p>{count(metricValue(leadingHarness.overview))} {t($language, metric === 'tokens' ? 'known tokens' : 'requests')} · {share(metricValue(leadingHarness.overview))}</p>{:else}<p>{t($language, metric === 'tokens' ? 'No known token totals' : 'No recorded requests')}</p>{/if}
        <small>{count(report.insights.activeDays)} / {count(report.insights.selectedDays)} {t($language, 'days with recorded requests')}</small>
      </article>
      <article><h3>{t($language, 'High-request days')}</h3><strong>{count(report.insights.unusualDays.length)}</strong>
        <p>{t($language, 'Above twice the selected-range daily average:')} {(report.insights.averageDailyRequests * 2).toFixed(1)} {t($language, 'requests')}</p>
        <small>{t($language, 'Requires at least 7 days; zero-activity days are included in the average.')}</small>
        <div class="unusual-days">{#each report.insights.unusualDays as day}<button type="button" onclick={() => onDay(day)}>{day} · {count(rows.find(row => row.day === day)?.recordedRequestCount ?? 0)}</button>{/each}</div>
      </article>
    </div>
  </section>
{/if}

<section class="model-distribution" aria-label={t($language, 'Recorded model distribution')}>
  <div class="chart-heading"><div><p class="chart-kicker">{t($language, 'Model usage')}</p><h2>{t($language, 'Recorded model distribution')}</h2></div></div>
  <p class="chart-caption">{t($language, metric === 'tokens' ? 'Share of known tokens, including tokens with no model attribution.' : 'Share of recorded requests, including requests with no model attribution.')}</p>
  {#if readable === 0}<p class="unknown-state">{t($language, 'No selected Harness source could be read. Usage totals are unavailable.')}</p>
  {:else if modelRows.length === 0}<p class="comparison-detail">{t($language, 'No request usage was recorded in this range.')}</p>{/if}
  {#each modelRows as row (JSON.stringify([row.modelProvider, row.model]))}
    <div class="model-distribution-row"><span>{row.modelProvider ? row.modelProvider + ' · ' : ''}{row.model ?? t($language, 'Model not recorded')}</span>
      <div class="comparison-track"><div class="comparison-fill" style:width={share(metricValue(row)) === '—' ? '0%' : share(metricValue(row))}></div></div>
      <strong>{share(metricValue(row))}</strong><small>{count(row.recordedRequestCount)} {t($language, 'requests')} · {count(row.knownTokenCount)} {t($language, 'known tokens')} · {count(row.unknownTokenRequestCount)} {t($language, 'unknown totals')}</small>
    </div>
  {/each}
</section>

<style>
  .usage-charts { display:grid; grid-template-columns:minmax(0,1.65fr) minmax(280px,1fr); gap:20px; margin:26px 0; }
  section { min-width:0; padding:22px 24px; border:1px solid var(--line); border-radius:14px; background:var(--paper); }
  .chart-heading { display:flex; justify-content:space-between; gap:12px; align-items:center; }
  .chart-kicker { margin:0 0 5px; font-size:11px; font-weight:650; letter-spacing:.09em; text-transform:uppercase; color:var(--muted); }
  h2 { margin:0; font-size:19px; letter-spacing:-.02em; }
  .chart-caption,.chart-help,.comparison-detail { color:var(--muted); font-size:12px; line-height:1.55; }
  .chart-caption { min-height:36px; margin:12px 0 8px; }
  .chart-metrics { display:flex; border:1px solid var(--line); border-radius:7px; padding:2px; }
  .chart-metrics button { background:transparent; color:var(--muted); border:0; padding:6px 9px; font:inherit; font-size:12px; border-radius:5px; cursor:pointer; white-space:nowrap; }
  .chart-metrics button[aria-pressed="true"] { background:var(--blue-pale); color:var(--blue); }
  svg { width:100%; display:block; overflow:visible; margin-top:6px; }
  .chart-grid { stroke:var(--line); stroke-width:1; }
  .axis-text { font-size:11px; fill:var(--muted); }
  .chart-bar,.comparison-fill { fill:var(--blue); background:var(--blue); }
  .unknown-bar { color:var(--ink); }
  .observation-dot { fill:#bf8127; }
  .chart-day { cursor:pointer; }
  .chart-day:hover .chart-bar,.chart-day:focus .chart-bar { opacity:.65; }
  .chart-day:focus { outline:2px solid var(--blue); outline-offset:2px; }
  .chart-legend { display:flex; flex-wrap:wrap; gap:8px 16px; font-size:11px; color:var(--muted); }
  .chart-legend span { display:inline-flex; align-items:center; gap:6px; }
  .chart-legend i { display:inline-block; width:9px; height:9px; border-radius:2px; }
  .legend-known { background:var(--blue); }.legend-unknown { background:repeating-linear-gradient(45deg,var(--muted),var(--muted) 1px,transparent 1px,transparent 3px); }.legend-observation { background:#bf8127; border-radius:50%!important; }
  .chart-help { margin:12px 0 0; }
  .unknown-state { padding:10px 12px; background:var(--blue-pale); border-radius:7px; font-size:13px; line-height:1.5; }
  .harness-comparison-row { padding:13px 0; border-top:1px solid var(--line); }
  .harness-comparison-title { display:flex; justify-content:space-between; gap:12px; align-items:baseline; font-size:12px; }
  .harness-comparison-title strong { font-size:13px; }.harness-comparison-title span { color:var(--muted); white-space:nowrap; }
  .comparison-track { height:7px; background:var(--line); border-radius:8px; margin-top:9px; overflow:hidden; }.comparison-fill { height:100%; border-radius:8px; }
  .comparison-detail { margin:6px 0 0; font-size:11px; }
  .usage-insights,.model-distribution { margin:20px 0; }
  .insight-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:22px; }
  .insight-grid article { padding:10px 0; min-width:0; }
  h3 { font-size:12px; font-weight:550; color:var(--muted); margin:0 0 10px; }
  article>strong { display:block; font-size:25px; line-height:1.3; letter-spacing:-.03em; overflow-wrap:anywhere; }
  article>strong.model-insight { font-size:17px; }
  article p { font-size:12px; line-height:1.6; margin:9px 0; } article small { color:var(--muted); font-size:11px; line-height:1.6; }
  .unusual-days { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }.unusual-days button { padding:4px 6px; background:var(--amber-pale); color:var(--amber); border:0; border-radius:4px; font:inherit; font-size:11px; cursor:pointer; }
  .model-distribution-row { display:grid; grid-template-columns:minmax(200px,1fr) minmax(160px,2fr) 60px minmax(160px,1fr); gap:16px; align-items:center; margin:14px 0; font-size:12px; }
  .model-distribution-row .comparison-track { margin:0; }.model-distribution-row small { color:var(--muted); font-size:11px; }
</style>
