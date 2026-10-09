<script lang="ts">
  import { getSystemPromptEvidence, type PromptProvenance, type SystemPromptEvidence, type SystemPromptItem } from './api';
  import { language, t } from './i18n';

  export let provider: string;
  export let sessionId: string;

  interface EvidenceEntry {
    item: SystemPromptItem;
    sectionTitle: string;
    sectionNote: string;
  }

  const revealChunkSize = 4096;
  let evidence: SystemPromptEvidence | null = null;
  let loading = false;
  let loadError = '';
  let visibleChars: Record<string, number> = {};

  $: recordedEntries = evidence ? entriesFor(evidence, 'recorded') : [];
  $: currentEntries = evidence ? entriesFor(evidence, 'current-local') : [];

  function entriesFor(source: SystemPromptEvidence, provenance: PromptProvenance): EvidenceEntry[] {
    return source.sections.flatMap(section => section.items
      .filter(item => item.provenance === provenance)
      .map(item => ({ item, sectionTitle: section.title, sectionNote: section.note }))) ?? [];
  }

  function handlePanelToggle(event: Event): void {
    const panel = event.currentTarget as HTMLDetailsElement;
    if (panel.open && !evidence && !loading && !loadError) void loadEvidence();
  }

  async function loadEvidence(): Promise<void> {
    loading = true;
    loadError = '';
    try {
      evidence = await getSystemPromptEvidence(provider, sessionId);
    } catch (cause) {
      loadError = cause instanceof Error ? cause.message : t($language, 'Prompt evidence could not be loaded.');
    } finally {
      loading = false;
    }
  }

  function itemKey(provenance: PromptProvenance, index: number): string {
    return provenance + '-' + index;
  }

  function handleItemToggle(event: Event, key: string, totalChars: number): void {
    const item = event.currentTarget as HTMLDetailsElement;
    if (item.open && visibleChars[key] === undefined) {
      visibleChars = { ...visibleChars, [key]: Math.min(revealChunkSize, totalChars) };
    }
  }

  function revealNext(key: string, totalChars: number): void {
    visibleChars = { ...visibleChars, [key]: Math.min((visibleChars[key] ?? 0) + revealChunkSize, totalChars) };
  }

  function formatMetadata(metadata: unknown): string {
    return JSON.stringify(metadata, null, 2) ?? String(metadata);
  }
</script>

<section class="prompt-evidence-panel" aria-labelledby="prompt-evidence-heading">
  <details class="prompt-evidence-disclosure" ontoggle={handlePanelToggle}>
    <summary class="prompt-evidence-toggle">
      <span id="prompt-evidence-heading">{t($language, 'AI instructions')}</span>
    </summary>
    <div class="prompt-evidence-content">
      <p>{t($language, 'Instructions saved with this conversation and local instruction files available now.')}</p>
      {#if loading}
        <p class="prompt-evidence-state" role="status">{t($language, 'Loading prompt evidence…')}</p>
      {:else if loadError}
        <p class="prompt-evidence-state" role="alert">{t($language, 'Prompt evidence could not be loaded:')} {loadError}</p>
        <button type="button" class="prompt-evidence-retry" onclick={() => void loadEvidence()}>{t($language, 'Retry')}</button>
      {:else if evidence}
        <header class="prompt-evidence-header">
          <p>{evidence.note}</p>
          <div class="prompt-evidence-facts">
            <span>{t($language, 'Evidence mode:')} <code>{evidence.mode}</code></span>
            {#if evidence.selectedAgent}<span>{t($language, 'Selected agent:')} <code>{evidence.selectedAgent}</code></span>{/if}
            <span>{evidence.hiddenPromptStored ? t($language, 'Recorded prompt text is present.') : t($language, 'No hidden provider prompt is stored.')}</span>
          </div>
        </header>

        <div class="prompt-evidence-groups">
          <section class="prompt-evidence-group" data-provenance="recorded" aria-labelledby="prompt-recorded-heading">
            <div class="prompt-evidence-group-heading">
              <div>
                <h2 id="prompt-recorded-heading">{t($language, 'Recorded with this session')}</h2>
                <p>{t($language, 'Prompt text explicitly persisted in the session source.')}</p>
              </div>
              <span>{recordedEntries.length} {recordedEntries.length === 1 ? t($language, 'item') : t($language, 'items')}</span>
            </div>
            {#if recordedEntries.length > 0}
              <ul class="prompt-evidence-list">
                {#each recordedEntries as entry, index (itemKey('recorded', index))}
                  {@const key = itemKey('recorded', index)}
                  <li>
                    <details class="prompt-evidence-item" data-provenance="recorded"
                      ontoggle={(event) => handleItemToggle(event, key, entry.item.content.length)}>
                      <summary class="prompt-evidence-item-summary">
                        <span class="prompt-provenance-badge recorded">{t($language, 'Recorded')}</span>
                        <span class="prompt-evidence-item-name"><strong>{entry.item.title}</strong>
                          <code>{entry.item.source}</code></span>
                      </summary>
                      <div class="prompt-evidence-item-content">
                        <p class="prompt-evidence-origin">{entry.sectionTitle} · {entry.item.resolution}</p>
                        {#if entry.sectionNote}<p class="prompt-evidence-origin-note">{entry.sectionNote}</p>{/if}
                        {#if entry.item.sourcePath}<p class="prompt-evidence-path">{t($language, 'Source path:')} <code>{entry.item.sourcePath}</code></p>{/if}
                        {#if entry.item.sourceMetadata !== null}
                          <details class="prompt-evidence-metadata">
                            <summary>{t($language, 'Source metadata')}</summary>
                            <pre>{formatMetadata(entry.item.sourceMetadata)}</pre>
                          </details>
                        {/if}
                        {#if entry.item.preview}<p class="prompt-evidence-preview">{t($language, 'Preview:')} {entry.item.preview}</p>{/if}
                        {#if entry.item.content.length > 0}
                          <pre class="prompt-evidence-text">{entry.item.content.slice(0, visibleChars[key] ?? 0)}</pre>
                          {#if (visibleChars[key] ?? 0) < entry.item.content.length}
                            <button type="button" class="prompt-evidence-reveal"
                              onclick={() => revealNext(key, entry.item.content.length)}>
                              {t($language, 'Reveal next')} {Math.min(revealChunkSize, entry.item.content.length - (visibleChars[key] ?? 0)).toLocaleString($language === 'zh' ? 'zh-CN' : 'en')} {t($language, 'characters')}
                            </button>
                          {/if}
                        {:else}
                          <p class="prompt-evidence-empty">{t($language, 'No content was recorded for this item.')}</p>
                        {/if}
                      </div>
                    </details>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="prompt-evidence-empty">{t($language, 'No prompt text was recorded with this session.')}</p>
            {/if}
          </section>

          <section class="prompt-evidence-group" data-provenance="current-local" aria-labelledby="prompt-current-heading">
            <div class="prompt-evidence-group-heading">
              <div>
                <h2 id="prompt-current-heading">{t($language, 'Current local sources')}</h2>
                <p>{t($language, 'Sources resolvable now from the recorded working directory. Their presence does not prove they were available to or loaded by the historical run.')}</p>
              </div>
              <span>{currentEntries.length} {currentEntries.length === 1 ? t($language, 'source') : t($language, 'sources')}</span>
            </div>
            {#if currentEntries.length > 0}
              <ul class="prompt-evidence-list">
                {#each currentEntries as entry, index (itemKey('current-local', index))}
                  {@const key = itemKey('current-local', index)}
                  <li>
                    <details class="prompt-evidence-item" data-provenance="current-local"
                      ontoggle={(event) => handleItemToggle(event, key, entry.item.content.length)}>
                      <summary class="prompt-evidence-item-summary">
                        <span class="prompt-provenance-badge current-local">{t($language, 'Current local')}</span>
                        <span class="prompt-evidence-item-name"><strong>{entry.item.title}</strong>
                          <code>{entry.item.sourcePath || entry.item.source}</code></span>
                      </summary>
                      <div class="prompt-evidence-item-content">
                        <p class="prompt-evidence-origin">{entry.sectionTitle} · {entry.item.resolution}</p>
                        {#if entry.sectionNote}<p class="prompt-evidence-origin-note">{entry.sectionNote}</p>{/if}
                        {#if entry.item.sourcePath}<p class="prompt-evidence-path">{t($language, 'Source path:')} <code>{entry.item.sourcePath}</code></p>{/if}
                        {#if entry.item.sourceMetadata !== null}
                          <details class="prompt-evidence-metadata">
                            <summary>{t($language, 'Source metadata')}</summary>
                            <pre>{formatMetadata(entry.item.sourceMetadata)}</pre>
                          </details>
                        {/if}
                        {#if entry.item.preview}<p class="prompt-evidence-preview">{t($language, 'Preview:')} {entry.item.preview}</p>{/if}
                        {#if entry.item.content.length > 0}
                          <pre class="prompt-evidence-text">{entry.item.content.slice(0, visibleChars[key] ?? 0)}</pre>
                          {#if (visibleChars[key] ?? 0) < entry.item.content.length}
                            <button type="button" class="prompt-evidence-reveal"
                              onclick={() => revealNext(key, entry.item.content.length)}>
                              {t($language, 'Reveal next')} {Math.min(revealChunkSize, entry.item.content.length - (visibleChars[key] ?? 0)).toLocaleString($language === 'zh' ? 'zh-CN' : 'en')} {t($language, 'characters')}
                            </button>
                          {/if}
                        {:else}
                          <p class="prompt-evidence-empty">{t($language, 'This local file is empty.')}</p>
                        {/if}
                      </div>
                    </details>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="prompt-evidence-empty">{t($language, 'No current local sources were resolved.')}</p>
            {/if}
          </section>
        </div>

        <section class="prompt-evidence-diagnostics" aria-labelledby="prompt-diagnostics-heading">
          <h2 id="prompt-diagnostics-heading">{t($language, 'Availability and resolution')}</h2>
          {#if evidence.diagnostics.length > 0}
            <ul>
              {#each evidence.diagnostics as diagnostic}
                <li data-code={diagnostic.code}>
                  <strong>{diagnostic.code === 'hidden_prompt_unavailable' ? t($language, 'Hidden provider prompt unavailable') : diagnostic.code.replaceAll('_', ' ')}</strong>
                  <p>{diagnostic.message}</p>
                  {#if diagnostic.source}<code>{diagnostic.source}</code>{/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="prompt-evidence-empty">{t($language, 'No prompt-source diagnostics were reported.')}</p>
          {/if}
        </section>
      {/if}
    </div>
  </details>
</section>
