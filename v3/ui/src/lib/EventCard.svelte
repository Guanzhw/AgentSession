<script lang="ts">
  import { onMount } from 'svelte';
  import type { ContentField, ContentProgress, ReaderEventRef, ReaderItem, RuntimeExecutionObservation } from './api';
  import { renderMarkdown } from './markdown';
  import { language, t, type Language } from './i18n';
  import ReplyMetadata from './ReplyMetadata.svelte';
  import { agentAppearance, actorLabel as recordedActorLabel, type ReaderCollaborationIdentity } from './transcript-collaboration';

  export interface DisplayItem {
    item: ReaderItem;
    key: string;
    anchor: string;
  }

  export interface SearchReveal {
    field: ContentField;
    offset: number;
    matchLength: number;
    text: string;
    totalChars: number;
  }

  export interface ExecutionLandmark {
    phase: RuntimeExecutionObservation['phase'] | 'unknown';
    label: string;
    counterpart?: ReaderEventRef;
    counterpartLabel?: string;
  }

  export let display: DisplayItem;
  export let progress: ContentProgress | undefined = undefined;
  export let toolInputProgress: ContentProgress | undefined = undefined;
  export let toolOutputProgress: ContentProgress | undefined = undefined;
  export let searchReveal: SearchReveal | undefined = undefined;
  export let executionLandmarks: ExecutionLandmark[] = [];
  export let collaborationIdentity: ReaderCollaborationIdentity | null = null;
  export let onReadMore: (display: DisplayItem, field: ContentField) => void;
  export let onOpenCounterpart: ((event: ReaderEventRef) => void) | undefined = undefined;

  $: item = display.item;
  $: role = item.role;
  $: toolMetadata = item.toolMetadata;
  $: encryptedInput = toolMetadata?.inputState === 'encrypted';
  $: agentKey = role === 'agent' ? collaborationIdentity?.fromKey ?? collaborationIdentity?.from
    : toolMetadata ? collaborationIdentity?.toKey ?? toolMetadata.taskName : null;
  $: appearance = agentKey ? agentAppearance(agentKey) : null;
  $: displayedRole = roleName(item, collaborationIdentity, $language);
  $: hasFullBody = item.totalChars > item.preview.length;
  $: completeText = progress?.hasLoaded ? progress.text : item.preview;
  $: bodyIncomplete = hasFullBody && !progress?.done;
  $: shownText = bodyIncomplete ? readingPreview(completeText) : completeText;
  $: markdownBody = (role === 'user' || role === 'assistant' || role === 'agent') && shownText
    ? renderMarkdown(shownText) : '';

  onMount(() => {
    if ((role === 'user' || role === 'assistant' || role === 'agent') && hasFullBody &&
      !progress?.hasLoaded && !progress?.loading) onReadMore(display, 'body');
  });

  function readingPreview(text: string): string {
    const boundary = Math.max(text.lastIndexOf('\n\n'), text.lastIndexOf('. '), text.lastIndexOf('。') + 1,
      text.lastIndexOf(' '));
    return boundary > text.length - 120 ? text.slice(0, boundary).trimEnd() : text;
  }

  function roleName(eventItem: ReaderItem, identity: ReaderCollaborationIdentity | null, locale: Language): string {
    if (eventItem.event.segment === 'context') return t(locale, 'Context checkpoint');
    if (eventItem.event.segment === 'thinking') return t(locale, 'Reasoning');
    if (eventItem.role === 'user') return t(locale, 'You');
    if (eventItem.role === 'assistant') return t(locale, 'Assistant');
    if (eventItem.role === 'agent') return identity?.from ? actorLabel(identity.from, locale) : t(locale, 'Unknown agent');
    if (eventItem.role === 'tool') return eventItem.toolName || t(locale, 'Tool activity');
    return eventItem.role ? eventItem.role.replace(/[-_]/g, ' ') : t(locale, 'Session event');
  }

  function actorLabel(value: string, locale: Language): string {
    return value === '/root' ? t(locale, 'Main assistant') : recordedActorLabel(value) ?? value;
  }

  function timeLabel(timestamp: number | null, locale: Language): string {
    if (timestamp === null) return '';
    const date = new Date(timestamp);
    if (Number.isNaN(date.valueOf())) return '';
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function actionLabel(progress: ContentProgress | undefined): string {
    if (progress?.loading) return t($language, 'Loading…');
    if (progress?.error) return t($language, 'Retry');
    return t($language, 'Show more');
  }

  function toolActionLabel(progress: ContentProgress | undefined): string {
    if (progress?.loading) return t($language, 'Loading…');
    if (progress?.error) return t($language, 'Retry');
    return t($language, 'Show more');
  }

  function openToolField(event: Event, field: 'toolInput' | 'toolOutput', current: ContentProgress | undefined): void {
    if ((event.currentTarget as HTMLDetailsElement).open && !current?.hasLoaded && !current?.loading) {
      onReadMore(display, field);
    }
  }
</script>

<article id={display.anchor} data-message-id={item.event.messageId} data-segment={item.event.segment} data-total-chars={item.totalChars} class="event-card" class:user-card={role === 'user'} class:assistant-card={role === 'assistant' && item.event.segment !== 'thinking'} class:agent-card={role === 'agent'} class:thinking-card={item.event.segment === 'thinking'} class:tool-card={role === 'tool' && item.event.segment !== 'thinking'} class:other-card={role !== 'user' && role !== 'assistant' && role !== 'agent' && role !== 'tool'}>
  <header class="event-header">
    <span class="role-mark" class:agent-identity-mark={appearance !== null} style:color={appearance?.color} aria-hidden="true">
      {#if appearance}<svg viewBox="0 0 5 5"><path d={appearance.icon} fill="currentColor" /></svg>{/if}
    </span>
    <strong title={role === 'agent' ? collaborationIdentity?.from ?? undefined : undefined}>{displayedRole}</strong>
    {#if role === 'agent' && collaborationIdentity?.to}<span class="agent-recipient" title={collaborationIdentity.to}>→ {actorLabel(collaborationIdentity.to, $language)}</span>{/if}
    {#if timeLabel(item.timestamp, $language)}<time>{timeLabel(item.timestamp, $language)}</time>{/if}
    {#if role === 'tool' && item.event.segment !== 'thinking'}<span class="tool-kind">{t($language, 'Tool')}</span>{/if}
    {#if toolMetadata && (toolMetadata.taskName || toolMetadata.model || toolMetadata.reasoningEffort || toolMetadata.forkTurns)}
      <div class="tool-metadata" aria-label={t($language, 'Agent launch')}>
        {#if toolMetadata.taskName}<span class="tool-agent-name" style:color={appearance?.color}>{t($language, 'Agent')}: {toolMetadata.taskName}</span>{/if}
        {#if toolMetadata.model}<span>{t($language, 'Model')}: {toolMetadata.model}</span>{/if}
        {#if toolMetadata.reasoningEffort}<span>{t($language, 'Reasoning')}: {toolMetadata.reasoningEffort}</span>{/if}
        {#if toolMetadata.forkTurns}<span>{t($language, 'Context')}: {toolMetadata.forkTurns}</span>{/if}
      </div>
    {/if}
    {#if toolMetadata?.summary || toolMetadata?.directory}
      <div class="tool-summary" aria-label={t($language, 'Recorded tool input')}>
        {#if toolMetadata.summary}<span class="tool-command-summary">{toolMetadata.summary}</span>{/if}
        {#if toolMetadata.directory}<span class="tool-directory" title={toolMetadata.directory}>{t($language, 'Directory')}: {toolMetadata.directory}</span>{/if}
      </div>
    {/if}
  </header>

  {#if role === 'tool' && item.event.segment !== 'thinking'}
    <div class="tool-fields">
      <details class="tool-field" ontoggle={(event) => { if (!encryptedInput) openToolField(event, 'toolInput', toolInputProgress); }}>
        <summary>{t($language, 'Input')}{#if encryptedInput}<span class="tool-input-state"> · {t($language, 'Encrypted task message')}</span>{/if}</summary>
        {#if encryptedInput}
          <p class="tool-input-notice">{t($language, 'The task message is encrypted in the recorded source.')}</p>
          <details class="technical-raw-input" ontoggle={(event) => openToolField(event, 'toolInput', toolInputProgress)}>
            <summary>{t($language, 'Raw input')}</summary>
            {#if toolInputProgress?.hasLoaded}
              <div class="event-body">{toolInputProgress.text || t($language, 'No input text was recorded.')}</div>
            {/if}
            {#if toolInputProgress?.error}<p class="content-error" role="status">{toolInputProgress.error}</p>{/if}
            {#if !toolInputProgress?.done}
              <button class="read-more" disabled={toolInputProgress?.loading} onclick={() => onReadMore(display, 'toolInput')}>{toolActionLabel(toolInputProgress)}</button>
            {/if}
          </details>
        {:else}
          {#if toolInputProgress?.hasLoaded}
            <div class="event-body">{toolInputProgress.text || t($language, 'No input text was recorded.')}</div>
          {/if}
          {#if toolInputProgress?.error}<p class="content-error" role="status">{toolInputProgress.error}</p>{/if}
          {#if !toolInputProgress?.done}
            <button class="read-more" disabled={toolInputProgress?.loading} onclick={() => onReadMore(display, 'toolInput')}>{toolActionLabel(toolInputProgress)}</button>
          {/if}
        {/if}
      </details>
      <details class="tool-field" ontoggle={(event) => openToolField(event, 'toolOutput', toolOutputProgress)}>
        <summary>{t($language, 'Output')}</summary>
        {#if toolOutputProgress?.hasLoaded}
          <div class="event-body">{toolOutputProgress.text || t($language, 'No output text was recorded.')}</div>
        {/if}
        {#if toolOutputProgress?.error}<p class="content-error" role="status">{toolOutputProgress.error}</p>{/if}
        {#if !toolOutputProgress?.done}
          <button class="read-more" disabled={toolOutputProgress?.loading} onclick={() => onReadMore(display, 'toolOutput')}>{toolActionLabel(toolOutputProgress)}</button>
        {/if}
      </details>
    </div>
  {:else}
    {#if shownText}
      {#if markdownBody}
        <div class="event-body markdown-body" class:body-preview={bodyIncomplete}>{@html markdownBody}</div>
      {:else}
        <div class="event-body" class:body-preview={bodyIncomplete}>{shownText}</div>
      {/if}
    {:else}
      <div class="event-body empty-body">{t($language, 'No preview is available for this event.')}</div>
    {/if}
    <ReplyMetadata {item} />
    {#if bodyIncomplete}
      <div class="event-footer">
        <button class="read-more" disabled={progress?.loading} onclick={() => onReadMore(display, 'body')}>{actionLabel(progress)}<span aria-hidden="true"> ↓</span></button>
      </div>
      {#if progress?.error}<p class="content-error" role="status">{progress.error}</p>{/if}
    {/if}
  {/if}
  {#if role === 'tool' && executionLandmarks.length > 0}
    <div class="execution-landmarks" aria-label={t($language, 'Recorded execution')}>
      {#each executionLandmarks as landmark, index (index)}
        <p class:execution-returned={landmark.phase === 'completed'} class:execution-failed={landmark.phase === 'failed'} class:execution-unknown={landmark.phase === 'unknown'} data-phase={landmark.phase}>
          {landmark.label}
          {#if landmark.counterpart && onOpenCounterpart}
            <button type="button" class="execution-counterpart" data-execution-counterpart={landmark.counterpart.messageId}
              onclick={() => onOpenCounterpart?.(landmark.counterpart!)}>{landmark.counterpartLabel}</button>
          {/if}
        </p>
      {/each}
    </div>
  {/if}
  {#if searchReveal}
    <section class="search-reveal" tabindex="-1" data-field={searchReveal.field} aria-label={t($language, 'Recorded content at search match')}>
      <p>{t($language, 'Match in')} {searchReveal.field === 'toolInput' ? t($language, 'tool input') : searchReveal.field === 'toolOutput' ? t($language, 'tool output') : t($language, 'message')} · {t($language, 'character')} {searchReveal.offset + 1} {t($language, 'of')} {searchReveal.totalChars}</p>
      <div class="event-body"><mark>{searchReveal.text.slice(0, searchReveal.matchLength)}</mark>{searchReveal.text.slice(searchReveal.matchLength)}</div>
    </section>
  {/if}
</article>

<style>
  .search-reveal:focus {
    outline: 3px solid var(--focus-ring);
    outline-offset: 3px;
  }
</style>
