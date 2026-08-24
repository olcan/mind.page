import { pageContent } from '$lib/server/content.js'
import { canonicalizeHost } from './host.js'

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
    transformPageChunk: ({ html }) => html.replace('<!--ssr-content-->', content?.html ?? ''),
  })
}
