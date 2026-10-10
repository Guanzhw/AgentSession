<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { language, t } from './i18n';
  import InlineChildReader from './InlineChildReader.svelte';
  import type { ContentField, ContentProgress, ReaderBootstrap, ReaderChildPlacement, ReaderCollaborationSnapshot, ReaderEventRef, ReaderItem, ReaderSearchMatch, ReaderSearchTarget, ReaderSegment, RelationEntry, SessionRef } from './api';
  import { getContentPage, getReaderBootstrap, getReaderChildLocation, getReaderLocation, getReaderRelations, getReaderSegment } from './api';
  import EventCard, { type DisplayItem, type SearchReveal } from './EventCard.svelte';
  import InheritedContext from './InheritedContext.svelte';
  import TranscriptCollaboration from './TranscriptCollaboration.svelte';
  import ReaderContinuation from './ReaderContinuation.svelte';
  import { readerCollaborationIdentity, transcriptHandoffs } from './transcript-collaboration';
  import PaneSearch, { type PaneSearchState } from './PaneSearch.svelte';
  import { groupReaderItems, groupReaderProcesses, type ReaderBlock } from './reader-presentation';

  export let child: SessionRef;
  export let ancestors: SessionRef[];
  export let activeChildPath: SessionRef[];
  export let selectedChildSearch: ReaderSearchTarget | null;
  export let selectionHistoryVersion: number;
  export let paneSearchStates: Record<string, PaneSearchState>;
  export let onPaneSearchChange: (source: SessionRef, state: PaneSearchState) => void;
  export let onSearchSelection: (target: ReaderSearchTarget) => void;
  export let onCollaborationUpdate: (session: SessionRef,
    snapshot: ReaderCollaborationSnapshot | null) => void;
  export let onChildPathChange: (path: SessionRef[], fallbackEvent?: ReaderEventRef, focusChild?: SessionRef) => void | Promise<void>;
  export let onCollapse: () => void;

  let bootstrap: ReaderBootstrap | null = null;
  let segments: ReaderSegment[] = [];
  let content: Record<string, ContentProgress> = {};
  let searchReveals: Record<string, SearchReveal> = {};
  let searchSelectionGeneration = 0;
  let error = '';
  let loading = true;
  let pageLoading = false;
  let childPlacements: ReaderChildPlacement[] = [];
  let relationEntries: RelationEntry[] = [];
  let relationCursor: string | null = null;
  let relationLoading = false;
  let relationError = '';
  let relationGeneration = 0;
  let restoreGeneration = 0;
  let restoredSelectionVersion = -1;
  let active = true;
  let transcriptElement: HTMLElement | null = null;
  $: headingTag = (['h2', 'h3', 'h4', 'h5', 'h6'] as const)[Math.min(ancestors.length - 1, 4)];
  $: ordered = [...segments].sort((a, b) => a.startOrdinal - b.startOrdinal);
  $: items = ordered.flatMap(page => page.items);
  $: hasTranscriptHandoffs = transcriptHandoffs(relationEntries, child).length > 0;
  $: if (relationCursor && !relationLoading && !relationError && items.some(item =>
    item.role === 'agent' && !readerCollaborationIdentity(relationEntries, item.event))) void loadRelations();
  $: blocks = groupReaderItems(items, display);
  $: processUnits = groupReaderProcesses(blocks);
  $: continuationCursor = nextUnreadCursor(ordered);
  $: expandedChildKey = activeChildPath.length > ancestors.length
    ? childKey(activeChildPath[ancestors.length]) : '';
  $: if (expandedChildKey && bootstrap) void restoreNestedAnchor(expandedChildKey);
  $: if (bootstrap && restoredSelectionVersion !== selectionHistoryVersion) {
    restoredSelectionVersion = selectionHistoryVersion;
    searchSelectionGeneration++;
    searchReveals = {};
    if (!paneSearchStates[childKey(child)]?.selected && selectedChildSearch?.event.provider === child.provider &&
      selectedChildSearch.event.sessionId === child.sessionId) {
      void openSearchMatch(selectedChildSearch, false).catch(cause => {
        if (active) error = cause instanceof Error ? cause.message : 'The selected child content could not be restored.';
      });
    }
  }
  $: placementsByAnchor = childPlacements.reduce((map, placement) => {
    if (placement.afterEvent) {
      const key = eventKey(placement.afterEvent);
      map.set(key, [...(map.get(key) ?? []), placement]);
    }
    return map;
  }, new Map<string, ReaderChildPlacement[]>());

  function childKey(session: SessionRef): string {
    return session.provider + '\0' + session.sessionId;
  }

  function childButtonId(session: SessionRef): string {
    return 'child-toggle-' + Array.from(new TextEncoder().encode(childKey(session)),
      byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function childExpanded(session: SessionRef): boolean {
    return activeChildPath.length > ancestors.length &&
      childKey(activeChildPath[ancestors.length]) === childKey(session);
  }

  function eventKey(event: ReaderEventRef): string {
    return JSON.stringify([event.provider, event.sessionId, event.messageId, event.segment]);
  }

  function key(item: ReaderItem): string {
    return eventKey(item.event);
  }

  function anchor(event: ReaderEventRef): string {
    return 'inline-' + Array.from(new TextEncoder().encode(eventKey(event)),
      byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function display(item: ReaderItem): DisplayItem {
    return { item, key: key(item), anchor: anchor(item.event) };
  }

  function nextUnreadCursor(pages: ReaderSegment[]): string | null {
    for (let index = 0; index < pages.length - 1; index++) {
      if (pages[index + 1].startOrdinal > pages[index].startOrdinal + pages[index].items.length) {
        return pages[index].nextCursor;
      }
    }
    return pages.at(-1)?.nextCursor ?? null;
  }

  onMount(() => {
    void getReaderBootstrap(child.provider, child.sessionId).then(result => {
      if (!active) return;
      bootstrap = result;
      segments = result.segments;
      relationCursor = result.relations?.firstCursor ?? null;
      void preloadOpeningReply(result);
      reportCollaboration();
      if (relationCursor) void loadRelations();
    }).catch(cause => {
      if (active) error = cause instanceof Error ? cause.message : 'Child source could not be opened.';
    }).finally(() => { if (active) loading = false; });
    return () => {
      active = false; searchSelectionGeneration++; relationGeneration++; restoreGeneration++;
      onCollaborationUpdate(child, null);
    };
  });

  function reportCollaboration(): void {
    if (!bootstrap) return;
    onCollaborationUpdate(child, {
      revision: bootstrap.revision,
      summary: bootstrap.relations,
      entries: relationEntries,
      nextCursor: relationCursor,
      loading: relationLoading,
      error: relationError,
    });
  }

  async function restoreNestedAnchor(targetKey: string): Promise<void> {
    if (!bootstrap) return;
    const target = activeChildPath[ancestors.length];
    const request = ++restoreGeneration;
    relationError = '';
    try {
      let placement = childPlacements.find(row => childKey(row.child) === targetKey);
      const response = placement?.afterEvent ? null
        : await getReaderChildLocation(child.provider, child.sessionId, bootstrap.revision, target);
      if (!active || request !== restoreGeneration || expandedChildKey !== targetKey) return;
      placement ??= response?.placement ?? undefined;
      const location = response ? response.location : placement?.afterEvent
        ? await getReaderLocation(child.provider, child.sessionId, bootstrap.revision, placement.afterEvent) : null;
      if (!active || request !== restoreGeneration || expandedChildKey !== targetKey) return;
      if (!placement || !location) throw new Error(t($language, 'The recorded child insertion point is unavailable.'));
      if (location.revision !== bootstrap.revision || location.session.provider !== child.provider ||
        location.session.sessionId !== child.sessionId) throw new Error('The child source changed. Reload this history.');
      if (!childPlacements.some(row => childKey(row.child) === targetKey)) {
        childPlacements = [...childPlacements, placement];
      }
      if (!segments.some(page => location.ordinal >= page.startOrdinal &&
        location.ordinal < page.startOrdinal + page.items.length)) {
        const response = await getReaderSegment(child.provider, child.sessionId, location.pageCursor);
        if (!active || request !== restoreGeneration || expandedChildKey !== targetKey) return;
        if (response.revision !== bootstrap.revision || response.session.provider !== child.provider ||
          response.session.sessionId !== child.sessionId) throw new Error('The child source changed. Reload this history.');
        if (!segments.some(page => page.pageId === response.page.pageId)) {
          segments = [...segments, response.page];
        }
      }
      await tick();
      if (active && request === restoreGeneration && expandedChildKey === targetKey) {
        const button = document.getElementById(childButtonId(placement.child));
        button?.focus();
        button?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      }
    } catch (cause) {
      if (active && request === restoreGeneration) relationError = cause instanceof Error
        ? cause.message : 'The nested child insertion point could not be restored.';
    }
  }

  async function loadRelations(): Promise<void> {
    if (!relationCursor || relationLoading || !bootstrap) return;
    const request = ++relationGeneration;
    const cursor = relationCursor;
    relationLoading = true;
    relationError = '';
    reportCollaboration();
    try {
      const response = await getReaderRelations(child.provider, child.sessionId, cursor);
      if (!active || request !== relationGeneration) return;
      if (response.revision !== bootstrap.revision || response.session.provider !== child.provider ||
          response.session.sessionId !== child.sessionId) {
        throw new Error('The child work changed while this pane was open. Reload the parent session.');
      }
      const seen = new Set(childPlacements.map(placement => childKey(placement.child)));
      relationEntries = [...relationEntries, ...response.entries];
      childPlacements = [...childPlacements, ...response.childPlacements.filter(placement => {
        const key = childKey(placement.child);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })];
      relationCursor = response.nextCursor;
      reportCollaboration();
    } catch (cause) {
      if (active && request === relationGeneration) {
        relationError = cause instanceof Error ? cause.message : 'Child work could not be loaded.';
      }
    } finally {
      if (active && request === relationGeneration) relationLoading = false;
      if (active && request === relationGeneration) reportCollaboration();
    }
  }

  function resetPaneSearch(): void {
    searchSelectionGeneration++;
    searchReveals = {};
  }

  async function openSearchMatch(match: ReaderSearchTarget, updateHistory = true, restorePane = false): Promise<void> {
    if (!bootstrap) return;
    const request = ++searchSelectionGeneration;
    const location = await getReaderLocation(child.provider, child.sessionId, bootstrap.revision, match.event);
    if (!active || request !== searchSelectionGeneration) return;
    const alreadyLoaded = segments.some(page => location.ordinal >= page.startOrdinal &&
      location.ordinal < page.startOrdinal + page.items.length);
    if (!alreadyLoaded) {
      const response = await getReaderSegment(child.provider, child.sessionId, location.pageCursor);
      if (!active || request !== searchSelectionGeneration) return;
      if (response.revision !== bootstrap.revision || response.session.provider !== child.provider ||
          response.session.sessionId !== child.sessionId) {
        throw new Error('The child source changed. Reload this history before opening the match.');
      }
      // A nested-path restoration can finish the same page while search waits.
      if (!segments.some(page => page.pageId === response.page.pageId)) {
        segments = [...segments, response.page];
      }
    }
    const page = await getContentPage(child.provider, child.sessionId, match.event,
      bootstrap.revision, match.offset, match.field, Math.max(1400, match.matchLength));
    if (!active || request !== searchSelectionGeneration) return;
    if (page.offset !== match.offset || page.text.length < match.matchLength) {
      throw new Error('The child content changed. Reload this history and search again.');
    }
    searchReveals = { [eventKey(match.event)]: { field: match.field,
      offset: match.offset, matchLength: match.matchLength, text: page.text,
      totalChars: page.totalChars } };
    if (updateHistory) onSearchSelection(match);
    await tick();
    if (!active || request !== searchSelectionGeneration) return;
    const target = document.getElementById(anchor(match.event));
    for (let ancestor = target?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    }
    if (!restorePane) {
      const region = target?.querySelector<HTMLElement>('.search-reveal');
      region?.focus({ preventScroll: true });
      const mark = region?.querySelector('mark');
      if (mark) mark.scrollIntoView({ behavior: 'instant', block: 'center' });
      else target?.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
  }

  async function nextPage(): Promise<void> {
    const cursor = continuationCursor;
    if (!cursor || pageLoading) return;
    pageLoading = true;
    error = '';
    try {
      const response = await getReaderSegment(child.provider, child.sessionId, cursor);
      if (!bootstrap || response.revision !== bootstrap.revision ||
          response.session.provider !== child.provider || response.session.sessionId !== child.sessionId) {
        throw new Error('The child source changed while this pane was open. Reload the parent session.');
      }
      if (active && !segments.some(page => page.pageId === response.page.pageId)) {
        segments = [...segments, response.page];
      }
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : 'Child continuation could not be loaded.';
    } finally { if (active) pageLoading = false; }
  }

  async function preloadOpeningReply(initial: ReaderBootstrap): Promise<void> {
    const opening = initial.segments[0];
    if (!opening?.nextCursor ||
      opening.items.some(item => item.role === 'assistant' && item.event.segment === 'message' && item.totalChars > 0) ||
      !opening.items.some(item => item.role === 'assistant' && item.event.segment === 'message' &&
        item.totalChars === 0 && item.processId !== null)) return;
    pageLoading = true;
    try {
      const response = await getReaderSegment(child.provider, child.sessionId, opening.nextCursor);
      if (!active) return;
      if (response.revision !== initial.revision || response.session.provider !== child.provider ||
          response.session.sessionId !== child.sessionId) {
        throw new Error('The child source changed while this pane was open. Reload the parent session.');
      }
      if (!segments.some(page => page.pageId === response.page.pageId)) segments = [...segments, response.page];
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : 'Child continuation could not be loaded.';
    } finally { if (active) pageLoading = false; }
  }

  async function readMore(shown: DisplayItem, field: ContentField): Promise<void> {
    if (!bootstrap) return;
    const id = shown.key + ':' + field;
    const current = content[id] ?? { text: '', hasLoaded: false, totalChars: shown.item.totalChars,
      nextOffset: 0, done: false, loading: false, error: '' };
    if (current.loading || current.done || current.nextOffset === null) return;
    content = { ...content, [id]: { ...current, loading: true, error: '' } };
    try {
      const page = await getContentPage(child.provider, child.sessionId, shown.item.event,
        bootstrap.revision, current.hasLoaded ? current.nextOffset : 0, field, 1400,
        shown.item.contentRevisions[field]);
      if (!active) return;
      const previous = content[id] ?? current;
      content = { ...content, [id]: { text: previous.text + page.text, hasLoaded: true,
        totalChars: page.totalChars, nextOffset: page.nextOffset, done: page.nextOffset === null,
        loading: false, error: '' } };
    } catch (cause) {
      if (active) content = { ...content, [id]: { ...(content[id] ?? current), loading: false,
        error: cause instanceof Error ? cause.message : 'Child content could not be loaded.' } };
    }
  }
</script>

<section class="inline-child-reader" aria-label={t($language, 'Child session') + ' ' + child.sessionId}>
  <header class="inline-child-heading">
    <div>
      <p class="eyebrow">{t($language, 'Child session')} · {child.provider}</p>
      <svelte:element this={headingTag}>{bootstrap?.session.title || child.sessionId}</svelte:element>
      <code>{child.sessionId}</code>
    </div>
    <div class="inline-child-heading-actions">
      <a href={'/' + encodeURIComponent(child.provider) + '/session/' + encodeURIComponent(child.sessionId)}>{t($language, 'Open child source')} ↗</a>
      <button type="button" class="inline-child-collapse" onclick={onCollapse}>{t($language, 'Collapse child')}</button>
    </div>
  </header>
  {#if loading}<p role="status">{t($language, 'Opening child history…')}</p>{/if}
  {#if error}<p class="content-error" role="status">{error}</p>{/if}
  {#if bootstrap}
    {#if child.provider === 'codex' && bootstrap.session.parent?.provider === 'codex'}
      <InheritedContext child={child} parent={bootstrap.session.parent} revision={bootstrap.revision} />
    {/if}
    <div class="inline-child-actions">
      <span>{items.length} {t($language, 'of')} {bootstrap.totalItems} {t($language, 'events loaded')}</span>
    </div>
    <PaneSearch provider={child.provider} sessionId={child.sessionId} revision={bootstrap.revision}
      scope="child" onSelect={openSearchMatch} onReset={resetPaneSearch}
      state={paneSearchStates[childKey(child)]} restoreVersion={selectionHistoryVersion}
      onStateChange={(state) => onPaneSearchChange(child, state)}
      onRestore={(match) => openSearchMatch(match, false, true)} />
    {#snippet renderPlacement(shown: DisplayItem)}
      {#each placementsByAnchor.get(shown.key) ?? [] as placement (childKey(placement.child))}
        {#if placement.afterEvent}
          <div class="inline-child-placement">
            <button id={childButtonId(placement.child)} type="button" class="inline-child-toggle"
              aria-expanded={expandedChildKey === childKey(placement.child)}
              onclick={() => childExpanded(placement.child)
                ? onChildPathChange(ancestors, placement.afterEvent!, placement.child)
                : onChildPathChange([...ancestors, placement.child])}>
              {expandedChildKey === childKey(placement.child) ? t($language, 'Collapse') : t($language, 'Expand')} {t($language, 'child history')} · {placement.child.sessionId}
            </button>
            {#if expandedChildKey === childKey(placement.child)}
              <InlineChildReader child={placement.child} ancestors={[...ancestors, placement.child]}
                {activeChildPath} {selectedChildSearch} {selectionHistoryVersion} {paneSearchStates} {onPaneSearchChange}
                {onSearchSelection} {onCollaborationUpdate} {onChildPathChange}
                onCollapse={() => onChildPathChange(ancestors, placement.afterEvent!, placement.child)} />
            {/if}
          </div>
        {/if}
      {/each}
    {/snippet}
    {#snippet renderBlock(block: ReaderBlock)}
      <div class="turn-block">
        <EventCard display={block.main} progress={content[block.main.key + ':body']}
          collaborationIdentity={readerCollaborationIdentity(relationEntries, block.main.item.event)}
          toolInputProgress={content[block.main.key + ':toolInput']}
          toolOutputProgress={content[block.main.key + ':toolOutput']}
          searchReveal={searchReveals[block.main.key]} onReadMore={readMore} />
        {@render renderPlacement(block.main)}
        {#if block.thinking.length > 0}
          <div class="attached-reasoning">
            <details>
              <summary>{t($language, 'Recorded reasoning')} · {block.thinking.length} {block.thinking.length === 1 ? t($language, 'segment') : t($language, 'segments')}</summary>
              {#each block.thinking as thought (thought.key)}
                <EventCard display={thought} progress={content[thought.key + ':body']}
                  searchReveal={searchReveals[thought.key]} onReadMore={readMore} />
                {@render renderPlacement(thought)}
              {/each}
            </details>
          </div>
        {/if}
        {#if block.tools.length > 0}
          <div class="attached-tools" role="group" aria-label={t($language, 'Tool activity for this assistant message')}>
            <div class="tool-branch" aria-hidden="true"></div>
            <div class="tool-stack">
              <p class="tool-stack-label">{t($language, 'Tool activity')}</p>
              {#each block.tools as tool (tool.main.key)}
                <div class="tool-entry">
                  <EventCard display={tool.main} progress={content[tool.main.key + ':body']}
                    collaborationIdentity={readerCollaborationIdentity(relationEntries, tool.main.item.event)}
                    toolInputProgress={content[tool.main.key + ':toolInput']}
                    toolOutputProgress={content[tool.main.key + ':toolOutput']}
                    searchReveal={searchReveals[tool.main.key]} onReadMore={readMore} />
                  {@render renderPlacement(tool.main)}
                  {#if tool.thinking.length > 0}
                    <div class="attached-reasoning">
                      <details>
                        <summary>{t($language, 'Recorded reasoning')} · {tool.thinking.length} {tool.thinking.length === 1 ? t($language, 'segment') : t($language, 'segments')}</summary>
                        {#each tool.thinking as thought (thought.key)}
                          <EventCard display={thought} progress={content[thought.key + ':body']}
                            searchReveal={searchReveals[thought.key]} onReadMore={readMore} />
                          {@render renderPlacement(thought)}
                        {/each}
                      </details>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/snippet}
    <div class="inline-child-transcript" class:has-collaboration-gutter={hasTranscriptHandoffs} bind:this={transcriptElement}
      role="region" aria-label={t($language, 'Transcript of') + ' ' + child.sessionId}>
      <TranscriptCollaboration entries={relationEntries} provider={child.provider} sessionId={child.sessionId} host={transcriptElement} />
      {#each processUnits as unit (unit.blocks[0].main.key)}
        {#if unit.id !== null || unit.blocks[0].main.item.event.segment === 'thinking'}
          <details class="reader-process" data-reader-process={unit.id}
            data-reader-process-count={unit.totalCount} data-reader-process-loaded-count={unit.count}>
            <summary>{t($language, 'Execution process')} · {unit.totalCount} {unit.totalCount === 1 ? t($language, 'step') : t($language, 'steps')}{#if unit.count < unit.totalCount} · {unit.count} {t($language, 'loaded')}{/if}</summary>
            {#each unit.blocks as processBlock (processBlock.main.key)}
              {@render renderBlock(processBlock)}
            {/each}
          </details>
        {:else}
          {@render renderBlock(unit.blocks[0])}
        {/if}
      {/each}
    </div>
    {#if relationError}<p class="content-error" role="status">{relationError}</p>{/if}
    {#if relationCursor}
      <button type="button" class="inline-child-relations-next" disabled={relationLoading} onclick={() => void loadRelations()}>
        {relationLoading ? t($language, 'Loading child work…') : t($language, 'Load more child work')}
      </button>
    {/if}
    {#if continuationCursor}
      <ReaderContinuation cursor={continuationCursor} loading={pageLoading} error={error}
        label="Continue child history" buttonClass="inline-child-next read-more" onContinue={nextPage} />
    {/if}
  {/if}
</section>
