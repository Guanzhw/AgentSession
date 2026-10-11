<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    ApiRequestError,
    getLibraryFamilies,
    getLibraryChildren,
    getProviders,
    getSettings,
    getReaderBootstrap,
    searchSessions,
    getViewerTrash,
    mutateViewer,
    batchViewer,
    type BatchAction,
    type BatchResult,
    type ProviderSummary,
    type SettingsSnapshot,
    type ReaderBootstrap,
    type LibraryNode,
    type LibraryFamilyPage,
    type SessionRef,
    type SourceDiagnostic,
    type SearchProviderDiagnostic,
    type SearchMatch,
    type ViewerMeta,
    type LibraryFilters,
  } from './lib/api';
  import LibraryPage from './lib/LibraryPage.svelte';
  import ReaderPage from './lib/ReaderPage.svelte';
  import SettingsPage from './lib/SettingsPage.svelte';
  import StatsPage from './lib/StatsPage.svelte';
  import { sourceSettingsHref } from './lib/source-guidance';
  import { searchMatchHref } from './lib/search-navigation';
  import { readThemePreference, saveThemePreference, type ThemePreference } from './lib/theme';
  import { language, setLanguage, syncDocumentLanguage, t, type Language } from './lib/i18n';

  type Route = { kind: 'library' } | { kind: 'settings' } | { kind: 'stats'; provider?: string }
    | { kind: 'reader'; provider: string; sessionId: string };

  type LibraryFocusTarget = { provider: string; sessionId: string; href: string };

  type LibraryHistorySnapshot = {
    libraryQuery: string;
    titleQuery: string;
    contentQuery: string;
    searchSubmittedQuery: string;
    mode: 'sessions' | 'content';
    view: 'sessions' | 'trash';
    provider: string;
    contentProviders?: string;
    legacySearchOffset?: '' | 'first-page' | 'invalid';
    project: string;
    range?: '' | NonNullable<LibraryFilters['range']>;
    sort?: NonNullable<LibraryFilters['sort']>;
    starredOnly?: boolean;
    expandedFamilies: string[];
    scroll: number;
    familyCount: number;
    childCounts: Record<string, number>;
    focusTarget?: LibraryFocusTarget | null;
    searchMatchCount?: number;
  };

  type AppHistoryState = { agentSessionLibrary?: LibraryHistorySnapshot };

  function routeFromPath(path: string): Route {
    if (path === '/settings' || path === '/settings/') return { kind: 'settings' };
    if (path === '/stats' || path === '/stats/') return { kind: 'stats', provider: new URLSearchParams(window.location.search).get('providers') || 'all' };
    const stats = path.match(/^\/([^/]+)\/stats\/?$/);
    if (stats) {
      try { return { kind: 'stats', provider: decodeURIComponent(stats[1]) }; }
      catch { return { kind: 'library' }; }
    }
    const match = path.match(/^\/([^/]+)\/session\/([^/]+)\/?$/);
    if (match) {
      try {
        return { kind: 'reader', provider: match[1], sessionId: decodeURIComponent(match[2]) };
      } catch {
        return { kind: 'library' };
      }
    }
    return { kind: 'library' };
  }

  let route: Route = routeFromPath(window.location.pathname);
  let providers: ProviderSummary[] = [];
  let families: LibraryNode[] = [];
  let familyTotal = 0;
  let matchingSessions = 0;
  let familyCursor: string | null = null;
  let familyLoading = false;
  let familyError = '';
  let familyLoaded = false;
  let familyDirty = false;
  let familyFilterSignature = '';
  let restoredFamilyCount = 40;
  let familyRequest = 0;
  let familySearchTimer: ReturnType<typeof setTimeout> | undefined;
  let childrenByParent: Record<string, LibraryNode[]> = {};
  let childCursors: Record<string, string | null> = {};
  let childLoading: Record<string, boolean> = {};
  let childErrors: Record<string, string> = {};
  let sourceErrors: SourceDiagnostic[] = [];
  let providerFilter = '';
  let projectFilter = '';
  let rangeFilter: '' | NonNullable<LibraryFilters['range']> = '';
  let sortFilter: NonNullable<LibraryFilters['sort']> = 'updated-desc';
  let starredOnly = false;
  let childPageTargets: Record<string, number> = {};
  let libraryQuery = '';
  let libraryMode: 'sessions' | 'content' = 'sessions';
  let titleQuery = '';
  let contentQuery = '';
  let contentProviders = '';
  let legacySearchOffset: '' | 'first-page' | 'invalid' = '';
  let libraryView: 'sessions' | 'trash' = 'sessions';
  let trashRows: ViewerMeta[] = [];
  let trashLoading = false;
  let trashError = '';
  let trashFailedSources = 0;
  $: trashStatusError = trashError || (trashFailedSources
    ? `${trashFailedSources} ${t($language, trashFailedSources === 1 ? 'provider metadata source could not be read.' : 'provider metadata sources could not be read.')}` : '');
  let trashReadState: 'unread' | 'complete' | 'partial' | 'failed' = 'unread';
  let trashReadGeneration = 0;
  let trashActionBusy = false;
  let searchMatches: SearchMatch[] = [];
  let searchCursor: string | null = null;
  let searchSubmittedQuery = '';
  let searchStarted = false;
  let searchLoading = false;
  let searchError = '';
  let searchDiagnostics: SearchProviderDiagnostic[] = [];
  let searchGeneration = 0;
  let libraryScroll = 0;
  let hasLibraryPosition = false;
  let expandedFamilies: string[] = [];
  let restoreLibraryPosition = false;
  let libraryFocusTarget: LibraryFocusTarget | null = null;
  let pendingLibraryFocus: LibraryFocusTarget | null = null;
  let restoredSearchMatchCount = 0;
  let restoringLibraryFocus = false;
  let reader: ReaderBootstrap | null = null;
  let settings: SettingsSnapshot | null = null;
  let loading = true;
  let error = '';
  let pageErrorCode = '';
  let providersReady = false;
  let generation = 0;
  let themePreference: ThemePreference = readThemePreference();

  onMount(() => {
    syncDocumentLanguage($language);
    const onPopState = (event: PopStateEvent) => {
      const next = routeFromPath(window.location.pathname);
      if (route.kind === 'reader' && next.kind === 'reader'
        && route.provider === next.provider && route.sessionId === next.sessionId) return;
      const restoredHistory = restoreLibraryHistory(event.state, next.kind === 'library');
      const searchUrl = !restoredHistory && next.kind === 'library' && initializeContentSearchFromUrl();
      route = next;
      void loadRoute(next, (restoredHistory || searchUrl) && next.kind === 'library');
    };
    const restoredHistory = restoreLibraryHistory(window.history.state, route.kind === 'library');
    const searchUrl = !restoredHistory && route.kind === 'library' && initializeContentSearchFromUrl();
    window.addEventListener('popstate', onPopState);
    const onPageHide = () => {
      if (route.kind === 'library') saveLibraryHistory();
    };
    window.addEventListener('pagehide', onPageHide);
    void loadRoute(route, (restoredHistory || searchUrl) && route.kind === 'library');
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('pagehide', onPageHide);
      if (familySearchTimer) clearTimeout(familySearchTimer);
    };
  });

  function familyKey(ref: SessionRef): string {
    return ref.provider + '/' + ref.sessionId;
  }

  function initializeContentSearchFromUrl(): boolean {
    const url = new URL(window.location.href);
    const path = url.pathname.match(/^\/(sessions|[^/]+)\/search\/?$/);
    if (!path) return false;
    libraryMode = 'content';
    libraryView = 'sessions';
    contentQuery = url.searchParams.get('q') || '';
    libraryQuery = contentQuery;
    contentProviders = path[1] === 'sessions'
      ? [...new Set(url.searchParams.getAll('provider').flatMap(value => value.split(',')).filter(Boolean))].join(',')
      : path[1];
    const offset = Number(url.searchParams.get('offset') || '0');
    legacySearchOffset = !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000
      ? 'invalid' : offset > 0 ? 'first-page' : '';
    searchSubmittedQuery = legacySearchOffset === 'invalid' ? '' : contentQuery.trim();
    searchStarted = false;
    searchGeneration++;
    searchLoading = false;
    searchMatches = [];
    searchCursor = null;
    searchError = '';
    searchDiagnostics = [];
    return true;
  }

  function updateContentSearchUrl(): void {
    const url = new URL(window.location.href);
    if (route.kind !== 'library' || !/^\/[^/]+\/search\/?$/.test(url.pathname)) return;
    url.pathname = '/sessions/search';
    url.searchParams.set('q', searchSubmittedQuery);
    url.searchParams.delete('provider');
    if (contentProviders) url.searchParams.set('provider', contentProviders);
    url.searchParams.delete('offset');
    window.history.replaceState(window.history.state, '', url);
  }

  function currentLibraryFilters(): LibraryFilters {
    const filters: LibraryFilters = {};
    if (providerFilter) filters.provider = providerFilter;
    if (projectFilter.trim()) filters.project = projectFilter.trim();
    if (rangeFilter) filters.range = rangeFilter;
    if (starredOnly) filters.starredOnly = true;
    filters.sort = sortFilter;
    return filters;
  }

  function currentFamilyFilterSignature(): string {
    return JSON.stringify([titleQuery.trim(), providerFilter, projectFilter.trim(), rangeFilter, sortFilter, starredOnly]);
  }

  function libraryHistorySnapshot(scroll = window.scrollY): LibraryHistorySnapshot {
    return {
      libraryQuery, titleQuery, contentQuery, searchSubmittedQuery, mode: libraryMode, view: libraryView,
      provider: providerFilter, contentProviders, legacySearchOffset,
      project: projectFilter, range: rangeFilter, sort: sortFilter, starredOnly,
      expandedFamilies: [...expandedFamilies],
      scroll, familyCount: Math.max(restoredFamilyCount, families.length),
      childCounts: { ...childPageTargets }, focusTarget: libraryFocusTarget,
      searchMatchCount: restoredSearchMatchCount,
    };
  }

  function saveLibraryHistory(scroll = restoreLibraryPosition && hasLibraryPosition ? libraryScroll : window.scrollY): void {
    const state = (window.history.state && typeof window.history.state === 'object'
      ? window.history.state : {}) as AppHistoryState;
    window.history.replaceState({ ...state, agentSessionLibrary: libraryHistorySnapshot(scroll) }, '', window.location.href);
  }

  function restoreLibraryHistory(rawState: unknown, restoreFocus = false): boolean {
    const snapshot = (rawState as AppHistoryState | null)?.agentSessionLibrary;
    if (!snapshot) {
      libraryFocusTarget = null;
      pendingLibraryFocus = null;
      restoredSearchMatchCount = 0;
      return false;
    }
    if (searchSubmittedQuery !== (snapshot.searchSubmittedQuery ?? '')
      || contentProviders !== (snapshot.contentProviders ?? '')) {
      searchGeneration++;
      searchStarted = false;
      searchLoading = false;
      searchMatches = [];
      searchCursor = null;
      searchError = '';
      searchDiagnostics = [];
    }
    libraryQuery = snapshot.libraryQuery;
    titleQuery = snapshot.titleQuery;
    contentQuery = snapshot.contentQuery;
    searchSubmittedQuery = snapshot.searchSubmittedQuery ?? '';
    libraryMode = snapshot.mode;
    libraryView = snapshot.view;
    providerFilter = snapshot.provider;
    contentProviders = snapshot.contentProviders ?? '';
    legacySearchOffset = snapshot.legacySearchOffset ?? '';
    projectFilter = snapshot.project;
    rangeFilter = snapshot.range ?? '';
    sortFilter = snapshot.sort ?? 'updated-desc';
    starredOnly = snapshot.starredOnly ?? false;
    expandedFamilies = [...snapshot.expandedFamilies];
    libraryScroll = snapshot.scroll;
    hasLibraryPosition = true;
    restoreLibraryPosition = true;
    restoredFamilyCount = Math.max(40, snapshot.familyCount);
    childPageTargets = { ...snapshot.childCounts };
    libraryFocusTarget = snapshot.focusTarget ?? null;
    pendingLibraryFocus = restoreFocus ? libraryFocusTarget : null;
    restoredSearchMatchCount = snapshot.searchMatchCount ?? 0;
    return true;
  }

  async function restoreLibraryScrollWhenReady(): Promise<void> {
    if (!restoreLibraryPosition || route.kind !== 'library' || loading || familyLoading
      || Object.values(childLoading).some(Boolean)) return;
    await tick();
    if (!restoreLibraryPosition || route.kind !== 'library' || loading || familyLoading
      || Object.values(childLoading).some(Boolean)) return;
    restoreLibraryPosition = false;
    window.scrollTo({ top: libraryScroll, behavior: 'instant' });
  }

  function clearLibraryFocusTarget(): void {
    libraryFocusTarget = null;
    pendingLibraryFocus = null;
    restoredSearchMatchCount = 0;
  }

  function libraryLinkForFocusTarget(target: LibraryFocusTarget): HTMLAnchorElement | null {
    const path = '/' + encodeURIComponent(target.provider) + '/session/' + encodeURIComponent(target.sessionId);
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')];
    return links.find(link => link.getAttribute('href') === target.href)
      || links.find(link => {
        try { return new URL(link.getAttribute('href') || '', window.location.href).pathname === path; }
        catch { return false; }
      }) || null;
  }

  async function restoreLibraryFocusWhenReady(): Promise<void> {
    const target = pendingLibraryFocus;
    if (!target || restoringLibraryFocus || route.kind !== 'library' || loading || familyLoading || searchLoading
      || Object.values(childLoading).some(Boolean)) return;
    if (libraryMode === 'content' && libraryView === 'sessions' && searchSubmittedQuery
      && searchCursor && searchMatches.length < restoredSearchMatchCount && !searchError) return;
    restoringLibraryFocus = true;
    try {
      await tick();
      if (pendingLibraryFocus !== target || route.kind !== 'library' || loading || familyLoading || searchLoading
        || Object.values(childLoading).some(Boolean)) return;
      const link = libraryLinkForFocusTarget(target);
      if (link) link.focus({ preventScroll: true });
      else document.querySelector<HTMLInputElement>('form.list-toolbar input[type="search"]')
        ?.focus({ preventScroll: true });
      pendingLibraryFocus = null;
    } finally {
      restoringLibraryFocus = false;
    }
  }

  function clearFamilyRows(): void {
    familyLoaded = false;
    familyDirty = true;
    familyFilterSignature = '';
    families = [];
    familyTotal = 0;
    matchingSessions = 0;
    familyCursor = null;
    restoredFamilyCount = 40;
    childrenByParent = {};
    childCursors = {};
    childLoading = {};
    childErrors = {};
    childPageTargets = {};
  }

  function clearFamilyResultsForFilterChange(): void {
    familyRequest++;
    familyLoading = false;
    familyError = '';
    clearFamilyRows();
    sourceErrors = [];
  }

  async function selectedSourceDiagnostic(cause: unknown): Promise<SourceDiagnostic | null> {
    if (!providerFilter || !(cause instanceof ApiRequestError)
      || (cause.code !== 'provider_unavailable' && cause.code !== 'source_error')) return null;
    let message = cause.message;
    if (cause.code === 'provider_unavailable') {
      try {
        providers = await getProviders();
        const diagnostic = providers.find(item => item.id === providerFilter)?.storageDiagnostic;
        message = diagnostic?.note || cause.message;
      } catch {
        // Keep the selected-provider request error if its status cannot be refreshed.
      }
    }
    return { provider: providerFilter, message };
  }

  async function refreshFamilies(preservePages = true,
    initialPage?: Promise<PromiseSettledResult<LibraryFamilyPage>>): Promise<void> {
    const request = ++familyRequest;
    const routeRequest = generation;
    const search = titleQuery.trim();
    const loadedCount = preservePages ? Math.max(40, families.length, restoredFamilyCount) : 40;
    const filters = currentLibraryFilters();
    const filterSignature = currentFamilyFilterSignature();
    familyLoading = true;
    familyError = '';
    try {
      let cursor: string | null = null;
      let next: LibraryNode[] = [];
      let page;
      do {
        if (initialPage) {
          const result = await initialPage;
          initialPage = undefined;
          if (result.status === 'rejected') throw result.reason;
          page = result.value;
        } else page = await getLibraryFamilies(search, cursor ?? undefined, filters);
        if (request !== familyRequest || routeRequest !== generation) return;
        next = [...next, ...page.families];
        cursor = page.nextCursor;
      } while (cursor && next.length < loadedCount);
      families = next;
      familyTotal = page.total;
      matchingSessions = page.matchingSessions;
      sourceErrors = page.sourceDiagnostics;
      familyCursor = cursor;
      familyLoaded = true;
      familyDirty = false;
      familyFilterSignature = filterSignature;
      restoredFamilyCount = next.length;
      childrenByParent = {};
      childCursors = {};
      childLoading = {};
      childErrors = {};
      for (const family of next) {
        if ((expandedFamilies.includes(familyKey(family.session.session)) || search)
          && family.childCount > 0) void loadChildren(family.session.session);
      }
      saveLibraryHistory();
    } catch (cause) {
      if (request === familyRequest && routeRequest === generation) {
        const diagnostic = await selectedSourceDiagnostic(cause);
        if (request !== familyRequest || routeRequest !== generation) return;
        if (diagnostic) {
          clearFamilyRows();
          sourceErrors = [diagnostic];
          familyError = t($language, 'The session library could not load.');
        } else {
          sourceErrors = [];
          familyError = cause instanceof Error ? cause.message : t($language, 'The session library could not load.');
        }
      }
    } finally {
      if (request === familyRequest) {
        familyLoading = false;
        if (routeRequest === generation) {
          void restoreLibraryScrollWhenReady();
          void restoreLibraryFocusWhenReady();
        }
      }
    }
  }

  async function loadMoreFamilies(): Promise<void> {
    if (!familyCursor || familyLoading) return;
    const request = familyRequest;
    familyLoading = true;
    familyError = '';
    try {
      const page = await getLibraryFamilies(titleQuery.trim(), familyCursor, currentLibraryFilters());
      if (request !== familyRequest) return;
      const seen = new Set(families.map(node => familyKey(node.session.session)));
      const added = page.families.filter(node => !seen.has(familyKey(node.session.session)));
      families = [...families, ...added];
      familyTotal = page.total;
      matchingSessions = page.matchingSessions;
      sourceErrors = page.sourceDiagnostics;
      familyCursor = page.nextCursor;
      restoredFamilyCount = families.length;
      saveLibraryHistory();
      if (titleQuery.trim()) for (const node of added) {
        if (node.childCount > 0) void loadChildren(node.session.session);
      }
    } catch (cause) {
      if (request === familyRequest) {
        const diagnostic = await selectedSourceDiagnostic(cause);
        if (request !== familyRequest) return;
        if (diagnostic) {
          clearFamilyRows();
          sourceErrors = [diagnostic];
          familyError = t($language, 'The session library could not load.');
        } else {
          sourceErrors = [];
          familyError = cause instanceof Error ? cause.message : t($language, 'More families could not load.');
        }
      }
    } finally {
      if (request === familyRequest) {
        familyLoading = false;
        void restoreLibraryScrollWhenReady();
        void restoreLibraryFocusWhenReady();
      }
    }
  }

  async function loadChildren(parent: SessionRef, more = false): Promise<void> {
    const key = familyKey(parent);
    if (childLoading[key] || (more && !childCursors[key]) || (!more && childrenByParent[key])) return;
    const request = familyRequest;
    childLoading = { ...childLoading, [key]: true };
    childErrors = { ...childErrors, [key]: '' };
    try {
      const existing = more ? childrenByParent[key] || [] : [];
      const targetCount = more ? existing.length + 20 : childPageTargets[key] || 0;
      let rows = existing;
      let cursor = more ? childCursors[key] : undefined;
      const addedRows: LibraryNode[] = [];
      let page;
      do {
        page = await getLibraryChildren(parent, titleQuery.trim(), cursor ?? undefined, currentLibraryFilters());
        if (request !== familyRequest) return;
        const seen = new Set(rows.map(node => familyKey(node.session.session)));
        const added = page.children.filter(node => !seen.has(familyKey(node.session.session)));
        addedRows.push(...added);
        rows = [...rows, ...added];
        cursor = page.nextCursor;
      } while (cursor && rows.length < targetCount);
      childrenByParent = { ...childrenByParent, [key]: rows };
      childCursors = { ...childCursors, [key]: cursor };
      childPageTargets = { ...childPageTargets, [key]: rows.length };
      saveLibraryHistory();
      for (const node of addedRows) {
        if (node.childCount > 0 && (titleQuery.trim() || expandedFamilies.includes(familyKey(node.session.session)))) {
          void loadChildren(node.session.session);
        }
      }
    } catch (cause) {
      if (request === familyRequest) childErrors = { ...childErrors,
        [key]: cause instanceof Error ? cause.message : t($language, 'Child sessions could not load.') };
    } finally {
      if (request === familyRequest) {
        childLoading = { ...childLoading, [key]: false };
        void restoreLibraryScrollWhenReady();
        void restoreLibraryFocusWhenReady();
      }
    }
  }

  function retryChildren(parent: SessionRef): void {
    const key = familyKey(parent);
    const remaining = { ...childrenByParent };
    delete remaining[key];
    childrenByParent = remaining;
    childCursors = { ...childCursors, [key]: null };
    childErrors = { ...childErrors, [key]: '' };
    saveLibraryHistory();
    void loadChildren(parent);
  }

  function toggleFamily(parent: SessionRef): void {
    const key = familyKey(parent);
    if (expandedFamilies.includes(key)) expandedFamilies = expandedFamilies.filter(value => value !== key);
    else {
      expandedFamilies = [...expandedFamilies, key];
      void loadChildren(parent);
    }
    saveLibraryHistory();
  }

  function changeLibraryQuery(value: string): void {
    clearLibraryFocusTarget();
    libraryQuery = value;
    if (libraryMode !== 'sessions') {
      contentQuery = value;
      saveLibraryHistory();
      return;
    }
    titleQuery = value;
    restoredFamilyCount = 40;
    childPageTargets = {};
    clearFamilyResultsForFilterChange();
    saveLibraryHistory();
    if (familySearchTimer) clearTimeout(familySearchTimer);
    familySearchTimer = setTimeout(() => void refreshFamilies(false), 180);
  }

  function changeProviderFilter(value: string): void {
    if (providerFilter === value) return;
    clearLibraryFocusTarget();
    providerFilter = value;
    restoredFamilyCount = 40;
    childPageTargets = {};
    clearFamilyResultsForFilterChange();
    saveLibraryHistory();
    if (familySearchTimer) clearTimeout(familySearchTimer);
    void refreshFamilies(false);
  }

  function changeContentProviders(value: string): void {
    if (contentProviders === value) return;
    clearLibraryFocusTarget();
    contentProviders = value;
    searchGeneration++;
    searchLoading = false;
    searchMatches = [];
    searchCursor = null;
    searchError = '';
    searchDiagnostics = [];
    updateContentSearchUrl();
    saveLibraryHistory();
    if (searchSubmittedQuery) void refreshSubmittedContentSearch();
  }

  function changeProjectFilter(value: string): void {
    if (projectFilter === value) return;
    clearLibraryFocusTarget();
    projectFilter = value;
    restoredFamilyCount = 40;
    childPageTargets = {};
    clearFamilyResultsForFilterChange();
    saveLibraryHistory();
    if (familySearchTimer) clearTimeout(familySearchTimer);
    familySearchTimer = setTimeout(() => void refreshFamilies(false), 180);
  }

  function changeRangeFilter(value: '' | NonNullable<LibraryFilters['range']>): void {
    if (rangeFilter === value) return;
    clearLibraryFocusTarget();
    rangeFilter = value;
    restoredFamilyCount = 40;
    childPageTargets = {};
    clearFamilyResultsForFilterChange();
    saveLibraryHistory();
    if (familySearchTimer) clearTimeout(familySearchTimer);
    void refreshFamilies(false);
  }

  function changeSortFilter(value: NonNullable<LibraryFilters['sort']>): void {
    if (sortFilter === value) return;
    clearLibraryFocusTarget();
    sortFilter = value;
    restoredFamilyCount = 40;
    childPageTargets = {};
    clearFamilyResultsForFilterChange();
    saveLibraryHistory();
    if (familySearchTimer) clearTimeout(familySearchTimer);
    void refreshFamilies(false);
  }

  function changeStarredOnly(value: boolean): void {
    if (starredOnly === value) return;
    clearLibraryFocusTarget();
    starredOnly = value;
    restoredFamilyCount = 40;
    childPageTargets = {};
    clearFamilyResultsForFilterChange();
    saveLibraryHistory();
    if (familySearchTimer) clearTimeout(familySearchTimer);
    void refreshFamilies(false);
  }

  function openSourceSettings(provider: string): void {
    if (route.kind === 'library') saveLibraryHistory();
    window.history.pushState({ agentSessionLibrary: libraryHistorySnapshot() }, '', sourceSettingsHref(provider));
    route = { kind: 'settings' };
    void loadRoute(route);
  }

  function navigate(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const returningToLibrary = route.kind === 'reader' && path === '/sessions';
    if (route.kind === 'library') saveLibraryHistory();
    const state = (window.history.state && typeof window.history.state === 'object'
      ? window.history.state : {}) as AppHistoryState;
    const librarySnapshot = returningToLibrary && state.agentSessionLibrary
      ? state.agentSessionLibrary : libraryHistorySnapshot();
    window.history.pushState({ ...state, agentSessionLibrary: librarySnapshot }, '', path);
    if (returningToLibrary) pendingLibraryFocus = libraryFocusTarget;
    route = routeFromPath(path);
    void loadRoute(route, returningToLibrary);
  }

  async function loadRoute(next: Route, restoreSubmittedContentSearch = false): Promise<void> {
    const request = ++generation;
    loading = true;
    error = '';
    pageErrorCode = '';
    reader = null;
    settings = null;
    try {
      const parallelLibrary = next.kind === 'library' && !providersReady &&
        (!familyLoaded || familyDirty || familyFilterSignature !== currentFamilyFilterSignature());
      // Publish and report this prefetched page through refreshFamilies after discovery.
      const initialFamilyPage = parallelLibrary
        ? getLibraryFamilies(titleQuery.trim(), undefined, currentLibraryFilters()).then(
          value => ({ status: 'fulfilled', value } as const),
          reason => ({ status: 'rejected', reason } as const),
        ) : undefined;
      const [, nextReader] = await Promise.all([
        providersReady ? providers : getProviders().then(nextProviders => {
          providers = nextProviders;
          providersReady = true;
          return nextProviders;
        }),
        next.kind === 'reader' ? getReaderBootstrap(next.provider, next.sessionId,
          window.location.hash.startsWith('#event?') ? new URLSearchParams(window.location.hash.slice(7)) : undefined) : null,
      ]);
      if (request !== generation) return;
      if (next.kind === 'settings') {
        const nextSettings = await getSettings();
        if (request !== generation) return;
        settings = nextSettings;
      } else if (next.kind === 'stats') {
        // The statistics page owns its selected range and request lifecycle.
      } else if (next.kind === 'reader') {
        reader = nextReader;
      } else {
        if (!familyLoaded || familyDirty || familyFilterSignature !== currentFamilyFilterSignature()) {
          await refreshFamilies(true, initialFamilyPage);
        }
        if (request !== generation) return;
        if (restoreSubmittedContentSearch && !searchStarted && libraryView === 'sessions'
          && libraryMode === 'content' && searchSubmittedQuery) {
          void refreshSubmittedContentSearch();
        }
        if (libraryView === 'trash') void refreshTrash();
      }
    } catch (cause) {
      if (request === generation) {
        error = cause instanceof Error ? cause.message : t($language, 'The local service could not load this page.');
        pageErrorCode = cause instanceof ApiRequestError ? cause.code : '';
      }
    } finally {
      if (request === generation) {
        loading = false;
        if (next.kind === 'library' && hasLibraryPosition) {
          restoreLibraryPosition = true;
          void restoreLibraryScrollWhenReady();
        }
        if (next.kind === 'library') void restoreLibraryFocusWhenReady();
      }
    }
  }

  function openSession(session: SessionRef): void {
    if (route.kind === 'library') {
      libraryScroll = window.scrollY;
      hasLibraryPosition = true;
      libraryFocusTarget = {
        provider: session.provider, sessionId: session.sessionId,
        href: '/' + encodeURIComponent(session.provider) + '/session/' + encodeURIComponent(session.sessionId),
      };
      pendingLibraryFocus = null;
      restoredSearchMatchCount = 0;
      saveLibraryHistory(libraryScroll);
    }
    const path = '/' + encodeURIComponent(session.provider) + '/session/' + encodeURIComponent(session.sessionId);
    window.history.pushState({ agentSessionLibrary: libraryHistorySnapshot() }, '', path);
    route = { kind: 'reader', provider: session.provider, sessionId: session.sessionId };
    void loadRoute(route);
  }

  function selectStatsProvider(provider: string): void {
    const path = provider === 'all' ? '/stats' : '/stats?' + new URLSearchParams({ providers: provider });
    window.history.pushState({ agentSessionLibrary: libraryHistorySnapshot() }, '', path);
    route = { kind: 'stats', provider };
  }

  function openSearchMatch(match: SearchMatch): void {
    const href = searchMatchHref(match);
    if (route.kind === 'library') {
      libraryScroll = window.scrollY;
      hasLibraryPosition = true;
      libraryFocusTarget = { provider: match.session.provider, sessionId: match.session.sessionId, href };
      pendingLibraryFocus = null;
      restoredSearchMatchCount = searchMatches.length;
      saveLibraryHistory(libraryScroll);
    }
    window.history.pushState({ agentSessionLibrary: libraryHistorySnapshot() }, '', href);
    route = { kind: 'reader', provider: match.session.provider, sessionId: match.session.sessionId };
    void loadRoute(route);
  }

  async function runContentSearch(more = false, refreshSubmitted = false): Promise<void> {
    const term = more ? searchSubmittedQuery : refreshSubmitted ? searchSubmittedQuery : libraryQuery.trim();
    if (!term || (!refreshSubmitted && searchLoading) || (more && !searchCursor)) return;
    const request = ++searchGeneration;
    searchStarted = true;
    searchLoading = true;
    searchError = '';
    if (!more) {
      searchMatches = [];
      searchCursor = null;
      searchSubmittedQuery = term;
      searchDiagnostics = [];
      if (!refreshSubmitted) {
        if (legacySearchOffset === 'invalid') legacySearchOffset = '';
        updateContentSearchUrl();
        saveLibraryHistory();
      }
    }
    try {
      const page = await searchSessions(term, more ? searchCursor ?? undefined : undefined, contentProviders);
      if (request !== searchGeneration) return;
      searchMatches = more ? [...searchMatches, ...page.matches] : page.matches;
      searchCursor = page.nextCursor;
      searchDiagnostics = page.diagnostics.filter(row => row.status === 'error' || row.status === 'partial');
    } catch (cause) {
      if (request === searchGeneration) {
        searchError = cause instanceof Error ? cause.message : t($language, 'The search could not finish.');
      }
    } finally {
      if (request === searchGeneration) {
        searchLoading = false;
        void restoreLibraryFocusWhenReady();
      }
    }
  }

  async function refreshSubmittedContentSearch(): Promise<void> {
    if (!searchSubmittedQuery) return;
    const targetCount = pendingLibraryFocus ? restoredSearchMatchCount : 0;
    let more = false;
    while (true) {
      const previousCount = searchMatches.length;
      await runContentSearch(more, true);
      if (!pendingLibraryFocus || searchMatches.length >= targetCount || !searchCursor
        || searchMatches.length <= previousCount) break;
      more = true;
    }
    if (route.kind === 'library' && hasLibraryPosition) {
      await tick();
      if (route.kind === 'library' && hasLibraryPosition) {
        window.scrollTo({ top: libraryScroll, behavior: 'instant' });
      }
    }
    void restoreLibraryFocusWhenReady();
  }

  async function refreshTrash(): Promise<void> {
    const request = ++trashReadGeneration;
    trashLoading = true;
    trashError = '';
    trashFailedSources = 0;
    trashReadState = 'unread';
    try {
      const pages = await Promise.allSettled(providers.map(provider => getViewerTrash(provider.id)));
      if (request !== trashReadGeneration) return;
      trashRows = pages.flatMap(page => page.status === 'fulfilled' ? page.value : [])
        .sort((left, right) => (right.timeDeleted ?? 0) - (left.timeDeleted ?? 0));
      const failed = pages.filter(page => page.status === 'rejected');
      trashReadState = failed.length === 0 ? 'complete'
        : failed.length === pages.length ? 'failed' : 'partial';
      trashFailedSources = failed.length;
    } catch (cause) {
      if (request !== trashReadGeneration) return;
      trashReadState = 'failed';
      trashError = cause instanceof Error ? cause.message : t($language, 'Trash could not be loaded.');
    } finally {
      if (request === trashReadGeneration) trashLoading = false;
    }
  }

  function invalidateTrashRead(): void {
    trashReadGeneration++;
    trashReadState = 'unread';
    trashLoading = false;
  }

  function changeLibraryView(next: 'sessions' | 'trash'): void {
    clearLibraryFocusTarget();
    libraryView = next;
    saveLibraryHistory();
    if (next === 'trash') void refreshTrash();
  }

  function changeLibraryMode(next: 'sessions' | 'content'): void {
    if (next === libraryMode) return;
    clearLibraryFocusTarget();
    if (libraryMode === 'sessions') titleQuery = libraryQuery;
    else contentQuery = libraryQuery;
    libraryQuery = next === 'sessions' ? titleQuery : contentQuery;
    libraryMode = next;
    saveLibraryHistory();
    if (next === 'sessions' && !familyLoaded) void refreshFamilies();
  }

  async function manageTrash(row: ViewerMeta, action: 'restore' | 'permanent-delete'): Promise<void> {
    if (trashActionBusy) return;
    trashActionBusy = true;
    trashError = '';
    try {
      await mutateViewer(row.provider, row.sessionId, action);
      void refreshSubmittedContentSearch();
      trashRows = trashRows.filter(entry => entry.provider !== row.provider || entry.sessionId !== row.sessionId);
      await refreshFamilies();
    } catch (cause) {
      trashError = cause instanceof Error ? cause.message : t($language, 'The Viewer change could not be saved.');
    } finally {
      trashActionBusy = false;
    }
  }

  async function manageLibraryBatch(action: BatchAction, items: SessionRef[]): Promise<BatchResult> {
    const result = await batchViewer(action, items);
    if (!result.ok) throw new Error(t($language, 'The Viewer change could not be saved.'));
    if (action === 'delete') invalidateTrashRead();
    await refreshFamilies();
    void refreshSubmittedContentSearch();
    return result;
  }

  function goToLibrary(event: MouseEvent): void {
    navigate(event, '/sessions');
  }

  function changeTheme(event: Event): void {
    themePreference = (event.currentTarget as HTMLSelectElement).value as ThemePreference;
    saveThemePreference(themePreference);
  }

  function afterReaderDelete(): void {
    invalidateTrashRead();
    window.history.pushState({ agentSessionLibrary: libraryHistorySnapshot() }, '', '/sessions');
    route = { kind: 'library' };
    libraryScroll = 0;
    hasLibraryPosition = false;
    familyDirty = true;
    restoredFamilyCount = 40;
    childPageTargets = {};
    void loadRoute(route);
    void refreshSubmittedContentSearch();
  }

  function afterReaderRename(title: string): void {
    familyDirty = true;
    void refreshFamilies();
    void refreshSubmittedContentSearch();
    if (route.kind === 'reader' && reader && reader.session.session.provider === route.provider
      && reader.session.session.sessionId === route.sessionId) {
      reader = { ...reader, session: { ...reader.session, title } };
    }
  }

  $: pageTitle = route.kind === 'reader' ? (reader?.session.title || t($language, 'Session Reader'))
    : route.kind === 'settings' ? t($language, 'Settings') : route.kind === 'stats' ? t($language, 'Token statistics') : t($language, 'Session library');
</script>

<svelte:head>
  <title>{pageTitle} · AgentSession</title>
</svelte:head>

<div class="app-shell">
  <header class="topbar">
    <a class="brand" href="/sessions" onclick={goToLibrary} aria-label={t($language, 'AgentSession session library')}>
      <span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>
      <span>AgentSession</span>
    </a>
    <div class="topbar-right">
      <a class="settings-nav-link" href="/stats" onclick={(event) => navigate(event, '/stats')}
        aria-current={route.kind === 'stats' ? 'page' : undefined}>{t($language, 'Stats')}</a>
      <a class="settings-nav-link" href="/settings" onclick={(event) => navigate(event, '/settings')}
        aria-current={route.kind === 'settings' ? 'page' : undefined}>{t($language, 'Settings')}</a>
      <label class="theme-control">
        <span class="sr-only">{t($language, 'Theme preference')}</span>
        <select class="theme-select" aria-label={t($language, 'Theme preference')} bind:value={themePreference} onchange={changeTheme}>
          <option value="system">{t($language, 'System')}</option>
          <option value="light">{t($language, 'Light')}</option>
          <option value="dark">{t($language, 'Dark')}</option>
        </select>
      </label>
      <label class="theme-control">
        <span class="sr-only">{t($language, 'Language')}</span>
        <select class="language-select" aria-label={t($language, 'Language')} value={$language}
          onchange={(event) => setLanguage(event.currentTarget.value as Language)}>
          <option value="en">English</option>
          <option value="zh">简体中文</option>
        </select>
      </label>
    </div>
  </header>

  {#if loading}
    <main class="loading-state" aria-live="polite">
      <span class="loading-mark" aria-hidden="true"></span>
      <p>{t($language, 'Opening your sessions…')}</p>
    </main>
  {:else if error}
    <main class="error-state" role="alert">
      {#if route.kind === 'reader' && pageErrorCode === 'session_not_found'}
        <p class="state-kicker">{t($language, 'Session Reader')}</p>
        <h1>{t($language, 'Session not found')}</h1>
        <p>{t($language, 'This session is not in the current sources. Return to your sessions to open an available history.')}</p>
        <details>
          <summary>{t($language, 'Technical details')}</summary>
          <p>{error}</p>
        </details>
        <a class="quiet-button" href="/sessions" onclick={goToLibrary}>{t($language, 'All sessions')}</a>
      {:else if route.kind === 'reader' && pageErrorCode === 'protocol_unavailable'}
        <p class="state-kicker">{t($language, 'Session Reader')}</p>
        <h1>{t($language, 'Recorded history unavailable')}</h1>
        <p>{t($language, 'The local records for this session could not be read. You can return to your sessions or try again.')}</p>
        <details>
          <summary>{t($language, 'Technical details')}</summary>
          <p>{error}</p>
        </details>
        <a class="quiet-button" href="/sessions" onclick={goToLibrary}>{t($language, 'All sessions')}</a>
      {:else}
        <p class="state-kicker">{t($language, 'The page could not load')}</p>
        <h1>{t($language, 'Check the local service')}</h1>
        <p>{error}</p>
      {/if}
      <button class="quiet-button" onclick={() => void loadRoute(route)}>{t($language, 'Try again')}</button>
    </main>
  {:else if route.kind === 'settings' && settings}
    <SettingsPage {settings} />
  {:else if route.kind === 'stats'}
    <StatsPage {providers} provider={route.provider || 'all'}
      onSelectProvider={selectStatsProvider} onOpen={openSession} />
  {:else if route.kind === 'reader' && reader}
    <ReaderPage provider={route.provider} sessionId={route.sessionId} bootstrap={reader}
      onBack={goToLibrary} onOpen={openSession} onDeleted={afterReaderDelete} onRenamed={afterReaderRename}
      onStarred={() => { familyDirty = true; }} />
  {:else}
    <LibraryPage {providers} {families} {familyTotal} {matchingSessions} {familyCursor} {familyLoading} {familyError}
      {childrenByParent} {childCursors} {childLoading} {childErrors} {sourceErrors} query={libraryQuery}
      {providerFilter} {projectFilter} {rangeFilter} {sortFilter} {starredOnly} onProviderFilterChange={changeProviderFilter}
      onProjectFilterChange={changeProjectFilter} onRangeFilterChange={changeRangeFilter}
      onSortFilterChange={changeSortFilter} onStarredOnlyChange={changeStarredOnly}
      {expandedFamilies} onQueryChange={changeLibraryQuery} onToggleFamily={toggleFamily}
      onLoadMoreFamilies={loadMoreFamilies} onRefreshFamilies={() => void refreshFamilies(false)}
      onLoadChildren={loadChildren} onRetryChildren={retryChildren}
      mode={libraryMode} onModeChange={changeLibraryMode} {libraryView} {trashRows} {trashLoading} trashError={trashStatusError} {trashActionBusy}
      {trashReadState} onRetryTrash={() => void refreshTrash()} onOpenSettings={openSourceSettings}
      onViewChange={changeLibraryView} onTrashAction={manageTrash}
      onBatchAction={manageLibraryBatch}
      {searchMatches} {searchCursor} {searchSubmittedQuery}
      {searchLoading} {searchError} {searchDiagnostics} onSearch={runContentSearch}
      {contentProviders} {legacySearchOffset} onContentProvidersChange={changeContentProviders}
      onOpen={openSession} onOpenSearchMatch={openSearchMatch} />
  {/if}
</div>
