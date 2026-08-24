import { browser } from '$app/environment'

// scoped urls like /2f/ keep their trailing slash so that relative links resolve within the scope
export const trailingSlash = 'always'

// window globals (lodash, firebase, marked, octokit, ...) must exist before index.svelte
// instantiates; loading them here keeps them out of the server bundle (see src/client-globals.ts)
export async function load({ data }) {
  if (browser) await import('../../client-globals')
  return data
}
