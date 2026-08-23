import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'
import { middleware } from './src/server/app.mjs'
import fs from 'fs'
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
const hmrServer = https ? createServer(https) : undefined

export default defineConfig(({ command }) => {
  if (command == 'serve' && hmrServer) hmrServer.listen(hmrPort)
  return {
  // host true binds the wildcard address: macos only allows unprivileged low ports there, and the
  // lan address is part of the usual dev flow (device testing via the ssl-dev cert sans)
  // the empty proxy config downgrades the dev server to http/1.1: vite serves https with http/2 by
  // default, which its connect stack and the express middleware below cannot handle
  server: {
    // firebase-config.js lives at the repo root, outside kit's default fs allow list
    fs: { allow: ['.'] },
    // the hmr websocket rejects unknown hosts (vite's backported host check); allow the dev-cert
    // hostnames (see ssl-dev/ and build_mind_page.sh in the vault; ip literals are always allowed)
    allowedHosts: ['localhost', 'local.dev', 'localhost.dev', '.local'],
    // hmr gets its own port: with `proxy` set, vite skips ws upgrades on the main server and the
    // first client attempt fails before falling back (the dedicated port connects directly)
    ...(https ? { https, port: 443, host: true, strictPort: false, proxy: {}, hmr: { server: hmrServer, clientPort: hmrPort } } : {}),
  },
  plugins: [
    sveltekit(),
    {
      // the express middleware stack (proxy, webhooks, /user, manifests, icons, dev routes) in
      // front of kit, as in production (see server.mjs)
      name: 'mindpage-server',
      configureServer: server => void server.middlewares.use(middleware),
      configurePreviewServer: server => void server.middlewares.use(middleware),
    },
  ],
  }
})
