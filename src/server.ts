import sirv from 'sirv'
import express from 'express'
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import * as sapper from '@sapper/server'
import https from 'https'
import fs from 'fs'
import os from 'os'
import ip from 'ip'
import crypto from 'crypto'
import mime from 'mime'
import { canonicalizeHost, getHostDir } from './util.js'

const { PORT, NODE_ENV } = process.env
const dev = NODE_ENV === 'development' // NOTE: production for 'firebase serve'
const server_id = crypto.randomBytes(8).toString('hex')

const chokidar = dev ? require('chokidar') : null
const events = {} // recorded fs events for /watch/... requests

// initialize firebase admin client
// NOTE: Firebase ADMIN API is NOT to be confused with Firebase API
// see https://firebase.google.com/docs/reference/admin vs https://firebase.google.com/docs/reference
import { firebaseConfig } from '../firebase-config.js'
const admin = require('firebase-admin')
const firebase_admin = admin.initializeApp(firebaseConfig)

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

const sapper_server = express().use(
  paths,
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
    const hostport = req.headers['x-forwarded-host'] || req.headers['host']
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
      const [m, client_id, req_path] = req.path.match(/^\/watch\/(\d+?)(\/.+)$/) ?? []
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
    } else if (hostname == 'localhost' && req.path.startsWith('/client/sapper-dev-client')) {
      // modify sapper-dev-client.*.js file (see comments below on changes)
      // the file is in __sapper__/dev/client/sapper-dev-client.*.js
      // the dev server is in node_modules/sapper/dist/dev.js
      const abspath = process.env['PWD'] + '/__sapper__/dev' + req.path
      // res.sendFile(abspath)
      fs.readFile(abspath, 'utf8', (err, data) => {
        if (err) {
          console.error(err)
          res.status(400).send('could not find ' + abspath + ';' + err)
        } else {
          res.contentType('text/javascript') // Or some other more appropriate value
          // use /proxy for HTTP to avoid mixed content errors
          // upgrade-insecure-requests header (or meta tag) does NOT work on Safari
          data = data.replace('http:', '/proxy/http:')
          // force reload on server connection with new server_id
          // otherwise server restarts are NOT detected via proxy
          data = data.replace(
            `console.log(\`[SAPPER] dev client connected\`);`,
            `console.log(\`[SAPPER] dev client connected\`);
             fetch('/server_id').then(resp => resp.text()).then(server_id => {
              if (window._dev_server_id && window._dev_server_id != server_id) {
                console.log('[SAPPER] dev server_id changed!', window._dev_server_id, '-->', server_id)
                window.location.reload()
                return
              }
              window._dev_server_id = server_id
              console.log('[SAPPER] dev server_id is', server_id)
            })`
          )
          res.send(data)
        }
      })
    } else if (hostname == 'localhost' && req.path == '/preview') {
      const html = `<!doctype html><html lang=en><head><meta charset=utf-8><title>preview</title><script>document.open('text/html');document.write(localStorage.getItem('mindpage_preview_html') ?? 'missing html');document.close()</script></head></html>`
      res.status(200).contentType('text/html').send(html)
    } else if (req.path.startsWith('/user/')) {
      const uid = req.path.match(/^\/user\/(\w+?)$/)?.pop()
      if (!uid) return res.status(400).send('invalid user path ' + req.path)
      firebase_admin
        .firestore()
        .collection('users')
        .doc(uid)
        .get()
        .then(doc => {
          const name = doc.data().mindpageDisplayName || doc.data().displayName
          res.status(200).contentType('text/plain').send(name)
        })
        .catch(e => {
          return res.status(400).send('could not retrieve user path ' + req.path)
        })
    } else {
      next()
    }
  },

  // set up generic http proxy, see https://github.com/chimurai/http-proxy-middleware
  // backend protocol://host:port is extracted from first path segment, as in /proxy/<backend>/<path>
  // redirects are followed instead of exposed to server for robust CORS bypass
  // note // in https?:// can be rewritted to / by browser or intemediaries
  // websockets can also be proxied
  createProxyMiddleware({
    changeOrigin: true,
    pathFilter: path => /^\/proxy\/(?:http|ws)s?:\/\/?.+$/.test(path),
    pathRewrite: (path, req) => {
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
      proxyReq: fixRequestBody, // see https://github.com/chimurai/http-proxy-middleware?tab=readme-ov-file#intercept-and-manipulate-requests
      // proxyRes: (proxyRes, req, res) => {
      //   console.debug(req.headers, proxyRes.headers)
      // },
      // error: (error, req, res, target) => {
      //   console.error(error)
      // },
    },
    followRedirects: true, // follow redirects (instead of exposing to browser w/ potential CORS issues)
    ws: true, // proxy websockets also
    // logger: console,
  }),

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
            'sha256=' + crypto.createHmac('sha256', req.query.crc_key).update(req.query.crc_token).digest('base64'),
        })
        return
      }
      if (!req.query.user) {
        res.status(400).send('webhook missing user parameter')
        return
      }
      firebase_admin
        .firestore()
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
      firebase_admin.firestore().collection('github_webhooks').add({
        time: Date.now(), // to allow time range queries and cutoff (e.g. time>now)
        body: req.body,
      })
      res.status(200).end()
    } else {
      next()
    }
  },

  // populate session w/ cookie, see https://sapper.svelte.dev/docs#Seeding_session_data
  sapper.middleware({
    session: (req, res) => ({
      cookie: res['cookie'],
      server_name: os.hostname(),
      server_ip: ip.address(), // see https://stackoverflow.com/a/43888492
      // we use client_ip to help identify distinct client devices (_should_ work on firebase w/ the 'trust proxy' setting set below, but otherwise you can try accessing headers directly as in https://stackoverflow.com/a/67397092)
      // aside from public ip & user agent, there is no info in http headers that can help identify client machine
      // browsers do not reveal any more info to servers than they do to local javascript via navigator.*
      // browsers do provide user-level identifiers for authentication, but we are interested in devices
      // see https://code-maze.com/http-series-part-3/#headers for some more info about relevant headers
      client_ip: req['ip'], // see https://stackoverflow.com/a/14631683
    }),
  })
)

sapper_server.set('trust proxy', true) // trust first proxy for ip, see https://stackoverflow.com/a/14631683

const on_firebase = 'FIREBASE_CONFIG' in process.env
let sapper_https_server // started here unless on_firebase

// listen if firebase is not handling the server ...
if (!on_firebase) {
  // listen on standard HTTP port
  sapper_server.listen(PORT, () => {
    console.log(`HTTP server ${server_id} listening on http://localhost:${PORT}`)
  })

  // also listen on HTTPS port
  sapper_https_server = https
    .createServer(
      {
        key: fs.readFileSync('static/ssl-dev/ca.key'),
        cert: fs.readFileSync('static/ssl-dev/ca.crt'),
      },
      sapper_server
    )
    .listen(443, () => {
      console.log(`HTTPS server ${server_id} listening on https://localhost:443`)
    })
}

// helper to read stream into buffer, from https://stackoverflow.com/a/67729663
function read_to_buffer(stream) {
  return new Promise((resolve, reject) => {
    const bufs = []
    stream.on('data', chunk => bufs.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(bufs)))
    stream.on('error', reject)
  })
}

// server-side preload hidden from client code (see index.svelte)
// see https://sapper.svelte.dev/docs#preloading for documentation
// NOTE: for dev server, admin credentials require `gcloud auth application-default login`
process['server-preload'] = async (page, session) => {
  // console.debug('preloading', page, session)

  // sanity check that this function is not invoked on the client side
  if (typeof window !== 'undefined') throw new Error('server-preload invoked on client side')

  // server session information included in all responses
  // these should match up with exported variables in index.svelte
  const resp = {
    server_name: session.server_name,
    server_ip: session.server_ip,
    client_ip: session.client_ip,
  }

  // disable preload for now since firebase realtime is often faster due to client-side caching
  return resp

  let user = null
  if (session.cookie == 'signin_pending') {
    // if signin is pending, we do not want to waste time loading anonymous items, and we also can not risk any auth errors (e.g. when loading fixed items) that would interrupt signin, so we simply return nothing (with an indication that preloading was skipped) and expect client to reload if server-side loading is required (i.e. if client-side fallback is not available)
    return resp
  } else if (!session.cookie || page.query.user == 'anonymous') {
    user = { uid: 'anonymous' }
  } else {
    user = await firebase_admin.auth().verifyIdToken(session.cookie).catch(console.error)
    if (!user) return { ...resp, server_warning: 'invalid/expired signin' }
    // console.debug('user', user)
  }

  const start = Date.now()
  let items // items preloaded from firebase

  console.debug(`retrieving all items for user ${user.email} (${user.uid}) ...`)
  const item_docs = await firebase_admin
    .firestore()
    .collection('items') // server always reads from primary collection
    .where('user', '==', user.uid) // important since otherwise firebaseAdmin has full access
    .orderBy('time', 'desc')
    .get()
  items = item_docs.docs.map(doc => Object.assign(doc.data(), { id: doc.id }))

  const bytes = JSON.stringify(items).length
  console.debug(
    `retrieved ${items.length} items (${bytes} bytes) for user ` +
      `${user.email} (${user.uid}) in ${Date.now() - start}ms`
  )

  resp['items_preload'] = items // _preload suffix avoids replacing client-side items[] on back/forward
  return resp
}

export { sapper_server } // for use as handler in functions.ts
