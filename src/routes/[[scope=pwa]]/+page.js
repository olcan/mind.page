import { browser } from '$app/environment'
import { isSharedOrigin } from '../../host.js'

// scoped urls like /2f/ keep their trailing slash so that relative links resolve within the scope
export const trailingSlash = 'always'

// window globals (lodash, firebase, marked, octokit, ...) must exist before index.svelte
// instantiates; loading them here keeps them out of the server bundle (see src/client-globals.ts)
export async function load({ data }) {
  if (browser) {
    // SCRUB STORAGE on the isolated shared-page origins, before firebase and before any owner
    // code. every owner's shared page runs on that one origin, so anything a page leaves in
    // localStorage or sessionStorage is readable by the NEXT owner's code — including values
    // written by builds that predate the per-key rules, which those rules cannot reach. clearing
    // wholesale needs no security-sensitive key inventory to stay correct.
    // the honest limit: owner code can still write storage during its own page lifetime, and live
    // same-origin tabs mutually trust each other. the next clean navigation removes the residue.
    // this runs FIRST in the browser branch, and is the earliest app code on the page
    if (isSharedOrigin(location.hostname)) {
      try {
        localStorage.clear()
        sessionStorage.clear()
      } catch (e) {
        console.warn('could not scrub shared-origin storage:', e) // private mode, blocked cookies
      }
    }
    // drop the injected crawler content (see hooks.server.js) before the app renders
    document.querySelector('.ssr-content')?.remove()
    await import('../../client-globals')
  }
  return data
}
