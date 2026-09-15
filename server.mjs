// production server: the express middleware stack (src/server/app.js) in front of kit's
// adapter-node handler (npm run build); replaces the sapper-era __sapper__/build entry
// usage: [NO_HTTPS=1] [PORT=3000] node server.mjs
import fs from 'fs'
import https from 'https'
import { enableLocalProxy, guardProxyUpgrades, middleware, server_id } from './src/server/app.mjs'
import { vendoredAssets } from './src/server/vendor.mjs'
import { handler } from './build/handler.js'

// HOST binds the http listener to one address (the e2e lanes bind `127.0.0.1`: a worker sandbox
// allows loopback listeners only, and an unspecified bind is not one; vault design
// mind_task_agents 9.7); unset, the listener binds every address as before
const { PORT = 3000, HOST } = process.env
enableLocalProxy() // local server: mount the proxy BEFORE the kit handler claims the path
// the e2e gate's vendored cdn assets (VENDOR_DIR, see src/server/vendor.mjs): a lane server only
if (process.env.VENDOR_DIR) middleware.use(vendoredAssets())
middleware.use(handler) // kit handles all remaining requests (pages, assets, service worker)
const http = middleware.listen(PORT, HOST, () => {
  // the bound port, not the requested one: PORT=0 picks a free port (a test's throwaway server)
  console.log(`HTTP server ${server_id} listening on http://${HOST ?? 'localhost'}:${http.address().port}`)
})
guardProxyUpgrades(http)
if (!process.env.NO_HTTPS)
  guardProxyUpgrades(
    https
      .createServer({ key: fs.readFileSync('ssl-dev/ca.key'), cert: fs.readFileSync('ssl-dev/ca.crt') }, middleware)
      .listen(443, HOST, () => {
        console.log(`HTTPS server ${server_id} listening on https://${HOST ?? 'localhost'}:443`)
      }),
  )
