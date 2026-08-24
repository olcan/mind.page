// express middleware stack shared by the dev server (vite plugin, see vite.config.ts), the
// production server (server.mjs) and the ssr cloud function; extracted from the sapper-era
// src/server.ts, which mounted sapper.middleware at the end (kit's handler is now mounted by the
// caller instead, and the page's session fields moved to src/routes/[[scope=pwa]]/+page.server.js)
import sirv from 'sirv'
import express from 'express'
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import fs from 'fs'
import crypto from 'crypto'
import mime from 'mime'
import { canonicalizeHost, getHostDir } from '../host.js'

const { NODE_ENV } = process.env
const dev = NODE_ENV === 'development' // NOTE: production for 'firebase serve'
const server_id = crypto.randomBytes(8).toString('hex')

const chokidar = dev ? (await import('chokidar')).default : null
const events = {} // recorded fs events for /watch/... requests

// initialize firebase admin client
// NOTE: Firebase ADMIN API is NOT to be confused with Firebase API
// see https://firebase.google.com/docs/reference/admin vs https://firebase.google.com/docs/reference
import { firebaseConfig } from '../../firebase-config.js'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
initializeApp(firebaseConfig)

// we allow numeric path prefixes /\d/ to allow multiple same-domain web apps on same device
// see https://stackoverflow.com/questions/51280821/multiple-pwas-in-the-same-domain
// optionally, digit can be followed by a letter (f, s, m, b) to indicate display mode
// fullscreen (f) hides status bar (though also inhibits app switching gestures)
// minimal-ui (m) always shows a thick chrome toolbar that is unnecessary w/ pull-to-reload gesture
// standalone (s) should hide chrome toolbar but may show if app navigates outside scope
// browser (b) runs in a regular browser tab or window
// see https://developer.mozilla.org/en-US/docs/Web/Manifest/display

const paths = []
for (let i = 0; i < 10; i++) {
  paths.push(`/${i}f/`) // fullscreen
  paths.push(`/${i}s/`) // standalone (default)
  paths.push(`/${i}m/`) // minimal-ui
  paths.push(`/${i}b/`) // browser
  paths.push(`/${i}/`) // default (standalone)
}
// display-only prefixes
paths.push('/f/')
paths.push('/s/')
paths.push('/m/')
paths.push('/b/')
// default global-scope standalone-display prefix
paths.push('/')

const scoped = express.Router()
scoped.use(

  // set up generic http proxy, see https://github.com/chimurai/http-proxy-middleware
  // backend protocol://host:port is extracted from first path segment, as in /proxy/<backend>/<path>
  // redirects are followed instead of exposed to server for robust CORS bypass
  // note // in https?:// can be rewritted to / by browser or intemediaries
  // websockets can also be proxied
    createProxyMiddleware({
    changeOrigin: true,
    pathFilter: path => /^\/proxy\/(?:http|ws)s?:\/\/?.+$/.test(path),
    pathRewrite: (path, _req) => {
      path = path.replace(/^\/proxy\/(?:http|ws)s?:\/\/?[^/?#]+/, '')
      if (!path.startsWith('/')) path = '/' + path
      // console.debug('proxy path', path)
      return path
    },
    router: req => {
      const backend = req.url
        .match(/^\/proxy\/((?:http|ws)s?:\/\/?[^/?#]+)/)
        .pop()
        .replace(/((?:http|ws)s?:\/)([^/])/, '$1/$2') // in case double-forward-slash was dropped
      // console.debug('proxying to', backend)
      return backend
    },
    on: {
      proxyReq: (proxyReq, req) => {
        // note this fixes missing body issue in some cases (e.g. to tiny0.duckdns.org) but not in all cases (e.g. claude) and in fact can conceal the missing body error (e.g. for claude, which returns simply 400 with html that says only "cloudflare"); we have confirmed the body is "fixed" in both cases and there is no need to call proxyReq.end (as some do) so the problem must be about something else (vs "concealed" missing body), likely a security/cors issue with intentionally obscured responses
        // see https://github.com/chimurai/http-proxy-middleware?tab=readme-ov-file#intercept-and-manipulate-requests
        // also https://github.com/chimurai/http-proxy-middleware/issues/40
        // also https://github.com/chimurai/http-proxy-middleware/blob/45fce2ccb80b8617773b92a8dc563767fb7e2a61/src/handlers/fix-request-body.ts#L9
        fixRequestBody(proxyReq, req) // see http-proxy-middleware > dist > handlers > fix-request-body.js
        // console.debug(proxyReq.headers)
      },
      // proxyRes: (proxyRes, req, res) => {
      //   console.debug(proxyRes.headers)
      // },
      // error: (error, req, res, target) => console.error(error),
    },
    followRedirects: true, // follow redirects (instead of exposing to browser w/ potential CORS issues)
    ws: true, // proxy websockets also
    // logger: console,
  }),

  compression({ threshold: 0 }),
  sirv('static', {
    dev,
    // maxAge: 365 * 24 * 3600, // cache for up to 1y (disabled in dev mode)
    dotfiles: true, // allow requests for .DS_Store to avoid 404 preventing "app" treatment on Android
  }),

  // serve dynamic manifest, favicon.ico, apple-touch-icon (in case browser does not load main page or link tags)
  // NOTE: /favicon.ico requests are NOT being sent to 'ssr' function by firebase hosting meaning it can ONLY be served statically OR redirected, so we redirect to /icon.png for now (see config in firebase.json).
  (req, res, next) => {
    // console.debug('handling path', req.path)
    const hostport = (req.headers['x-forwarded-host'] || req.headers['host'])
    const hostname_orig = hostport.replace(/:\d+$/, '')
    // note globalThis.hostname is used in index.svelte on server side
    const hostname = (globalThis.hostname = canonicalizeHost(hostport))
    const hostdir = getHostDir(hostname)
    // serve /manifest.json from any path (to allow scoping in manifest)
    if (req.path.endsWith('/manifest.json')) {
      const scope = req.originalUrl.replace(/manifest\.json[?]?.*$/, '')
      res.json({
        scope: scope,
        // NOTE: start_url is not allowed to be outside scope, and if there is redirect it can force address bar for app
        start_url: scope,
        name: hostname_orig + scope.slice(0, -1),
        short_name: hostname_orig + scope.slice(0, -1),
        display: scope.includes('f')
          ? 'fullscreen'
          : scope.includes('s')
          ? 'standalone'
          : scope.includes('m')
          ? 'minimal-ui'
          : scope.includes('b')
          ? 'browser'
          : 'standalone',
        background_color: '#111',
        theme_color: '#111',
        icons: [
          {
            src: hostdir + '/apple-touch-icon.png',
            sizes: '180x180',
            type: 'image/png',
          },
          {
            src: hostdir + '/android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: hostdir + '/android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      })
    } else if (req.path == '/apple-touch-icon.png') {
      res.sendFile(process.env['PWD'] + '/static/' + hostdir + req.path)
    } else if (req.path == '/favicon.ico') {
      res.sendFile(process.env['PWD'] + '/static/' + hostdir + req.path)
    } else if (req.path == '/icon.png') {
      res.sendFile(process.env['PWD'] + '/static/' + hostdir + '/favicon.ico')
    } else if (req.path == '/.well-known/appspecific/com.chrome.devtools.json') {
      res.status(204).end() // chrome devtools probes this on every load; a 404 is noise in dev logs
    } else if (req.path == '/server_id') {
      res.status(200).contentType('text/plain').send(server_id)
    } else if (hostname == 'localhost' && req.path.startsWith('/file/')) {
      res.sendFile(process.env['PWD'].replace('/mind.page', req.path.slice(5)))
    } else if (hostname == 'localhost' && req.path.startsWith('/file_abs/')) {
      const abspath = req.path.slice(9)
      // res.sendFile(abspath)
      fs.readFile(abspath, 'utf8', (err, data) => {
        if (err) {
          console.error(err)
          res.status(400).send('could not find ' + abspath + ';' + err)
        } else {
          res.type(mime.getType(abspath))
          res.send(data)
        }
      })
    } else if (hostname == 'localhost' && req.path.startsWith('/watch/') && chokidar) {
      const [, client_id, req_path] = req.path.match(/^\/watch\/(\d+?)(\/.+)$/) ?? []
      if (!client_id || !req_path) {
        console.warn('invalid watch path ' + req.path)
        res.status(400).send('invalid watch path ' + req.path)
        return
      }
      const watch_path = process.env['PWD'].replace('/mind.page', req_path)
      const key = client_id + ':' + watch_path
      if (!events[key]) {
        events[key] = []
        chokidar.watch(watch_path, { ignoreInitial: true, ignored: /(^|[\/\\])\../ }).on('all', (event, path) => {
          if (path.length > watch_path.length) path = path.replace(watch_path, '')
          events[key].push({ event, path })
        })
        console.log(`server watching ${req_path} for client ${client_id}`)
      }
      res.json(events[key])
      events[key] = []
    } else if (hostname == 'localhost' && req.path == '/preview') {
      const html = `<!doctype html><html lang=en><head><meta charset=utf-8><title>preview</title><script>document.open('text/html');document.write(localStorage.getItem('mindpage_preview_html') ?? 'missing html');document.close()</script></head></html>`
      res.status(200).contentType('text/html').send(html)
    } else if (req.path.startsWith('/user/')) {
      const uid = req.path.match(/^\/user\/(\w+?)$/)?.pop()
      if (!uid) return res.status(400).send('invalid user path ' + req.path)
      getFirestore()
        .collection('users')
        .doc(uid)
        .get()
        .then(doc => {
          const data = doc.data() ?? {} // missing user doc
          const name = data.mindpageDisplayName || data.displayName || '' // empty if no display name
          res.status(200).contentType('text/plain').send(name)
        })
        .catch(e => {
          // NOTE: on dev server, admin credentials require `gcloud auth application-default login`
          console.error(`could not retrieve user path ${req.path}:`, e)
          return res.status(400).send('could not retrieve user path ' + req.path)
        })
    } else {
      next()
    }
  },

  // parse cookies
  cookieParser(),
  (req, res, next) => {
    res.cookie = req.cookies['__session'] || ''
    // enable cross-origin isolated state, see https://web.dev/coop-coep/
    // enables advanced features (e.g. SharedArrayBuffer), self.crossOriginIsolated === true
    // res.set('Cross-Origin-Embedder-Policy', 'require-corp')
    // res.set('Cross-Origin-Opener-Policy', 'same-origin')
    next()
  },

  // parse json in request body (if any)
  express.json(),

  // handle POST for webhooks
  (req, res, next) => {
    if (req.path == '/webhooks') {
      console.log(`received /webhooks for user '${req.query.user}'`, req.body)
      if (req.query.crc_token && req.query.crc_key) {
        // handle twitter webhook challenge
        // see https://developer.twitter.com/en/docs/twitter-api/enterprise/account-activity-api/guides/securing-webhooks
        res.json({
          response_token:
            'sha256=' +
            crypto
              .createHmac('sha256', req.query.crc_key)
              .update(req.query.crc_token)
              .digest('base64'),
        })
        return
      }
      if (!req.query.user) {
        res.status(400).send('webhook missing user parameter')
        return
      }
      getFirestore()
        .collection('webhooks')
        .add({
          time: Date.now(), // to allow time range queries and cutoff (e.g. time>now)
          user: req.query.user,
          source: req.query.source ?? null,
          body: req.body,
        })
      res.status(200).end()
    } else {
      next()
    }
  },

  // handle POST for github_webhooks
  (req, res, next) => {
    if (req.path == '/github_webhooks') {
      console.log('received /github_webhooks', req.body)
      getFirestore().collection('github_webhooks').add({
        time: Date.now(), // to allow time range queries and cutoff (e.g. time>now)
        body: req.body,
      })
      res.status(200).end()
    } else {
      next()
    }
  }
)

// the stack is mounted at the root and again at the pwa scope prefixes, which strip the prefix so
// that e.g. /2f/apple-touch-icon.png resolves within the scope (express 5 no longer accepts '/'
// inside a path array, hence the separate root mount)
const app = express()
app.use(scoped)
app.use(paths.filter(path => path != '/'), scoped)

app.set('trust proxy', true) // trust first proxy for ip, see https://stackoverflow.com/a/14631683

 // for use as handler in functions.ts
export { app as middleware, server_id }
