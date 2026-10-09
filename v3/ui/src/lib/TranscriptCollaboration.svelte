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
  $: if (mounted) observeHost(host);
  $: if (mounted && host && handoffs) void tick().then(scheduleMeasure);

  function scheduleMeasure(): void {
    if (!mounted || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; measure(); });
  }

  function measure(): void {
    if (!host) return;
    const bounds = host.getBoundingClientRect();
    const points = new Map<string, number>();
    const cards = [...host.querySelectorAll<HTMLElement>('[data-message-id][data-segment]')]
      .filter(card => card.closest('.transcript, .inline-child-transcript') === host);
    for (const handoff of handoffs) for (const event of [handoff.dispatch, handoff.returned]) {
      if (!event) continue;
      const card = cards.find(item => item.dataset.messageId === event.messageId && item.dataset.segment === event.segment);
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

  function laneX(lane: number): number {
    const count = Math.max(1, ...layout.map(item => item.lane + 1));
    return width - 20 - lane * Math.min(12, (width - 34) / count);
  }

  function path(item: TranscriptHandoffLayout): string {
    const x = laneX(item.lane);
    // Open spans show a short continuation, never an invented return at the page bottom.
    if (item.returnY === null) return `M ${width} ${item.dispatchY} H ${x + 5} Q ${x} ${item.dispatchY} ${x} ${item.dispatchY! + 5} V ${item.dispatchY! + 32}`;
    if (item.dispatchY === null) return `M ${x} ${item.returnY - 32} V ${item.returnY - 5} Q ${x} ${item.returnY} ${x + 5} ${item.returnY} H ${width}`;
    const start = item.dispatchY;
    const end = item.returnY;
    return `M ${width} ${start} H ${x + 5} Q ${x} ${start} ${x} ${start + 5} V ${end - 5} Q ${x} ${end} ${x + 5} ${end} H ${width}`;
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
      {#each layout as item (item.id)}
        {#if item.dispatchY !== item.returnY}
          <path data-collaboration-connector={item.correlationId} data-collaboration-lane={item.lane}
            class:open-span={item.dispatchY === null || item.returnY === null}
            style:stroke={agentAppearance(item.agentKey).color} d={path(item)} />
        {/if}
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
        <details class="collaboration-gutter-group" style:top={`${group.y - 11}px`} style:left={`${width - 31}px`}>
          <summary class="collaboration-gutter-point" title={t($language, 'Delegated agents') + ' · ' + group.choices.length}
            aria-label={t($language, 'Delegated agents') + ' · ' + group.choices.length}>{group.choices.length}</summary>
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
