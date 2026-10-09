<script lang="ts">
  import { onMount } from 'svelte';
  import { language, t, type Message } from './i18n';

  export let cursor: string;
  export let loading = false;
  export let blocked = false;
  export let error = '';
  export let label: Message = 'Continue conversation';
  export let buttonClass = '';
  export let onContinue: () => void | Promise<void>;
  let sentinel: HTMLDivElement;
  let observer: IntersectionObserver | null = null;
  let attemptedCursor: string | null = null;

  $: if (observer && cursor && !loading && !blocked && !error && cursor !== attemptedCursor) {
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  }

  onMount(() => {
    observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && !loading && !blocked && !error && cursor !== attemptedCursor) {
        attemptedCursor = cursor;
        void onContinue();
      }
    }, { rootMargin: '160px 0px' });
    observer.observe(sentinel);
    return () => observer?.disconnect();
  });
</script>

<div class="reader-page-controls reader-continue" data-reader-continuation bind:this={sentinel}>
  <button class={buttonClass} disabled={loading || blocked} onclick={() => void onContinue()}>{loading ? t($language, 'Loading…') : error ? t($language, 'Retry') : t($language, label)}</button>
</div>
