<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { ContentField, ContentProgress, ProtocolDiagnostic, ReaderBootstrap, ReaderChildPlacement, ReaderCollaborationSnapshot, ReaderEventRef, ReaderItem, ReaderSearchTarget, ReaderSegment, ReaderTocEntry, ReaderTocPage, RelationEntry, RelationParticipant, RuntimeExecutionEvent, SessionRef, ViewerMeta } from './api';
  import { ApiRequestError, getContentPage, getReaderChildLocation, getReaderLocation, getReaderRelations, getReaderSegment, getReaderToc, getReaderExecutionEvents, getTeamMessageContentPage, getViewerMeta, mutateViewer } from './api';
  import EventCard, { type DisplayItem, type ExecutionLandmark, type SearchReveal } from './EventCard.svelte';
  import InheritedContext from './InheritedContext.svelte';
  import InlineChildReader from './InlineChildReader.svelte';
  import PaneSearch, { type PaneSearchState } from './PaneSearch.svelte';
  import RecordedMemory from './RecordedMemory.svelte';
  import RuntimeEvents from './RuntimeEvents.svelte';
  import { readRuntimeHistory, runtimeHash, runtimeSourceHash } from './runtime-history';
  import { searchTargetFromHash } from './search-navigation';
  import SystemPromptEvidence from './SystemPromptEvidence.svelte';
  import CollaborationTimeline from './CollaborationTimeline.svelte';
  import TranscriptCollaboration from './TranscriptCollaboration.svelte';
  import ReaderContinuation from './ReaderContinuation.svelte';
  import { readerCollaborationIdentity, transcriptHandoffs } from './transcript-collaboration';
  import { groupReaderItems, groupReaderProcesses, type ProcessUnit, type ReaderBlock } from './reader-presentation';
  import { diagnosticText, errorText, language, protocolLabel, t, type Language } from './i18n';

  export let provider: string;
  export let sessionId: string;
  export let bootstrap: ReaderBootstrap;
  export let onBack: (event: MouseEvent) => void;
  export let onOpen: (session: SessionRef) => void;
  export let onDeleted: () => void;
  export let onRenamed: (title: string) => void;
  export let onStarred: () => void = () => {};
  let runtimePanel: RuntimeEvents | null = null;
  let conversationHash = window.location.hash.startsWith('#runtime?') ? '' : window.location.hash;

  type OutlineNode = { key: string; entry: ReaderTocEntry };
  interface OutlineTurn { key: string; request: ReaderTocEntry | null; children: OutlineNode[] }

  let segments: ReaderSegment[] = bootstrap.targetLocation
    ? [bootstrap.segments[bootstrap.segments.length - 1]] : [...bootstrap.segments];
  let toc: ReaderTocPage = bootstrap.openingToc ? { ...bootstrap.openingToc,
    entries: mergeToc(bootstrap.openingToc.entries, bootstrap.toc.entries) } : bootstrap.toc;
  const tocEntriesByEvent = new Map(toc.entries.map(entry => [eventKey(entry.event), entry]));
  let tocCursor = bootstrap.openingToc?.nextCursor ?? bootstrap.toc.nextCursor;
  let searchOpen = false;
  let sessionDetailsOpen = false;
  let expandedOutlineTurns = new Set<string>();
  let outlineExpandAll = false;
  let transcriptElement: HTMLElement | null = null;
  let outlineElement: HTMLElement | null = null;
  let readingKey = '';
  let readingOrdinal = 0;
  let readingPercent = 0;
  let readingFrame = 0;
  let followReading = false;
  let readerMounted = false;
  const openingItem = bootstrap.segments[0]?.items[0];
  const openingMessage = openingItem?.ordinal === 0 && openingItem.role === 'assistant' &&
    openingItem.event.segment === 'message' && openingItem.presentationPhase === 'commentary' &&
    openingItem.totalChars > 0 && openingItem.processId !== null &&
    openingItem.processCount !== null && openingItem.processCount > 1
      ? openingItem : null;
  let content: Record<string, ContentProgress> = {};
  const contentLoads = new Map<string, Promise<void>>();
  let searchReveals: Record<string, SearchReveal> = {};
  let searchSelectionGeneration = 0;
  let pageLoading = false;
  let tocLoading = false;
  let locationLoading = false;
  let pageError = '';
  let tocError = '';
  let locationError = '';
  let relationEntries: RelationEntry[] = [];
  let childPlacements: ReaderChildPlacement[] = [];
  let childCollaboration: Record<string, ReaderCollaborationSnapshot> = {};
  let executionEvents: RuntimeExecutionEvent[] = [];
  let executionComplete = false;
  let executionCursor: string | null = null;
  let executionLoading = false;
  let executionError = '';
  let executionDiagnostics: ProtocolDiagnostic[] = [];
  let executionDiagnosticsTruncated = false;
  let activeChildPath: SessionRef[] = childPathFromHash();
  let selectedChildSearch: ReaderSearchTarget | null = childSearchFromHash();
  let selectionHistoryVersion = 0;
  type ReaderSearchHistory = { owner: SessionRef; panes: Record<string, PaneSearchState> };
  type ReaderHistoryState = { agentSessionReaderSearch?: ReaderSearchHistory };
  let paneSearchStates = readPaneSearchHistory();
  searchOpen = Boolean(paneSearchStates[provider + '\0' + sessionId]?.query);

  async function openSessionSearch(): Promise<void> {
    searchOpen = true;
    await tick();
    document.querySelector<HTMLInputElement>('.reader-search-disclosure .pane-search input')?.focus();
  }

  function closeSessionSearch(): void {
    searchOpen = false;
    document.querySelector<HTMLButtonElement>('.reader-find-toggle')?.focus();
  }

  function readPaneSearchHistory(): Record<string, PaneSearchState> {
    const saved = (window.history.state as ReaderHistoryState | null)?.agentSessionReaderSearch;
    return saved?.owner.provider === provider && saved.owner.sessionId === sessionId ? saved.panes : {};
  }

  function savePaneSearch(source: SessionRef, state: PaneSearchState): void {
    if (!active) return;
    paneSearchStates = { ...paneSearchStates, [childKey(source)]: state };
    window.history.replaceState({ ...window.history.state,
      agentSessionReaderSearch: { owner: { provider, sessionId }, panes: paneSearchStates },
    }, '');
  }
  let relationCursor = bootstrap.relations?.firstCursor ?? null;
  let relationLoading = false;
  let resolveInitialLayout!: () => void;
  const initialLayoutReady = new Promise<void>(resolve => { resolveInitialLayout = resolve; });
  let relationError = '';
  let teamMessagePages: Record<string, { text: string; nextOffset: number | null; loading: boolean; error: string }> = {};
  let selectedParticipantId = '';
  let active = true;
  let pageGeneration = 0;
  let tocGeneration = 0;
  let locationGeneration = 0;
  let relationGeneration = 0;
  let childRestoreGeneration = 0;
  let focusRestoredRoot = false;
  let lastHandledHash: string | null = null;
  let taskReturnFocus: HTMLElement | null = null;
  let viewerMeta: ViewerMeta | null = null;
  let metaReady = false;
  let resumeInfo: { allowTerminalLaunch: boolean; available: boolean; diagnostic: string | null; command: { executable: string; args: string[]; cwd: string } | null } | null = null;
  let resumeBusy = false;
  let resumeMessage = '';
  const resumeUrl = '/api/v3/resume/' + encodeURIComponent(provider) + '/' + encodeURIComponent(sessionId);
  async function launchResume(): Promise<void> {
    resumeBusy = true; resumeMessage = '';
    try {
      const response = await fetch(resumeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || t($language, 'Terminal launch failed'));
      resumeMessage = t($language, 'Terminal started');
    } catch (cause) { resumeMessage = cause instanceof Error ? cause.message : String(cause); }
    finally { resumeBusy = false; }
  }
  let managementBusy = false;
  let managementError = '';
  let renaming = false;
  let renameDraft = bootstrap.session.title;
  let effectiveTitle = bootstrap.session.title;
  let view: 'conversation' | 'runtime' = window.location.hash.startsWith('#runtime?') ? 'runtime' : 'conversation';
  const collaborationPreferenceKey = 'agentsession.reader.collaboration-panel.v1';
  let collaborationPreference: 'open' | 'closed' | null = null;
  try {
    const stored = window.localStorage.getItem(collaborationPreferenceKey);
    if (stored === 'open' || stored === 'closed') collaborationPreference = stored;
  } catch { /* The current page can still control the panel when storage is unavailable. */ }
  let collaborationOpen = collaborationPreference === 'open';

  function setCollaborationOpen(open: boolean): void {
    collaborationPreference = open ? 'open' : 'closed';
    collaborationOpen = open;
    try { window.localStorage.setItem(collaborationPreferenceKey, collaborationPreference); }
    catch { /* Current-page state remains usable. */ }
    void tick().then(() => document.querySelector<HTMLButtonElement>(
      open ? '.collaboration-close' : '.collaboration-launcher')?.focus());
  }

  $: orderedSegments = [...segments].sort((a, b) => a.startOrdinal - b.startOrdinal);
  $: items = orderedSegments.flatMap(segment => segment.items);
  $: itemsByAnchor = new Map(items.map(item => [stableAnchor(item.event), item]));
  $: hasTranscriptHandoffs = transcriptHandoffs(relationEntries, { provider, sessionId }).length > 0;
  $: if (relationCursor && !relationLoading && !relationError && items.some(item =>
    item.role === 'agent' && !readerCollaborationIdentity(relationEntries, item.event))) void loadRelations();
  $: blocks = groupReaderItems(items, makeDisplay);
  $: processUnits = groupReaderProcesses(blocks);
  $: outlineTurns = groupOutline(toc.entries);
  $: outlineTurnByEvent = new Map(outlineTurns.flatMap(turn =>
    turn.children.map(node => [node.key, turn] as const)));
  $: if (outlineExpandAll) expandedOutlineTurns = new Set(outlineTurns.map(turn => turn.key));
  $: executionLandmarksByAnchor = createExecutionLandmarks(executionEvents, executionComplete, executionCursor !== null);
  $: if (readerMounted && executionCursor && !executionLoading && !executionError) void loadExecutionFacts(executionCursor);
  $: firstPage = orderedSegments[0];
  $: lastPage = orderedSegments[orderedSegments.length - 1];
  $: if (readerMounted && items && view === 'conversation') void tick().then(() => scheduleReading(false));
  $: if (readerMounted && tocCursor && !tocLoading && !tocError && !locationLoading) void loadToc();
  $: panelSource = activeChildPath.at(-1) ?? bootstrap.session.session;
  $: hasCollaboration = activeChildPath.length > 0 ||
    Boolean(bootstrap.relations && (bootstrap.relations.taskCount > 0 || bootstrap.relations.observationCount > 0));
  $: shortExchange = bootstrap.totalItems === 2 && items.length === 2 &&
    items[0].role === 'user' && items[1].role === 'assistant' &&
    !hasCollaboration && !firstPage?.previousCursor && !lastPage?.nextCursor;
  $: childPanel = activeChildPath.length > 0 ? childCollaboration[childKey(panelSource)] : null;
  $: panelEntries = activeChildPath.length > 0 ? childPanel?.entries ?? [] : relationEntries;
  $: panelCursor = activeChildPath.length > 0 ? childPanel?.nextCursor ?? null : relationCursor;
  $: panelLoading = activeChildPath.length > 0 ? childPanel?.loading ?? false : relationLoading;
  $: panelError = activeChildPath.length > 0 ? childPanel?.error ?? '' : relationError;
  $: panelRevision = activeChildPath.length > 0 ? childPanel?.revision ?? '' : bootstrap.revision;
  $: panelParticipants = recordedParticipants(panelEntries);
  $: panelUnassignedTasks = panelEntries.flatMap(entry =>
    entry.type === 'task' && !entry.task.ownerParticipant ? [entry.task] : []);
  $: selectedParticipant = panelParticipants.find(participant => participant.id === selectedParticipantId) ?? panelParticipants[0];
  $: participantEntries = selectedParticipant ? panelEntries.filter(entry =>
    entry.type === 'task' ? entry.task.ownerParticipant?.id === selectedParticipant.id :
      entry.observation.fromParticipant?.id === selectedParticipant.id ||
      entry.observation.toParticipant?.id === selectedParticipant.id) : [];
  $: expandedRootChildKey = activeChildPath.length > 0 ? childKey(activeChildPath[0]) : '';
  $: placementsByAnchor = childPlacements.reduce((map, placement) => {
    if (placement.afterEvent) {
      const key = eventKey(placement.afterEvent);
      map.set(key, [...(map.get(key) ?? []), placement]);
    }
    return map;
  }, new Map<string, ReaderChildPlacement[]>());

  function teamMessageKey(source: SessionRef, revision: string, sequence: string, messageId: string): string {
    return `${source.provider}\0${source.sessionId}\0${revision}\0${sequence}\0${messageId}`;
  }

  async function readTeamMessage(sequence: string, messageId: string): Promise<void> {
    if (!panelRevision) return;
    const source = panelSource;
    const revision = panelRevision;
    const key = teamMessageKey(source, revision, sequence, messageId);
    const current = teamMessagePages[key];
    if (current?.loading || current?.nextOffset === null) return;
    const offset = current?.nextOffset ?? 0;
    teamMessagePages = { ...teamMessagePages, [key]: {
      text: current?.text ?? '', nextOffset: offset, loading: true, error: '',
    } };
    try {
      const page = await getTeamMessageContentPage(source.provider, source.sessionId,
        sequence, messageId, revision, offset);
      if (!active) return;
      if (panelRevision !== revision || childKey(panelSource) !== childKey(source)) {
        teamMessagePages = { ...teamMessagePages, [key]: {
          text: current?.text ?? '', nextOffset: offset, loading: false, error: '',
        } };
        return;
      }
      teamMessagePages = { ...teamMessagePages, [key]: {
        text: (current?.text ?? '') + page.text, nextOffset: page.nextOffset,
        loading: false, error: '',
      } };
    } catch (cause) {
      if (!active) return;
      if (panelRevision !== revision || childKey(panelSource) !== childKey(source)) {
        teamMessagePages = { ...teamMessagePages, [key]: {
          text: current?.text ?? '', nextOffset: offset, loading: false, error: '',
        } };
        return;
      }
      teamMessagePages = { ...teamMessagePages, [key]: {
        text: current?.text ?? '', nextOffset: offset, loading: false,
        error: cause instanceof Error ? cause.message : 'Recorded team message could not be loaded.',
      } };
    }
  }

  function providerLabel(id: string): string {
    return ({ codex: 'Codex', 'deepseek-harness': 'DeepSeek Harness', 'claude-code': 'Claude Code',
      opencode: 'OpenCode', pi: 'Pi' } as Record<string, string>)[id] || id;
  }

  function sessionHref(session: SessionRef): string {
    return '/' + encodeURIComponent(session.provider) + '/session/' + encodeURIComponent(session.sessionId);
  }

  function childKey(child: SessionRef): string {
    return child.provider + '\0' + child.sessionId;
  }

  function childHash(path: SessionRef[], search?: ReaderSearchTarget): string {
    const leaf = path[path.length - 1];
    const query = new URLSearchParams({
      provider: leaf.provider,
      sessionId: leaf.sessionId,
      path: JSON.stringify(path),
    });
    if (search) {
      query.set('searchProvider', search.event.provider);
      query.set('searchSessionId', search.event.sessionId);
      query.set('messageId', search.event.messageId);
      query.set('segment', search.event.segment);
      query.set('field', search.field);
      query.set('offset', String(search.offset));
      query.set('matchLength', String(search.matchLength));
    }
    return '#child?' + query;
  }

  function childSearchFromHash(): ReaderSearchTarget | null {
    if (!window.location.hash.startsWith('#child?')) return null;
    const query = new URLSearchParams(window.location.hash.slice(7));
    const provider = query.get('searchProvider');
    const sessionId = query.get('searchSessionId');
    const messageId = query.get('messageId');
    const segment = query.get('segment');
    const field = query.get('field');
    const offset = Number(query.get('offset'));
    const matchLength = Number(query.get('matchLength'));
    if (!provider || !sessionId || !childPathFromHash().some(step =>
      step.provider === provider && step.sessionId === sessionId) || !messageId || !segment ||
      (field !== 'body' && field !== 'toolInput' && field !== 'toolOutput') ||
      !query.has('offset') || !query.has('matchLength') ||
      !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(matchLength) || matchLength < 1) return null;
    return { event: { provider, sessionId, messageId, segment }, field, offset, matchLength };
  }

  function recordChildSearch(target: ReaderSearchTarget): void {
    if (!activeChildPath.some(step => childKey(step) === childKey(target.event))) return;
    window.history.pushState(window.history.state, '', childHash(activeChildPath, target));
    lastHandledHash = window.location.hash;
  }

  function childPathFromHash(): SessionRef[] {
    if (!window.location.hash.startsWith('#child?')) return [];
    const query = new URLSearchParams(window.location.hash.slice(7));
    const encodedPath = query.get('path');
    if (encodedPath !== null) {
      try {
        const parsed: unknown = JSON.parse(encodedPath);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((step: unknown) =>
          typeof step === 'object' && step !== null &&
          typeof (step as SessionRef).provider === 'string' && (step as SessionRef).provider.length > 0 &&
          typeof (step as SessionRef).sessionId === 'string' && (step as SessionRef).sessionId.length > 0)) {
          return parsed as SessionRef[];
        }
      } catch { /* An invalid path does not identify a canonical Reader child. */ }
      return [];
    }
    const childProvider = query.get('provider');
    const childSessionId = query.get('sessionId');
    return childProvider && childSessionId ? [{ provider: childProvider, sessionId: childSessionId }] : [];
  }

  function childButtonId(child: SessionRef): string {
    return 'child-toggle-' + Array.from(new TextEncoder().encode(childKey(child)), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function focusChildToggle(child: SessionRef): void {
    const button = document.getElementById(childButtonId(child));
    button?.focus();
    button?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }

  async function setChildPath(path: SessionRef[], fallbackEvent?: ReaderEventRef, focusChild?: SessionRef): Promise<void> {
    searchSelectionGeneration++;
    childRestoreGeneration++;
    focusRestoredRoot = path.length === 1 && !focusChild;
    activeChildPath = path;
    selectedChildSearch = null;
    const href = path.length > 0 ? childHash(path) : fallbackEvent ? hashFor(fallbackEvent) : window.location.pathname;
    window.history.pushState(window.history.state, '', href);
    lastHandledHash = window.location.hash;
    await tick();
    if (focusChild) focusChildToggle(focusChild);
    else if (path.length > 0) void restoreRootChildAnchor();
  }

  async function restoreRootChildAnchor(): Promise<void> {
    const target = activeChildPath[0];
    if (!target) return;
    const request = childRestoreGeneration;
    locationError = '';
    try {
      let placement = childPlacements.find(row => childKey(row.child) === childKey(target));
      const response = placement?.afterEvent ? null
        : await getReaderChildLocation(provider, sessionId, bootstrap.revision, target);
      if (!active || request !== childRestoreGeneration) return;
      placement ??= response?.placement ?? undefined;
      const location = response ? response.location : placement?.afterEvent
        ? await getReaderLocation(provider, sessionId, bootstrap.revision, placement.afterEvent) : null;
      if (!active || request !== childRestoreGeneration) return;
      if (!placement || !location) throw new Error(t($language, 'The recorded child insertion point is unavailable.'));
      if (location.revision !== bootstrap.revision || location.session.provider !== provider ||
        location.session.sessionId !== sessionId) throw new Error('The recorded source changed. Refresh this session.');
      if (!childPlacements.some(row => childKey(row.child) === childKey(target))) {
        childPlacements = [...childPlacements, placement];
      }
      if (!segments.some(page => location.ordinal >= page.startOrdinal &&
        location.ordinal < page.startOrdinal + page.items.length)) {
        const response = await getReaderSegment(provider, sessionId, location.pageCursor);
        if (!active || request !== childRestoreGeneration) return;
        if (response.revision !== bootstrap.revision || response.session.provider !== provider ||
          response.session.sessionId !== sessionId) throw new Error('The recorded source changed. Refresh this session.');
        if (!segments.some(page => page.pageId === response.page.pageId)) {
          segments = [...segments, response.page];
        }
      }
      await initialLayoutReady;
      await tick();
      await contentLoads.get(eventKey(location.event) + ':body');
      await tick();
      if (active && request === childRestoreGeneration && focusRestoredRoot) focusChildToggle(target);
    } catch (cause) {
      if (active && request === childRestoreGeneration) locationError = cause instanceof Error
        ? cause.message : 'The child insertion point could not be restored.';
    }
  }

  function rootChildExpanded(child: SessionRef): boolean {
    return activeChildPath.length > 0 && childKey(activeChildPath[0]) === childKey(child);
  }

  function expandChild(child: SessionRef): void {
    void setChildPath([child]);
  }

  function collapseChild(child: SessionRef, anchor: ReaderEventRef): void {
    void setChildPath([], anchor, child);
  }

  function onChildCollaborationUpdate(session: SessionRef, snapshot: ReaderCollaborationSnapshot | null): void {
    const key = childKey(session);
    if (snapshot) childCollaboration = { ...childCollaboration, [key]: snapshot };
    else {
      const next = { ...childCollaboration };
      delete next[key];
      childCollaboration = next;
    }
  }

  function openRelated(event: MouseEvent, session: SessionRef): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(session);
  }

  function recordedParticipants(entries: RelationEntry[]): RelationParticipant[] {
    const participants = new Map<string, RelationParticipant>();
    for (const entry of entries) {
      const candidates = entry.type === 'task' ? [entry.task.ownerParticipant] :
        [entry.observation.fromParticipant, entry.observation.toParticipant];
      for (const participant of candidates) {
        if (participant?.kind === 'member') {
          participants.set(participant.id, participant);
        }
      }
    }
    return [...participants.values()];
  }

  function createExecutionLandmarks(events: RuntimeExecutionEvent[], complete: boolean, hasMore: boolean): Map<string, ExecutionLandmark[]> {
    const landmarks = new Map<string, ExecutionLandmark[]>();
    const firstYieldByExecution = new Map<string, RuntimeExecutionEvent>();
    const terminalByExecution = new Map<string, RuntimeExecutionEvent>();
    const add = (event: RuntimeExecutionEvent, landmark: ExecutionLandmark) => {
      const key = eventKey(event.readerEvent);
      landmarks.set(key, [...(landmarks.get(key) ?? []), landmark]);
    };
    const labels: Record<RuntimeExecutionEvent['execution']['phase'], string> = {
      started: 'Execution started',
      yielded: 'Continued in the background',
      polled: 'Result check started',
      input: 'Input sent to the process',
      'interruption-requested': 'Interruption requested',
      completed: 'Result returned',
      failed: 'Execution failed',
    };
    for (const event of events) {
      const { execution } = event;
      if (execution.phase === 'yielded' && !firstYieldByExecution.has(execution.id)) {
        firstYieldByExecution.set(execution.id, event);
      }
      if (execution.phase === 'completed' || execution.phase === 'failed') {
        terminalByExecution.set(execution.id, event);
      }
    }
    for (const event of events) {
      const { execution } = event;
      const counterpart = execution.phase === 'yielded'
        ? terminalByExecution.get(execution.id)
        : execution.phase === 'completed' || execution.phase === 'failed'
          ? firstYieldByExecution.get(execution.id) : undefined;
      add(event, {
        phase: execution.phase,
        label: labels[execution.phase],
        ...(counterpart && eventKey(counterpart.readerEvent) !== eventKey(event.readerEvent)
          ? { counterpart: counterpart.readerEvent,
              counterpartLabel: execution.phase === 'yielded' ? 'Open recorded return' : 'Back to background handoff' }
          : {}),
      });
    }
    for (const [id, source] of firstYieldByExecution) {
      if (terminalByExecution.has(id)) continue;
      add(source, {
        phase: 'unknown',
        label: complete
          ? 'No returned result is recorded; outcome unknown.'
          : hasMore
            ? 'Return status is still unknown; later source records have not been checked.'
            : 'Return status is still unknown while execution records load.',
      });
    }
    return landmarks;
  }

  async function loadExecutionFacts(cursor?: string): Promise<void> {
    if (executionLoading || executionComplete) return;
    executionLoading = true;
    executionError = '';
    executionDiagnostics = [];
    executionDiagnosticsTruncated = false;
    try {
      const page = await getReaderExecutionEvents(provider, sessionId, bootstrap.revision, { cursor, limit: 200 });
      if (!active) return;
      if (page.revision !== bootstrap.revision || page.session.provider !== provider || page.session.sessionId !== sessionId) {
        throw new Error('Source revision changed or session identity differs; reload this session.');
      }
      executionEvents = [...executionEvents, ...page.events];
      executionCursor = page.nextCursor;
      executionComplete = page.nextCursor === null;
    } catch (cause) {
      if (active) {
        executionError = cause instanceof Error
          ? cause.message : 'Recorded execution details could not be loaded.';
        if (cause instanceof ApiRequestError) {
          executionDiagnostics = cause.diagnostics;
          executionDiagnosticsTruncated = cause.diagnosticsTruncated;
        }
      }
    } finally {
      if (active) executionLoading = false;
    }
  }

  onMount(() => {
    readerMounted = true;
    const onReadingScroll = () => scheduleReading(true);
    const onReadingResize = () => scheduleReading(false);
    window.addEventListener('scroll', onReadingScroll, { passive: true });
    window.addEventListener('resize', onReadingResize);
    document.addEventListener('toggle', onReadingResize, true);
    const onPanelKeydown = (event: KeyboardEvent) => {
      if (view !== 'conversation') return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        void openSessionSearch();
      } else if (event.key === 'Escape' && searchOpen) {
        event.preventDefault();
        closeSessionSearch();
      } else if (event.key === 'Escape' && collaborationOpen) setCollaborationOpen(false);
    };
    document.addEventListener('keydown', onPanelKeydown);
    const initialExecutionReady = loadExecutionFacts();
    const initialResumeReady = fetch(resumeUrl).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || 'Resume unavailable');
      if (active) resumeInfo = result;
    }).catch(cause => { if (active) resumeMessage = cause instanceof Error ? cause.message : String(cause); });
    void getViewerMeta(provider, sessionId).then(value => {
      if (active) {
        viewerMeta = value;
        effectiveTitle = value?.customTitle || bootstrap.session.title;
      }
    }).catch(cause => {
      if (active) managementError = cause instanceof Error ? cause.message : 'Viewer metadata could not be loaded.';
    }).finally(() => {
      if (active) metaReady = true;
    });
    const onLocationChange = () => {
      if (window.location.pathname.replace(/\/$/, '') !== sessionHref({ provider, sessionId }) ||
        window.location.hash === lastHandledHash) return;
      paneSearchStates = readPaneSearchHistory();
      const previousHash = lastHandledHash;
      if (previousHash !== null) searchSelectionGeneration++;
      lastHandledHash = window.location.hash;
      if (window.location.hash.startsWith('#runtime?')) {
        locationGeneration++;
        pageGeneration++;
        locationLoading = false;
        pageLoading = false;
        view = 'runtime';
        return;
      }
      view = 'conversation';
      conversationHash = window.location.hash;
      childRestoreGeneration++;
      const previous = activeChildPath;
      if (previousHash !== null) selectionHistoryVersion++;
      const next = childPathFromHash();
      activeChildPath = next;
      selectedChildSearch = childSearchFromHash();
      focusRestoredRoot = next.length === 1 && previous.length <= next.length;
      if (next.length > 0) {
        void restoreRootChildAnchor();
        if (previous.length > next.length && next.every((step, index) =>
          childKey(step) === childKey(previous[index]))) {
          const focusChild = previous[previous.length - 1];
          void tick().then(() => focusChildToggle(focusChild));
        }
        return;
      }
      if (previous.length > 0) {
        const focusChild = previous[previous.length - 1];
        void tick().then(() => focusChildToggle(focusChild));
      }
      const target = targetFromHash();
      if (target) {
        try {
          const searchTarget = searchTargetFromHash(window.location.hash, { provider, sessionId });
          if (searchTarget) {
            const searchHash = window.location.hash;
            void openSearchMatch(searchTarget, false, true).catch(cause => {
              if (active && window.location.hash === searchHash) locationError = cause instanceof Error ? cause.message : 'The matching source could not be opened.';
            });
            return;
          }
        } catch (cause) {
          locationError = cause instanceof Error ? cause.message : 'The search destination is invalid. Return to Library and search again.';
          return;
        }
        const sourceRevision = new URLSearchParams(window.location.hash.slice(7)).get('sourceRevision') ?? undefined;
        if (!sourceRevision && previousHash === null && bootstrap.targetLocation?.event.messageId === target.messageId &&
          bootstrap.targetLocation.event.segment === target.segment) {
          const request = ++locationGeneration;
          void tick().then(() => {
            if (active && request === locationGeneration) scrollToEvent(target);
          });
        } else void revealTarget(target, false, undefined, false, sourceRevision);
      }
      else {
        const returnFocus = previousHash?.startsWith('#event?') ? taskReturnFocus : null;
        void restoreStart().then(() => {
          if (!active || !returnFocus?.isConnected) return;
          returnFocus.scrollIntoView({ behavior: 'instant', block: 'center' });
          returnFocus.focus({ preventScroll: true });
        });
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || view !== 'conversation' || activeChildPath.length === 0) return;
      // BFCache resumes this Reader without mount or a changed hash. Restore the
      // insertion control after the browser has resumed the returning document.
      childRestoreGeneration++;
      focusRestoredRoot = activeChildPath.length === 1;
      void restoreRootChildAnchor();
    };
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
    window.addEventListener('pageshow', onPageShow);
    const initialRelationsReady = relationCursor ? loadRelations() : Promise.resolve();
    void Promise.all([initialExecutionReady, initialResumeReady, initialRelationsReady]).then(resolveInitialLayout);
    onLocationChange();
    return () => {
      active = false;
      readerMounted = false;
      if (readingFrame) cancelAnimationFrame(readingFrame);
      window.removeEventListener('scroll', onReadingScroll);
      window.removeEventListener('resize', onReadingResize);
      document.removeEventListener('toggle', onReadingResize, true);
      pageGeneration++;
      tocGeneration++;
      locationGeneration++;
      relationGeneration++;
      searchSelectionGeneration++;
      childRestoreGeneration++;
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('hashchange', onLocationChange);
      document.removeEventListener('keydown', onPanelKeydown);
    };
  });

  async function manage(action: 'star' | 'rename' | 'delete', title?: string): Promise<void> {
    if (managementBusy) return;
    managementBusy = true;
    managementError = '';
    try {
      const updated = await mutateViewer(provider, sessionId, action, title);
      if (!active) return;
      viewerMeta = updated;
      if (action === 'star') onStarred();
      if (action === 'rename') {
        effectiveTitle = updated.customTitle || bootstrap.session.title;
        renaming = false;
        onRenamed(effectiveTitle);
      }
      if (action === 'delete') onDeleted();
    } catch (cause) {
      if (active) managementError = cause instanceof Error ? cause.message : 'The Viewer change could not be saved.';
    } finally {
      if (active) managementBusy = false;
    }
  }

  function eventKey(event: ReaderEventRef): string {
    return JSON.stringify([event.provider, event.sessionId, event.messageId, event.segment]);
  }

  function stableAnchor(event: ReaderEventRef): string {
    const bytes = new TextEncoder().encode(eventKey(event));
    return 'event-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function scrollToEvent(event: ReaderEventRef): void {
    expandOutlineFor(event);
    const target = document.getElementById(stableAnchor(event));
    if (!target) return;
    for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    }
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  function scheduleReading(follow: boolean): void {
    followReading ||= follow;
    if (readingFrame || !active) return;
    readingFrame = requestAnimationFrame(() => {
      readingFrame = 0;
      updateReading(followReading);
      followReading = false;
    });
  }

  function updateReading(follow: boolean): void {
    if (!transcriptElement || view !== 'conversation') return;
    const cards = [...transcriptElement.querySelectorAll<HTMLElement>('article.event-card')]
      .filter(card => card.closest('.transcript, .inline-child-transcript') === transcriptElement && card.getClientRects().length);
    const top = 125;
    const card = cards.filter(card => card.getBoundingClientRect().top <= top).at(-1) ?? cards[0];
    if (!card) return;
    const item = itemsByAnchor.get(card.id);
    if (!item) return;
    const nextKey = eventKey(item.event);
    const changed = nextKey !== readingKey;
    readingKey = nextKey;
    readingOrdinal = item.ordinal;
    readingPercent = Math.round(100 * (item.ordinal + 1) / Math.max(1, bootstrap.totalItems));
    if (!lastPage?.nextCursor && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) readingPercent = 100;
    if (follow && changed) {
      expandOutlineFor(item.event);
      void tick().then(() => {
        const link = outlineElement?.querySelector<HTMLElement>('a[aria-current="location"]');
        if (!link || !outlineElement) return;
        const rect = link.getBoundingClientRect();
        const pane = outlineElement.getBoundingClientRect();
        if (rect.top < pane.top || rect.bottom > pane.bottom) {
          outlineElement.scrollTop += rect.top - pane.top - outlineElement.clientHeight / 3;
        }
      });
    }
  }

  function hashFor(event: ReaderEventRef): string {
    return '#event?' + new URLSearchParams({ messageId: event.messageId, segment: event.segment });
  }

  function readerEventHref(event: ReaderEventRef): string {
    return sessionHref(event) + hashFor(event);
  }

  function targetFromHash(): ReaderEventRef | null {
    if (!window.location.hash.startsWith('#event?')) return null;
    const query = new URLSearchParams(window.location.hash.slice(7));
    const messageId = query.get('messageId');
    const segment = query.get('segment');
    if (!messageId || !segment) return null;
    return { provider, sessionId, messageId, segment };
  }

  function fieldKey(display: DisplayItem, field: ContentField): string {
    return display.key + ':' + field;
  }

  function visibleProcessCount(unit: ProcessUnit): number {
    return unit.totalCount - (openingMessage?.processId === unit.id ? 1 : 0);
  }

  function makeDisplay(item: ReaderItem): DisplayItem {
    return { item, key: eventKey(item.event), anchor: stableAnchor(item.event) };
  }

  function groupOutline(entries: ReaderTocEntry[]): OutlineTurn[] {
    const turns: OutlineTurn[] = [];
    let turn: OutlineTurn | null = null;
    let previousOrdinal = -1;
    for (const entry of entries) {
      if (entry.ordinal !== previousOrdinal + 1) turn = null;
      previousOrdinal = entry.ordinal;
      if (entry.event.segment !== 'message' && entry.event.segment !== 'context') {
        continue;
      }
      if (entry.role === 'user' && entry.event.segment === 'message') {
        turn = { key: eventKey(entry.event), request: entry, children: [] };
        turns.push(turn);
        continue;
      }
      if (!turn) {
        turn = { key: `continuation-${entry.ordinal}`, request: null, children: [] };
        turns.push(turn);
      }
      turn.children.push({ key: eventKey(entry.event), entry });
    }
    return turns;
  }

  function mergeToc(current: ReaderTocEntry[], added: ReaderTocEntry[]): ReaderTocEntry[] {
    return [...new Map([...current, ...added].map(entry => [eventKey(entry.event), entry])).values()]
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  function mergeOutlineEntries(added: ReaderTocEntry[]): ReaderTocEntry[] {
    let append = added.length > 0 && toc.entries.length === tocEntriesByEvent.size &&
      (!toc.entries.length || toc.entries[toc.entries.length - 1].ordinal < added[0].ordinal);
    for (const entry of added) {
      const key = eventKey(entry.event);
      append &&= !tocEntriesByEvent.has(key);
      tocEntriesByEvent.set(key, entry);
    }
    const entries = append ? toc.entries.concat(added)
      : [...tocEntriesByEvent.values()].sort((a, b) => a.ordinal - b.ordinal);
    if (!expandedOutlineTurns.size) return entries;
    const expandedChildren = new Set(outlineTurns
      .filter(turn => expandedOutlineTurns.has(turn.key)).flatMap(turn => turn.children.map(node => node.key)));
    expandedOutlineTurns = new Set(groupOutline(entries)
      .filter(turn => expandedOutlineTurns.has(turn.key) || turn.children.some(node => expandedChildren.has(node.key)))
      .map(turn => turn.key));
    return entries;
  }

  function toggleOutlineTurn(key: string): void {
    outlineExpandAll = false;
    const expanded = new Set(expandedOutlineTurns);
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    expandedOutlineTurns = expanded;
  }

  function setOutlineExpanded(expanded: boolean): void {
    outlineExpandAll = expanded;
    expandedOutlineTurns = expanded ? new Set(outlineTurns.map(turn => turn.key)) : new Set();
  }

  function expandOutlineFor(event: ReaderEventRef): void {
    const key = eventKey(event);
    const turn = outlineTurnByEvent.get(key);
    if (turn && !expandedOutlineTurns.has(turn.key)) {
      expandedOutlineTurns = new Set([...expandedOutlineTurns, turn.key]);
    }
  }

  function outlineHeading(entry: ReaderTocEntry, lang: Language): string {
    if (entry.event.segment === 'context') return t(lang, 'Context checkpoint');
    if (entry.event.segment === 'thinking') return t(lang, 'Reasoning');
    if (entry.event.segment === 'tool' || entry.role === 'tool') return t(lang, 'Tool activity');
    if (entry.role === 'user') return t(lang, 'You');
    if (entry.role === 'assistant') return t(lang, 'Assistant');
    if (entry.role === 'agent') return t(lang, 'Agent');
    return t(lang, 'Event') + ' ' + (entry.ordinal + 1);
  }

  function outlineLabel(entry: ReaderTocEntry): string {
    return entry.label.replace(/^#{1,6}\s+/, '').replace(/[*`]/g, '').trim() || t($language, 'Open event');
  }

  function updatedLabel(timestamp: number | null, locale: Language): string {
    if (timestamp === null) return t(locale, 'Time unavailable');
    const date = new Date(timestamp);
    if (Number.isNaN(date.valueOf())) return t(locale, 'Time unavailable');
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  async function restoreStart(): Promise<void> {
    const request = ++locationGeneration;
    ++pageGeneration;
    locationLoading = false;
    pageLoading = false;
    locationError = '';
    pageError = '';
    segments = bootstrap.segments.filter(page => page.startOrdinal === 0);
    await preloadOpeningReply();
    await tick();
    if (active && request === locationGeneration && !window.location.hash) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }

  async function revealTarget(target: ReaderEventRef | 'end', updateHistory: boolean,
    stillCurrent: () => boolean = () => true, restoringSearch = false,
    sourceRevision?: string): Promise<boolean> {
    const request = ++locationGeneration;
    ++pageGeneration;
    pageLoading = false;
    locationLoading = true;
    locationError = '';
    try {
      const location = await getReaderLocation(provider, sessionId, bootstrap.revision, target, sourceRevision);
      if (!active || request !== locationGeneration || !stillCurrent()) return false;
      const alreadyLoaded = segments.some(page => location.ordinal >= page.startOrdinal &&
        location.ordinal < page.startOrdinal + page.items.length);
      const pageResponse = alreadyLoaded ? null : await getReaderSegment(provider, sessionId, location.pageCursor);
      if (!active || request !== locationGeneration || !stillCurrent()) return false;
      if (pageResponse) segments = restoringSearch ? [...segments, pageResponse.page] : [pageResponse.page];
      if (!toc.entries.some(entry => eventKey(entry.event) === eventKey(location.event))) {
        const response = await getReaderToc(provider, sessionId, location.tocCursor);
        if (!active || request !== locationGeneration || !stillCurrent()) return false;
        toc = { ...toc, entries: mergeOutlineEntries(response.toc.entries) };
      }
      if (updateHistory) {
        const hash = sourceRevision ? runtimeSourceHash(location.event, sourceRevision) : hashFor(location.event);
        if (window.location.hash !== hash) window.history.pushState(window.history.state, '', hash);
        lastHandledHash = window.location.hash;
        conversationHash = window.location.hash;
      }
      await tick();
      if (!active || request !== locationGeneration || !stillCurrent()) return false;
      expandOutlineFor(location.event);
      if (!restoringSearch) scrollToEvent(location.event);
      return true;
    } catch (cause) {
      if (active && request === locationGeneration && stillCurrent()) {
        const detail = cause instanceof Error ? cause.message : 'The source location could not be opened.';
        locationError = /source changed|revision|invalid cursor/i.test(detail)
          ? 'The recorded source changed. Refresh this session before opening this event.' : detail;
      }
      return false;
    } finally {
      if (active && request === locationGeneration) locationLoading = false;
    }
  }

  async function loadAdjacent(direction: 'previous' | 'next', automatic = false): Promise<void> {
    const cursor = direction === 'previous' ? firstPage?.previousCursor : lastPage?.nextCursor;
    if (!cursor || pageLoading || locationLoading) return;
    const request = ++pageGeneration;
    pageLoading = true;
    pageError = '';
    try {
      const response = await getReaderSegment(provider, sessionId, cursor);
      if (!active || request !== pageGeneration) return;
      if (!segments.some(page => page.pageId === response.page.pageId)) segments = [...segments, response.page];
      await tick();
      const first = response.page.items[0];
      if (first && !automatic) scrollToEvent(first.event);
    } catch (cause) {
      if (active && request === pageGeneration) pageError = cause instanceof Error ? cause.message : 'The segment could not be loaded.';
    } finally {
      if (active && request === pageGeneration) pageLoading = false;
    }
  }

  async function loadToc(): Promise<void> {
    const cursor = tocCursor;
    if (!cursor || tocLoading || locationLoading) return;
    const request = ++tocGeneration;
    tocLoading = true;
    tocError = '';
    try {
      const response = await getReaderToc(provider, sessionId, cursor, 512);
      if (active && request === tocGeneration) {
        toc = { entries: mergeOutlineEntries(response.toc.entries),
          previousCursor: null, nextCursor: response.toc.nextCursor };
        tocCursor = response.toc.nextCursor;
      }
    } catch (cause) {
      if (active && request === tocGeneration) tocError = cause instanceof Error ? cause.message : 'The outline could not be loaded.';
    } finally {
      if (active && request === tocGeneration) tocLoading = false;
    }
  }

  function jumpTo(event: MouseEvent, target: ReaderEventRef, returnFocus?: HTMLElement): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    taskReturnFocus = returnFocus ?? null;
    void revealTarget(target, true);
  }

  async function preloadOpeningReply(): Promise<void> {
    const opening = bootstrap.segments[0];
    if (window.location.hash || !opening?.nextCursor ||
      opening.items.some(item => item.role === 'assistant' && item.event.segment === 'message' && item.totalChars > 0) ||
      !opening.items.some(item => item.role === 'assistant' && item.event.segment === 'message' &&
        item.totalChars === 0 && item.processId !== null)) return;
    const request = ++pageGeneration;
    pageLoading = true;
    try {
      const response = await getReaderSegment(provider, sessionId, opening.nextCursor);
      if (!active || request !== pageGeneration) return;
      if (response.revision !== bootstrap.revision || response.session.provider !== provider ||
        response.session.sessionId !== sessionId) throw new Error('The recorded source changed. Refresh this session.');
      segments = [...segments, response.page];
    } catch (cause) {
      if (active && request === pageGeneration) pageError = cause instanceof Error
        ? cause.message : 'The next segment could not be loaded.';
    } finally {
      if (active && request === pageGeneration) pageLoading = false;
    }
  }

  function resetPaneSearch(): void {
    searchSelectionGeneration++;
    searchReveals = {};
  }

  async function openSearchMatch(match: ReaderSearchTarget & { contentRevision?: string }, restoring = false,
    fromLocation = false): Promise<void> {
    const request = ++searchSelectionGeneration;
    if (restoring || fromLocation) { await tick(); await initialLayoutReady; await tick(); }
    if (!active || request !== searchSelectionGeneration) return;
    const opened = await revealTarget(match.event, !restoring && !fromLocation,
      () => request === searchSelectionGeneration, restoring || fromLocation);
    if (!opened || !active || request !== searchSelectionGeneration) return;
    const navigation = locationGeneration;
    const page = await getContentPage(provider, sessionId, match.event, bootstrap.revision,
      match.offset, match.field, Math.max(1400, match.matchLength), match.contentRevision);
    if (!active || request !== searchSelectionGeneration || navigation !== locationGeneration) return;
    if (page.offset !== match.offset || page.text.length < match.matchLength) {
      throw new Error('The matching content changed. Refresh this session and search again.');
    }
    const readingFocus = document.activeElement;
    const focusRect = restoring && readingFocus?.classList.contains('inline-child-toggle')
      ? readingFocus.getBoundingClientRect() : null;
    const keepReadingFocus = focusRect && focusRect.top >= -1 && focusRect.bottom <= window.innerHeight + 1;
    searchReveals = { [eventKey(match.event)]: { field: match.field, offset: match.offset,
      matchLength: match.matchLength, text: page.text, totalChars: page.totalChars } };
    const positionMatch = async (): Promise<void> => {
      await tick();
      // The target card's automatic body read can move the match after it mounts.
      await contentLoads.get(eventKey(match.event) + ':body');
      await tick();
      if (active && request === searchSelectionGeneration && navigation === locationGeneration) {
        const event = document.getElementById(stableAnchor(match.event));
        for (let ancestor = event?.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        }
        if (restoring) {
          if (keepReadingFocus && document.activeElement === readingFocus) {
            readingFocus?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
          }
          return;
        }
        const region = event?.querySelector<HTMLElement>('.search-reveal');
        region?.focus({ preventScroll: true });
        const mark = region?.querySelector('mark');
        if (mark) mark.scrollIntoView({ behavior: 'instant', block: 'center' });
        else scrollToEvent(match.event);
      }
    };
    if (restoring || fromLocation) await positionMatch();
    else void positionMatch().catch(cause => {
      if (active && request === searchSelectionGeneration && navigation === locationGeneration) {
        locationError = cause instanceof Error ? cause.message : 'The matching source could not be opened.';
      }
    });
  }

  async function openRuntimeSource(target: ReaderEventRef, sourceRevision: string): Promise<void> {
    const runtimeHash = window.location.hash;
    view = 'conversation';
    await tick();
    if (!active || view !== 'conversation') return;
    const request = locationGeneration + 1;
    const opened = await revealTarget(target, true, undefined, false, sourceRevision);
    if (!opened && active && request === locationGeneration && view === 'conversation' &&
      window.location.hash === runtimeHash) {
      window.history.pushState(window.history.state, '', window.location.pathname + window.location.search + conversationHash);
      lastHandledHash = window.location.hash;
    }
  }

  function enterRuntime(): void {
    if (view === 'runtime') return;
    if (!window.location.hash.startsWith('#runtime?')) conversationHash = window.location.hash;
    const saved = readRuntimeHistory(provider, sessionId);
    const hash = runtimeHash(saved?.lens ?? 'events', saved?.focusNodeId ?? null);
    if (window.location.hash !== hash) window.history.pushState(window.history.state, '', hash);
    lastHandledHash = window.location.hash;
    searchSelectionGeneration++;
    locationGeneration++;
    pageGeneration++;
    locationLoading = false;
    pageLoading = false;
    view = 'runtime';
  }

  function enterConversation(): void {
    if (view === 'conversation') return;
    runtimePanel?.saveNavigation();
    window.history.pushState(window.history.state, '', window.location.pathname + window.location.search + conversationHash);
    lastHandledHash = window.location.hash;
    view = 'conversation';
  }

  function openRuntimeSession(session: SessionRef): void {
    onOpen(session);
  }

  function openExecutionCounterpart(target: ReaderEventRef): void {
    void revealTarget(target, true);
  }

  function openCollaborationChild(child: SessionRef): void {
    setCollaborationOpen(false);
    void setChildPath([...activeChildPath, child]);
  }

  function openCollaborationEvent(target: ReaderEventRef): void {
    setCollaborationOpen(false);
    if (target.provider === provider && target.sessionId === sessionId) {
      void revealTarget(target, true);
    } else {
      window.location.assign(readerEventHref(target));
    }
  }

  async function readMore(display: DisplayItem, field: ContentField): Promise<void> {
    const key = fieldKey(display, field);
    const current = content[key] ?? {
      text: '', hasLoaded: false, totalChars: display.item.totalChars,
      nextOffset: 0, done: false, loading: false, error: '',
    };
    if (current.loading) return contentLoads.get(key);
    if (current.done || current.nextOffset === null) return;
    const offset = current.hasLoaded ? current.nextOffset : 0;
    content = { ...content, [key]: { ...current, loading: true, error: '' } };
    const load = (async () => { try {
      const page = await getContentPage(provider, sessionId, display.item.event, bootstrap.revision,
        offset, field, 1400, display.item.contentRevisions[field]);
      if (!active) return;
      const previous = content[key] ?? current;
      content = {
        ...content,
        [key]: {
          text: previous.text + page.text,
          hasLoaded: true,
          totalChars: page.totalChars,
          nextOffset: page.nextOffset,
          done: page.nextOffset === null,
          loading: false,
          error: '',
        },
      };
    } catch (cause) {
      if (!active) return;
      const previous = content[key] ?? current;
      content = {
        ...content,
        [key]: {
          ...previous,
          loading: false,
          error: cause instanceof Error ? cause.message : 'The next part could not be loaded.',
        },
      };
    } })();
    contentLoads.set(key, load);
    try { await load; } finally { contentLoads.delete(key); }
  }

  async function loadRelations(): Promise<void> {
    if (!relationCursor || relationLoading) return;
    const request = ++relationGeneration;
    const cursor = relationCursor;
    relationLoading = true;
    relationError = '';
    try {
      const response = await getReaderRelations(provider, sessionId, cursor);
      if (!active || request !== relationGeneration) return;
      if (response.revision !== bootstrap.revision || response.session.provider !== provider || response.session.sessionId !== sessionId) {
        throw new Error('The recorded work changed while this session was open. Reload to read its current revision.');
      }
      relationEntries = [...relationEntries, ...response.entries];
      const seen = new Set(childPlacements.map(placement => childKey(placement.child)));
      childPlacements = [...childPlacements, ...response.childPlacements.filter(placement => {
        const key = childKey(placement.child);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })];
      relationCursor = response.nextCursor;
    } catch (cause) {
      if (active && request === relationGeneration) relationError = cause instanceof Error ? cause.message : 'Recorded work could not be loaded.';
    } finally {
      if (active && request === relationGeneration) relationLoading = false;
    }
  }
</script>

<main class="reader-layout">
  <section class="reader-main" class:short-exchange={shortExchange} aria-labelledby="reader-title">
    <header class="reader-heading">
      <a class="reader-back-link" href="/sessions" onclick={onBack}><span aria-hidden="true">←</span> {t($language, 'All sessions')}</a>
      <div class="reader-heading-top">
        <nav class="reader-view-tabs" aria-label={t($language, 'Session view')}>
          <button type="button" class="conversation-tab" aria-current={view === 'conversation' ? 'page' : undefined} onclick={enterConversation}>{t($language, 'Conversation')}</button>
          <button type="button" class="runtime-tab" aria-current={view === 'runtime' ? 'page' : undefined} onclick={enterRuntime}>{t($language, 'Technical details')}</button>
        </nav>
        <div class="reader-management" role="group" aria-label={t($language, 'Viewer metadata actions')}>
          <button type="button" class="reader-star" disabled={!metaReady || managementBusy}
            aria-pressed={viewerMeta?.starred ?? false} onclick={() => void manage('star')}>
            {viewerMeta?.starred ? t($language, '★ Starred') : t($language, '☆ Star')}
          </button>
          <button type="button" class="reader-rename" disabled={!metaReady || managementBusy}
            onclick={() => { renameDraft = effectiveTitle; renaming = !renaming; }}>{t($language, 'Rename')}</button>
          <button type="button" class="reader-delete" disabled={!metaReady || managementBusy}
            onclick={() => void manage('delete')}>{t($language, 'Move to trash')}</button>
        </div>
      </div>
      <h1 id="reader-title">{effectiveTitle || t($language, 'Untitled session')}</h1>
      {#if renaming}
        <form class="reader-rename-form" onsubmit={(event) => { event.preventDefault(); void manage('rename', renameDraft.trim()); }}>
          <label for="reader-rename-input">{t($language, 'Custom title')}</label>
          <input id="reader-rename-input" class="reader-rename-input" bind:value={renameDraft} maxlength="500" required />
          <button type="submit" class="reader-rename-save" disabled={!renameDraft.trim() || managementBusy}>{t($language, 'Save title')}</button>
          <button type="button" onclick={() => renaming = false}>{t($language, 'Cancel')}</button>
        </form>
      {/if}
      {#if managementError}<p class="content-error" role="alert">{managementError}</p>{/if}
      <div class="reader-byline">
        <span>{providerLabel(provider)}</span>
        <span>{bootstrap.session.messageCount} {t($language, 'messages')}</span>
        <span>{updatedLabel(bootstrap.session.updatedAt, $language)}</span>
        {#if bootstrap.session.parent}
          <a href={sessionHref(bootstrap.session.parent)} onclick={(event) => openRelated(event, bootstrap.session.parent!)}>{t($language, 'Open parent session')}</a>
        {/if}
      </div>
      <details class="reader-session-details" ontoggle={(event) => sessionDetailsOpen = (event.currentTarget as HTMLDetailsElement).open}>
        <summary>{t($language, 'Session details')}</summary>
        <div class="session-details-content">
          <dl><dt>{t($language, 'Project folder')}</dt><dd>{bootstrap.session.directory || t($language, 'Project folder unavailable')}</dd>
            <dt>{t($language, 'Session ID')}</dt><dd><code>{sessionId}</code></dd>
            <dt>{t($language, 'Source revision')}</dt><dd><code>{bootstrap.revision}</code></dd></dl>
          {#if resumeInfo?.diagnostic}<p>{resumeInfo.diagnostic}</p>{/if}
          {#if executionError}
            <details class="reader-execution-details"><summary>{t($language, 'Tool execution details')}</summary>
              <button class="read-more" disabled={executionLoading} onclick={() => void loadExecutionFacts(executionCursor ?? undefined)}>
                {executionLoading ? t($language, 'Loading…') : t($language, 'Retry')}
              </button>
              <p class="content-error" role="status">{errorText($language, executionError)}</p>
              {#if executionDiagnostics.length > 0}
                <ul class="reader-execution-diagnostics">{#each executionDiagnostics as diagnostic}
                  {@const label = diagnosticText($language, diagnostic.code)}
                  <li>{#if label !== diagnostic.code}{label} {/if}<code>{diagnostic.code}</code>
                    {#if diagnostic.event_id !== null}<code>{diagnostic.event_id}</code>{/if}</li>
                {/each}</ul>
              {/if}
              {#if executionDiagnosticsTruncated}<p>{t($language, 'Additional diagnostic codes are omitted.')}</p>{/if}
            </details>
          {/if}
          {#if sessionDetailsOpen}
            <SystemPromptEvidence {provider} {sessionId} />
            {#if provider === 'codex'}<RecordedMemory {sessionId} />{/if}
          {/if}
        </div>
      </details>
      {#if view === 'conversation'}
      <div class="reader-actions">
        <button type="button" class="reader-find-toggle" aria-expanded={searchOpen} aria-controls="reader-search"
          title={t($language, 'Search every message, including content not on this page.')} onclick={() => searchOpen ? closeSessionSearch() : void openSessionSearch()}>
          {t($language, 'Find in session')} <kbd>Ctrl Shift F</kbd>
        </button>
        {#if resumeInfo?.available && resumeInfo.allowTerminalLaunch}
          <button type="button" onclick={launchResume} disabled={resumeBusy}>
            {resumeBusy ? t($language, 'Starting terminal…') : t($language, 'Resume in terminal')}
          </button>
        {/if}
        {#if resumeMessage}<span role="status">{resumeMessage}</span>{/if}
        <div class="reader-action-links">
          <button class="read-more" disabled={locationLoading} onclick={() => void revealTarget('end', true)}>{t($language, 'Go to session end')}</button>
        </div>
      </div>
      {#if locationError}<p class="content-error" role="status">{errorText($language, locationError)}</p>{/if}
      {#if locationError.includes('Refresh this session')}<button class="read-more" onclick={() => window.location.reload()}>{t($language, 'Refresh session')}</button>{/if}
      <div id="reader-search" class="reader-search-disclosure" hidden={!searchOpen}>
        <div class="reader-search-heading"><p>{t($language, 'Search the full conversation, including collapsed and unloaded messages.')}</p>
          <button type="button" aria-label={t($language, 'Close session search')} onclick={closeSessionSearch}>×</button></div>
        <PaneSearch {provider} {sessionId} revision={bootstrap.revision} scope="session"
          onSelect={openSearchMatch} onReset={resetPaneSearch}
            state={paneSearchStates[childKey({ provider, sessionId })]} restoreVersion={selectionHistoryVersion}
            onStateChange={(state) => savePaneSearch({ provider, sessionId }, state)}
            onRestore={(match) => openSearchMatch(match, true)} />
      </div>
      {/if}
    </header>

    {#if provider === 'codex' && bootstrap.session.parent?.provider === 'codex'}
      <InheritedContext child={bootstrap.session.session} parent={bootstrap.session.parent} />
    {:else if provider === 'deepseek-harness'}
      <InheritedContext child={bootstrap.session.session} parent={bootstrap.session.parent}
        discover />
    {/if}

    {#if view === 'runtime'}
      <RuntimeEvents bind:this={runtimePanel} {provider} {sessionId} onOpenReader={openRuntimeSource}
        onOpenSession={openRuntimeSession} />
    {:else}
    {#if hasCollaboration}
      <button type="button" class="collaboration-launcher" hidden={collaborationOpen}
        aria-label={t($language, 'Open tasks and collaboration')} aria-expanded={collaborationOpen}
        onclick={() => setCollaborationOpen(true)}>{t($language, 'Tasks & collaboration')}
        <span>{t($language, 'Child conversations and agent messages')}</span></button>
      {#if collaborationOpen}
      <section id="collaboration-panel" class="collaboration-summary" aria-labelledby="collaboration-title">
        <div class="collaboration-heading">
          <div>
            <h2 id="collaboration-title">{t($language, 'Tasks & collaboration')}</h2>
          </div>
          <button type="button" class="collaboration-close" aria-label={t($language, 'Close tasks and collaboration')}
            onclick={() => setCollaborationOpen(false)}>×</button>
        </div>
        {#if activeChildPath.length > 0 && !childPanel}<p role="status">{t($language, 'Opening child collaboration…')}</p>{/if}
        {#if panelEntries.length === 0 && !panelLoading && !panelError && (activeChildPath.length === 0 || childPanel)}
          <p class="collaboration-empty" role="status">{t($language, 'No recorded tasks or agent messages.')}</p>
        {/if}
        <CollaborationTimeline entries={panelEntries} session={panelSource} items={activeChildPath.length > 0 ? [] : items} complete={!panelCursor && !panelLoading}
          onOpenChild={openCollaborationChild} onNavigate={openCollaborationEvent} />
        {#if panelUnassignedTasks.length > 0}
          <ol class="collaboration-thread collaboration-unassigned-tasks">
            {#each panelUnassignedTasks as task (task.provenance.sourceId + ':' + task.id)}
              <li class="collaboration-assignment" data-source-seq={task.provenance.sourceId}>
                <strong>{t($language, 'Latest recorded task state')}: {protocolLabel(task.status, $language)}</strong>
                {#if task.subject}<p>{task.subject}</p>{/if}
                {#if task.description}<p>{task.description}</p>{/if}
                {#if task.readerEvent}
                  <button type="button" onclick={() => openCollaborationEvent(task.readerEvent!)}>{t($language, 'Open Reader event')}</button>
                {:else}
                  <span class="relation-unavailable-history">{t($language, 'This recorded team event has no conversation-message link.')}</span>
                {/if}
                <details class="collaboration-source-details">
                  <summary>{t($language, 'Technical details')}</summary>
                  <p>{task.id} · {task.provenance.sourceType} #{task.provenance.sourceId}</p>
                </details>
              </li>
            {/each}
          </ol>
        {/if}
        {#if panelParticipants.length > 0}
          <section class="collaboration-participants" aria-label={t($language, 'Recorded participants')}>
            <div class="collaboration-participant-choices">
              {#each panelParticipants as participant (participant.id)}
                <button type="button" data-member-id={participant.id}
                  aria-pressed={selectedParticipant?.id === participant.id}
                  onclick={() => selectedParticipantId = participant.id}>{participant.name}</button>
              {/each}
            </div>
            {#if selectedParticipant}
              <p class="collaboration-participant-description">{selectedParticipant.description ?? selectedParticipant.name}</p>
              <ol class="collaboration-thread">
                {#each participantEntries as entry (entry.type + ':' + (entry.type === 'task' ? entry.task.id : entry.observation.eventId))}
                  {#if entry.type === 'task'}
                    <li class="collaboration-assignment" data-source-seq={entry.task.provenance.sourceId}>
                      <strong>{t($language, 'Latest recorded task state')}</strong>
                      {#if entry.task.subject}<p>{entry.task.subject}</p>{/if}
                      {#if entry.task.description}<p>{entry.task.description}</p>{/if}
                      <small>{entry.task.status} · {entry.task.provenance.sourceType} #{entry.task.provenance.sourceId}</small>
                      {#if entry.task.readerEvent}
                        <a href={readerEventHref(entry.task.readerEvent)}>{t($language, 'Open Reader event')}</a>
                      {:else}
                        <span class="relation-unavailable-history">{t($language, 'This recorded team event has no conversation-message link.')}</span>
                      {/if}
                    </li>
                  {:else}
                    {@const teamPage = teamMessagePages[teamMessageKey(panelSource, panelRevision, entry.observation.provenance.sourceId, entry.observation.correlationId)]}
                    {@const hasTeamContent = entry.observation.kind === 'message' &&
                      entry.observation.messageExcerptTruncated === true}
                    <li class="collaboration-exchange" data-event-id={entry.observation.eventId}
                      data-source-seq={entry.observation.provenance.sourceId}>
                      <strong>{entry.observation.kind === 'message' ? t($language, 'Message queued') :
                        entry.observation.kind === 'mailbox-delivery' ? t($language, 'Mailbox delivery recorded') :
                        t($language, 'Agent handoff recorded')}</strong>
                      {#if entry.observation.fromParticipant || entry.observation.toParticipant}
                        <p>{entry.observation.fromParticipant?.name ?? t($language, 'Source session')} → {entry.observation.toParticipant?.name ?? t($language, 'Source session')}</p>
                      {/if}
                      {#if teamPage?.text}
                        <p class="collaboration-message-body"><span class="collaboration-preview-label">{t($language, 'Recorded team message')}</span> {teamPage.text}</p>
                      {:else if entry.observation.messageExcerpt}
                        <p><span class="collaboration-preview-label">{t($language, 'Message preview')}</span> {entry.observation.messageExcerpt}</p>
                      {/if}
                      {#if hasTeamContent && (!teamPage || teamPage.nextOffset !== null)}
                        <button type="button" class="collaboration-message-more" disabled={teamPage?.loading || !panelRevision}
                          onclick={() => void readTeamMessage(entry.observation.provenance.sourceId, entry.observation.correlationId)}>
                          {teamPage?.loading ? t($language, 'Loading team message…') :
                            teamPage?.text ? t($language, 'Continue team message') : t($language, 'Read full team message')}
                        </button>
                      {/if}
                      {#if teamPage?.error}<p class="content-error" role="status">{teamPage.error}</p>{/if}
                      <small>{entry.observation.state} · {entry.observation.provenance.sourceType} #{entry.observation.provenance.sourceId}</small>
                      {#if entry.observation.readerEvent}
                        <a href={readerEventHref(entry.observation.readerEvent)}>{t($language, 'Open Reader event')}</a>
                      {:else}
                        <span class="relation-unavailable-history">{t($language, 'This recorded team event has no conversation-message link.')}</span>
                      {/if}
                    </li>
                  {/if}
                {/each}
              </ol>
            {/if}
          </section>
        {/if}
        {#if panelError}<p class="content-error" role="status">{panelError}</p>{/if}
      </section>
      {/if}
    {/if}

    {#if blocks.length === 0}
      <div class="reader-empty"><h2>{t($language, 'No readable events')}</h2><p>{t($language, 'This session has no readable messages.')}</p></div>
    {:else}
      {#if firstPage?.previousCursor}
        <div class="reader-page-controls">
          <button disabled={pageLoading || locationLoading} onclick={() => void loadAdjacent('previous')}>{pageLoading ? t($language, 'Loading…') : t($language, 'Show earlier messages')}</button>
        </div>
      {/if}
      {#if pageError}<p class="content-error" role="status">{pageError}</p>{/if}
      {#snippet renderWork(block: ReaderBlock)}
          {#if block.thinking.length > 0}
            <div class="attached-reasoning">
              <details>
                <summary>{t($language, 'Recorded reasoning')} · {block.thinking.length} {block.thinking.length === 1 ? t($language, 'segment') : t($language, 'segments')}</summary>
                {#each block.thinking as thought (thought.key)}
                  <EventCard
                    display={thought}
                    progress={content[fieldKey(thought, 'body')]}
                    searchReveal={searchReveals[thought.key]}
                    onReadMore={readMore}
                  />
                {/each}
              </details>
            </div>
          {/if}
          {#if block.tools.length > 0}
            <div class="attached-tools" role="group" aria-label={t($language, 'Tool activity for this assistant message')}>
              <div class="tool-stack">
                {#each block.tools as tool (tool.main.key)}
                  <div class="tool-entry">
                    <EventCard
                      display={tool.main}
                      collaborationIdentity={readerCollaborationIdentity(relationEntries, tool.main.item.event)}
                      executionLandmarks={executionLandmarksByAnchor.get(tool.main.key) ?? []}
                      progress={content[fieldKey(tool.main, 'body')]}
                      toolInputProgress={content[fieldKey(tool.main, 'toolInput')]}
                      toolOutputProgress={content[fieldKey(tool.main, 'toolOutput')]}
                      searchReveal={searchReveals[tool.main.key]}
                      onReadMore={readMore}
                      onOpenCounterpart={openExecutionCounterpart}
                    />
                    {#each placementsByAnchor.get(tool.main.key) ?? [] as placement (childKey(placement.child))}
                      <div class="inline-child-placement">
                        <button id={childButtonId(placement.child)} type="button" class="inline-child-toggle"
                          aria-expanded={expandedRootChildKey === childKey(placement.child)}
                          onclick={() => rootChildExpanded(placement.child)
                            ? collapseChild(placement.child, placement.afterEvent!) : expandChild(placement.child)}>
                          {expandedRootChildKey === childKey(placement.child) ? t($language, 'Collapse') : t($language, 'Expand')} {t($language, 'child history')} · {placement.child.sessionId}
                        </button>
                        {#if expandedRootChildKey === childKey(placement.child)}
                          <InlineChildReader child={placement.child} ancestors={[placement.child]}
                            {activeChildPath} {selectedChildSearch} {selectionHistoryVersion} {paneSearchStates} onPaneSearchChange={savePaneSearch} onSearchSelection={recordChildSearch}
                            onCollaborationUpdate={onChildCollaborationUpdate}
                            onChildPathChange={setChildPath}
                            onCollapse={() => collapseChild(placement.child, placement.afterEvent!)} />
                        {/if}
                      </div>
                    {/each}
                    {#if tool.thinking.length > 0}
                      <div class="attached-reasoning">
                        <details>
                          <summary>{t($language, 'Recorded reasoning')} · {tool.thinking.length} {tool.thinking.length === 1 ? t($language, 'segment') : t($language, 'segments')}</summary>
                          {#each tool.thinking as thought (thought.key)}
                            <EventCard
                              display={thought}
                              progress={content[fieldKey(thought, 'body')]}
                              searchReveal={searchReveals[thought.key]}
                              onReadMore={readMore}
                            />
                          {/each}
                        </details>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}
      {/snippet}
      {#snippet renderBlock(block: ReaderBlock, openingProcess: ProcessUnit | null = null)}
        <div class="turn-block">
          {#if block.main.item.owner && (block.main.item.role === 'tool' || block.main.item.event.segment === 'thinking')}
            <p class="owner-context"><a href={hashFor(block.main.item.owner)} onclick={(event) => jumpTo(event, block.main.item.owner!)}>{t($language, 'Related reply')}</a></p>
          {/if}
          <EventCard
            display={block.main}
            collaborationIdentity={readerCollaborationIdentity(relationEntries, block.main.item.event)}
            executionLandmarks={executionLandmarksByAnchor.get(block.main.key) ?? []}
            progress={content[fieldKey(block.main, 'body')]}
            toolInputProgress={content[fieldKey(block.main, 'toolInput')]}
            toolOutputProgress={content[fieldKey(block.main, 'toolOutput')]}
            searchReveal={searchReveals[block.main.key]}
            onReadMore={readMore}
            onOpenCounterpart={openExecutionCounterpart}
          />
          {#each placementsByAnchor.get(block.main.key) ?? [] as placement (childKey(placement.child))}
            <div class="inline-child-placement">
              <button id={childButtonId(placement.child)} type="button" class="inline-child-toggle"
                aria-expanded={expandedRootChildKey === childKey(placement.child)}
                onclick={() => rootChildExpanded(placement.child)
                  ? collapseChild(placement.child, placement.afterEvent!) : expandChild(placement.child)}>
                {expandedRootChildKey === childKey(placement.child) ? t($language, 'Collapse') : t($language, 'Expand')} {t($language, 'child history')} · {placement.child.sessionId}
              </button>
              {#if expandedRootChildKey === childKey(placement.child)}
                <InlineChildReader child={placement.child} ancestors={[placement.child]}
                  {activeChildPath} {selectedChildSearch} {selectionHistoryVersion} {paneSearchStates} onPaneSearchChange={savePaneSearch} onSearchSelection={recordChildSearch}
                  onCollaborationUpdate={onChildCollaborationUpdate}
                  onChildPathChange={setChildPath}
                  onCollapse={() => collapseChild(placement.child, placement.afterEvent!)} />
              {/if}
            </div>
          {/each}
          {#if openingProcess}
            <details class="reader-process" data-reader-process={openingProcess.id}
              data-reader-process-count={visibleProcessCount(openingProcess)}
              data-reader-process-loaded-count={openingProcess.count - 1}>
              <summary>{t($language, 'Execution process')} · {visibleProcessCount(openingProcess)} {visibleProcessCount(openingProcess) === 1 ? t($language, 'step') : t($language, 'steps')}{#if openingProcess.count < openingProcess.totalCount} · {openingProcess.count - 1} {t($language, 'loaded')}{/if}</summary>
              {@render renderWork(block)}
              {#each openingProcess.blocks.slice(1) as processBlock (processBlock.main.key)}
                {@render renderBlock(processBlock)}
              {/each}
            </details>
          {:else}
            {@render renderWork(block)}
          {/if}
        </div>
      {/snippet}
      <div class="transcript" class:has-collaboration-gutter={hasTranscriptHandoffs} bind:this={transcriptElement}
        role="region" aria-label={t($language, 'Session transcript')}>
        <TranscriptCollaboration entries={relationEntries} {provider} {sessionId} host={transcriptElement} onNavigate={openExecutionCounterpart} />
        {#each processUnits as unit (unit.blocks[0].main.key)}
          {#if openingMessage && unit.blocks[0].main.key === eventKey(openingMessage.event)}
            {@render renderBlock(unit.blocks[0], unit)}
          {:else if unit.id !== null || unit.blocks[0].main.item.event.segment === 'thinking'}
            <details class="reader-process" data-reader-process={unit.id} data-reader-process-count={visibleProcessCount(unit)} data-reader-process-loaded-count={unit.count}>
              <summary>{t($language, 'Execution process')} · {visibleProcessCount(unit)} {visibleProcessCount(unit) === 1 ? t($language, 'step') : t($language, 'steps')}{#if unit.count < visibleProcessCount(unit)} · {unit.count} {t($language, 'loaded')}{/if}</summary>
              {#each unit.blocks as processBlock (processBlock.main.key)}
                {@render renderBlock(processBlock)}
              {/each}
            </details>
          {:else}
            {@render renderBlock(unit.blocks[0])}
          {/if}
        {/each}
      </div>
      {#if lastPage?.nextCursor}
        <ReaderContinuation cursor={lastPage.nextCursor} loading={pageLoading} blocked={locationLoading}
          error={pageError} onContinue={() => loadAdjacent('next', true)} />
      {/if}
    {/if}
    {/if}
  </section>

  {#if view === 'conversation'}
  <div class="reading-progress" role="progressbar" aria-label={t($language, 'Reading progress')}
    aria-valuemin="0" aria-valuemax="100" aria-valuenow={readingPercent} style:--reading-progress={`${readingPercent}%`}><span></span></div>
  <aside class="reader-outline" aria-label={t($language, 'In this session')}>
    <div class="outline-heading">
      <h2>{t($language, 'Contents')}</h2>
      <div class="outline-actions">
        <button type="button" onclick={() => setOutlineExpanded(false)}>{t($language, 'Collapse all')}</button>
        <button type="button" onclick={() => setOutlineExpanded(true)}>{t($language, 'Expand all')}</button>
      </div>
    </div>
    <nav bind:this={outlineElement} aria-label={t($language, 'Jump to message')} aria-busy={tocLoading}>
      {#each outlineTurns as turn (turn.key)}
        <div class="outline-turn" class:has-request={Boolean(turn.request)}>
          {#if turn.request}
            <button type="button" class="outline-turn-toggle" aria-expanded={expandedOutlineTurns.has(turn.key)}
              aria-controls={'outline-replies-' + stableAnchor(turn.request.event)}
              aria-label={t($language, expandedOutlineTurns.has(turn.key) ? 'Collapse replies' : 'Expand replies') + ': ' + outlineLabel(turn.request)}
              onclick={() => toggleOutlineTurn(turn.key)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
            </button>
            <a class="outline-request" class:current-reading={readingKey === turn.key}
              aria-current={readingKey === turn.key ? 'location' : undefined} href={hashFor(turn.request.event)} title={turn.request.label}
              onclick={(event) => jumpTo(event, turn.request!.event)}>
              <span class="outline-copy"><strong>{outlineLabel(turn.request)}</strong><span>{t($language, 'You')}</span></span>
            </a>
          {/if}
          <div class="outline-children" id={turn.request ? 'outline-replies-' + stableAnchor(turn.request.event) : undefined}
            hidden={Boolean(turn.request) && !expandedOutlineTurns.has(turn.key)}>
            {#each turn.children as node (node.key)}
                <a class:context-outline={node.entry.event.segment === 'context'}
                  class:current-reading={readingKey === node.key} aria-current={readingKey === node.key ? 'location' : undefined} href={hashFor(node.entry.event)}
                  title={node.entry.label} onclick={(event) => jumpTo(event, node.entry.event)}>
                  <span class="outline-mark" aria-hidden="true"></span>
                  <span class="outline-copy"><strong>{outlineLabel(node.entry)}</strong><span>{outlineHeading(node.entry, $language)}</span></span>
                </a>
            {/each}
          </div>
        </div>
      {/each}
      {#if tocError}<p class="content-error" role="status">{tocError}</p>
        <button type="button" class="outline-retry" disabled={tocLoading || locationLoading} onclick={() => void loadToc()}>{t($language, 'Retry')}</button>
      {:else if tocLoading}<p class="outline-loading" role="status">{t($language, 'Loading contents…')}</p>{/if}
    </nav>
  </aside>
  {:else}<aside class="reader-outline runtime-outline" aria-label={t($language, 'Runtime')}><p class="rail-label">{t($language, 'Runtime')}</p><p>{t($language, 'Recorded event metadata for this session.')}</p></aside>{/if}
</main>
