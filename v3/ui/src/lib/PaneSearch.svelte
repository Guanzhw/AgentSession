<script module lang="ts">
  import type { ReaderSearchMatch } from './api';
  export interface PaneSearchState {
    revision: string;
    query: string;
    committed: string;
    matches: ReaderSearchMatch[];
    nextCursor: string | null;
    selected: ReaderSearchMatch | null;
    error: string;
    pending: 'initial' | 'more' | null;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import type { ReaderSearchMatch } from './api';
  import { getReaderSearch } from './api';
  import { language, t } from './i18n';

  export let provider: string;
  export let sessionId: string;
  export let revision: string;
  export let scope: 'session' | 'child';
  export let onSelect: (match: ReaderSearchMatch) => Promise<void> | void;
  export let onReset: () => void;
  export let state: PaneSearchState | undefined;
  export let restoreVersion: number;
  export let onStateChange: (state: PaneSearchState) => void;
  export let onRestore: (match: ReaderSearchMatch) => Promise<void> | void;

  let query = '';
  let committed = '';
  let matches: ReaderSearchMatch[] = [];
  let nextCursor: string | null = null;
  let loading = false;
  let error = '';
  let active = true;
  let generation = 0;
  let selected: ReaderSearchMatch | null = null;
  let restoredVersion = -1;
  let pending: 'initial' | 'more' | null = null;

  $: if (restoredVersion !== restoreVersion) {
    restoredVersion = restoreVersion;
    generation++;
    loading = false;
    onReset();
    const saved = state;
    const currentSource = !saved || saved.revision === revision;
    query = saved?.query ?? '';
    committed = currentSource ? saved?.committed ?? '' : '';
    matches = currentSource ? saved?.matches ?? [] : [];
    nextCursor = currentSource ? saved?.nextCursor ?? null : null;
    selected = currentSource ? saved?.selected ?? null : null;
    error = currentSource ? saved?.error ?? ''
      : t($language, 'The recorded source changed. Refresh this session before searching again.');
    pending = currentSource ? saved?.pending ?? null : null;
    if (selected) void restore(selected);
    if (pending) void search(pending === 'more');
  }

  onMount(() => {
    // Navigation aborts fetches; retain the pending snapshot for the returning Reader.
    const onBeforeUnload = () => { generation++; };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && pending) { loading = false; void search(pending === 'more'); }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      active = false;
      generation++;
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pageshow', onPageShow);
    };
  });

  function save(): void {
    onStateChange({ revision, query, committed, matches, nextCursor, selected, error, pending });
  }

  async function restore(match: ReaderSearchMatch): Promise<void> {
    const request = generation;
    try { await onRestore(match); }
    catch (cause) {
      if (active && request === generation) {
        error = cause instanceof Error ? cause.message : t($language, 'The matching source could not be opened.');
      }
    }
  }

  function changed(): void {
    generation++;
    matches = [];
    nextCursor = null;
    committed = '';
    loading = false;
    error = '';
    selected = null;
    pending = null;
    onReset();
    save();
  }

  async function search(continuePage = false): Promise<void> {
    const q = query.trim();
    if (!q || (continuePage && !nextCursor) || loading) return;
    const cursor = continuePage ? nextCursor : undefined;
    const request = ++generation;
    if (!continuePage) {
      committed = q;
      matches = [];
      nextCursor = null;
      selected = null;
      onReset();
    }
    loading = true;
    pending = continuePage ? 'more' : 'initial';
    error = '';
    save();
    try {
      const page = await getReaderSearch(provider, sessionId, revision, q, cursor ?? undefined);
      if (!active || request !== generation) return;
      if (page.session.provider !== provider || page.session.sessionId !== sessionId || page.revision !== revision) {
        throw new Error(t($language, 'The recorded source changed. Refresh this session before searching again.'));
      }
      matches = continuePage ? [...matches, ...page.matches] : page.matches;
      nextCursor = page.nextCursor;
    } catch (cause) {
      if (active && request === generation) {
        error = cause instanceof Error ? cause.message : t($language, 'This session could not be searched.');
      }
    } finally {
      if (active && request === generation) { loading = false; pending = null; save(); }
    }
  }

  async function select(match: ReaderSearchMatch): Promise<void> {
    const request = generation;
    try {
      await onSelect(match);
      if (active && request === generation) { selected = match; save(); }
    }
    catch (cause) {
      if (active && request === generation) {
        error = cause instanceof Error ? cause.message : t($language, 'The matching source could not be opened.');
      }
    }
  }

  function fieldName(field: ReaderSearchMatch['field']): string {
    return field === 'toolInput' ? t($language, 'Tool input') : field === 'toolOutput' ? t($language, 'Tool output') : t($language, 'Message');
  }
</script>

<section class="pane-search" data-scope={scope} aria-label={scope === 'child' ? t($language, 'Search this child history') : t($language, 'Search this session')}>
  <form onsubmit={(event) => { event.preventDefault(); void search(); }}>
    <label for={'pane-search-' + scope + '-' + sessionId}>
      {scope === 'child' ? t($language, 'Find in child') : t($language, 'Find in session')}
    </label>
    <input id={'pane-search-' + scope + '-' + sessionId} type="search" bind:value={query}
      oninput={changed} maxlength="500" autocomplete="off"
      aria-label={(scope === 'child' ? t($language, 'Find in child') : t($language, 'Find in session')) + ' ' + sessionId} />
    <button type="submit" disabled={loading || !query.trim()}>{t($language, 'Find')}</button>
  </form>
  {#if loading}<p class="pane-search-state" role="status">{t($language, 'Searching recorded content…')}</p>{/if}
  {#if error}<p class="content-error" role="status">{error}</p>{/if}
  {#if committed && !loading && !error && matches.length === 0}
    <p class="pane-search-state">{t($language, 'No matches in this')} {scope === 'child' ? t($language, 'child history') : t($language, 'session')}.</p>
  {/if}
  {#if matches.length > 0}
    <p class="pane-search-state">{matches.length}{nextCursor ? '+' : ''} {matches.length === 1 && !nextCursor ? t($language, 'match') : t($language, 'matches')} {t($language, 'in this')} {scope === 'child' ? t($language, 'child history') : t($language, 'session')}</p>
    <ol class="pane-search-results">
      {#each matches as match, index (`${match.ordinal}:${match.field}:${match.offset}:${index}`)}
        <li><button type="button" class="pane-search-result" onclick={() => void select(match)}>
          <strong>{fieldName(match.field)} · {t($language, 'event')} {match.ordinal + 1} · {t($language, 'character')} {match.offset + 1}</strong>
          <span>{match.excerpt}</span>
        </button></li>
      {/each}
    </ol>
  {/if}
  {#if nextCursor}
    <button type="button" class="pane-search-more read-more" disabled={loading} onclick={() => void search(true)}>
      {loading ? t($language, 'Loading matches…') : t($language, 'More matches')}
    </button>
  {/if}
</section>
