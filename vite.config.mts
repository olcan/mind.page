import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'
import { middleware } from './src/server/app.mjs'
import fs from 'fs'

// dev certs as in the sapper-era dev server (see ssl-dev/ and bin/build_mind_page.sh in the vault);
// https on 443 when present, so the usual https://localhost dev flow keeps working
const https = fs.existsSync('ssl-dev/ca.key')
  ? { key: fs.readFileSync('ssl-dev/ca.key'), cert: fs.readFileSync('ssl-dev/ca.crt') }
  : undefined

export default defineConfig(({ command }) => ({
  // host true binds the wildcard address: macos only allows unprivileged low ports there, and the
  // lan address is part of the usual dev flow (device testing via the ssl-dev cert sans)
  // the empty proxy config downgrades the dev server to http/1.1: vite serves https with http/2 by
  // default, which its connect stack and the express middleware below cannot handle
  server: https ? { https, port: 443, host: true, strictPort: false, proxy: {} } : {},
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
}))
