<script>
  import Index from '../index.svelte'
  export let data
  export let params = undefined // passed by kit in dev, unused
  void params
  const { meta, ...session } = data
</script>

<svelte:head>
  {#if meta}
    <meta name="description" content={meta.description} />
    <meta property="og:title" content={meta.title} />
    <meta property="og:description" content={meta.description} />
  {/if}
</svelte:head>

<Index {...session} />
