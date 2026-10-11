<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { ReaderEventRef, RuntimeEvent, RuntimeEventPage, SessionRef } from './api';
  import { getRuntimeEvents, RuntimeApiError } from './api';
  import RuntimeWork from './RuntimeWork.svelte';
  import RuntimeSummary from './RuntimeSummary.svelte';
  import RuntimeSessions from './RuntimeSessions.svelte';
  import RuntimeDomain from './RuntimeDomain.svelte';
  import { language, protocolLabel, t } from './i18n';
  import { readRuntimeHistory, runtimeLensFromHash, runtimeSourceHash, saveRuntimeHistory,
    type RuntimeLens, type RuntimeNavigationSnapshot } from './runtime-history';

  export let provider: string;
  export let sessionId: string;
  export let onOpenReader: (event: ReaderEventRef, sourceRevision: string) => void;
  export let onOpenSession: (session: SessionRef, nodeId: string) => void;

  const saved = readRuntimeHistory(provider, sessionId);
  let navigation: RuntimeNavigationSnapshot = saved ?? {
    provider, sessionId, lens: 'events', scrollY: 0, domains: {}, focusNodeId: null,
  };

  type State = 'loading' | 'ready' | 'empty' | 'invalid' | 'unavailable' | 'request' | 'cursor' | 'stale';
  let state: State = 'loading';
  let message = '';
  let sourceRevision: string | null = navigation.events?.revision ?? null;
  let page: RuntimeEventPage | null = null;
  let categoryDraft = navigation.events?.category ?? '';
  let kindDraft = navigation.events?.kind ?? '';
  let category = categoryDraft;
  let kind = kindDraft;
  let currentCursor = navigation.events?.cursor ?? null;
  let generation = 0;
  let active = true;
  const initialRuntime = window.location.hash.startsWith('#runtime?')
    ? new URLSearchParams(window.location.hash.slice(9)) : null;
  let lens: RuntimeLens = runtimeLensFromHash() ?? navigation.lens;
  let focusNodeId = initialRuntime?.get('node') ?? navigation.focusNodeId;
  let restoreScroll = saved !== null && initialRuntime !== null;

  export function saveNavigation(): void {
    navigation = { ...navigation, lens, focusNodeId, scrollY: window.scrollY,
      events: { category, kind, cursor: currentCursor, revision: sourceRevision } };
    saveRuntimeHistory(navigation);
  }

  async function restorePosition(): Promise<void> {
    if (!restoreScroll) return;
    restoreScroll = false;
    const currentLens = lens;
    await tick();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (!active || lens !== currentLens) return;
    window.scrollTo({ top: saved!.scrollY, behavior: 'instant' });
    saveNavigation();
  }

  function selectLens(next: RuntimeLens): void {
    lens = next;
    focusNodeId = next === 'sessions' ? null : focusNodeId;
    generation++;
    restoreScroll = false;
    saveNavigation();
    if (next === 'events') void load(currentCursor);
  }

  function openReader(event: ReaderEventRef, revision: string): void {
    saveNavigation();
    onOpenReader(event, revision);
  }

  function openSession(session: SessionRef, nodeId: string): void {
    focusNodeId = nodeId;
    saveNavigation();
    onOpenSession(session, nodeId);
  }

  onMount(() => {
    if (lens === 'events') void load(currentCursor);
    return () => { active = false; generation++; };
  });

  async function load(cursor: string | null): Promise<void> {
    const request = ++generation;
    currentCursor = cursor;
    state = 'loading';
    message = '';
    try {
      const result = await getRuntimeEvents(provider, sessionId, {
        category: category || undefined,
        kind: kind || undefined,
        cursor: cursor || undefined,
      });
      if (!active || request !== generation) return;
      if ((sourceRevision !== null && result.revision !== sourceRevision) || result.session.provider !== provider ||
        result.session.sessionId !== sessionId) {
        page = null;
        state = 'stale';
        return;
      }
      sourceRevision = result.revision;
      page = result;
      state = result.events.length ? 'ready' : 'empty';
      saveNavigation();
      await restorePosition();
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

  function applyFilters(event: SubmitEvent): void {
    event.preventDefault();
    category = categoryDraft.trim();
    kind = kindDraft.trim();
    page = null;
    void load(null);
  }

  function timeLabel(timestamp: number | null): string {
    if (timestamp === null) return 'Time unavailable';
    const date = new Date(timestamp);
    return Number.isNaN(date.valueOf()) ? 'Time unavailable'
      : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
  }

  function openSource(click: MouseEvent, event: RuntimeEvent): void {
    if (!event.readerEvent || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    openReader(event.readerEvent, page!.revision);
  }
</script>

<section class="runtime-panel" aria-label={t($language, 'Runtime')}>
  <nav class="runtime-lenses" aria-label={t($language, 'Runtime views')}>
    <button type="button" class:active={lens === 'events'} aria-current={lens === 'events' ? 'page' : undefined}
      onclick={() => selectLens('events')}>{t($language, 'Events')}</button>
    <button type="button" class:active={lens === 'work'} aria-current={lens === 'work' ? 'page' : undefined}
      onclick={() => selectLens('work')}>{t($language, 'Work')}</button>
    <button type="button" class="runtime-lens-summary" class:active={lens === 'summary'} aria-current={lens === 'summary' ? 'page' : undefined}
      onclick={() => selectLens('summary')}>{t($language, 'Summary')}</button>
    <button type="button" class="runtime-lens-sessions" class:active={lens === 'sessions'} aria-current={lens === 'sessions' ? 'page' : undefined}
      onclick={() => selectLens('sessions')}>{t($language, 'Sessions')}</button>
    <button type="button" class="runtime-lens-execution" class:active={lens === 'execution'} aria-current={lens === 'execution' ? 'page' : undefined}
      onclick={() => selectLens('execution')}>{t($language, 'Execution')}</button>
    <button type="button" class="runtime-lens-coordination" class:active={lens === 'coordination'} aria-current={lens === 'coordination' ? 'page' : undefined}
      onclick={() => selectLens('coordination')}>{t($language, 'Coordination')}</button>
    <button type="button" class="runtime-lens-context" class:active={lens === 'context'} aria-current={lens === 'context' ? 'page' : undefined}
      onclick={() => selectLens('context')}>{t($language, 'Context')}</button>
  </nav>
  {#if lens === 'events'}
  <div class="runtime-intro">
    <div>
      <p class="eyebrow">{t($language, 'Source event stream')}</p>
      <h2 id="runtime-title">{t($language, 'Runtime events')}</h2>
    </div>
    <p class="runtime-coverage"><strong>{t($language, 'Partial coverage')}</strong> · {t($language, 'recorded source events in source order.')}</p>
  </div>

  <form class="runtime-filters" onsubmit={applyFilters}>
    <label>{t($language, 'Category')} <input class="runtime-category" type="text" bind:value={categoryDraft} placeholder={t($language, 'Exact category')} /></label>
    <label>{t($language, 'Kind')} <input class="runtime-kind" type="text" bind:value={kindDraft} placeholder={t($language, 'Exact kind')} /></label>
    <button type="submit">{t($language, 'Apply filters')}</button>
  </form>
  <p class="runtime-filter-note">{t($language, 'Filters match exact recorded category and kind values.')}</p>

  {#if state === 'loading'}
    <p class="runtime-state" role="status">{t($language, 'Loading Runtime events…')}</p>
  {:else if state === 'stale'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Source revision changed')}</strong><p>{t($language, 'Refresh this session before opening a source event.')}</p><button onclick={() => window.location.reload()}>{t($language, 'Refresh session')}</button></div>
  {:else if state === 'invalid'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Invalid protocol evidence')}</strong><p>{message}</p><button onclick={() => void load(null)}>{t($language, 'Retry')}</button></div>
  {:else if state === 'unavailable'}
    <div class="runtime-state" role="status"><strong>{t($language, 'Runtime events unavailable')}</strong><p>{message}</p><button onclick={() => void load(null)}>{t($language, 'Retry')}</button></div>
  {:else if state === 'cursor'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Event cursor is stale or invalid')}</strong><p>{message}</p><button onclick={() => void load(null)}>{t($language, 'Start again')}</button></div>
  {:else if state === 'request'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Runtime request failed')}</strong><p>{message}</p><button onclick={() => void load(null)}>{t($language, 'Retry')}</button></div>
  {:else if page}
    {#if state === 'empty'}
      <div class="runtime-state" role="status"><strong>{t($language, 'No matching events on this page')}</strong><p>{page.nextCursor ? t($language, 'The bounded scan can continue.') : t($language, 'No more recorded events match these filters.')}</p></div>
    {:else}
      <ol class="runtime-events" aria-label={t($language, 'Source-ordered Runtime events')}>
        {#each page.events as event (event.id)}
          <li class="runtime-event">
            <div class="runtime-event-heading"><strong>{event.kind}</strong><span>{event.category}</span><time>{timeLabel(event.timestamp)}</time></div>
            <p>{t($language, 'Source order')} {event.sourceOrder.record}:{event.sourceOrder.ordinal} · {t($language, 'Event')} {event.sequence}</p>
            <p>{t($language, 'Provenance:')} {protocolLabel(event.provenance.fidelity, $language)} · {event.provenance.sourceType}{event.provenance.sourceId ? ` #${event.provenance.sourceId}` : ''}</p>
            {#if event.readerEvent}
              <a href={runtimeSourceHash(event.readerEvent, page.revision)}
                onclick={(click) => openSource(click, event)}>{t($language, 'Open in conversation')}</a>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
    <div class="runtime-pagination">
      <span>{page.events.length} {t($language, 'events on this page')} · {page.scannedEvents} {t($language, 'source events scanned')}</span>
      {#if page.nextCursor}<button onclick={() => void load(page!.nextCursor)}>{t($language, 'Next page')}</button>{/if}
    </div>
  {/if}
  {:else if lens === 'work'}
    <RuntimeWork {provider} {sessionId} initialState={navigation.work}
      onStateChange={(state) => { navigation = { ...navigation, work: state }; saveNavigation(); }}
      onReady={restorePosition} onOpenReader={openReader} />
  {:else if lens === 'summary'}
    <RuntimeSummary {provider} {sessionId} initialRevision={navigation.summaryRevision ?? null}
      onRevision={(revision) => { navigation = { ...navigation, summaryRevision: revision }; saveNavigation(); }}
      onReady={restorePosition} />
  {:else if lens === 'sessions'}
    <RuntimeSessions {provider} {sessionId} {focusNodeId} initialRevision={navigation.sessionsRevision ?? null}
      onRevision={(revision) => { navigation = { ...navigation, sessionsRevision: revision }; saveNavigation(); }}
      onReady={restorePosition} onOpenSession={openSession} />
  {:else}
    {#key lens}
      <RuntimeDomain {provider} {sessionId} domain={lens} initialState={navigation.domains[lens]}
        onStateChange={(domain, state) => { navigation = { ...navigation, domains: { ...navigation.domains, [domain]: state } }; saveNavigation(); }}
        onReady={restorePosition} onOpenReader={openReader} />
    {/key}
  {/if}
</section>
