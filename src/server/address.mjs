// side-effect-free helper importable from kit server code (src/routes/**/+page.server.js) without
// bundling the express app in src/server/app.mjs
import os from 'os'

// first non-internal ipv4 address of this host (as ip.address() of the dropped `ip` package did)
function localAddress() {
  for (const addresses of Object.values(os.networkInterfaces()))
    for (const a of addresses ?? []) if (a.family == 'IPv4' && !a.internal) return a.address
  return '127.0.0.1'
}
export { localAddress }
