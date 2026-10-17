<script lang="ts">
  import { onMount } from 'svelte';
  import { getStats, statsExportUrl, type ProviderSummary, type SessionRef,
    type StatsDays, type StatsReport } from './api';
  import { language, t, type Language } from './i18n';
  import StatsCharts from './StatsCharts.svelte';

  export let providers: ProviderSummary[] = [];
  export let provider: string;
  export let onSelectProvider: (provider: string) => void;
  export let onOpen: (session: SessionRef) => void;

  $: selectedProviders = provider === 'all' ? providers.map(item => item.id) : provider.split(',').filter(Boolean);
  $: singleOpenCode = selectedProviders.length === 1 && selectedProviders[0] === 'opencode';
  let harnessOpen = false;

  let days: StatsDays = '30';
  let from = '';
  let to = '';
  let scope: 'all' | 'root' = 'all';
  let directory = '';
  let model = '';
  let modelProvider: string | undefined;
  let selectedModelKey = '';
  let project = '';
  let appliedFrom = '';
  let appliedTo = '';
  let selectedDay: string | null = null;
  let dayDrill: StatsReport['dailyUsage'][number] | null = null;
  let dayDrillLoading = false;
  let dayDrillError = '';
  let dayDrillNeedsRefresh = false;
  let report: StatsReport | null = null;
  let availableDirectories: string[] = [];
  let availableModels: StatsReport['availableModels'] = [];
  let availableProjects: string[] = [];
  let loading = false;
  let error = '';
  let generation = 0;
  let dayDrillGeneration = 0;
  let loadedProvider = provider;

  onMount(() => { void load(); });
  $: if (provider !== loadedProvider) {
    ++generation;
    report = null;
    availableDirectories = [];
    availableModels = [];
    availableProjects = [];
    loading = false;
    error = '';
    scope = 'all';
    directory = '';
    model = '';
    modelProvider = undefined;
    project = '';
    ++dayDrillGeneration;
    selectedDay = null;
    dayDrill = null;
    dayDrillLoading = false;
    dayDrillError = '';
    dayDrillNeedsRefresh = false;
    loadedProvider = provider;
    void load();
  }

  async function load(): Promise<void> {
    if (!provider || (days === 'custom' && (!appliedFrom || !appliedTo))) return;
    const request = ++generation;
    loading = true;
    error = '';
    try {
      const next = await getStats(selectedProviders, days, appliedFrom, appliedTo, scope, directory, model, project, '', modelProvider);
      if (request === generation) {
        report = next;
        availableDirectories = next.availableDirectories;
        availableModels = next.availableModels;
        availableProjects = next.availableProjects;
        if (selectedDay && next.dailyUsage.some(row => row.day === selectedDay)) {
          void loadDay(selectedDay);
        } else if (selectedDay) {
          ++dayDrillGeneration;
          selectedDay = null;
          dayDrill = null;
          dayDrillLoading = false;
          dayDrillError = '';
          dayDrillNeedsRefresh = false;
        }
      }
    } catch (cause) {
      if (request === generation) error = cause instanceof Error ? cause.message : t($language, 'Statistics could not be loaded.');
    } finally {
      if (request === generation) loading = false;
    }
  }

  function chooseDays(event: Event): void {
    days = (event.currentTarget as HTMLSelectElement).value as StatsDays;
    if (days === 'custom') {
      ++generation;
      report = null;
      loading = false;
      error = '';
    }
    else void load();
  }

  function chooseScope(event: Event): void {
    scope = (event.currentTarget as HTMLSelectElement).value as 'all' | 'root';
    void load();
  }

  function chooseDirectory(event: Event): void {
    directory = (event.currentTarget as HTMLSelectElement).value;
    void load();
  }

  function chooseModel(event: Event): void {
    selectedModelKey = (event.currentTarget as HTMLSelectElement).value;
    const selected = availableModels.find(option => modelKey(option.model, option.modelProvider) === selectedModelKey);
    model = selected?.model ?? '';
    modelProvider = selected ? (selected.modelProvider ?? '') : undefined;
    void load();
  }

  function modelKey(name: string | null, source?: string): string {
    return JSON.stringify([source ?? null, name]);
  }

  function modelLabel(name: string, source?: string): string {
    return source ? `${source} · ${name}` : name;
  }

  function chooseProject(event: Event): void {
    project = (event.currentTarget as HTMLSelectElement).value;
    void load();
  }

  function toggleDay(day: string): void {
    ++dayDrillGeneration;
    dayDrill = null;
    dayDrillLoading = false;
    dayDrillError = '';
    dayDrillNeedsRefresh = false;
    selectedDay = selectedDay === day ? null : day;
    if (selectedDay) void loadDay(selectedDay);
  }

  async function loadDay(day: string): Promise<void> {
    const request = ++dayDrillGeneration;
    dayDrillLoading = true;
    dayDrillError = '';
    dayDrillNeedsRefresh = false;
    try {
      const next = await getStats(selectedProviders, days, appliedFrom, appliedTo, scope,
        directory, model, project, day, modelProvider);
      if (request === dayDrillGeneration && selectedDay === day) {
        if (!report || next.revision !== report.revision) {
          dayDrill = null;
          dayDrillError = t($language,
            'The source changed after this report was loaded. Refresh the report to retry this day.');
          dayDrillNeedsRefresh = true;
        } else {
          dayDrill = next.dailyUsage.find(row => row.day === day) ?? null;
        }
      }
    } catch (cause) {
      if (request === dayDrillGeneration && selectedDay === day) {
        dayDrillError = cause instanceof Error ? cause.message : t($language, 'Statistics could not be loaded.');
      }
    } finally {
      if (request === dayDrillGeneration) dayDrillLoading = false;
    }
  }

  function applyCustom(event: SubmitEvent): void {
    event.preventDefault();
    appliedFrom = from;
    appliedTo = to;
    void load();
  }

  function toggleHarness(id: string): void {
    const next = selectedProviders.includes(id)
      ? selectedProviders.filter(item => item !== id) : [...selectedProviders, id];
    if (next.length) onSelectProvider(next.length === providers.length ? 'all' : next.join(','));
  }

  function openSession(event: MouseEvent, session: SessionRef): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(session);
  }

  function count(value: number): string {
    return new Intl.NumberFormat($language === 'zh' ? 'zh-CN' : 'en').format(value);
  }

  const costDimensions: Record<string, string> = {
    input: 'Input', output: 'Output', reasoning: 'Reasoning',
    cacheRead: 'Cache read', cacheWrite: 'Cache write',
    'cache-read': 'Cache read', 'cache-write': 'Cache write',
  };

  function costDimension(dimension: string, selectedLanguage: Language): string {
    return t(selectedLanguage, costDimensions[dimension] || dimension);
  }

  $: topSessions = report?.sessions.filter(row => row.recordedRequestCount > 0
    || row.unresolvedUsageObservationCount > 0)
    .sort((left, right) => right.knownTokenCount - left.knownTokenCount
      || right.recordedRequestCount - left.recordedRequestCount
      || right.unresolvedUsageObservationCount - left.unresolvedUsageObservationCount
      || left.session.sessionId.localeCompare(right.session.sessionId)).slice(0, 20) ?? [];
  $: selectedModelKey = model ? modelKey(model, modelProvider || undefined) : '';
  $: noReadableSources = !!report?.sources?.length && !report.sources.some(row => row.status === 'readable');
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') harnessOpen = false; }} />

<main class="stats-page" aria-label={t($language, 'Token statistics')}>
  <div class="stats-intro">
    <p class="eyebrow">{t($language, 'Recorded usage')}</p>
    <h1>{t($language, 'Token statistics')}</h1>
    <p>{t($language, 'Inspect recorded token usage and requests. Days use UTC.')}</p>
  </div>

  <div class="stats-toolbar">
    <div class="harness-filter">
      <span class="harness-label">Harness</span>
      <button type="button" class="harness-trigger" aria-expanded={harnessOpen} aria-controls="stats-harness-options"
        onclick={() => harnessOpen = !harnessOpen}>
        {selectedProviders.length === providers.length ? t($language, 'All Harnesses') : `${selectedProviders.length} ${t($language, 'selected')}`} <span aria-hidden="true">⌄</span>
      </button>
      {#if harnessOpen}
        <fieldset id="stats-harness-options" class="harness-options">
          <legend>{t($language, 'Select Harnesses')}</legend>
          <button type="button" onclick={() => onSelectProvider('all')}>{t($language, 'Select all')}</button>
          {#each providers as item (item.id)}
            <label><input type="checkbox" checked={selectedProviders.includes(item.id)}
              disabled={selectedProviders.length === 1 && selectedProviders.includes(item.id)}
              onchange={() => toggleHarness(item.id)} />
              <span>{item.name || item.id}{!item.available ? ` · ${t($language, 'Unavailable')}` : ''}</span>
            </label>
          {/each}
          <button type="button" onclick={() => harnessOpen = false}>{t($language, 'Done')}</button>
        </fieldset>
      {/if}
    </div>
    {#if singleOpenCode}
      <label>{t($language, 'Project ID')}
        <select aria-label={t($language, 'Project ID')} bind:value={project} onchange={chooseProject}>
          <option value="">{t($language, 'All projects')}</option>
          {#each availableProjects as option (option)}
            <option value={option}>{option === '__opensession_empty_project__' ? t($language, 'Unassigned project') : option}</option>
          {/each}
        </select>
      </label>
    {/if}
    <label>{t($language, 'Working directory')}
      <select aria-label={t($language, 'Working directory')} bind:value={directory} onchange={chooseDirectory}>
        <option value="">{t($language, 'All working directories')}</option>
        {#each availableDirectories as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </label>
    <label>{t($language, 'Request model')}
      <select aria-label={t($language, 'Request model')} bind:value={selectedModelKey} onchange={chooseModel}>
        <option value="">{t($language, 'All recorded models')}</option>
        {#if model && !availableModels.some(option => modelKey(option.model, option.modelProvider) === selectedModelKey)}
          <option value={selectedModelKey}>{modelLabel(model, modelProvider)}</option>
        {/if}
        {#each availableModels as option (modelKey(option.model, option.modelProvider))}
          <option value={modelKey(option.model, option.modelProvider)}>{modelLabel(option.model, option.modelProvider)}</option>
        {/each}
      </select>
    </label>
    {#if singleOpenCode}
      <label>{t($language, 'Session scope')}
        <select aria-label={t($language, 'Session scope')} bind:value={scope} onchange={chooseScope}>
          <option value="all">{t($language, 'All sessions')}</option>
          <option value="root">{t($language, 'Root sessions')}</option>
        </select>
      </label>
    {/if}
    <label>{t($language, 'Date range')}
      <select aria-label={t($language, 'Date range')} bind:value={days} onchange={chooseDays}>
        <option value="7">{t($language, 'Last 7 days')}</option>
        <option value="30">{t($language, 'Last 30 days')}</option>
        <option value="90">{t($language, 'Last 90 days')}</option>
        <option value="custom">{t($language, 'Custom UTC range')}</option>
      </select>
    </label>
    {#if days === 'custom'}
      <form class="stats-custom-range" onsubmit={applyCustom}>
        <label>{t($language, 'From')} <input aria-label={t($language, 'From UTC date')} type="date" bind:value={from} required /></label>
        <label>{t($language, 'To')} <input aria-label={t($language, 'To UTC date')} type="date" bind:value={to} required /></label>
        <button type="submit">{t($language, 'Apply')}</button>
      </form>
    {/if}
    {#if report && !loading}
      <div class="stats-downloads">
        <a href={statsExportUrl(selectedProviders, 'csv', days, appliedFrom, appliedTo, scope, directory, model, project, modelProvider)} download>{t($language, 'Download CSV')}</a>
        <a href={statsExportUrl(selectedProviders, 'json', days, appliedFrom, appliedTo, scope, directory, model, project, modelProvider)} download>{t($language, 'Download JSON')}</a>
      </div>
    {/if}
  </div>

  {#if loading}
    <p class="stats-status" aria-live="polite">{t($language, 'Reading recorded requests…')}</p>
  {:else if error}
    <div class="stats-status" role="alert"><p>{error}</p><button onclick={() => void load()}>{t($language, 'Try again')}</button></div>
  {:else if report}
    <p class="stats-coverage">{report.coverage === 'partial' ? t($language, 'Partial source coverage') : report.coverage} ·
      {report.usageCoverage === 'not-observed' ? t($language, 'No request usage observed') : t($language, 'Request usage is incomplete where source records are missing')}.
      {t($language, 'Unknown totals remain unknown.')}</p>
    {#if report.overview.excludedSourceSessionCount > 0}
      <div class="stats-exclusions" role="status">
        <p><strong>{count(report.overview.excludedSourceSessionCount)}</strong> {t($language, 'source session(s) excluded from the totals because their history is unavailable. Request and token totals cover readable sessions only. Excluded sessions cannot be assigned to a request model or UTC day.')}</p>
      </div>
    {/if}
    <div class="stats-kpis">
      <article class="stats-known-tokens"><span>{t($language, 'Known token subtotal')}</span><strong>{noReadableSources ? '—' : count(report.overview.knownTokenCount)}</strong></article>
      <article><span>{t($language, 'Included sessions')}</span><strong>{noReadableSources ? '—' : count(report.overview.totalSessions)}</strong></article>
      <article><span>{t($language, 'Recorded requests')}</span><strong>{noReadableSources ? '—' : count(report.overview.recordedRequestCount)}</strong></article>
      <article class="stats-unknown-requests"><span>{t($language, 'Requests with unknown total')}</span><strong>{noReadableSources ? '—' : count(report.overview.unknownTokenRequestCount)}</strong></article>
    </div>
    {#if !noReadableSources}
    <p class="stats-note">{count(report.overview.unresolvedUsageObservationCount)} {t($language, 'usage observation(s) have no proved request identity. Verified token increments are included in known tokens.')}</p>
    {#if report.usageRange.model}
      <p class="stats-note">{t($language, 'The model filter narrows attributed requests and token consumption. Observation counts retain the selected source, date, directory, project, and session filters.')}</p>
    {/if}
    {#if report.overview.untimedRequestCount > 0}
      <p class="stats-note">{count(report.overview.untimedRequestCount)} {t($language, 'request(s) have no recorded time and cannot be assigned to a UTC day.')}</p>
    {/if}
    {/if}
    <StatsCharts {report} {providers} {selectedDay} onDay={toggleDay} />
    {#if selectedDay}
          <div class="stats-day-drill" id="stats-selected-day">
            <h3>{t($language, 'Sessions with usage on')} {selectedDay}</h3>
            {#if dayDrillLoading}
              <p class="stats-status" aria-live="polite">{t($language, 'Reading recorded requests…')}</p>
            {:else if dayDrillError}
              <div class="stats-status" role="alert"><p>{dayDrillError}</p><button onclick={() => dayDrillNeedsRefresh ? void load() : void loadDay(selectedDay)}>{t($language, dayDrillNeedsRefresh ? 'Refresh report' : 'Try again')}</button></div>
            {:else if !dayDrill || dayDrill.sessions.length === 0}
              <p class="stats-note">{t($language, 'No request usage or unresolved observations match the current filters for this day.')}</p>
            {:else}
              <div class="stats-day-drill-head" aria-hidden="true">
                <span>{t($language, 'Session ID')}</span><span>{t($language, 'Requests')}</span>
                <span>{t($language, 'Known token subtotal')}</span><span>{t($language, 'Unknown totals and unresolved observations')}</span>
              </div>
              {#each dayDrill.sessions as item (item.session.provider + ':' + item.session.sessionId)}
                <a class="stats-day-session-row"
                  href={'/' + encodeURIComponent(item.session.provider) + '/session/' + encodeURIComponent(item.session.sessionId)}
                  onclick={(event) => openSession(event, item.session)}>
                  <span>{item.session.provider} · {item.session.sessionId}</span>
                  <span>{count(item.recordedRequestCount)}</span>
                  <span>{count(item.knownTokenCount)}</span>
                  <span>{count(item.unknownTokenRequestCount)} {t($language, 'unknown')} · {count(item.unresolvedUsageObservationCount)} {t($language, 'unresolved')}</span>
                </a>
              {/each}
            {/if}
          </div>
    {/if}
    <details class="statistics-details">
      <summary>{t($language, 'Statistics details')}</summary>
    {#if !noReadableSources}
    <section class="stats-section stats-cost" aria-label={t($language, 'Cost estimate')}>
      <h2>{t($language, 'Cost estimate')}</h2>
      {#if !report.usageRange.model}
        <p>{t($language, 'Select one recorded model provider and model to estimate cost.')}</p>
      {:else if !report.usageRange.modelProvider}
        <p>{t($language, 'The model provider is not recorded for this selection, so its pricing key is unknown.')}</p>
      {:else if !report.costEstimate}
        <p>{t($language, 'No pricing is configured for this model. Add rates in Settings.')}</p>
      {:else}
        <p class="stats-note">{t($language, 'Estimate from your rates and recorded token dimensions.')}</p>
        <p class="stats-cost-total"><strong>{report.costEstimate.totalCost === null
          ? t($language, 'No priced token dimensions are recorded for this selection.')
          : `${report.costEstimate.currency} ${report.costEstimate.totalCost.toFixed(4)}`}</strong></p>
        {#if report.costEstimate.sourceLabel || report.costEstimate.sourceUrl || report.costEstimate.asOf}
          <p class="stats-note">{report.costEstimate.sourceLabel}
            {#if report.costEstimate.sourceUrl}<a href={report.costEstimate.sourceUrl} target="_blank" rel="noopener noreferrer">{t($language, 'Pricing source')}</a>{/if}
            {#if report.costEstimate.asOf}<span>{t($language, 'As of')} {report.costEstimate.asOf}</span>{/if}
          </p>
        {/if}
        <table>
          <thead><tr><th>{t($language, 'Dimension')}</th><th>{t($language, 'Tokens')}</th><th>{t($language, 'Amount')}</th></tr></thead>
          <tbody>{#each Object.entries(report.costEstimate.breakdown) as [dimension, item] (dimension)}
            {#if item}<tr><td>{costDimension(dimension, $language)}</td><td>{count(item.tokens)}</td><td>{report.costEstimate.currency} {item.cost.toFixed(4)}</td></tr>{/if}
          {/each}</tbody>
        </table>
        {#if report.costEstimate.omittedDimensions.length}
          <p class="stats-note">{t($language, 'Dimensions omitted because token evidence or a rate is missing:')} {report.costEstimate.omittedDimensions.map(dimension => costDimension(dimension, $language)).join(', ')}</p>
        {/if}
      {/if}
    </section>
    <section class="stats-section" aria-label={t($language, 'Sessions with usage evidence')}>
      <div class="stats-section-heading"><h2>{t($language, 'Sessions with usage evidence')}</h2><p>{t($language, 'Showing up to 20 sessions by known token subtotal.')}</p></div>
      {#if topSessions.length === 0}
        <p class="stats-note">{t($language, 'No request usage or unresolved observations were recorded in this range.')}</p>
      {:else}
        {#each topSessions as row (row.session.provider + ':' + row.session.sessionId)}
          <a class="stats-session-row" href={'/' + encodeURIComponent(row.session.provider) + '/session/' + encodeURIComponent(row.session.sessionId)}
            onclick={(event) => openSession(event, row.session)}>
            <span>{row.session.provider} · {row.session.sessionId}</span><span>{count(row.knownTokenCount)} {t($language, 'known tokens')}</span>
            <span>{count(row.recordedRequestCount)} {t($language, 'requests')} · {count(row.unresolvedUsageObservationCount)} {t($language, 'unresolved observations')}</span>
          </a>
        {/each}
      {/if}
    </section>
    {/if}
    <p class="stats-note">{t($language, 'Source revision:')} <code>{report.revision}</code>. {t($language, 'Statistics cover active source sessions; provider files are read only.')}</p>
      <section class="stats-section" aria-label={t($language, 'Source details')}>
        <h2>{t($language, 'Source details')}</h2>
        <ul>{#each report.sources ?? [] as source (source.provider)}<li>{source.provider} · {source.status}{source.diagnostic ? ` · ${source.diagnostic}` : ''}</li>{/each}</ul>
        <ul>{#each report.sourceDiagnostics as diagnostic (diagnostic.code)}<li><code>{diagnostic.code}</code> ({count(diagnostic.affectedSessions)})</li>{/each}</ul>
        {#if report.sourceDiagnosticsTruncated}<p>{t($language, 'Additional diagnostic codes are omitted.')}</p>{/if}
      </section>
    </details>
  {:else if days === 'custom'}
    <p class="stats-status">{t($language, 'Choose two UTC dates and apply the range.')}</p>
  {:else}
    <p class="stats-status">{t($language, 'No available provider statistics.')}</p>
  {/if}
</main>

<style>
  .statistics-details { margin:24px 0; border-top:1px solid var(--line); }
  .statistics-details>summary { cursor:pointer; padding:16px 0; font-weight:550; }
  .harness-filter { position:relative; display:flex; flex-direction:column; gap:6px; min-width:180px; }
  .harness-label { font-size:12px; color:var(--muted); }
  .harness-trigger { display:flex; justify-content:space-between; gap:20px; padding:9px 11px; border:1px solid var(--line); border-radius:7px; background:var(--paper); color:var(--ink); font:inherit; font-size:13px; cursor:pointer; }
  .harness-options { position:absolute; top:100%; left:0; z-index:20; min-width:240px; padding:12px; margin:6px 0 0; border:1px solid var(--line); border-radius:9px; background:var(--paper); box-shadow:0 12px 30px #0002; }
  .harness-options legend { font-size:12px; padding:2px 6px; background:var(--paper); }
  .harness-options label { display:flex; align-items:center; gap:9px; padding:9px 4px; font-size:13px; cursor:pointer; }
  .harness-options input { accent-color:var(--blue); }
  .harness-options button { border:0; background:var(--blue-pale); color:var(--blue); padding:6px 9px; border-radius:5px; cursor:pointer; }
</style>
