import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'
import { enableLocalProxy, guardProxyUpgrades, middleware } from './src/server/app.mjs'
import fs from 'fs'
import tls from 'tls'

// dev certs as in the sapper-era dev server (see ssl-dev/ and bin/build_mind_page.sh in the vault);
// https on 443 when present, so the usual https://localhost dev flow keeps working
const https = fs.existsSync('ssl-dev/ca.key')
  ? { key: fs.readFileSync('ssl-dev/ca.key'), cert: fs.readFileSync('ssl-dev/ca.crt') }
  : undefined

// the hmr websocket gets its own port so upgrades bypass the express stack on the main server
// and concurrent instances can pick their own (HMR_PORT, e.g. tests); vite creates the dedicated
// server itself, carrying the same https options (in vite 5 this needed a hand-rolled server)
const hmrPort = Number(process.env.HMR_PORT ?? 24678)

// vite 8 always serves https with an http/2 server (the vite 5 `proxy` downgrade is gone), and
// express is structurally incompatible with node's http/2 compat objects: it reparents req/res
// prototypes onto the http/1 classes, losing Http2ServerRequest's url/method accessors and
// Http2ServerResponse's methods. restricting the tls handshake to http/1.1 keeps browsers off
// http/2 (the server still handles http/1 via allowHTTP1), so express sees real http/1 objects
const restrictALPN = (httpServer: any) => {
  // convertALPNProtocols is exported by node:tls but missing from @types/node; it writes the
  // ALPNProtocols buffer consulted on each tls handshake onto the server
  if (httpServer?.setSecureContext) (tls as any).convertALPNProtocols(['http/1.1'], httpServer)
}

// safety net for clients that force http/2 anyway (e.g. curl --http2-prior-knowledge): express
// matches nothing on such requests (its url reads come back undefined), and without restoring the
// prototypes vite's own connect stack crashes reading req.url after express declines
const h1CompatMiddleware = (req: any, res: any, next: (err?: any) => void) => {
  const reqProto = Object.getPrototypeOf(req)
  const resProto = Object.getPrototypeOf(res)
  const url = req.url
  middleware(req, res, (err?: any) => {
    Object.setPrototypeOf(req, reqProto)
    Object.setPrototypeOf(res, resProto)
    req.url = url
    next(err)
  })
}
export default defineConfig({
  // host true binds the wildcard address: macos only allows unprivileged low ports there, and the
  // lan address is part of the usual dev flow (device testing via the ssl-dev cert sans)
  server: {
    // firebase-config.js lives at the repo root, outside kit's default fs allow list
    fs: { allow: ['.'] },
    // the hmr websocket rejects unknown hosts (vite's backported host check); allow the dev-cert
    // hostnames (see ssl-dev/ and build_mind_page.sh in the vault; ip literals are always allowed)
    allowedHosts: ['localhost', 'local.dev', 'localhost.dev', '.local'],
    ...(https ? { https, port: 443, host: true, strictPort: false, ws: { port: hmrPort, clientPort: hmrPort } } : {}),
  },
  plugins: [
    sveltekit(),
    {
      // the express middleware stack (proxy, webhooks, /user, manifests, icons, dev routes) in
      // front of kit, as in production (see server.mjs); vite 8 serves https with http/2, and
      // express swaps the request prototype (losing Http2ServerRequest's url accessors), so the
      // prototypes are restored before the request continues down vite's own middlewares
      name: 'mindpage-server',
      configureServer: server => {
        enableLocalProxy() // a LOCAL server: the proxy exists here and nowhere else
        restrictALPN(server.httpServer)
        // the dev/preview servers mount the same middleware stack, and vite binds the wildcard
        // address — without this the proxy's upgrade path is reachable from the whole LAN
        if (server.httpServer) guardProxyUpgrades(server.httpServer)
        server.middlewares.use(h1CompatMiddleware)
      },
      configurePreviewServer: server => {
        enableLocalProxy()
        restrictALPN(server.httpServer)
        if (server.httpServer) guardProxyUpgrades(server.httpServer)
        server.middlewares.use(h1CompatMiddleware)
      },
    },
  ],
})
