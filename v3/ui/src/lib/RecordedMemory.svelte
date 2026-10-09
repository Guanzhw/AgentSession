<script lang="ts">
  import { onMount } from 'svelte';
  import { getMemoryArtifacts, getMemoryContent } from './api';
  import type { MemoryArtifacts, MemoryArtifact } from './api';
  import { language, t } from './i18n';

  export let sessionId: string;

  let listing: MemoryArtifacts | null = null;
  let loading = true;
  let error = '';
  let selected: MemoryArtifact | null = null;
  let body = '';
  let nextOffset: number | null = null;
  let bodyLoading = false;
  let bodyError = '';
  let active = true;

  onMount(() => {
    void getMemoryArtifacts(sessionId).then(value => { if (active) listing = value; })
      .catch(cause => { if (active) error = cause instanceof Error ? cause.message : String(cause); })
      .finally(() => { if (active) loading = false; });
    return () => { active = false; };
  });

  async function read(artifact: MemoryArtifact, offset = 0): Promise<void> {
    if (!listing || bodyLoading) return;
    if (offset === 0) { selected = artifact; body = ''; nextOffset = null; }
    bodyLoading = true;
    bodyError = '';
    try {
      const page = await getMemoryContent(sessionId, artifact.id, listing.revision, offset);
      if (!active || selected?.id !== artifact.id) return;
      body += page.text;
      nextOffset = page.nextOffset;
    } catch (cause) {
      if (active) bodyError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (active) bodyLoading = false;
    }
  }
</script>

<div class="context-block recorded-memory">
  <span class="rail-label">{t($language, 'Recorded memory')}</span>
  {#if loading}<p>{t($language, 'Checking recorded artifacts…')}</p>
  {:else if error}<p role="alert">{error}</p>
  {:else if listing?.sourceState.state !== 'available'}
    <p>{t($language, 'Memory source')} {listing?.sourceState.code || t($language, 'unavailable')}.</p>
  {:else if listing.artifacts.length === 0}
    <p>{t($language, 'No memory recorded for this session.')}</p>
  {:else}
    <div class="recorded-memory-actions">
      {#each listing.artifacts as artifact (artifact.id)}
        <button type="button" onclick={() => void read(artifact)}>{artifact.kind === 'memory' ? t($language, 'Saved memory') : t($language, 'Rollout summary')}</button>
      {/each}
    </div>
    {#if selected}
      <p class="recorded-memory-provenance">{selected.productionEvidence ? t($language, 'Production recorded') : t($language, 'Production history unknown')} · {new Date(selected.timeCreated).toLocaleString($language === 'zh' ? 'zh-CN' : 'en')}</p>
      <pre>{body}</pre>
      {#if bodyError}<p role="alert">{bodyError}</p>{/if}
      {#if nextOffset !== null}
        <button type="button" disabled={bodyLoading} onclick={() => void read(selected!, nextOffset!)}>{bodyLoading ? t($language, 'Loading…') : t($language, 'Read more')}</button>
      {/if}
    {/if}
  {/if}
</div>
