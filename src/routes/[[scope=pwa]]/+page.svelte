<script>
  import Index from '../index.svelte'
  export let data
  export let params = undefined // passed by kit in dev, unused
  void params
</script>

<Index {...data} />
