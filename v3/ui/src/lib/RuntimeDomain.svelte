<script lang="ts">
  import { onMount } from 'svelte';
  import type { ReaderEventRef, SessionRef } from './api';
  import { RuntimeApiError, runtimeEventDetailUrl } from './api';
  import { getRuntimeDomain, type DomainFact, type DomainPage, type RuntimeDomain } from './runtime-projections';
  import { language, protocolLabel, t } from './i18n';

  export let provider: string;
  export let sessionId: string;
  export let readerRevision: string;
  export let domain: RuntimeDomain;
  export let onOpenReader: (event: ReaderEventRef) => void;

  let page: DomainPage | null = null;
  let state: 'loading' | 'ready' | 'empty' | 'invalid' | 'unavailable' | 'stale' | 'cursor' | 'request' = 'loading';
  let message = '';
  let kindDraft = '';
  let kind = '';
  let generation = 0;
  let active = true;

  onMount(() => {
    void load(null);
    return () => { active = false; generation++; };
  });

  async function load(cursor: string | null): Promise<void> {
    const request = ++generation;
    state = 'loading';
    page = null;
    message = '';
    try {
      const result = await getRuntimeDomain(provider, sessionId, domain,
        { kind: kind || undefined, cursor: cursor || undefined, limit: 25 });
      if (!active || request !== generation) return;
      if (result.revision !== readerRevision || result.session.provider !== provider || result.session.sessionId !== sessionId) {
        state = 'stale';
        return;
      }
      page = result;
      state = result.entries.length ? 'ready' : 'empty';
    } catch (cause) {
      if (!active || request !== generation) return;
      const code = cause instanceof RuntimeApiError ? cause.code : 'request_failed';
      message = cause instanceof Error ? cause.message : String(cause);
      state = code === 'protocol_invalid' ? 'invalid'
        : code === 'protocol_unavailable' || code === 'provider_unavailable' ? 'unavailable'
          : code === 'source_changed' ? 'stale'
            : code === 'invalid_cursor' && cursor ? 'cursor' : 'request';
    }
  }

  function applyFilter(event: SubmitEvent): void {
    event.preventDefault();
    kind = kindDraft.trim();
    void load(null);
  }

  function title(type: string, kind: string, fact: DomainFact): string {
    if (type === 'contextResult') return t($language, 'Compaction result');
    if (type === 'contextObservation' && kind === 'compaction-boundary')
      return t($language, 'Compaction boundary');
    if (type === 'executionEvent' && fact.execution) return `${fact.execution.toolName}: ${fact.execution.phase}`;
    if (type === 'coordination') return kind.replaceAll('.', ' ');
    if (type === 'contextArtifact') return fact.title || kind.replaceAll('-', ' ');
    if (type === 'usageRecord') return fact.model || t($language, 'Request usage');
    return kind.replaceAll('.', ' ');
  }

  function provenance(fact: DomainFact): string {
    const source = fact.transformation?.provenance ?? fact.evidence?.provenance ?? fact.provenance;
    return source ? `${protocolLabel(source.fidelity, $language)} · ${source.sourceType} #${source.sourceId ?? '?'}` : t($language, 'unavailable');
  }

  function timeLabel(timestamp: number | null | undefined): string {
    if (timestamp == null) return t($language, 'time unavailable');
    const date = new Date(timestamp);
    return Number.isNaN(date.valueOf()) ? t($language, 'time unavailable')
      : new Intl.DateTimeFormat($language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
  }

  function endpointLabel(actorPath: string | null | undefined,
    session: SessionRef | null | undefined, unknown: string): string {
    return actorPath ?? (session ? `${session.provider}/${session.sessionId}` : unknown);
  }

  function openReader(click: MouseEvent, event: ReaderEventRef): void {
    if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    onOpenReader(event);
  }
</script>

<section class={'runtime-domain runtime-domain-' + domain} aria-labelledby={'runtime-domain-title-' + domain}>
  <div class="runtime-intro"><div><p class="eyebrow">{t($language, 'Recorded')} {domain === 'execution' ? t($language, 'Execution') : domain === 'coordination' ? t($language, 'Coordination') : t($language, 'Context')}</p><h2 id={'runtime-domain-title-' + domain}>{domain === 'execution' ? t($language, 'Execution') : domain === 'coordination' ? t($language, 'Coordination') : t($language, 'Context')}</h2></div>
    {#if page}<p class="runtime-coverage runtime-domain-coverage"><strong>{protocolLabel(page.domainCoverage.state, $language)}</strong> · {page.domainCoverage.details} · {protocolLabel(page.coverage, $language)} {t($language, 'protocol coverage')}</p>{/if}
  </div>
  <form class="runtime-filters" onsubmit={applyFilter}>
    <label>{t($language, 'Kind')} <input class="runtime-domain-kind" type="text" bind:value={kindDraft} placeholder={t($language, 'Exact kind')} /></label>
    <button type="submit">{t($language, 'Apply filter')}</button>
  </form>
  <p class="runtime-filter-note">{t($language, 'Kind matches the recorded value exactly. Pages preserve source order.')}</p>

  {#if state === 'loading'}
    <p class="runtime-state" role="status">{t($language, 'Loading')} {domain === 'execution' ? t($language, 'Execution') : domain === 'coordination' ? t($language, 'Coordination') : t($language, 'Context')} {t($language, 'evidence…')}</p>
  {:else if state === 'stale'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Source revision changed')}</strong><p>{t($language, 'Refresh this session before opening evidence.')}</p><button onclick={() => window.location.reload()}>{t($language, 'Refresh session')}</button></div>
  {:else if state !== 'ready' && state !== 'empty'}
    <div class="runtime-state" role={state === 'unavailable' ? 'status' : 'alert'}>
      <strong>{state === 'invalid' ? t($language, 'Invalid protocol evidence') : state === 'unavailable' ? t($language, 'Domain evidence unavailable') : state === 'cursor' ? t($language, 'Cursor is stale or invalid') : t($language, 'Domain request failed')}</strong>
      <p>{message}</p><button class="runtime-retry" onclick={() => void load(null)}>{state === 'cursor' ? t($language, 'Start again') : t($language, 'Retry')}</button>
    </div>
  {:else if page}
    {#if state === 'empty'}
      <div class="runtime-state" role="status"><strong>{page.domainCoverage.state === 'unknown' ? t($language, 'Coverage is unknown') : page.domainCoverage.state === 'not-observed' ? t($language, 'No observation recorded') : t($language, 'No matching evidence on this page')}</strong>
        <p>{page.domainCoverage.details}{page.nextCursor ? ' ' + t($language, 'The bounded scan can continue.') : ''}</p></div>
    {:else}
      <ol class="runtime-events runtime-domain-entries" aria-label={t($language, 'Source-ordered') + ' ' + domain + ' ' + t($language, 'evidence')}>
        {#each page.entries as entry, index (index)}
          <li class="runtime-event runtime-domain-entry">
            <div class="runtime-event-heading"><strong>{title(entry.type, entry.kind, entry.fact)}</strong><span>{entry.type}</span>{#if entry.fact.status}<span>{entry.fact.status}</span>{/if}</div>
            {#if entry.type === 'agentRun'}
              <p>{t($language, 'Turn')} {entry.fact.turnId ?? t($language, 'unknown')}{entry.fact.taskId ? ` · ${t($language, 'Task')} ${entry.fact.taskId}` : ''} · {t($language, 'Pairing')} {entry.fact.pairing ?? t($language, 'unknown')}</p>
            {:else if entry.type === 'executionEvent' && entry.fact.execution}
              <p>{entry.fact.execution.label ?? entry.fact.execution.toolName} · {entry.fact.execution.handle}</p>
            {:else if entry.type === 'coordination'}
              <p>{endpointLabel(entry.fact.fromActorPath, entry.fact.fromSessionRef, t($language, 'Unknown sender'))} → {endpointLabel(entry.fact.toActorPath, entry.fact.toSessionRef, t($language, 'Unknown recipient'))} · {entry.fact.state ?? t($language, 'unknown state')} · {t($language, 'Correlation')} {entry.fact.correlationId ?? t($language, 'unknown')}</p>
            {:else if entry.type === 'relationship'}
              <p>{entry.fact.from?.provider}/{entry.fact.from?.sessionId} → {entry.fact.to?.provider}/{entry.fact.to?.sessionId}</p>
            {:else if entry.type === 'contextObservation'}
              <p>{t($language, 'Summary')} {entry.fact.summaryAvailable ? t($language, 'recorded') : t($language, 'unavailable')}</p>
              {#if entry.fact.trigger}<p>{t($language, 'Recorded trigger')} {entry.fact.trigger}</p>{/if}
              {#if entry.fact.preCompactTokens != null}<p>{t($language, 'Recorded tokens before compaction')} {entry.fact.preCompactTokens}</p>{/if}
            {:else if entry.type === 'contextResult' && entry.fact.transformation && entry.fact.version}
              <p>{entry.fact.version.readerEvent ? t($language, 'Readable summary recorded in the conversation') : t($language, 'Compaction summary content unavailable')} · {t($language, 'Protocol sequence')} {entry.fact.version.sequence}</p>
              {#if entry.fact.transformation.shadowedRange}<p>{t($language, 'Recorded shadowed range')} {entry.fact.transformation.shadowedRange.start}–{entry.fact.transformation.shadowedRange.end}</p>{/if}
              {#if entry.fact.transformation.shadowedSeqs}<p>{entry.fact.transformation.shadowedSeqs.length} {t($language, 'listed shadowed source')} {entry.fact.transformation.shadowedSeqs.length === 1 ? t($language, 'sequence') : t($language, 'sequences')}</p>{/if}
              {#if entry.fact.transformation.shadowedTokenCount != null}<p>{entry.fact.transformation.shadowedTokenCount} {t($language, 'recorded shadowed tokens')}</p>{/if}
              {#if entry.fact.transformation.retainedFrom}<p>{t($language, 'Retained from source entry')} {entry.fact.transformation.retainedFrom.sourceId}</p>{/if}
              {#if entry.fact.transformation.retainedTailCount != null}<p>{t($language, 'Recorded retained tail:')} {entry.fact.transformation.retainedTailCount} {t($language, 'entries')}</p>{/if}
            {:else if entry.type === 'contextArtifact'}
              <p>{entry.fact.summary ?? t($language, 'No summary recorded')} · {entry.fact.scope ?? t($language, 'scope unknown')} · {t($language, 'Content')} {entry.fact.contentAccess ?? t($language, 'unavailable')}</p>
            {:else if entry.type === 'usageRecord' && entry.fact.tokens}
              <p>{t($language, 'Input')} {entry.fact.tokens.input ?? t($language, 'unknown')} · {t($language, 'Cache read')} {entry.fact.tokens.cacheRead ?? t($language, 'unknown')} · {t($language, 'Output')} {entry.fact.tokens.output ?? t($language, 'unknown')} · {t($language, 'Total')} {entry.fact.tokens.total ?? t($language, 'unknown')}</p>
            {/if}
            <p>{timeLabel(entry.fact.transformation?.timestamp ?? entry.fact.timestamp ?? entry.fact.timeStart ?? entry.fact.timeCreated)}{entry.sourceOrder ? ` · ${t($language, 'Source order')} ${entry.sourceOrder.record}:${entry.sourceOrder.ordinal}` : ''}</p>
            <p>{t($language, 'Provenance:')} {provenance(entry.fact)}</p>
            {#if entry.fact.version?.readerEvent ?? entry.fact.readerEvent}
              {@const readerEvent = (entry.fact.version?.readerEvent ?? entry.fact.readerEvent)!}
              <a href={'#event?' + new URLSearchParams({ messageId: readerEvent.messageId, segment: readerEvent.segment })}
                onclick={(click) => openReader(click, readerEvent)}>{t($language, 'Open in conversation')}</a>
            {/if}
            {#if entry.fact.transformation?.eventId ?? entry.fact.evidence?.eventId}
              <a href={runtimeEventDetailUrl(provider, sessionId, (entry.fact.transformation?.eventId ?? entry.fact.evidence?.eventId)!, readerRevision)} target="_blank" rel="noopener noreferrer">{t($language, 'Inspect source event')}</a>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
    <div class="runtime-pagination"><span>{page.entries.length} {t($language, 'entries on this page')} · {page.scannedEntries} {t($language, 'scanned')}</span>
      {#if page.nextCursor}<button onclick={() => void load(page!.nextCursor)}>{t($language, 'Next page')}</button>{/if}
    </div>
  {/if}
</section>
