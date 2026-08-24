<script>
  import { onMount } from 'svelte'
  import Index from '../index.svelte'
  export let data
  export let params = undefined // passed by kit in dev, unused
  void params
  // server-rendered content for crawlers and link unfurlers (public and shared pages only, see
  // +page.server.js); the app replaces it on mount, underneath the loading overlay
  let mounted = false
  onMount(() => (mounted = true))
  const { content, ...session } = data
</script>

<svelte:head>
  {#if content}
    <meta name="description" content={content.meta.description} />
    <meta property="og:title" content={content.meta.title} />
    <meta property="og:description" content={content.meta.description} />
  {/if}
</svelte:head>

{#if content && !mounted}
  <div class="ssr-content">
    {#each content.items as item}
      <article>{@html item.html}</article>
    {/each}
  </div>
{/if}
<Index {...session} />

<style>
  /* readable no-javascript view; the app's loading overlay covers it while hydrating */
  .ssr-content {
    max-width: 40em;
    margin: 0 auto;
    padding: 1em;
    font-family: 'Open Sans', sans-serif;
  }
  .ssr-content article {
    margin-bottom: 1.5em;
  }
</style>
