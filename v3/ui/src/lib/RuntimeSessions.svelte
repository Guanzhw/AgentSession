<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { SessionRef } from './api';
  import { RuntimeApiError } from './api';
  import { getRuntimeGraph, type RuntimeGraph } from './runtime-projections';
  import { language, protocolLabel, t } from './i18n';

  export let provider: string;
  export let sessionId: string;
  export let readerRevision: string;
  export let focusNodeId: string | null = null;
  export let onOpenSession: (session: SessionRef, nodeId: string) => void;

  let graph: RuntimeGraph | null = null;
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
    graph = null;
    message = '';
    try {
      const result = await getRuntimeGraph(provider, sessionId, 100);
      if (!active || generation !== request) return;
      if (result.revision !== readerRevision || result.focus.provider !== provider || result.focus.sessionId !== sessionId) {
        state = 'stale';
        return;
      }
      graph = result;
      state = 'ready';
      if (focusNodeId) {
        await tick();
        if (active && generation === request) {
          [...document.querySelectorAll<HTMLAnchorElement>('.runtime-graph-node[data-node-id] a')]
            .find(link => link.closest('.runtime-graph-node')?.getAttribute('data-node-id') === focusNodeId)
            ?.focus();
        }
      }
    } catch (cause) {
      if (!active || generation !== request) return;
      const code = cause instanceof RuntimeApiError ? cause.code : 'request_failed';
      message = cause instanceof Error ? cause.message : String(cause);
      state = code === 'protocol_invalid' ? 'invalid'
        : code === 'protocol_unavailable' || code === 'provider_unavailable' ? 'unavailable'
          : code === 'source_changed' ? 'stale' : 'request';
    }
  }

  function nodeLabel(id: string): string {
    return graph?.nodes.find(node => node.id === id)?.label ?? id;
  }

  function openSession(click: MouseEvent, session: SessionRef, nodeId: string): void {
    if (click.defaultPrevented || click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    onOpenSession(session, nodeId);
  }

  function timeLabel(timestamp: number | null): string {
    if (timestamp === null) return t($language, 'time unavailable');
    const date = new Date(timestamp);
    return Number.isNaN(date.valueOf()) ? t($language, 'time unavailable')
      : new Intl.DateTimeFormat($language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
  }
</script>

<section class="runtime-sessions" aria-labelledby="runtime-sessions-title">
  <div class="runtime-intro"><div><p class="eyebrow">{t($language, 'Recorded relationships')}</p><h2 id="runtime-sessions-title">{t($language, 'Tasks and collaboration')}</h2></div></div>
  {#if state === 'loading'}
    <p class="runtime-state" role="status">{t($language, 'Loading relationship graph…')}</p>
  {:else if state === 'stale'}
    <div class="runtime-state" role="alert"><strong>{t($language, 'Source revision changed')}</strong><p>{t($language, 'Refresh this session to inspect current relationships.')}</p><button onclick={() => window.location.reload()}>{t($language, 'Refresh session')}</button></div>
  {:else if state !== 'ready'}
    <div class="runtime-state" role={state === 'unavailable' ? 'status' : 'alert'}><strong>{state === 'invalid' ? t($language, 'Invalid protocol evidence') : state === 'unavailable' ? t($language, 'Relationship graph unavailable') : t($language, 'Relationship graph request failed')}</strong><p>{message}</p><button onclick={() => void load()}>{t($language, 'Retry')}</button></div>
  {:else if graph}
    <p class="runtime-coverage"><strong>{protocolLabel(graph.coverage, $language)} {t($language, 'coverage')}</strong> · {graph.nodes.length} {t($language, 'of at most')} {graph.maxNodes} {t($language, 'nodes shown.')}{graph.truncated ? ' ' + t($language, 'Graph is truncated at this limit.') : ''}</p>
    <ul class="runtime-coverage-list" aria-label={t($language, 'Relationship evidence coverage')}>
      {#each Object.entries(graph.domainCoverage) as [domain, coverage] (domain)}
        <li><strong>{protocolLabel(domain, $language)}</strong>: {protocolLabel(coverage.state, $language)} · {coverage.details}</li>
      {/each}
    </ul>
    <ol class="runtime-events runtime-graph-nodes" aria-label={t($language, 'Bounded relationship nodes')}>
      {#each graph.nodes as node (node.id)}
        <li class="runtime-event runtime-graph-node" data-node-id={node.id} data-session-id={node.session.sessionId}>
          <div class="runtime-event-heading"><strong>{#if node.kind === 'session' && !node.focus}<a href={'/' + encodeURIComponent(node.session.provider) + '/session/' + encodeURIComponent(node.session.sessionId)} onclick={(click) => openSession(click, node.session, node.id)}>{node.label}</a>{:else}{node.label}{/if}</strong><span>{protocolLabel(node.kind, $language)}</span>{#if node.status}<span>{protocolLabel(node.status, $language)}</span>{/if}</div>
          <p>{node.focus ? t($language, 'Current session') + ' · ' : ''}{node.resolution === 'unverified' ? t($language, 'Related session is unverified') : t($language, 'Resolved in this snapshot')} · {node.session.provider}</p>
          {#if node.timeStart !== null}<p>{t($language, 'Started')} {timeLabel(node.timeStart)}{node.timeEnd !== null ? ` · ${t($language, 'Ended')} ${timeLabel(node.timeEnd)}` : ''}</p>{/if}
          {#if node.provenance}<p>{t($language, 'Provenance:')} {protocolLabel(node.provenance.fidelity, $language)} · {node.provenance.sourceType} #{node.provenance.sourceId ?? '?'}</p>{/if}
        </li>
      {/each}
    </ol>
    {#if graph.edges.length > 0}
      <h3>{t($language, 'Recorded connections')}</h3>
      <ol class="runtime-graph-edges" aria-label={t($language, 'Relationship connections')}>
        {#each graph.edges as edge (edge.id)}
          <li><strong>{nodeLabel(edge.from)}</strong> → <strong>{nodeLabel(edge.to)}</strong> · {protocolLabel(edge.type, $language)} · {protocolLabel(edge.inferred ? 'derived' : edge.provenance.fidelity, $language)}</li>
        {/each}
      </ol>
    {/if}
  {/if}
</section>
