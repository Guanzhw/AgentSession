<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { ReaderEventRef, RelationEntry } from './api';
  import { agentAppearance, collaborationEventKey, layoutTranscriptHandoffs, transcriptEndpointGroups, transcriptHandoffs, type TranscriptHandoffLayout } from './transcript-collaboration';
  import { language, t } from './i18n';

  export let entries: RelationEntry[] = [];
  export let provider: string;
  export let sessionId: string;
  export let host: HTMLElement | null = null;
  export let onNavigate: ((event: ReaderEventRef) => void) | undefined = undefined;

  let layout: TranscriptHandoffLayout[] = [];
  let height = 0;
  let width = 88;
  let mounted = false;
  let frame = 0;
  let observedHost: HTMLElement | null = null;
  let disconnectObservers: () => void = () => {};
  $: handoffs = transcriptHandoffs(entries, { provider, sessionId });
  $: endpointGroups = transcriptEndpointGroups(layout);
  $: connectors = connectorPaths(layout, width);
  $: if (mounted) observeHost(host);
  $: if (mounted && host && handoffs) void tick().then(scheduleMeasure);

  function scheduleMeasure(): void {
    if (!mounted || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; measure(); });
  }

  function measure(): void {
    if (!host) return;
    if (handoffs.length === 0) {
      layout = [];
      return;
    }
    const bounds = host.getBoundingClientRect();
    const points = new Map<string, number>();
    const cards = [...host.querySelectorAll<HTMLElement>('[data-message-id][data-segment]')]
      .filter(card => card.closest('.transcript, .inline-child-transcript') === host);
    const cardsByEvent = new Map(cards.map(card => [
      [provider, sessionId, card.dataset.messageId, card.dataset.segment].join('\0'), card,
    ]));
    for (const handoff of handoffs) for (const event of [handoff.dispatch, handoff.returned]) {
      if (!event) continue;
      const card = cardsByEvent.get(collaborationEventKey(event));
      if (!card) continue;
      let target: HTMLElement = card;
      // Hidden work still has a visible execution disclosure as its recorded anchor.
      for (let parent = card.parentElement; parent && parent !== host; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement && !parent.open) {
          const summary = parent.querySelector<HTMLElement>(':scope > summary');
          if (summary) target = summary;
        }
      }
      if (!target.getClientRects().length) continue;
      points.set(collaborationEventKey(event), target.getBoundingClientRect().top - bounds.top + 18);
    }
    height = host.clientHeight;
    width = Math.max(48, Number.parseFloat(getComputedStyle(host).paddingLeft) - 12);
    layout = layoutTranscriptHandoffs(handoffs, points);
  }

  function connectorPaths(items: TranscriptHandoffLayout[], gutterWidth: number): { item: TranscriptHandoffLayout; d: string; open: boolean }[] {
    const groups = new Map<string, TranscriptHandoffLayout[]>();
    for (const item of items) {
      const group = groups.get(item.correlationId) ?? [];
      group.push(item);
      groups.set(item.correlationId, group);
    }
    const count = Math.max(1, ...items.map(item => item.lane + 1));
    return [...groups.values()].flatMap(group => {
      const item = group[0];
      const x = gutterWidth - 20 - item.lane * Math.min(12, (gutterWidth - 34) / count);
      const dispatch = item.dispatchY;
      const returns = [...new Set(group.flatMap(entry => entry.returnY !== null && entry.returnY !== dispatch ? [entry.returnY] : []))].sort((a, b) => a - b);
      const missingReturn = group.some(entry => entry.returnY === null);
      const paths: { item: TranscriptHandoffLayout; d: string; open: boolean }[] = [];
      const branch = (y: number) => `M ${x} ${y - 5} Q ${x} ${y} ${x + 5} ${y} H ${gutterWidth}`;
      if (returns.length) {
        const last = returns.at(-1)!;
        // A dispatch owns one trunk; each recorded return adds only its own branch.
        const trunk = dispatch !== null
          ? `M ${gutterWidth} ${dispatch} H ${x + 5} Q ${x} ${dispatch} ${x} ${dispatch + 5} V ${last - 5}`
          : `M ${x} ${returns[0] - 5} V ${last - 5}`;
        paths.push({ item, d: `${trunk} ${returns.map(branch).join(' ')}`, open: false });
        if (dispatch === null) paths.push({ item, d: `M ${x} ${returns[0] - 32} V ${returns[0] - 5}`, open: true });
        if (missingReturn) paths.push({ item, d: `M ${x} ${last - 5} V ${last + 32}`, open: true });
      } else if (dispatch !== null && missingReturn) {
        paths.push({ item, d: `M ${gutterWidth} ${dispatch} H ${x + 5} Q ${x} ${dispatch} ${x} ${dispatch + 5} V ${dispatch + 32}`, open: true });
      }
      return paths;
    });
  }

  function eventHref(event: ReaderEventRef): string {
    return '/' + encodeURIComponent(event.provider) + '/session/' + encodeURIComponent(event.sessionId) +
      '#event?' + new URLSearchParams({ messageId: event.messageId, segment: event.segment });
  }

  function navigate(click: MouseEvent, event: ReaderEventRef): void {
    if (!onNavigate || click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    (click.currentTarget as HTMLElement).closest('.collaboration-gutter-group')?.removeAttribute('open');
    onNavigate(event);
  }

  function observeHost(target: HTMLElement | null): void {
    if (target === observedHost) return;
    disconnectObservers();
    observedHost = target;
    if (!target) return;
    const resize = new ResizeObserver(scheduleMeasure);
    resize.observe(target);
    const mutation = new MutationObserver(records => {
      if (records.some(record => !(record.target as Element).closest?.('.transcript-collaboration'))) scheduleMeasure();
    });
    mutation.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    target.addEventListener('toggle', scheduleMeasure, true);
    scheduleMeasure();
    disconnectObservers = () => {
      resize.disconnect(); mutation.disconnect();
      target.removeEventListener('toggle', scheduleMeasure, true);
    };
  }

  onMount(() => {
    mounted = true;
    return () => {
      mounted = false;
      disconnectObservers();
      if (frame) cancelAnimationFrame(frame);
    };
  });
</script>

{#if layout.length > 0}
  <div class="transcript-collaboration" style:width={`${width}px`} style:height={`${height}px`} aria-label={t($language, 'Delegated agents')}>
    <svg {width} {height} aria-hidden="true">
      {#each connectors as connector}
        <path data-collaboration-connector={connector.item.correlationId} data-collaboration-lane={connector.item.lane}
          class:open-span={connector.open}
          style:stroke={agentAppearance(connector.item.agentKey).color} d={connector.d} />
      {/each}
    </svg>
    {#each endpointGroups as group (group.y)}
      {#if group.choices.length === 1}
        {@const choice = group.choices[0]}
        {@const label = `${choice.agent ?? t($language, 'Unknown agent')} · ${t($language, choice.event ? (choice.kind === 'dispatch' ? 'Jump to return' : 'Jump to dispatch') : (choice.kind === 'dispatch' ? 'Requested' : 'Returned result'))}`}
        {@const appearance = agentAppearance(choice.agentKey)}
        {#if choice.event}
          <a class="collaboration-gutter-point" class:dispatch-point={choice.kind === 'dispatch'} class:return-point={choice.kind === 'return'}
            style:top={`${group.y - 11}px`} style:left={`${width - 31}px`} style:color={appearance.color} style:border-color={appearance.color}
            href={eventHref(choice.event)} title={label} aria-label={label} onclick={(event) => navigate(event, choice.event!)}>
            <svg class="agent-icon" viewBox="0 0 5 5" aria-hidden="true"><path d={appearance.icon} /></svg>
          </a>
        {:else}
          <details class="collaboration-gutter-group" style:top={`${group.y - 11}px`} style:left={`${width - 31}px`}>
            <summary class="collaboration-gutter-point pending-point" class:dispatch-point={choice.kind === 'dispatch'} class:return-point={choice.kind === 'return'}
              style:color={appearance.color} style:border-color={appearance.color} title={label} aria-label={label}>
              <svg class="agent-icon" viewBox="0 0 5 5" aria-hidden="true"><path d={appearance.icon} /></svg>
            </summary>
            <div class="collaboration-gutter-choices pending-choice">{label}</div>
          </details>
        {/if}
      {:else}
        {@const sameAgent = group.choices.every(choice => choice.agentKey === group.choices[0].agentKey)}
        {@const appearance = agentAppearance(group.choices[0].agentKey)}
        {@const destination = group.choices.every(choice => choice.kind === 'dispatch') ? 'Return destinations' : group.choices.every(choice => choice.kind === 'return') ? 'Dispatch destinations' : 'Collaboration destinations'}
        {@const label = `${sameAgent ? (group.choices[0].agent ?? t($language, 'Unknown agent')) + ' · ' : ''}${t($language, destination)} · ${group.choices.length}`}
        <details class="collaboration-gutter-group" style:top={`${group.y - 11}px`} style:left={`${width - 31}px`}>
          <summary class="collaboration-gutter-point" style:color={sameAgent ? appearance.color : undefined} style:border-color={sameAgent ? appearance.color : undefined}
            title={label} aria-label={label}>
            {#if sameAgent}<svg class="agent-icon" viewBox="0 0 5 5" aria-hidden="true"><path d={appearance.icon} /></svg>{:else}{group.choices.length}{/if}
          </summary>
          <ul class="collaboration-gutter-choices">
            {#each group.choices as choice, index (choice.id)}
              {@const appearance = agentAppearance(choice.agentKey)}
              <li style:color={appearance.color}>
                {#if choice.event}
                  <a href={eventHref(choice.event)} class:dispatch-point={choice.kind === 'dispatch'} class:return-point={choice.kind === 'return'}
                    onclick={(event) => navigate(event, choice.event!)}>
                    <svg class="agent-icon" viewBox="0 0 5 5" aria-hidden="true"><path d={appearance.icon} /></svg>
                    {choice.agent ?? t($language, 'Unknown agent')} · {t($language, choice.kind === 'dispatch' ? 'Jump to return' : 'Jump to dispatch')} {index + 1}
                  </a>
                {:else}
                  <span class="pending-choice"><svg class="agent-icon" viewBox="0 0 5 5" aria-hidden="true"><path d={appearance.icon} /></svg>
                    {choice.agent ?? t($language, 'Unknown agent')} · {t($language, choice.kind === 'dispatch' ? 'Requested' : 'Returned result')}
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .transcript-collaboration { position: absolute; top: 0; left: 0; pointer-events: none; }
  .transcript-collaboration > svg { position: absolute; inset: 0; overflow: visible; }
  .transcript-collaboration > svg path { fill: none; stroke-width: 1.5; opacity: .6; }
  .open-span { stroke-dasharray: 3 3; }
  .agent-icon { width: 12px; height: 12px; flex: none; }
  .agent-icon path { fill: currentColor; }
  .collaboration-gutter-point { position: absolute; display: grid; place-items: center; box-sizing: border-box; width: 22px; height: 22px; padding: 0; margin: 0; border: 1px solid var(--line); border-radius: 50%; background: var(--paper); color: var(--muted); pointer-events: auto; font-size: 11px; line-height: 1; text-decoration: none; }
  .collaboration-gutter-group { position: absolute; pointer-events: auto; }
  .collaboration-gutter-group > summary { position: relative; cursor: pointer; list-style: none; }
  .collaboration-gutter-group > summary::-webkit-details-marker { display: none; }
  .collaboration-gutter-group[open] { z-index: 2; }
  .collaboration-gutter-choices { position: absolute; top: 22px; left: 0; width: max-content; max-width: 340px; padding: .4rem; margin: .25rem 0 0; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); box-shadow: 0 4px 14px #0002; list-style: none; }
  .collaboration-gutter-choices a, .pending-choice { display: flex; align-items: center; gap: .5rem; padding: .5rem .6rem; color: inherit; font-size: .8rem; overflow-wrap: anywhere; text-decoration: none; }
  .collaboration-gutter-choices a:hover, .collaboration-gutter-choices a:focus-visible { background: var(--blue-pale); outline: 1px solid var(--blue); }
  .pending-point { border-style: dashed; }
  .collaboration-gutter-point:hover, .collaboration-gutter-point:focus-visible { color: var(--blue); outline: 2px solid var(--blue); outline-offset: 3px; }
</style>
