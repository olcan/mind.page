import os from 'os'
import { localAddress } from '../../server/address.mjs'
import { pageContent } from '$lib/server/content.js'
import { canonicalizeHost } from '../../host.js'

// server session information included in all responses (as the sapper-era server-preload did);
// these match up with exported props of index.svelte. public (anonymous) and shared pages also get
// server-rendered content and meta tags for crawlers and link unfurlers (see $lib/server/content)
export async function load({ request, url, cookies, getClientAddress }) {
  let client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (!client_ip) {
    try {
      client_ip = getClientAddress()
    } catch {
      client_ip = ''
    }
  }
  // behind firebase hosting the host header is the function's own host (x-forwarded-host is the site)
  const hostname = canonicalizeHost(request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host)
  const content = await pageContent({ url, cookie: cookies.get('__session'), hostname })
  return { server_name: os.hostname(), server_ip: localAddress(), client_ip, content }
}
