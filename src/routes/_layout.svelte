<!-- this fixes "preload" is not exported error that popped up w/ newer rollup -->
<script context="module">
  export async function preload({ params, query }) {
    return null
  }
</script>

<!-- these fixes console warning: <Layout> was created with unknown prop 'segment'  -->
<script>
  export let segment
</script>

<slot>{segment}</slot>
