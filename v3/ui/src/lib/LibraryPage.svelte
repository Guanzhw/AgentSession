<script lang="ts">
  import type { BatchAction, BatchResult, LibraryFilters, LibraryNode, ProviderSummary, SearchMatch, SearchProviderDiagnostic, SessionRef, SessionSummary, SourceDiagnostic, ViewerMeta } from './api';
  import { errorText, language, t, type Language } from './i18n';
  import { sourceSettingsHref } from './source-guidance';
  import { searchMatchHref } from './search-navigation';

  export let providers: ProviderSummary[] = [];
  export let families: LibraryNode[] = [];
  export let familyTotal = 0;
  export let matchingSessions = 0;
  export let familyCursor: string | null = null;
  export let familyLoading = false;
  export let familyError = '';
  export let childrenByParent: Record<string, LibraryNode[]> = {};
  export let childCursors: Record<string, string | null> = {};
  export let childLoading: Record<string, boolean> = {};
  export let childErrors: Record<string, string> = {};
  export let sourceErrors: SourceDiagnostic[] = [];
  export let query = '';
  export let providerFilter = '';
  export let projectFilter = '';
  export let rangeFilter: '' | NonNullable<LibraryFilters['range']> = '';
  export let sortFilter: NonNullable<LibraryFilters['sort']> = 'updated-desc';
  export let starredOnly = false;
  export let onStarredOnlyChange: (value: boolean) => void;
  export let onOpenSettings: (provider: string) => void;
  export let onQueryChange: (value: string) => void;
  export let onProviderFilterChange: (value: string) => void;
  export let onProjectFilterChange: (value: string) => void;
  export let onRangeFilterChange: (value: '' | NonNullable<LibraryFilters['range']>) => void;
  export let onSortFilterChange: (value: NonNullable<LibraryFilters['sort']>) => void;
  export let onToggleFamily: (parent: SessionRef) => void;
  export let onLoadMoreFamilies: () => void;
  export let onRefreshFamilies: () => void;
  export let onLoadChildren: (parent: SessionRef, more?: boolean) => void;
  export let onRetryChildren: (parent: SessionRef) => void;
  export let mode: 'sessions' | 'content' = 'sessions';
  export let libraryView: 'sessions' | 'trash' = 'sessions';
  export let trashRows: ViewerMeta[] = [];
  export let trashLoading = false;
  export let trashError = '';
  export let trashReadState: 'unread' | 'complete' | 'partial' | 'failed' = 'unread';
  export let onRetryTrash: () => void;
  export let trashActionBusy = false;
  export let onViewChange: (view: 'sessions' | 'trash') => void;
  export let onTrashAction: (row: ViewerMeta, action: 'restore' | 'permanent-delete') => void;
  export let onBatchAction: (action: BatchAction, items: SessionRef[]) => Promise<BatchResult>;
  export let searchMatches: SearchMatch[] = [];
  export let searchCursor: string | null = null;
  export let searchSubmittedQuery = '';
  export let contentProviders = '';
  export let legacySearchOffset: '' | 'first-page' | 'invalid' = '';
  export let onContentProvidersChange: (value: string) => void;
  export let searchLoading = false;
  export let searchError = '';
  export let searchDiagnostics: SearchProviderDiagnostic[] = [];
  export let onSearch: (more?: boolean) => void;
  export let onModeChange: (mode: 'sessions' | 'content') => void;
  export let onOpen: (session: SessionRef) => void;
  export let onOpenSearchMatch: (match: SearchMatch) => void;
  export let expandedFamilies: string[] = [];

  function key(session: SessionRef): string {
    return session.provider + '/' + session.sessionId;
  }

  $: rootFamilies = families.filter(family => !family.parentBoundary);
  $: unlinkedFamilies = families.filter(family => Boolean(family.parentBoundary));
  $: searchActive = Boolean(query.trim()) && mode === 'sessions';
  $: trashCount = trashLoading || trashReadState === 'unread' || trashReadState === 'failed'
    ? '—' : String(trashRows.length) + (trashReadState === 'partial' ? '+' : '');

  let batchMode = false;
  let batchBusy = false;
  let batchConfirmDelete = false;
  let batchError = '';
  let batchFeedback = '';
  let selectedKeys: string[] = [];
  let lastSelectionScope = '';

  function collectVisibleRows(nodes: LibraryNode[], children: Record<string, LibraryNode[]>,
    expanded: string[], search: boolean): SessionSummary[] {
    const rows: SessionSummary[] = [];
    const seen = new Set<string>();
    function visit(node: LibraryNode): void {
      const ref = node.session.session;
      if (seen.has(key(ref))) return;
      seen.add(key(ref));
      rows.push(node.session);
      if (expanded.includes(key(ref)) || (search && node.childCount > 0)) {
        for (const child of children[key(ref)] || []) visit(child);
      }
    }
    for (const node of nodes) visit(node);
    return rows;
  }

  function canManage(summary: SessionSummary): boolean {
    const provider = providers.find(item => item.id === summary.session.provider);
    return !summary.diagnostic && provider?.available === true && provider.manageable === true;
  }

  $: visibleRows = collectVisibleRows(families, childrenByParent, expandedFamilies, searchActive);
  $: manageableRows = visibleRows.filter(summary => !summary.diagnostic && providers.some(item =>
    item.id === summary.session.provider && item.available && item.manageable)).map(summary => summary.session);
  $: selectedItems = manageableRows.filter(ref => selectedKeys.includes(key(ref)));
  $: selectionScope = JSON.stringify([libraryView, mode, query, providerFilter, projectFilter,
    rangeFilter, sortFilter, starredOnly, visibleRows.map(summary => key(summary.session)), manageableRows.map(key)]);
  $: if (selectionScope !== lastSelectionScope) {
    selectedKeys = [];
    batchConfirmDelete = false;
    if (libraryView !== 'sessions' || mode !== 'sessions') batchMode = false;
    lastSelectionScope = selectionScope;
  }

  function toggleBatchMode(): void {
    batchMode = !batchMode;
    selectedKeys = [];
    batchConfirmDelete = false;
    batchError = '';
  }

  function toggleSelected(ref: SessionRef, checked: boolean): void {
    const id = key(ref);
    selectedKeys = checked ? [...selectedKeys, id] : selectedKeys.filter(value => value !== id);
    batchConfirmDelete = false;
  }

  function selectAll(checked: boolean): void {
    selectedKeys = checked ? manageableRows.map(key) : [];
    batchConfirmDelete = false;
  }

  async function runBatch(action: BatchAction, confirmedDelete = false): Promise<void> {
    if (batchBusy || selectedItems.length === 0) return;
    if (action === 'delete' && (!confirmedDelete || !batchConfirmDelete)) {
      batchConfirmDelete = true;
      return;
    }
    batchBusy = true;
    batchError = '';
    batchFeedback = '';
    try {
      const result = await onBatchAction(action, selectedItems);
      batchFeedback = `${result.affected} ${t($language, 'sessions updated')}`
        + (result.skipped ? ` · ${result.skipped} ${t($language, 'skipped')}` : '');
      batchMode = false;
      selectedKeys = [];
      batchConfirmDelete = false;
    } catch (cause) {
      batchError = cause instanceof Error ? cause.message : t($language, 'The Viewer change could not be saved.');
      batchConfirmDelete = false;
    } finally {
      batchBusy = false;
    }
  }

  function providerLabel(id: string): string {
    return ({ codex: 'Codex', 'deepseek-harness': 'DeepSeek Harness', 'claude-code': 'Claude Code',
      opencode: 'OpenCode', pi: 'Pi' } as Record<string, string>)[id] || id;
  }

  function searchDiagnosticMessage(problem: SearchProviderDiagnostic, selectedLanguage: Language): string {
    if (problem.status !== 'partial') return problem.message || t(selectedLanguage, 'The source could not be searched.');
    return (problem.sourceDiagnostics || []).map(item => {
      const label = item.code === 'codex_multiple_source_files_unmerged'
        ? t(selectedLanguage, 'History unavailable: multiple Codex source files')
        : item.code === 'codex_source_inventory_incomplete'
          ? t(selectedLanguage, 'History unavailable: Codex source identity is incomplete')
          : item.code === 'codex_child_ownership_boundary_unavailable'
            ? t(selectedLanguage, 'History unavailable: child ownership boundary is missing')
            : item.code;
      const count = item.affectedSessions ?? item.affectedSources;
      return count === undefined ? label : `${label} (${count})`;
    }).join('; ') || t(selectedLanguage, 'Some sources could not be searched');
  }

  function dateLabel(timestamp: number | null): string {
    if (timestamp === null) return t($language, 'Date unavailable');
    const date = new Date(timestamp);
    if (Number.isNaN(date.valueOf())) return t($language, 'Date unavailable');
    return new Intl.DateTimeFormat($language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function displayTitle(summary: SessionSummary): string {
    return summary.title && summary.title !== summary.session.sessionId ? summary.title : t($language, 'Untitled conversation');
  }

  function spanLabel(value: number | null | undefined): string {
    if (value == null) return '—';
    const minutes = Math.floor(value / 60000);
    return minutes < 1 ? '< 1 min' : minutes < 60 ? `${minutes} min` : minutes < 1440
      ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.floor(minutes / 1440)} d ${Math.floor(minutes % 1440 / 60)} h`;
  }

  function open(event: MouseEvent, session: SessionRef): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(session);
  }

  function openMatch(event: MouseEvent, match: SearchMatch): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpenSearchMatch(match);
  }

  function openSourceSettings(event: MouseEvent, provider: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpenSettings(provider);
  }

  function matchHref(match: SearchMatch): string {
    return searchMatchHref(match);
  }
</script>

{#snippet starState(node: LibraryNode)}
  {@const label = t($language, node.starred ? 'Starred' : 'Not starred')}
  <span class="library-row-star" class:starred={node.starred} role="img" aria-label={label} title={label}
    data-library-star={key(node.session.session)} data-starred={String(node.starred)}>{node.starred ? '★' : '☆'}</span>
{/snippet}

{#snippet usage(summary: SessionSummary)}
  <span class="session-usage">
    <span title={t($language, 'Conversation span')}>{t($language, 'Conversation span')} {spanLabel(summary.durationMs)}</span>
    <span>{t($language, 'Tokens')} {summary.tokenCount == null ? '—' : new Intl.NumberFormat($language === 'zh' ? 'zh-CN' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(summary.tokenCount)}</span>
    <span>{t($language, 'Cost')} {t($language, 'Unknown')}</span>
  </span>
{/snippet}

{#snippet childRows(parent: LibraryNode)}
  {@const parentKey = key(parent.session.session)}
  {#if childErrors[parentKey]}
    <p class="search-error" role="alert">{childErrors[parentKey]}</p>
    <button type="button" class="family-more" data-family-retry={parentKey}
      onclick={() => onRetryChildren(parent.session.session)}>{t($language, 'Reload child sessions')}</button>
  {/if}
  {#if childLoading[parentKey] && !childrenByParent[parentKey]}<p class="list-footnote">{t($language, 'Loading child sessions…')}</p>{/if}
  {#each childrenByParent[parentKey] || [] as child (key(child.session.session))}
    {@const childKey = key(child.session.session)}
    {@const expanded = expandedFamilies.includes(childKey) || (searchActive && child.childCount > 0)}
    <div class="family-child-branch" class:batch-mode={batchMode}>
      {#if batchMode}<input type="checkbox" class="batch-row-checkbox" data-batch-select={childKey}
        aria-label={t($language, 'Select session') + ' ' + (child.session.title || child.session.session.sessionId)}
        checked={selectedKeys.includes(childKey)} disabled={!canManage(child.session) || batchBusy}
        onchange={(event) => toggleSelected(child.session.session, event.currentTarget.checked)} />{/if}
      <a class="family-child-row" href={'/' + encodeURIComponent(child.session.session.provider) + '/session/' + encodeURIComponent(child.session.session.sessionId)} onclick={(event) => open(event, child.session.session)}>
        <span class="family-child-title"><span class="library-row-title">{@render starState(child)}<strong title={child.session.title}>{displayTitle(child.session)}</strong></span>
          <small>{providerLabel(child.session.session.provider)} · {child.session.directory || child.session.session.sessionId}</small>
          {@render usage(child.session)}
          {#if child.session.diagnostic === 'codex_multiple_source_files_unmerged'}<small class="source-diagnostic">{t($language, 'History unavailable: multiple Codex source files')}</small>{/if}
          {#if child.session.diagnostic === 'codex_source_inventory_incomplete'}<small class="source-diagnostic">{t($language, 'History unavailable: Codex source identity is incomplete')}</small>{/if}
          {#if child.session.diagnostic === 'codex_child_ownership_boundary_unavailable'}<small class="source-diagnostic">{t($language, 'History unavailable: child ownership boundary is missing')}</small>{/if}</span>
        <span class="session-date">{dateLabel(child.session.updatedAt)}</span>
        <span class="message-count">{child.session.diagnostic ? '—' : child.session.messageCount}</span>
        <span class="row-open" aria-hidden="true">↗</span>
      </a>
      {#if child.childCount > 0 && !searchActive}
        <button type="button" class="family-toggle" data-family-toggle={childKey} aria-expanded={expanded}
          onclick={() => onToggleFamily(child.session.session)}>{child.childCount} {t($language, 'children')} <span aria-hidden="true">{expanded ? '▴' : '▾'}</span></button>
      {/if}
      {#if expanded}<div class="family-children nested-children" role="group" aria-label={t($language, 'Child sessions of') + ' ' + (child.session.title || t($language, 'Untitled session'))}>
        {@render childRows(child)}
      </div>{/if}
    </div>
  {/each}
  {#if childCursors[parentKey]}
    <button type="button" class="family-more" data-family-more={parentKey} disabled={childLoading[parentKey]}
      onclick={() => onLoadChildren(parent.session.session, true)}>
      {childLoading[parentKey] ? t($language, 'Loading…') : t($language, 'Show more children') + ' (' + (childrenByParent[parentKey]?.length || 0) + ' ' + t($language, 'of') + ' ' + parent.childCount + ')'}
    </button>
  {/if}
{/snippet}

<main class="library-layout">
  <aside class="library-rail">
    <p class="rail-label">{t($language, 'Your archive')}</p>
    <button type="button" class:active={libraryView === 'sessions'} class="rail-link rail-button"
      data-library-view="sessions" aria-current={libraryView === 'sessions' ? 'page' : undefined}
      onclick={() => onViewChange('sessions')}>
      <span class="rail-icon library-icon" aria-hidden="true"></span>
      {t($language, 'Sessions')}
      <span class="rail-count">{matchingSessions}</span>
    </button>
    <button type="button" class:active={libraryView === 'trash'} class="rail-link rail-button"
      data-library-view="trash" aria-current={libraryView === 'trash' ? 'page' : undefined}
      onclick={() => onViewChange('trash')}>
      <span class="rail-icon trash-icon" aria-hidden="true"></span>
      {t($language, 'Trash')}
      <span class="rail-count" data-trash-count>{trashCount}</span>
    </button>
    {#each providers as provider (provider.id)}
      <div class="rail-note provider-note">
        <span class:online={provider.available} class="rail-status-dot"></span>
        <div>
          <strong>{providerLabel(provider.id)}</strong>
          <span>{provider.available ? t($language, 'Source available') : t($language, 'Source unavailable')}</span>
        </div>
      </div>
    {/each}
    <div class="rail-footnote">{t($language, 'Read-only history')}<br />{t($language, 'stored on this device')}</div>
  </aside>

  <section class="library-main">
    {#if sourceErrors.length > 0}
      <details class="library-source-note">
        <summary>{t($language, 'Some histories are unavailable')} <span>{t($language, 'Source issues')}</span></summary>
        {#each sourceErrors as problem}
          <p>{providerLabel(problem.provider)}: {errorText($language, problem.message)}
            <a class="source-settings-link" href={sourceSettingsHref(problem.provider)} data-source-settings={problem.provider}
              onclick={(event) => openSourceSettings(event, problem.provider)}>{t($language, 'Configure source')} · {providerLabel(problem.provider)}</a></p>
        {/each}
      </details>
    {/if}
    <div class="library-heading">
      <div>
        <p class="eyebrow">{t($language, 'Conversation archive')}</p>
        <h1 id="library-title">{libraryView === 'trash' ? t($language, 'Trash') : t($language, 'Sessions')}</h1>
        <p class="intro-copy">{libraryView === 'trash' ? t($language, 'Restore a session or permanently hide it from this Viewer.') : t($language, 'Return to a question, a decision, or the moment the work changed direction.')}</p>
      </div>
      <div class="library-heading-actions">
        {#if libraryView === 'sessions' && mode === 'sessions' && manageableRows.length > 0}
          <button type="button" class="library-manage-button" data-library-manage aria-pressed={batchMode}
            disabled={batchBusy} onclick={toggleBatchMode}>{t($language, batchMode ? 'Cancel manage' : 'Manage')}</button>
        {/if}
        <div class="archive-count"><strong>{libraryView === 'trash' ? trashCount : matchingSessions}</strong><span>{t($language, libraryView === 'trash' && trashReadState === 'partial' ? 'readable sessions' : 'sessions')}</span></div>
      </div>
    </div>

    {#if libraryView === 'trash'}
      {#if trashError}<p class="search-error" role="alert">{trashError}</p>{/if}
      {#if trashLoading}<p class="list-footnote">{t($language, 'Loading Viewer trash…')}</p>{/if}
      {#if !trashLoading && (trashReadState === 'failed' || trashReadState === 'partial')}
        <p class="list-footnote" data-trash-read-status role="status">{t($language, trashReadState === 'failed'
          ? 'Trash could not be read. Its contents and count are unknown.'
          : 'Trash is incomplete. Showing readable sessions; other records may be unavailable.')}</p>
        <button type="button" class="family-more" data-trash-retry disabled={trashActionBusy} onclick={onRetryTrash}>{t($language, 'Retry Trash')}</button>
      {/if}
      {#if !trashLoading && trashReadState === 'complete' && trashRows.length === 0}
        <div class="empty-state compact-empty"><h2>{t($language, 'Trash is empty')}</h2><p>{t($language, 'Moved sessions appear here until restored or permanently hidden.')}</p></div>
      {:else if trashRows.length > 0}
        <section class="trash-list" aria-label={t($language, 'Viewer trash')}>
          {#each trashRows as row (row.provider + '/' + row.sessionId)}
            <article class="trash-row">
              <div><strong>{row.customTitle || row.sessionId}</strong><span>{providerLabel(row.provider)} · {row.sessionId}</span></div>
              <button type="button" class="trash-restore" disabled={trashActionBusy}
                onclick={() => onTrashAction(row, 'restore')}>{t($language, 'Restore')}</button>
              <button type="button" class="trash-permanent" disabled={trashActionBusy}
                onclick={() => onTrashAction(row, 'permanent-delete')}>{t($language, 'Permanently hide')}</button>
            </article>
          {/each}
        </section>
      {/if}
    {:else}
    <div class="search-modes" aria-label={t($language, 'Search scope')}>
      <button type="button" data-search-mode="sessions" class:active={mode === 'sessions'}
        aria-pressed={mode === 'sessions'} onclick={() => onModeChange('sessions')}>{t($language, 'Session titles')}</button>
      <button type="button" data-search-mode="content" class:active={mode === 'content'}
        aria-pressed={mode === 'content'} onclick={() => onModeChange('content')}>{t($language, 'Conversation content')}</button>
    </div>
    <form class="list-toolbar" onsubmit={(event) => { event.preventDefault(); if (mode === 'content') onSearch(); }}>
      <label class="search-field">
        <span class="search-icon" aria-hidden="true"></span>
        <span class="sr-only">{mode === 'content' ? t($language, 'Search conversation content') : t($language, 'Search sessions')}</span>
        <input value={query} oninput={(event) => onQueryChange(event.currentTarget.value)} type="search"
          placeholder={mode === 'content' ? t($language, 'Find a recorded message or decision') : t($language, 'Find by title, folder, or session ID')} />
      </label>
      {#if mode === 'content'}
        <button class="search-submit" type="submit" disabled={!query.trim() || searchLoading}>{t($language, 'Search')}</button>
      {/if}
    </form>

    {#if mode === 'sessions'}
      <div class="library-filter-toolbar list-toolbar" role="group" aria-label={t($language, 'Session list filters')}>
        <label>
          <span>{t($language, 'Provider')}</span>
          <select class="library-provider-select" aria-label={t($language, 'Provider filter')} data-library-provider value={providerFilter}
            onchange={(event) => onProviderFilterChange(event.currentTarget.value)}>
            <option value="">{t($language, 'All providers')}</option>
            {#each providers as provider (provider.id)}
              <option value={provider.id}>{providerLabel(provider.id)}{provider.available ? '' : t($language, ' (unavailable)')}</option>
            {/each}
          </select>
        </label>
        <label class="search-field">
          <span>{t($language, 'Project path')}</span>
          <input type="search" aria-label={t($language, 'Project path filter')} data-library-project value={projectFilter}
            placeholder={t($language, 'Filter by exact project path')}
            oninput={(event) => onProjectFilterChange(event.currentTarget.value)} />
        </label>
        <label>
          <span>{t($language, 'Time range')}</span>
          <select class="library-provider-select" aria-label={t($language, 'Time range')} data-library-range value={rangeFilter}
            onchange={(event) => onRangeFilterChange(event.currentTarget.value as '' | NonNullable<LibraryFilters['range']>)}>
            <option value="">{t($language, 'All')}</option>
            <option value="today">{t($language, 'Today')}</option>
            <option value="week">{t($language, 'This Week')}</option>
            <option value="month">{t($language, 'This Month')}</option>
          </select>
        </label>
        <label>
          <span>{t($language, 'Sort')}</span>
          <select class="library-provider-select" aria-label={t($language, 'Sort')} data-library-sort value={sortFilter}
            onchange={(event) => onSortFilterChange(event.currentTarget.value as NonNullable<LibraryFilters['sort']>)}>
            <option value="updated-desc">{t($language, 'Newest updated')}</option>
            <option value="updated-asc">{t($language, 'Oldest updated')}</option>
            <option value="title-asc">{t($language, 'Title A-Z')}</option>
            <option value="title-desc">{t($language, 'Title Z-A')}</option>
          </select>
        </label>
        <label class="library-starred-filter"><input type="checkbox" data-library-starred checked={starredOnly}
          onchange={(event) => onStarredOnlyChange(event.currentTarget.checked)} />{t($language, 'Only starred')}</label>
      </div>
      {#if batchMode}
        <div class="library-batch-bar" role="group" aria-label={t($language, 'Manage sessions')}>
          <label><input type="checkbox" data-batch-select-all
            checked={manageableRows.length > 0 && selectedItems.length === manageableRows.length}
            disabled={batchBusy || manageableRows.length === 0}
            onchange={(event) => selectAll(event.currentTarget.checked)} />{t($language, 'Select all loaded sessions')}</label>
          <strong data-batch-count>{selectedItems.length} {t($language, 'selected')}</strong>
          <div class="library-batch-actions">
            <button type="button" data-batch-action="star" disabled={batchBusy || selectedItems.length === 0}
              onclick={() => void runBatch('star')}>{t($language, 'Star')}</button>
            <button type="button" data-batch-action="unstar" disabled={batchBusy || selectedItems.length === 0}
              onclick={() => void runBatch('unstar')}>{t($language, 'Unstar')}</button>
            <button type="button" data-batch-action="delete" class="batch-danger" disabled={batchBusy || selectedItems.length === 0}
              onclick={() => void runBatch('delete')}>{t($language, 'Delete')}</button>
            <button type="button" disabled={batchBusy} onclick={toggleBatchMode}>{t($language, 'Cancel')}</button>
          </div>
        </div>
        {#if batchConfirmDelete}
          <div class="library-batch-confirm" role="alertdialog" aria-label={t($language, 'Confirm delete')}>
            <p>{t($language, 'Move {count} selected sessions to Viewer trash?').replace('{count}', String(selectedItems.length))}</p>
            <button type="button" class="batch-danger" data-batch-confirm-delete disabled={batchBusy}
              onclick={() => void runBatch('delete', true)}>{t($language, 'Confirm delete')}</button>
            <button type="button" data-batch-dismiss-delete onclick={() => { batchConfirmDelete = false; }}>{t($language, 'Keep sessions')}</button>
          </div>
        {/if}
      {/if}
      {#if batchError}<p class="search-error" data-batch-error role="alert">{batchError}</p>{/if}
      {#if batchFeedback}<p class="library-batch-feedback" data-batch-feedback role="status">{batchFeedback}</p>{/if}
    {:else}
      <div class="library-filter-toolbar list-toolbar">
        <label>
          <span>{t($language, 'Provider')}</span>
          <select class="library-provider-select" aria-label={t($language, 'Content search providers')} data-content-provider value={contentProviders}
            onchange={(event) => onContentProvidersChange(event.currentTarget.value)}>
            <option value="">{t($language, 'All providers')}</option>
            {#if contentProviders && (contentProviders.includes(',') || !providers.some(provider => provider.id === contentProviders))}
              <option value={contentProviders}>{contentProviders.split(',').map(providerLabel).join(' + ')}</option>
            {/if}
            {#each providers as provider (provider.id)}
              <option value={provider.id}>{providerLabel(provider.id)}{provider.available ? '' : t($language, ' (unavailable)')}</option>
            {/each}
          </select>
        </label>
      </div>
      <p class="filter-scope-note">{t($language, contentProviders
        ? 'Content search uses the selected providers and covers all projects.'
        : 'List filters apply to sessions. Conversation content search covers all providers and projects.')}</p>
      {#if legacySearchOffset === 'first-page'}
        <p class="filter-scope-note" data-search-offset-notice>{t($language, 'This search starts at the first result. Use Load more for subsequent results.')}</p>
      {:else if legacySearchOffset === 'invalid'}
        <p class="search-error" data-search-offset-error role="alert">{t($language, 'Invalid search offset. Submit a new search to start at the first result.')}</p>
      {/if}
    {/if}

    {#if mode === 'content'}
      {#if searchError}<p class="search-error" role="alert">{searchError}</p>{/if}
      {#if searchDiagnostics.length > 0}
        <div class="source-diagnostic" role="alert">
          <strong>{t($language, 'Some sources could not be searched')}</strong>
          {#each searchDiagnostics as problem}<p>{providerLabel(problem.provider)}: {searchDiagnosticMessage(problem, $language)}</p>{/each}
        </div>
      {/if}
      {#if searchSubmittedQuery}
        <p class="list-footnote">{t($language, 'Recorded content results for')} “{searchSubmittedQuery}”</p>
        {#if searchLoading}
          <p class="list-footnote search-loading" role="status">{t($language, 'Searching recorded content…')}</p>
        {/if}
        {#if searchMatches.length === 0 && !searchLoading && !searchError}
          <div class="empty-state compact-empty"><h2>{searchDiagnostics.length > 0
            ? t($language, 'No recorded matches in available sources')
            : t($language, 'No matches')}</h2><p>{t($language, 'Try a different phrase.')}</p></div>
        {:else if searchMatches.length > 0 || searchLoading}
          <section class="search-results" aria-label={t($language, 'Conversation search results')} aria-busy={searchLoading}>
            {#each searchMatches as match, index (match.session.provider + '/' + match.session.sessionId + '/' + index)}
              <article class="search-result">
                <a href={matchHref(match)} onclick={(event) => openMatch(event, match)}>
                  <strong>{match.title || t($language, 'Untitled session')}</strong>
                  <span>{providerLabel(match.session.provider)} · {match.matchRole || match.matchField}</span>
                  <p>{match.snippet}</p>
                </a>
              </article>
            {/each}
          </section>
          {#if searchCursor}
            <button type="button" class="search-more" disabled={searchLoading}
              onclick={() => onSearch(true)}>{searchLoading ? t($language, 'Loading…') : t($language, 'Load more results')}</button>
          {/if}
        {/if}
      {:else}
        <div class="empty-state compact-empty"><h2>{t($language, 'Search the conversation archive')}</h2>
          <p>{t($language, 'Search recorded user and agent messages across available providers.')}</p></div>
      {/if}
    {:else}
      {#if familyError}
        <p class="search-error" role="alert">{familyError}</p>
        <button type="button" class="family-more" onclick={onRefreshFamilies}>{t($language, 'Reload families')}</button>
      {/if}
      {#if familyLoading && families.length === 0}<p class="list-footnote">{t($language, 'Loading session families…')}</p>{/if}
      {#if !familyLoading && familyTotal === 0 && !familyError}
        <div class="empty-state compact-empty"><h2>{sourceErrors.length > 0
          ? t($language, searchActive ? 'No recorded matches in available sources' : 'No recorded sessions in available sources')
          : t($language, searchActive ? 'No matches' : 'No sessions yet')}</h2>
          <p>{sourceErrors.length > 0
            ? t($language, 'Some session sources could not be read.')
            : t($language, searchActive ? 'Try a shorter title, folder name, or session ID.' : 'New sessions will appear here when the local index is ready.')}</p></div>
      {:else}
        {#if rootFamilies.length > 0}
          <section class="session-table" aria-label={t($language, 'Sessions')}>
            <div class="session-table-head" aria-hidden="true"><span>{t($language, 'Session')}</span><span>{t($language, 'Last activity')}</span><span>{t($language, 'Messages')}</span><span></span></div>
            {#each rootFamilies as family (key(family.session.session))}
              {@const root = family.session}
              {@const familyKey = key(root.session)}
              {@const expanded = expandedFamilies.includes(familyKey) || (searchActive && family.childCount > 0)}
              <div class="session-family" class:batch-mode={batchMode}>
                {#if batchMode}<input type="checkbox" class="batch-row-checkbox" data-batch-select={familyKey}
                  aria-label={t($language, 'Select session') + ' ' + (root.title || root.session.sessionId)}
                  checked={selectedKeys.includes(familyKey)} disabled={!canManage(root) || batchBusy}
                  onchange={(event) => toggleSelected(root.session, event.currentTarget.checked)} />{/if}
                <a class="session-row" href={'/' + encodeURIComponent(root.session.provider) + '/session/' + encodeURIComponent(root.session.sessionId)} onclick={(event) => open(event, root.session)}>
                  <span class="session-title-cell"><span class="session-glyph" aria-hidden="true"><span></span><span></span></span>
                    <span class="session-copy"><span class="library-row-title">{@render starState(family)}<strong title={root.title}>{displayTitle(root)}</strong></span>
                      <span>{providerLabel(root.session.provider)} · {root.directory || root.session.sessionId}</span>
                      {@render usage(root)}
                      {#if root.diagnostic === 'codex_multiple_source_files_unmerged'}<span class="source-diagnostic">{t($language, 'History unavailable: multiple Codex source files')}</span>{/if}
                      {#if root.diagnostic === 'codex_source_inventory_incomplete'}<span class="source-diagnostic">{t($language, 'History unavailable: Codex source identity is incomplete')}</span>{/if}
                      {#if root.diagnostic === 'codex_child_ownership_boundary_unavailable'}<span class="source-diagnostic">{t($language, 'History unavailable: child ownership boundary is missing')}</span>{/if}</span></span>
                  <span class="session-date" title={t($language, 'Latest family activity')}>{dateLabel(family.familyUpdated)}</span>
                  <span class="message-count">{root.diagnostic ? '—' : root.messageCount}</span><span class="row-open" aria-hidden="true">{family.childCount ? '' : '↗'}</span>
                </a>
                {#if family.childCount > 0 && !searchActive}
                  <button type="button" class="family-toggle" data-family-toggle={familyKey}
                    aria-expanded={expanded} aria-label={(expanded ? t($language, 'Hide') : t($language, 'Show')) + ' ' + family.childCount + ' ' + t($language, 'child sessions for') + ' ' + (root.title || t($language, 'Untitled session'))}
                    onclick={() => onToggleFamily(root.session)}>{family.childCount} {t($language, 'children')} <span aria-hidden="true">{expanded ? '▴' : '▾'}</span></button>
                {/if}
                {#if expanded}<div class="family-children" role="group" aria-label={t($language, 'Child sessions of') + ' ' + (root.title || t($language, 'Untitled session'))}>
                  {@render childRows(family)}
                </div>{/if}
              </div>
            {/each}
          </section>
        {/if}
        {#if unlinkedFamilies.length > 0}
          <section class="unlinked-child-list" aria-label={t($language, 'Child sessions with unresolved parents')}>
            <div class="unlinked-heading"><h2>{t($language, 'Child sessions with unresolved parents')}</h2>
              <p>{t($language, 'The recorded parent link could not form an ordinary family. Each child remains readable at its own session URL.')}</p></div>
            {#each unlinkedFamilies as family (key(family.session.session))}
              {@const root = family.session}
              {@const familyKey = key(root.session)}
              {@const expanded = expandedFamilies.includes(familyKey) || (searchActive && family.childCount > 0)}
              <div class="unlinked-family" class:batch-mode={batchMode}>
                {#if batchMode}<input type="checkbox" class="batch-row-checkbox" data-batch-select={familyKey}
                  aria-label={t($language, 'Select session') + ' ' + (root.title || root.session.sessionId)}
                  checked={selectedKeys.includes(familyKey)} disabled={!canManage(root) || batchBusy}
                  onchange={(event) => toggleSelected(root.session, event.currentTarget.checked)} />{/if}
                <a class="unlinked-child-row" href={'/' + encodeURIComponent(root.session.provider) + '/session/' + encodeURIComponent(root.session.sessionId)} onclick={(event) => open(event, root.session)}>
                  <span class="family-child-title"><span class="library-row-title">{@render starState(family)}<strong title={root.title}>{displayTitle(root)}</strong></span>
                    <small>{providerLabel(root.session.provider)} · {family.parentBoundary === 'cyclic-parent'
                      ? t($language, 'Cyclic parent reference') : family.parentBoundary === 'hidden-parent'
                        ? t($language, 'Parent session hidden') : t($language, 'Parent session unavailable')}: {root.parent?.sessionId}</small>
                    {@render usage(root)}</span>
                  <span class="session-date" title={t($language, 'Latest family activity')}>{dateLabel(family.familyUpdated)}</span>
                  <span class="message-count">{root.diagnostic ? '—' : root.messageCount}</span><span class="row-open" aria-hidden="true">↗</span>
                </a>
                {#if family.childCount > 0 && !searchActive}
                  <button type="button" class="family-toggle" data-family-toggle={familyKey} aria-expanded={expanded}
                    onclick={() => onToggleFamily(root.session)}>{family.childCount} {t($language, 'descendants')} <span aria-hidden="true">{expanded ? '▴' : '▾'}</span></button>
                {/if}
                {#if expanded}<div class="family-children" role="group" aria-label={t($language, 'Descendant sessions of') + ' ' + (root.title || t($language, 'Untitled session'))}>
                  {@render childRows(family)}
                </div>{/if}
              </div>
            {/each}
          </section>
        {/if}
        {#if familyCursor}
          <button type="button" class="family-more" disabled={familyLoading}
            onclick={onLoadMoreFamilies}>{familyLoading ? t($language, 'Loading…') : t($language, 'Load more families') + ' (' + families.length + ' ' + t($language, 'of') + ' ' + familyTotal + ')'}</button>
        {/if}
        <p class="list-footnote">{t($language, 'Showing')} {families.length} {t($language, 'of')} {familyTotal} {t($language, 'families')} · {matchingSessions} {t($language, 'matching sessions')}</p>
      {/if}
    {/if}
    {/if}
  </section>
</main>

<style>
  .library-row-title { display: flex; align-items: center; min-width: 0; }
  .library-row-star { display: inline-block; flex-shrink: 0; margin-right: 6px; color: var(--muted); }
  .library-row-star.starred { color: var(--forest-soft); }
  .library-starred-filter { display: flex; align-items: center; gap: 6px; align-self: end; padding-bottom: 8px; white-space: nowrap; }
  .source-settings-link { display: inline-block; margin-left: 8px; color: var(--forest-soft); }
</style>
