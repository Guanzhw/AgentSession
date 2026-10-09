<script lang="ts">
  import type { ReaderEventRef, ReaderItem, RelationEntry, SessionRef } from './api';
  import { actorLabel as shortActorLabel, agentAppearance, collaborationEventKey, coordinationIdentity } from './transcript-collaboration';
  import { language, protocolLabel, t } from './i18n';

  export let entries: RelationEntry[] = [];
  export let items: ReaderItem[] = [];
  export let compact = false;
  export let complete = false;
  export let session: SessionRef | null = null;
  export let onOpenChild: ((session: SessionRef) => void) | undefined = undefined;
  export let onNavigate: ((event: ReaderEventRef) => void) | undefined = undefined;

  type Observation = Extract<RelationEntry, { type: 'coordination' }>['observation'];
  type Handoff = { id: string; observations: Observation[] };
  let selectedId: string | null = null;

  $: observations = entries.flatMap(entry => entry.type === 'coordination' ? [entry.observation] : []);
  $: handoffs = groupHandoffs(observations);
  $: shown = compact ? handoffs.slice(0, 3) : handoffs;
  $: branches = groupBranches(shown, entries, session);
  $: messages = observations.filter(item => item.kind !== 'spawn' && item.kind !== 'result' && item.messageExcerpt);

  function groupHandoffs(items: Observation[]): Handoff[] {
    const groups = new Map<string, Handoff>();
    for (const item of items) {
      if (item.kind !== 'spawn' && item.kind !== 'result') continue;
      let group = groups.get(item.correlationId);
      if (!group) {
        group = { id: item.correlationId, observations: [] };
        groups.set(item.correlationId, group);
      }
      group.observations.push(item);
    }
    return [...groups.values()];
  }

  function sender(group: Handoff): string {
    const request = group.observations.find(item => item.kind === 'spawn');
    const returned = group.observations.find(item => item.kind === 'result');
    return request?.fromParticipant?.name ?? request?.fromActorPath
      ?? returned?.toParticipant?.name ?? returned?.toActorPath ?? t($language, 'Unknown agent');
  }

  function recipient(group: Handoff): string {
    const started = group.observations.find(item => item.kind === 'spawn' && item.state === 'started');
    const request = group.observations.find(item => item.kind === 'spawn');
    const returned = group.observations.find(item => item.kind === 'result');
    return started?.toParticipant?.name ?? started?.toActorPath
      ?? request?.toParticipant?.name ?? request?.toActorPath
      ?? returned?.fromParticipant?.name ?? returned?.fromActorPath ?? t($language, 'Unknown agent');
  }

  function groupBranches(groups: Handoff[], relations: RelationEntry[], sourceSession: SessionRef | null) {
    const observed = relations.flatMap(entry => entry.type === 'coordination' ? [entry.observation] : []);
    const branches = new Map<string, { key: string; label: string; children: { group: Handoff; key: string }[] }>();
    for (const group of groups) {
      const spawn = group.observations.find(item => item.kind === 'spawn' && item.state === 'requested')
        ?? group.observations.find(item => item.kind === 'spawn');
      const returned = group.observations.find(item => item.kind === 'result');
      const observation = spawn ?? returned!;
      const source = sourceSession ?? group.observations.find(item => item.readerEvent)?.readerEvent
        ?? spawn?.fromSessionRef ?? returned?.toSessionRef;
      const identity = source ? coordinationIdentity(observation, source, observed) : null;
      const parentKey = (spawn ? identity?.fromKey : identity?.toKey) ?? `unknown-sender:${group.id}`;
      const childKey = (spawn ? identity?.toKey : identity?.fromKey) ?? `unknown-recipient:${group.id}`;
      const branch = branches.get(parentKey) ?? { key: parentKey, label: sender(group), children: [] };
      branch.children.push({ group, key: childKey });
      branches.set(parentKey, branch);
    }
    return [...branches.values()];
  }

  function actorLabel(value: string): string {
    return value === '/root' ? t($language, 'Main assistant') : shortActorLabel(value) ?? value;
  }

  function preview(observation: Observation, readerItems: ReaderItem[]): string | null {
    if (observation.messageExcerpt) return observation.messageExcerpt;
    const event = observation.readerEvent;
    if (!event) return null;
    return readerItems.find(item => collaborationEventKey(item.event) === collaborationEventKey(event))?.preview ?? null;
  }

  function stateLabel(state: string): string {
    const names = { requested: 'Requested', started: 'Started', failed: 'Failed', completed: 'Completed' } as const;
    return state in names ? t($language, names[state as keyof typeof names]) : protocolLabel(state, $language);
  }

  function contextLabel(value: string): string {
    if (value === 'none') return t($language, 'Fresh context requested');
    if (value === 'all') return t($language, 'Full context requested');
    return `${t($language, 'Requested context')}: ${value}`;
  }

  function child(group: Handoff): SessionRef | null {
    return group.observations.find(item => item.kind === 'spawn' && item.state === 'started' && item.toSessionRef)?.toSessionRef ?? null;
  }

  function sessionHref(session: SessionRef): string {
    return '/' + encodeURIComponent(session.provider) + '/session/' + encodeURIComponent(session.sessionId);
  }

  function openChild(click: MouseEvent, session: SessionRef): void {
    if (!onOpenChild || click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    click.preventDefault();
    onOpenChild(session);
  }
</script>

{#if handoffs.length > 0 || messages.length > 0}
  <section class="collaboration-timeline" class:compact aria-label={t($language, 'Delegated agents')}>
    <div class="collaboration-timeline-heading">
      <strong>{t($language, 'Delegated agents')} · {handoffs.length}</strong>
      {#if !complete}<span>{t($language, 'Partial collaboration history')}</span>{/if}
    </div>
    <div class="collaboration-graph">
      {#each branches as branch (branch.key)}
        {@const parentAppearance = agentAppearance(branch.key)}
        <div class="collaboration-branch">
          <div class="collaboration-parent" style:--agent-color={parentAppearance.color}>
            <svg viewBox="0 0 5 5" aria-hidden="true"><path d={parentAppearance.icon}/></svg>
            <strong title={branch.label}>{actorLabel(branch.label)}</strong>
          </div>
          <ol class="collaboration-handoffs">
      {#each branch.children as node (node.group.id)}
        {@const group = node.group}
        {@const appearance = agentAppearance(node.key)}
        {@const request = group.observations.find(item => item.launchRequest)?.launchRequest}
        {@const childSession = child(group)}
        {@const dispatched = group.observations.find(item => item.kind === 'spawn' && item.readerEvent)}
        {@const results = group.observations.filter(item => item.kind === 'result')}
        <li class="collaboration-handoff" class:selected={selectedId === group.id} data-collaboration-handoff={group.id} style:--agent-color={appearance.color}>
          <button class="collaboration-child-node" type="button" disabled={compact} aria-expanded={compact ? undefined : selectedId === group.id} onclick={() => selectedId = selectedId === group.id ? null : group.id}>
            <svg viewBox="0 0 5 5" aria-hidden="true"><path d={appearance.icon}/></svg>
            <strong title={recipient(group)}>{actorLabel(recipient(group))}</strong>
            <span class="collaboration-state">{stateLabel(group.observations[group.observations.length - 1].state)}</span>
          </button>
          {#if !compact && selectedId === group.id}
            <div class="collaboration-selected-details">
            {#if dispatched?.messageExcerpt}<p class="collaboration-task-preview">{dispatched.messageExcerpt}{dispatched.messageExcerptTruncated ? '…' : ''}</p>{/if}
            <div class="collaboration-handoff-actions">
              {#if dispatched?.readerEvent && onNavigate}<button type="button" onclick={() => onNavigate?.(dispatched.readerEvent!)}>{t($language, 'Jump to dispatch')}</button>
              {:else if dispatched?.readerEvent}<a href={sessionHref(dispatched.readerEvent) + '#event?' + new URLSearchParams({ messageId: dispatched.readerEvent.messageId, segment: dispatched.readerEvent.segment })}>{t($language, 'Jump to dispatch')}</a>{/if}
              {#if childSession}<a href={sessionHref(childSession)} onclick={(event) => openChild(event, childSession)}>{t($language, 'Open child conversation')}</a>{/if}
            </div>
            {#each results as result (result.eventId)}
              <div class="collaboration-return">
                {#if preview(result, items)}<p>{preview(result, items)}</p>{/if}
                {#if result.readerEvent && onNavigate}<button type="button" onclick={() => onNavigate?.(result.readerEvent!)}>{t($language, 'Jump to return')}</button>
                {:else if result.readerEvent}<a href={sessionHref(result.readerEvent) + '#event?' + new URLSearchParams({ messageId: result.readerEvent.messageId, segment: result.readerEvent.segment })}>{t($language, 'Jump to return')}</a>{/if}
              </div>
            {/each}
            <details class="collaboration-source-details">
              <summary>{t($language, 'Technical details')}</summary>
              <div class="collaboration-request-tags">
                {#if request?.model}<span>{t($language, 'Requested model')}: <strong>{request.model}</strong></span>{/if}
                {#if request?.reasoningEffort}<span>{t($language, 'Requested reasoning')}: {request.reasoningEffort}</span>{/if}
                {#if request?.forkTurns}<span>{contextLabel(request.forkTurns)}</span>{/if}
              </div>
              <p>{group.id}</p>
              {#each group.observations as observation (observation.eventId)}
                <p>{stateLabel(observation.state)} · {observation.eventId} · {observation.provenance.fidelity} · {observation.provenance.sourceType} #{observation.provenance.sourceId}</p>
              {/each}
            </details>
            </div>
          {/if}
        </li>
      {/each}
          </ol>
        </div>
      {/each}
    </div>
    {#if !compact && messages.length > 0}
      <details class="collaboration-message-disclosure">
        <summary>{t($language, 'Recorded agent messages')} · {messages.length}</summary>
      <ol class="collaboration-messages" aria-label={t($language, 'Recorded agent messages')}>
        {#each messages as observation (observation.eventId)}
          <li><strong>{observation.fromParticipant?.name ?? observation.fromActorPath ?? t($language, 'Agent')}</strong> → <strong>{observation.toParticipant?.name ?? observation.toActorPath ?? t($language, 'Agent')}</strong> · {protocolLabel(observation.state, $language)}
            <p>{observation.messageExcerpt}{observation.messageExcerptTruncated ? '…' : ''}</p>
            {#if observation.readerEvent && onNavigate}<button type="button" onclick={() => onNavigate?.(observation.readerEvent!)}>{t($language, 'Related reply')}</button>{/if}
          </li>
        {/each}
      </ol>
      </details>
    {/if}
  </section>
{/if}

<style>
  .collaboration-timeline { border: 1px solid var(--line); border-radius: 10px; padding: 1rem; margin: 0 0 1rem; }
  .collaboration-timeline-heading { display: flex; align-items: baseline; gap: .55rem; flex-wrap: wrap; }
  .collaboration-timeline-heading { justify-content: space-between; }
  .collaboration-timeline-heading > span, .collaboration-state { color: var(--muted); font-size: .8rem; }
  .collaboration-graph { display: grid; gap: 1rem; margin-top: 1rem; }
  .collaboration-branch { display: grid; grid-template-columns: minmax(70px, 110px) minmax(0, 1fr); gap: 30px; align-items: start; }
  .collaboration-parent { display: flex; align-items: center; gap: .5rem; min-height: 44px; padding: .4rem 0; font-size: .8rem; }
  .collaboration-parent strong { overflow-wrap: anywhere; }
  .collaboration-parent svg, .collaboration-child-node svg { width: 18px; height: 18px; flex: 0 0 18px; fill: var(--agent-color); }
  .collaboration-handoffs { list-style: none; padding: 0; margin: 0; position: relative; }
  .collaboration-handoffs::before { content: ''; position: absolute; left: -16px; top: 22px; bottom: 22px; border-left: 1px solid var(--line); }
  .collaboration-handoff { position: relative; }
  .collaboration-handoff + .collaboration-handoff { margin-top: .55rem; }
  .collaboration-child-node { position: relative; display: flex; align-items: center; gap: .6rem; width: 100%; min-height: 44px; padding: .5rem .65rem; border: 1px solid var(--line); border-left: 3px solid var(--agent-color); border-radius: 7px; background: var(--paper); color: var(--ink); text-align: left; cursor: pointer; }
  .collaboration-child-node::before { content: ''; position: absolute; width: 16px; left: -19px; top: 20px; border-top: 1px solid var(--agent-color); }
  .collaboration-handoff:first-child .collaboration-child-node::before { width: 30px; left: -33px; }
  .collaboration-child-node strong { min-width: 0; overflow-wrap: anywhere; flex: 1; font-size: .85rem; }
  .collaboration-child-node:hover, .selected .collaboration-child-node { background: var(--surface-subtle); border-color: var(--agent-color); }
  .collaboration-child-node:focus-visible { outline: 2px solid var(--agent-color); outline-offset: 3px; }
  .collaboration-selected-details { padding: .35rem .7rem .7rem; font-size: .85rem; }
  .collaboration-messages { list-style: none; padding: 0; margin: .75rem 0 0; }
  .collaboration-messages li + li { border-top: 1px solid var(--line); padding-top: .8rem; margin-top: .8rem; }
  .collaboration-message-disclosure { margin-top: .9rem; font-size: .85rem; }
  .collaboration-request-tags, .collaboration-handoff-actions { display: flex; flex-wrap: wrap; gap: .5rem 1rem; margin-top: .55rem; font-size: .85rem; }
  .collaboration-request-tags span { background: var(--surface-subtle); border-radius: 5px; padding: .2rem .4rem; }
  .collaboration-source-details { color: var(--muted); font-size: .78rem; margin-top: .65rem; overflow-wrap: anywhere; }
  .collaboration-source-details p { margin: .35rem 0; }
  .collaboration-task-preview, .collaboration-return p { margin: .55rem 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; }
  .collaboration-return { margin-top: .7rem; padding-left: .75rem; border-left: 2px solid var(--agent-color); font-size: .85rem; }
  .compact { padding: .65rem .8rem; }
  .compact .collaboration-graph { gap: .5rem; margin-top: .5rem; }
  .compact .collaboration-branch { grid-template-columns: minmax(60px, 90px) minmax(0, 1fr); }
  @media (max-width: 460px) { .collaboration-branch { grid-template-columns: 70px minmax(0, 1fr); gap: 24px; } }
</style>
