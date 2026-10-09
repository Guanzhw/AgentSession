<script lang="ts">
  import type { ReaderItem } from './api';
  import { language, t } from './i18n';

  export let item: ReaderItem;

  $: metadata = item.replyMetadata;
  $: hasMetadata = item.role === 'assistant' && item.event.segment === 'message' && metadata !== null
    && (metadata.model !== null || metadata.modelProvider !== null ||
      Object.values(metadata.requestUsage?.tokens ?? {}).some(value => value !== null));
</script>

{#if hasMetadata && metadata}
  <div class="reply-metadata"
    data-reply-metadata data-reply-message-id={item.event.messageId} aria-label={t($language, 'Reply metadata')}>
    {#if metadata.model !== null}
      <span class="reply-metadata-fact"><span>{t($language, 'Model')}</span><code>{metadata.model}</code></span>
    {/if}
    {#if metadata.modelProvider !== null}
      <span class="reply-metadata-fact"><span>{t($language, 'Model provider')}</span><code>{metadata.modelProvider}</code></span>
    {/if}
    {#if metadata.requestUsage}
      {#if metadata.requestUsage.tokens.input !== null}<span class="reply-metadata-fact"><span>{t($language, 'Input')}</span><code>{metadata.requestUsage.tokens.input}</code></span>{/if}
      {#if metadata.requestUsage.tokens.output !== null}<span class="reply-metadata-fact"><span>{t($language, 'Output')}</span><code>{metadata.requestUsage.tokens.output}</code></span>{/if}
      {#if metadata.requestUsage.tokens.reasoning !== null}<span class="reply-metadata-fact"><span>{t($language, 'Reasoning')}</span><code>{metadata.requestUsage.tokens.reasoning}</code></span>{/if}
      {#if metadata.requestUsage.tokens.cacheRead !== null}<span class="reply-metadata-fact"><span>{t($language, 'Cache read')}</span><code>{metadata.requestUsage.tokens.cacheRead}</code></span>{/if}
      {#if metadata.requestUsage.tokens.cacheWrite !== null}<span class="reply-metadata-fact"><span>{t($language, 'Cache write')}</span><code>{metadata.requestUsage.tokens.cacheWrite}</code></span>{/if}
      {#if metadata.requestUsage.tokens.total !== null}<span class="reply-metadata-fact"><span>{t($language, 'Total')}</span><code>{metadata.requestUsage.tokens.total}</code></span>{/if}
    {/if}
  </div>
{/if}
