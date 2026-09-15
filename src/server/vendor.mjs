// the vendored cdn assets of the e2e gate (vault design mind_task_agents 9.7, the offline app
// gate): the app shell loads MathJax, d3, c3, the hpcc wasm, highlight.js and its languages from
// cdns (src/app.html), item code loads more at runtime (Sortable, jStat), and a worker sandbox
// reaches loopback only, so a LANE SERVER serves those assets itself: the shell it renders names
// them as `/vendor/<host>/<path>` (src/server/vendor_shell.js, applied by src/hooks.server.js
// under VENDOR_DIR), and this route serves them from a CACHE under the real home
// (`~/.cache/mindpage/vendor/<sha256 of the url>`, read-granted to the worker sandbox like the
// emulator jars), pinned by the manifest tests/e2e/vendor_manifest.json (url -> content type).
// the route never fetches: a url outside the manifest or missing from the cache is a 404,
// reported to VENDOR_UNLISTED (reason, url, referer), and the runner fails the run on it; a new
// dependency is recorded deliberately and host-side, `node tests/e2e/vendor.mjs add <url>`
// (tests/e2e/vendor.mjs fetches it online, caches it, pins its type), so no server relays a
// request anywhere. online runs use the cache too: the gate compares one asset set. mounted by
// server.mjs only when VENDOR_DIR is set: never by the cloud function
import { createHash } from 'crypto'
import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/e2e/vendor_manifest.json',
)

export const assetFile = (dir, url) => path.join(dir, createHash('sha256').update(url).digest('hex'))

export const loadManifest = (file = MANIFEST_PATH) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}

// the router: /vendor/<host>/<path>[?query] names https://<host>/<path>[?query]; `manifest` is
// the pinned map (url -> {type}) or the path of one (the tests hand in their own)
export function vendoredAssets({
  dir = process.env.VENDOR_DIR,
  unlisted = process.env.VENDOR_UNLISTED,
  manifest = MANIFEST_PATH,
} = {}) {
  const assets = typeof manifest == 'string' ? loadManifest(manifest) : manifest
  const router = express.Router()
  router.get(/^\/vendor\/([^/]+)\/(.+)$/, (req, res) => {
    const url = `https://${req.params[0]}/${req.params[1]}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`
    const file = assetFile(dir, url)
    const pinned = assets[url]
    // the cache lives under a dot directory (~/.cache), which send refuses by default
    if (pinned && fs.existsSync(file)) return res.type(pinned.type).sendFile(file, { dotfiles: 'allow' })
    if (unlisted)
      fs.appendFileSync(
        unlisted,
        `${pinned ? 'missing from the cache' : 'not in the manifest'}\t${url}\t${req.headers.referer ?? ''}\n`,
      )
    res
      .status(404)
      .type('text/plain')
      .send('not vendored: ' + url)
  })
  return router
}
