// production server: the express middleware stack (src/server/app.js) in front of kit's
// adapter-node handler (npm run build); replaces the sapper-era __sapper__/build entry
// usage: [NO_HTTPS=1] [PORT=3000] node server.mjs
import fs from 'fs'
import https from 'https'
import { enableLocalProxy, guardProxyUpgrades, middleware, server_id } from './src/server/app.mjs'
import { handler } from './build/handler.js'

// HOST binds the http listener to one address (the e2e lanes bind `127.0.0.1`: a worker sandbox
// allows loopback listeners only, and an unspecified bind is not one; vault design
// mind_task_agents 9.7); unset, the listener binds every address as before
const { PORT = 3000, HOST } = process.env
enableLocalProxy() // local server: mount the proxy BEFORE the kit handler claims the path
middleware.use(handler) // kit handles all remaining requests (pages, assets, service worker)
guardProxyUpgrades(
  middleware.listen(PORT, HOST, () => {
    console.log(`HTTP server ${server_id} listening on http://${HOST ?? 'localhost'}:${PORT}`)
  }),
)
if (!process.env.NO_HTTPS)
  guardProxyUpgrades(
    https
      .createServer({ key: fs.readFileSync('ssl-dev/ca.key'), cert: fs.readFileSync('ssl-dev/ca.crt') }, middleware)
      .listen(443, HOST, () => {
        console.log(`HTTPS server ${server_id} listening on https://${HOST ?? 'localhost'}:443`)
      }),
  )
