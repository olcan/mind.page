<!-- these lines remove console warning: <Layout> was created with unknown prop 'segment'  -->
<script>
  export let segment;
</script>

<slot>{segment}</slot>
