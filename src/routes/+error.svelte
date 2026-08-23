<script>
  import { page } from '$app/stores'
  import { dev } from '$app/environment'
</script>

<svelte:head>
  <title>{$page.status}</title>
</svelte:head>

<div class="page">
  <div class="content">
    <h1>{$page.status}</h1>
    <p>{$page.error?.message}</p>
    {#if dev && $page.error?.stack}
      <pre>{$page.error.stack}</pre>
    {/if}
  </div>
</div>

<style>
  :global(#sapper) {
    height: 100%;
  }
  .page {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .content {
    text-align: center;
  }
</style>
