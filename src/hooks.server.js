import { env } from '$env/dynamic/private'
import { pageContent } from '$lib/server/content.js'
import { canonicalizeHost } from './host.js'
import { vendorShell } from './server/vendor_shell.js'

// injects the server-rendered content for crawlers, link unfurlers and no-javascript visitors
// directly into the page html (see the placeholder in app.html): unlike load data it is not
// serialized into the hydration payload or re-rendered by the client, which would roughly double
// the page and cost hydration work; the app removes the node on boot (see +page.js)
export async function handle({ event, resolve }) {
  let content = null
  if (event.route.id?.includes('scope=pwa')) {
    const hostname = canonicalizeHost(
      event.request.headers.get('x-forwarded-host') ?? event.request.headers.get('host') ?? event.url.host
    )
    content = await pageContent({ url: event.url, cookie: event.cookies.get('__session'), hostname })
  }
  event.locals.meta = content?.meta ?? null
  return resolve(event, {
    // the placeholder comment stays in place (content is inserted after it): removing comments in
    // transformPageChunk draws a dev warning since svelte hydration relies on comment markers.
    // the replacement MUST be a function: as a string, '$&', "$'" and '$`' in the item-authored
    // content are substitution patterns — "$'" splices in everything after the placeholder, so an
    // item containing it duplicated the app container INSIDE the injected block, which the app
    // removes on boot (see +page.js), leaving the real container empty and the app rendering into
    // a detached tree (every item then measures zero height and rendering never completes)
    // a vendoring server (VENDOR_DIR: a lane server of the e2e gate) serves the shell with its cdn
    // origins pointed at its own /vendor/ route (src/server/vendor_shell.js); every other server,
    // the cloud function included, serves the shell as written
    transformPageChunk: ({ html }) => {
      const page = content ? html.replace('<!--ssr-content-->', () => '<!--ssr-content-->' + content.html) : html
      return env.VENDOR_DIR ? vendorShell(page) : page
    },
  })
}
