<script lang="ts">
  import { onMount } from 'svelte';
  import type { ReaderEventRef, RuntimeEventDetail, RuntimeWorkPage } from './api';
  import { getRuntimeEventDetail, getRuntimeWork, runtimeEventDetailUrl, RuntimeApiError } from './api';
  import { language, protocolLabel, t } from './i18n';
  import { runtimeSourceHash, type RuntimeWorkState } from './runtime-history';

  export let provider: string;
  export let sessionId: string;
  export let onOpenReader: (event: ReaderEventRef, sourceRevision: string) => void;
  export let initialState: RuntimeWorkState | undefined;
  export let onStateChange: (state: RuntimeWorkState) => void;
  export let onReady: () => Promise<void>;

  type WorkDomainCoverage = RuntimeWorkPage['domainCoverage'];

  type State = 'loading' | 'ready' | 'empty' | 'invalid' | 'unavailable' | 'request' | 'cursor' | 'stale';
  let state: State = 'loading';
  let message = '';
  let sourceRevision: string | null = initialState?.revision ?? null;
  let page: RuntimeWorkPage | null = null;
  let workCoverage: WorkDomainCoverage | null = null;
  let kindDraft = initialState?.kind ?? '';
  let statusDraft = initialState?.status ?? '';
  let kind = kindDraft;
  let status = statusDraft;
  let currentCursor = initialState?.cursor ?? null;
  let generation = 0;
  let active = true;
  let evidence: Record<string, { loading: boolean; error: string; detail: RuntimeEventDetail | null }> = {};

  onMount(() => {
    void load(currentCursor);
    return () => { active = false; generation++; };
  });

  async function load(cursor: string | null): Promise<void> {
    const request = ++generation;
    currentCursor = cursor;
    state = 'loading';
    message = '';
    evidence = {};
    workCoverage = null;
    try {
      const result = await getRuntimeWork(provider, sessionId, {
        kind: kind || undefined, status: status || undefined, cursor: cursor || undefined,
      });
      if (!active || request !== generation) return;
      if ((sourceRevision !== null && result.revision !== sourceRevision) || result.session.provider !== provider ||
        result.session.sessionId !== sessionId) {
        page = null;
        state = 'stale';
        return;
      }
      if (!result.domainCoverage || !['observed', 'not-observed', 'unknown'].includes(result.domainCoverage.state) ||
        typeof result.domainCoverage.details !== 'string') {
        throw new RuntimeApiError('protocol_invalid', 'The Work page has no valid domain coverage.');
      }
      sourceRevision = result.revision;
      workCoverage = result.domainCoverage;
      page = result;
      state = result.entries.length ? 'ready' : 'empty';
      onStateChange({ kind, status, cursor: currentCursor, revision: sourceRevision });
      await onReady();
    } catch (cause) {
      if (!active || request !== generation) return;
      page = null;
      const code = cause instanceof RuntimeApiError ? cause.code : 'request_failed';
      message = cause instanceof Error ? cause.message : String(cause);
      state = code === 'protocol_invalid' ? 'invalid'
        : code === 'protocol_unavailable' || code === 'provider_unavailable' ? 'unavailable'
          : code === 'source_changed' ? 'stale'
            : code === 'invalid_cursor' && cursor ? 'cursor' : 'request';
    }
  }

  function coverageLabel(state: WorkDomainCoverage['state']): string {
    return protocolLabel(state, $language);
  }

  function applyFilters(event: SubmitEvent): void {
    event.preventDefault();
    kind = kindDraft.trim();
    status = statusDraft.trim();
    page = null;
    void load(null);
  }

  function timeLabel(timestamp: number | null): string {
    if (timestamp === null) return t($language, 'Unknown');
    const date = new Date(timestamp);
    return Number.isNaN(date.valueOf()) ? t($language, 'Unknown')
      : new Intl.DateTimeFormat($language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
  }

  async function inspectEvidence(click: MouseEvent, eventId: string): Promise<void> {
    if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    const request = generation;
    evidence = { ...evidence, [eventId]: { loading: true, error: '', detail: null } };
    try {
      const detail = await getRuntimeEventDetail(provider, sessionId, eventId, page!.revision);
      if (!active || request !== generation) return;
      if (detail.revision !== sourceRevision || detail.session.provider !== provider || detail.session.sessionId !== sessionId) {
        page = null;
        state = 'stale';
        return;
      }
      evidence = { ...evidence, [eventId]: { loading: false, error: '', detail } };
    } catch (cause) {
      if (!active || request !== generation) return;
      if (cause instanceof RuntimeApiError && cause.code === 'source_changed') {
        page = null;
        state = 'stale';
        return;
      }
      evidence = { ...evidence, [eventId]: { loading: false,
        error: cause instanceof Error ? cause.message : String(cause), detail: null } };
    }
  }

  function openReader(click: MouseEvent, event: ReaderEventRef): void {
    if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    onOpenReader(event, page!.revision);
  }
</script>

<section class="runtime-work" aria-labelledby="runtime-work-title">
  <div class="runtime-intro">
    <div><p class="eyebrow">{t($language, 'Recorded work')}</p><h2 id="runtime-work-title">{t($language, 'Tasks and runs')}</h2></div>
    <p class="runtime-coverage">
      {#if workCoverage}
        <strong>{t($language, 'Work coverage:')} {coverageLabel(workCoverage.state)}</strong> · {workCoverage.details}
      {:else if state === 'loading'}
        <strong>{t($language, 'Loading work coverage')}</strong>
      {:else}
        <strong>{t($language, 'Work coverage unavailable')}</strong>
      {/if}
    </p>
  </div>
  <form class="runtime-filters" onsubmit={applyFilters}>
    <label>{t($language, 'Kind')} <input class="runtime-work-kind" type="text" bind:value={kindDraft} placeholder={t($language, 'Exact kind')} /></label>
    <label>{t($language, 'Status')} <input class="runtime-work-status" type="text" bind:value={statusDraft} placeholder={t($language, 'Exact status')} /></label>
    <button type="submit">{t($language, 'Apply filters')}</button>
  </form>
  <p class="runtime-filter-note">{t($language, 'Filters match exact recorded kind and normalized status values.')}</p>

  {#if state === 'loading'}
    <p class="runtime-state" role="status">{t($language, 'Loading recorded work…')}</p>
  {:else if state === 'stale'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Source revision changed')}</strong><p>{t($language, 'Refresh this session before opening work evidence.')}</p><button onclick={() => window.location.reload()}>{t($language, 'Refresh session')}</button></div>
  {:else if state === 'invalid'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Invalid protocol evidence')}</strong><p>{message}</p><button onclick={() => void load(null)}>{t($language, 'Retry')}</button></div>
  {:else if state === 'unavailable'}
    <div class="runtime-state" role="status"><strong>{t($language, 'Recorded work unavailable')}</strong><p>{message}</p><button onclick={() => void load(null)}>{t($language, 'Retry')}</button></div>
  {:else if state === 'cursor'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Work cursor is stale or invalid')}</strong><p>{message}</p><button onclick={() => void load(null)}>{t($language, 'Start again')}</button></div>
  {:else if state === 'request'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Work request failed')}</strong><p>{message}</p><button onclick={() => void load(null)}>{t($language, 'Retry')}</button></div>
  {:else if page}
    {#if state === 'empty'}
      {#if workCoverage?.state === 'unknown'}
        <div class="runtime-state" role="status"><strong>{t($language, 'Work coverage is unknown')}</strong><p>{t($language, 'Source events can contain work that this view does not represent.')} {workCoverage.details}</p></div>
      {:else}
        <div class="runtime-state" role="status"><strong>{t($language, 'No matching work on this page')}</strong><p>{page.nextCursor ? t($language, 'The bounded scan can continue.') : t($language, 'No more recorded work matches these filters.')}</p></div>
      {/if}
    {:else}
      <ol class="runtime-events runtime-work-entries" aria-label={t($language, 'Source-ordered recorded work')}>
        {#each page.entries as entry (entry.type + ':' + entry.id)}
          <li class="runtime-event runtime-work-entry">
            <div class="runtime-event-heading"><strong>{entry.kind}</strong><span>{protocolLabel(entry.type, $language)}</span><span class="runtime-work-status-label">{protocolLabel(entry.status, $language)}</span></div>
            <p>{entry.turnId ? `${t($language, 'Turn')} ${entry.turnId} · ` : ''}{entry.pairing ? `${t($language, 'Pairing')} ${entry.pairing} · ` : ''}{t($language, 'Source order')} {entry.sourceOrder.record}:{entry.sourceOrder.ordinal}</p>
            <p>{t($language, 'Started')} {timeLabel(entry.timeStart)} · {t($language, 'Ended')} {timeLabel(entry.timeEnd)}</p>
            <p>{t($language, 'Provenance:')} {protocolLabel(entry.evidence.provenance.fidelity, $language)} · {entry.evidence.provenance.sourceType} #{entry.evidence.provenance.sourceId ?? '?'}</p>
            <div class="runtime-evidence-links">
              {#each [entry.evidence, ...(entry.terminalEvidence ? [entry.terminalEvidence] : [])] as source (source.eventId)}
                <a href={runtimeEventDetailUrl(provider, sessionId, source.eventId, page!.revision)} onclick={(click) => void inspectEvidence(click, source.eventId)}>{t($language, 'Inspect')} {source === entry.evidence ? t($language, 'start') : t($language, 'terminal')} {t($language, 'evidence')}</a>
                {#if evidence[source.eventId]?.loading}<span role="status">{t($language, 'Loading evidence…')}</span>{/if}
                {#if evidence[source.eventId]?.error}<span class="content-error" role="alert">{evidence[source.eventId].error}</span>{/if}
                {#if evidence[source.eventId]?.detail}
                  <div class="runtime-evidence-detail">
                    <strong>{evidence[source.eventId].detail!.event.kind}</strong>
                    <span>{t($language, 'Recorded event')} {source.eventId} · {timeLabel(evidence[source.eventId].detail!.event.timestamp)}</span>
                    {#if evidence[source.eventId].detail!.event.readerEvent}
                      <a href={runtimeSourceHash(evidence[source.eventId].detail!.event.readerEvent!, page.revision)}
                        onclick={(click) => openReader(click, evidence[source.eventId].detail!.event.readerEvent!)}>{t($language, 'Open in conversation')}</a>
                    {/if}
                  </div>
                {/if}
              {/each}
            </div>
            {#if entry.readerEvent}
              <a href={runtimeSourceHash(entry.readerEvent, page.revision)}
                onclick={(click) => openReader(click, entry.readerEvent!)}>{t($language, 'Open in conversation')}</a>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
    <div class="runtime-pagination">
      <span>{page.entries.length} {t($language, 'work entries on this page')} · {page.scannedEntries} {t($language, 'entries scanned')}</span>
      {#if page.nextCursor}<button onclick={() => void load(page!.nextCursor)}>{t($language, 'Next page')}</button>{/if}
    </div>
  {/if}
</section>
