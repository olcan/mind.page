<script>
  // kit passes these to every layout; declared to avoid unknown-prop warnings in dev
  export let data = undefined
  export let params = undefined
  void data, void params
</script>

<slot />
