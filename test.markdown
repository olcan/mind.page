#test this is a test of side-push
```js_input
_this.global_store.github = { sidepush_dests:[{
  owner: 'olcan',
  repo: 'olcan.com',
  path: 'test.markdown'  
},{
  owner: 'olcan',
  repo: 'mind.page',
  path: 'test.markdown'  
}] }
```
```_output
{"sidepush_dests":[{"owner":"olcan","repo":"olcan.com","path":"test.markdown"},{"owner":"olcan","repo":"mind.page","path":"test.markdown"}]}
```