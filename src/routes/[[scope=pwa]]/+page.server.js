import os from 'os'
import { localAddress } from '../../server/address.mjs'

// server session information included in all responses (as the sapper-era server-preload did);
// these match up with exported props of index.svelte. meta tags for public and shared pages come
// from hooks.server.js (which also injects the server-rendered content for crawlers)
export function load({ request, locals, getClientAddress }) {
  let client_ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (!client_ip) {
    try {
      client_ip = getClientAddress()
    } catch {
      client_ip = ''
    }
  }
  return { server_name: os.hostname(), server_ip: localAddress(), client_ip, meta: locals.meta }
}
