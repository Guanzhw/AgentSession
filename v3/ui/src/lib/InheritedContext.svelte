<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type {
    ContentField,
    ContentProgress,
    InheritedContextItem,
    InheritedContextPage,
    SessionRef,
  } from './api';
  import { ApiRequestError, getInheritedContextContent, getInheritedContextPage } from './api';
  import { language, t } from './i18n';

  export let child: SessionRef;
  export let parent: SessionRef | null = null;
  export let discover = false;

  const pageSize = 40;
  const contentPageSize = 2048;

  let inheritedPage: InheritedContextPage | null = null;
  let available = false;
  let items: InheritedContextItem[] = [];
  let nextCursor: string | null = null;
  let totalItems = 0;
  let loaded = false;
  let loading = false;
  let apiError: ApiRequestError | null = null;
  let retryMode: 'first' | 'next' | null = null;
  let content: Record<string, ContentProgress> = {};
  let requestGeneration = 0;
  let active = true;
  let disclosureOpen = false;

  onDestroy(() => {
    active = false;
    requestGeneration++;
  });

  onMount(() => {
    if (discover) void loadFirstPage();
  });

  $: if (!discover) available = true;
  $: if (discover && apiError) disclosureOpen = true;

  function providerLabel(provider: string): string {
    return ({ codex: 'Codex', 'deepseek-harness': 'DeepSeek Harness',
      'claude-code': 'Claude Code', opencode: 'OpenCode', pi: 'Pi' } as Record<string, string>)[provider] || provider;
  }

  function itemKey(item: InheritedContextItem, field: ContentField): string {
    return JSON.stringify([item.ordinal, item.messageId, item.segment, field]);
  }

  function assertPageScope(page: InheritedContextPage): void {
    if (page.session.provider !== child.provider || page.session.sessionId !== child.sessionId ||
      page.scope !== 'inherited-context') {
      throw new ApiRequestError('invalid_response', 'The inherited-context response did not match this child session.');
    }
    if (inheritedPage && page.revision !== inheritedPage.revision) {
      throw new ApiRequestError('source_changed',
        'The source changed while this Reader was open. Refresh this session before reading inherited context.');
    }
    const sourceMatches = parent
      ? page.sourceSession !== null && page.sourceSession.provider === parent.provider &&
        page.sourceSession.sessionId === parent.sessionId
      : page.sourceSession === null;
    if (!sourceMatches) {
      throw new ApiRequestError('invalid_response', 'The inherited context source did not match the recorded session identity.');
    }
    if (page.items.length > pageSize) {
      throw new ApiRequestError('invalid_response', 'The inherited-context page exceeded its 40-record limit.');
    }
  }

  function asApiError(cause: unknown, fallback: string): ApiRequestError {
    return cause instanceof ApiRequestError
      ? cause
      : new ApiRequestError('request_failed', cause instanceof Error ? cause.message : fallback);
  }

  async function loadFirstPage(): Promise<void> {
    if (loading) return;
    const request = ++requestGeneration;
    loading = true;
    apiError = null;
    retryMode = null;
    try {
      const page = await getInheritedContextPage(child);
      if (!active || request !== requestGeneration) return;
      if (!page) {
        available = !discover;
        loaded = true;
        return;
      }
      assertPageScope(page);
      available = true;
      inheritedPage = page;
      items = page.items;
      totalItems = page.totalItems;
      nextCursor = page.nextCursor;
      loaded = true;
    } catch (cause) {
      if (active && request === requestGeneration) {
        available = true;
        apiError = asApiError(cause, 'Inherited context could not be loaded.');
        retryMode = 'first';
      }
    } finally {
      if (active && request === requestGeneration) loading = false;
    }
  }

  async function loadNextPage(): Promise<void> {
    if (!nextCursor || !inheritedPage || loading) return;
    const request = requestGeneration;
    const cursor = nextCursor;
    loading = true;
    apiError = null;
    retryMode = null;
    try {
      const page = await getInheritedContextPage(child, cursor);
      if (!active || request !== requestGeneration) return;
      if (!page) {
        throw new ApiRequestError('invalid_response', 'The inherited context ended before its recorded cursor.');
      }
      assertPageScope(page);
      inheritedPage = page;
      items = [...items, ...page.items];
      totalItems = page.totalItems;
      nextCursor = page.nextCursor;
    } catch (cause) {
      if (active && request === requestGeneration) {
        apiError = asApiError(cause, 'The next inherited-context page could not be loaded.');
        retryMode = 'next';
      }
    } finally {
      if (active && request === requestGeneration) loading = false;
    }
  }

  function retryPage(): void {
    if (retryMode === 'first') void loadFirstPage();
    else if (retryMode === 'next') void loadNextPage();
  }

  function restartFromFirstPage(): void {
    requestGeneration++;
    inheritedPage = null;
    items = [];
    nextCursor = null;
    totalItems = 0;
    loaded = false;
    loading = false;
    apiError = null;
    retryMode = null;
    content = {};
    void loadFirstPage();
  }

  function handleToggle(event: Event): void {
    if ((event.currentTarget as HTMLDetailsElement).open && !loaded && !loading) {
      void loadFirstPage();
    }
  }

  function roleLabel(item: InheritedContextItem): string {
    if (item.segment === 'thinking') return t($language, 'Reasoning');
    if (item.role === 'system') return t($language, 'System context');
    if (item.role === 'tool') return item.toolName || t($language, 'Tool activity');
    return item.role ? item.role.replace(/[-_]/g, ' ') : t($language, 'Inherited record');
  }

  function defaultProgress(item: InheritedContextItem): ContentProgress {
    return { text: '', hasLoaded: false, totalChars: item.totalChars,
      nextOffset: 0, done: false, loading: false, error: '' };
  }

  function contentProgress(item: InheritedContextItem, field: ContentField): ContentProgress {
    return content[itemKey(item, field)] ?? defaultProgress(item);
  }

  function readLabel(progress: ContentProgress, field: ContentField): string {
    if (progress.loading) return t($language, 'Loading next part…');
    if (progress.error) return progress.hasLoaded ? t($language, 'Retry next part') : t($language, 'Retry');
    if (!progress.hasLoaded) return field === 'toolInput' ? t($language, 'Load tool input') : field === 'toolOutput' ? t($language, 'Load tool output') : t($language, 'Read full message');
    if (progress.done) return field === 'toolInput' ? t($language, 'Full input loaded') : field === 'toolOutput' ? t($language, 'Full output loaded') : t($language, 'Full message loaded');
    return t($language, 'Continue reading');
  }

  async function readMore(item: InheritedContextItem, field: ContentField): Promise<void> {
    const key = itemKey(item, field);
    const current = contentProgress(item, field);
    if (current.loading || current.done || current.nextOffset === null) return;
    const offset = current.hasLoaded ? current.nextOffset : 0;
    const request = requestGeneration;
    const sourceRevision = inheritedPage!.revision;
    content = { ...content, [key]: { ...current, loading: true, error: '' } };
    try {
      const page = await getInheritedContextContent(child, item,
        sourceRevision, field, offset, contentPageSize);
      if (!active || request !== requestGeneration) return;
      if (page.revision !== sourceRevision) {
        throw new ApiRequestError('source_changed',
          'The source changed while this Reader was open. Refresh this session before continuing.');
      }
      if (page.offset !== offset || (page.nextOffset !== null && page.nextOffset <= offset)) {
        throw new ApiRequestError('invalid_response', 'The inherited content response did not continue from the requested offset.');
      }
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
      if (!active || request !== requestGeneration) return;
      const error = asApiError(cause, 'The inherited content could not be loaded.');
      const previous = content[key] ?? current;
      content = { ...content, [key]: { ...previous, loading: false, error: error.message } };
      if (error.code === 'source_changed' || error.code === 'invalid_cursor') {
        apiError = error;
        retryMode = null;
      }
    }
  }

  function refreshSession(): void {
    window.location.reload();
  }
</script>

{#if available || apiError}
<section class="inherited-context" aria-label={t($language, 'Inherited context')}>
  <details class="inherited-context-details" ontoggle={handleToggle} bind:open={disclosureOpen}>
    <summary>
      <strong>{t($language, 'Starting context')}</strong>
      <span>{loaded ? `${totalItems} ${t($language, 'records')}` : t($language, 'Recorded context before this child’s own messages.')}</span>
    </summary>
    <div class="inherited-context-content">
      {#if inheritedPage}
      <p class="inherited-context-source">
        {#if inheritedPage?.sourceSession}
          {t($language, 'Inherited from')} {providerLabel(inheritedPage.sourceSession.provider)} {t($language, 'session')} <code>{inheritedPage.sourceSession.sessionId}</code>.
        {:else}
          {t($language, 'This copied prefix has no recorded source session ID.')}
        {/if}
        {t($language, 'These records are shown separately from the child’s conversation and outline.')}
      </p>
      {/if}

      {#if loading && !loaded}<p class="inherited-context-state" role="status">{t($language, 'Loading inherited context…')}</p>{/if}
      {#if apiError}
        <div class="inherited-context-error" role="alert">
          <strong>{apiError.code === 'source_changed' ? t($language, 'Source revision changed') : apiError.code === 'invalid_cursor' ? t($language, 'Inherited context cursor is invalid') : t($language, 'Inherited context could not be loaded')}</strong>
          <p>{apiError.message}</p>
          {#if apiError.code === 'source_changed'}
            <button type="button" class="read-more" onclick={refreshSession}>{t($language, 'Refresh session')}</button>
          {:else if apiError.code === 'invalid_cursor'}
            <button type="button" class="read-more" onclick={restartFromFirstPage}>{t($language, 'Restart from first page')}</button>
          {:else if retryMode}
            <button type="button" class="read-more" disabled={loading} onclick={retryPage}>{loading ? t($language, 'Retrying…') : t($language, 'Retry page')}</button>
          {/if}
        </div>
      {/if}

      {#if loaded}
        <p class="inherited-context-count">{t($language, 'Showing')} {items.length} {t($language, 'of')} {totalItems} {t($language, 'inherited records')}</p>
        {#if items.length === 0}
          <p class="inherited-context-state">{t($language, 'No inherited context was recorded for this child.')}</p>
        {:else}
          <ol class="inherited-context-list">
            {#each items as item (`${item.ordinal}:${item.messageId}:${item.segment}`)}
              {@const body = content[itemKey(item, 'body')] ?? defaultProgress(item)}
              {@const input = content[itemKey(item, 'toolInput')] ?? defaultProgress(item)}
              {@const output = content[itemKey(item, 'toolOutput')] ?? defaultProgress(item)}
              <li class="inherited-context-item" data-ordinal={item.ordinal} data-message-id={item.messageId} data-segment={item.segment}>
                <details class="inherited-context-record">
                  <summary class="inherited-context-record-summary">
                    <span class="inherited-context-item-header">
                      <strong>{roleLabel(item)}</strong>
                      <small>{t($language, 'Inherited record')} {item.ordinal + 1}</small>
                    </span>
                    <span class="inherited-context-item-preview">{item.preview || t($language, 'No preview is available for this record.')}</span>
                  </summary>
                  <div class="inherited-context-record-body">
                    {#if item.role === 'tool' && item.segment !== 'thinking'}
                      <div class="inherited-context-tool-fields">
                        <details class="inherited-context-field">
                          <summary>{t($language, 'Input')}</summary>
                          {#if input.hasLoaded}<pre>{input.text || t($language, 'No input text was recorded.')}</pre>
                          {:else}<p>{t($language, 'Load the recorded tool input from the source.')}</p>{/if}
                          {#if input.error}<p class="content-error" role="status">{input.error}</p>{/if}
                          <button type="button" class="read-more" disabled={input.loading || input.done} onclick={() => void readMore(item, 'toolInput')}>{readLabel(input, 'toolInput')}</button>
                          {#if input.hasLoaded}<span class="content-progress">{input.nextOffset ?? input.totalChars} / {input.totalChars} {t($language, 'characters')}</span>{/if}
                        </details>
                        <details class="inherited-context-field">
                          <summary>{t($language, 'Output')}</summary>
                          {#if output.hasLoaded}<pre>{output.text || t($language, 'No output text was recorded.')}</pre>
                          {:else if item.preview}<pre>{item.preview}</pre>
                          {:else}<p>{t($language, 'Load the recorded tool output from the source.')}</p>{/if}
                          {#if output.error}<p class="content-error" role="status">{output.error}</p>{/if}
                          {#if item.totalChars > item.preview.length || (output.hasLoaded && !output.done)}
                            <button type="button" class="read-more" disabled={output.loading || output.done} onclick={() => void readMore(item, 'toolOutput')}>{readLabel(output, 'toolOutput')}</button>
                          {/if}
                          {#if output.hasLoaded}<span class="content-progress">{output.nextOffset ?? output.totalChars} / {output.totalChars} {t($language, 'characters')}</span>{/if}
                        </details>
                      </div>
                    {:else}
                      {@const shownText = body.hasLoaded ? body.text : item.preview}
                      {#if shownText}<pre class="inherited-context-body">{shownText}</pre>
                      {:else}<p class="inherited-context-state">{t($language, 'No preview is available for this record.')}</p>{/if}
                      {#if item.totalChars > item.preview.length || (body.hasLoaded && !body.done)}
                        <div class="inherited-context-item-footer">
                          <button type="button" class="read-more" disabled={body.loading || body.done} onclick={() => void readMore(item, 'body')}>{readLabel(body, 'body')}</button>
                          {#if body.hasLoaded}<span class="content-progress">{body.nextOffset ?? body.totalChars} / {body.totalChars} {t($language, 'characters')}</span>
                          {:else}<span class="content-progress">{item.totalChars} {t($language, 'characters')}</span>{/if}
                        </div>
                      {/if}
                      {#if body.error}<p class="content-error" role="status">{body.error}</p>{/if}
                    {/if}
                    <details class="inherited-context-source-details">
                      <summary>{t($language, 'Source record')}</summary>
                      <code>{item.messageId} / {item.segment}</code>
                    </details>
                  </div>
                </details>
              </li>
            {/each}
          </ol>
        {/if}
        {#if nextCursor}
          <button type="button" class="read-more inherited-context-next" disabled={loading} onclick={() => void loadNextPage()}>{loading ? t($language, 'Loading inherited records…') : t($language, 'Load more inherited records')}</button>
        {/if}
      {/if}
    </div>
  </details>
</section>
{/if}
