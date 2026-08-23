import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'
import { middleware } from './src/server/app.mjs'

export default defineConfig({
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
})
