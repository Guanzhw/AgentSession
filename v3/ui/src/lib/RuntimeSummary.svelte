<script lang="ts">
  import { onMount } from 'svelte';
  import { RuntimeApiError } from './api';
  import { getRuntimeSummary, type RuntimeSummary as Summary } from './runtime-projections';
  import { language, protocolLabel, t } from './i18n';

  export let provider: string;
  export let sessionId: string;

  let sourceRevision: string | null = null;
  let summary: Summary | null = null;
  let state: 'loading' | 'ready' | 'invalid' | 'unavailable' | 'stale' | 'request' = 'loading';
  let message = '';
  let active = true;
  let generation = 0;

  onMount(() => {
    void load();
    return () => { active = false; generation++; };
  });

  async function load(): Promise<void> {
    const request = ++generation;
    state = 'loading';
    summary = null;
    message = '';
    try {
      const result = await getRuntimeSummary(provider, sessionId);
      if (!active || generation !== request) return;
      if ((sourceRevision !== null && result.revision !== sourceRevision) || result.session.provider !== provider || result.session.sessionId !== sessionId) {
        state = 'stale';
        return;
      }
      sourceRevision = result.revision;
      summary = result;
      state = 'ready';
    } catch (cause) {
      if (!active || generation !== request) return;
      const code = cause instanceof RuntimeApiError ? cause.code : 'request_failed';
      message = cause instanceof Error ? cause.message : String(cause);
      state = code === 'protocol_invalid' ? 'invalid'
        : code === 'protocol_unavailable' || code === 'provider_unavailable' ? 'unavailable'
          : code === 'source_changed' ? 'stale' : 'request';
    }
  }

  function coverageLabel(state: string): string {
    return protocolLabel(state, $language);
  }
</script>

<section class="runtime-summary" aria-labelledby="runtime-summary-title">
  <div class="runtime-intro"><div><p class="eyebrow">{t($language, 'Recorded runtime')}</p><h2 id="runtime-summary-title">{t($language, 'Session overview')}</h2></div></div>
  {#if state === 'loading'}
    <p class="runtime-state" role="status">{t($language, 'Loading session overview…')}</p>
  {:else if state === 'stale'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Source revision changed')}</strong><p>{t($language, 'Refresh this session to inspect its current runtime.')}</p><button onclick={() => window.location.reload()}>{t($language, 'Refresh session')}</button></div>
  {:else if state !== 'ready'}
    <div class="runtime-state" role={state === 'unavailable' ? 'status' : 'alert'}><strong>{state === 'invalid' ? t($language, 'Invalid protocol evidence') : state === 'unavailable' ? t($language, 'Runtime overview unavailable') : t($language, 'Runtime overview request failed')}</strong><p>{message}</p><button onclick={() => void load()}>{t($language, 'Retry')}</button></div>
  {:else if summary}
    <p class="runtime-coverage"><strong>{protocolLabel(summary.completeness, $language)} {t($language, 'protocol coverage')}</strong> · {t($language, 'source validation')} {summary.validation.ok ? t($language, 'passed') : t($language, 'failed')}</p>
    <dl class="runtime-summary-counts" aria-label={t($language, 'Recorded runtime counts')}>
      <div><dt>{t($language, 'Events')}</dt><dd>{summary.counts.events}</dd></div>
      <div><dt>{t($language, 'Tasks')}</dt><dd>{summary.counts.tasks}</dd></div>
      <div><dt>{t($language, 'Agent runs')}</dt><dd>{summary.counts.agentRuns}</dd></div>
      {#if summary.counts.branches != null}<div><dt>{t($language, 'Branches')}</dt><dd>{summary.counts.branches}</dd></div>{/if}
      <div><dt>{t($language, 'Relationships')}</dt><dd>{summary.counts.relationships}</dd></div>
      <div><dt>{t($language, 'Coordination')}</dt><dd>{summary.counts.coordination}</dd></div>
      <div><dt>{t($language, 'Context artifacts')}</dt><dd>{summary.counts.contextArtifacts}</dd></div>
      <div><dt>{t($language, 'Usage records')}</dt><dd>{summary.counts.usageRecords}</dd></div>
    </dl>
    <h3>{t($language, 'Evidence coverage')}</h3>
    <ul class="runtime-coverage-list">
      {#each Object.entries(summary.coverage) as [domain, coverage] (domain)}
        <li><strong>{protocolLabel(domain, $language)}</strong>: {coverageLabel(coverage.state)} · {coverage.details}</li>
      {/each}
    </ul>
  {/if}
</section>
