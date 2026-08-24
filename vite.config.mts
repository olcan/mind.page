import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'
import { middleware } from './src/server/app.mjs'
import fs from 'fs'
import tls from 'tls'
import { createServer } from 'https'

// dev certs as in the sapper-era dev server (see ssl-dev/ and bin/build_mind_page.sh in the vault);
// https on 443 when present, so the usual https://localhost dev flow keeps working
const https = fs.existsSync('ssl-dev/ca.key')
  ? { key: fs.readFileSync('ssl-dev/ca.key'), cert: fs.readFileSync('ssl-dev/ca.crt') }
  : undefined

// hmr needs its own server: with `proxy` set (see below) vite skips ws upgrades on the main
// server, and a bare hmr port would create a plain-ws server that wss:// clients cannot reach;
// this one carries the same dev certs (port overridable for concurrent instances, e.g. tests)
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
const hmrServer = https ? createServer(https) : undefined

export default defineConfig(({ command }) => {
  // tolerate a busy port: tools also load this config with command 'serve' (e.g. svelte-check),
  // and a second dev instance should use HMR_PORT instead of crashing the first
  if (command == 'serve' && hmrServer && !hmrServer.listening)
    hmrServer
      .on('error', (err: NodeJS.ErrnoException) => console.warn(`hmr server not listening (${err.code}); set HMR_PORT for another instance`))
      .listen(hmrPort)
  return {
  // host true binds the wildcard address: macos only allows unprivileged low ports there, and the
  // lan address is part of the usual dev flow (device testing via the ssl-dev cert sans)
  // the proxy config downgrades the dev server to http/1.1: vite serves https with http/2 by
  // default, which its connect stack and the express middleware below cannot handle; vite 8 only
  // downgrades when the proxy table is non-empty, so an inert entry stands in for the old `{}`
  server: {
    // firebase-config.js lives at the repo root, outside kit's default fs allow list
    fs: { allow: ['.'] },
    // the hmr websocket rejects unknown hosts (vite's backported host check); allow the dev-cert
    // hostnames (see ssl-dev/ and build_mind_page.sh in the vault; ip literals are always allowed)
    allowedHosts: ['localhost', 'local.dev', 'localhost.dev', '.local'],
    // hmr gets its own port: with `proxy` set, vite skips ws upgrades on the main server and the
    // first client attempt fails before falling back (the dedicated port connects directly)
    ...(https
      ? {
          https,
          port: 443,
          host: true,
          strictPort: false,
          proxy: { '^/__http1_downgrade__$': { target: 'http://127.0.0.1:9' } },
          hmr: { server: hmrServer, clientPort: hmrPort },
        }
      : {}),
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
        restrictALPN(server.httpServer)
        server.middlewares.use(h1CompatMiddleware)
      },
      configurePreviewServer: server => {
        restrictALPN(server.httpServer)
        server.middlewares.use(h1CompatMiddleware)
      },
    },
  ],
  }
})
