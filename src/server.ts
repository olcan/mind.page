import sirv from 'sirv'
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import * as sapper from '@sapper/server'
// NOTE: this is needed because firebase only has node 16; can be removed once firebase has node 17(.5)
//       also note we are restricted to node-fetch 2.6.7 because later version do not support import
//       see https://stackoverflow.com/a/69093538
import fetch from 'node-fetch'
import https from 'https'
import fs from 'fs'
import os from 'os'
import ip from 'ip'
import crypto from 'crypto'

const { PORT, NODE_ENV } = process.env
const dev = NODE_ENV === 'development' // NOTE: production for 'firebase serve'

const chokidar = dev ? require('chokidar') : null
const events = {} // recorded fs events for /watch/... requests

// initialize firebase admin client
// NOTE: Firebase ADMIN API is NOT to be confused with Firebase API
// see https://firebase.google.com/docs/reference/admin vs https://firebase.google.com/docs/reference
import { firebaseConfig } from '../firebase-config.js'
const admin = require('firebase-admin')
const firebase_admin = admin.initializeApp(firebaseConfig)

// helper to determine host name
// also sets globalThis.hostname for easy access from other files (e.g. index.svelte)
// rewrites 127.0.0.1 and local.dev as localhost for convenience in localhost checks
function get_hostname(req) {
  // see https://stackoverflow.com/a/51200572 about x-forwarded-host
  const hostport = (req.headers['x-forwarded-host'] || req.headers['host']).toString()
  return (globalThis.hostname = hostport
    .replace(/:.+$/, '')
    .replace(/^(?:127\.0\.0\.1|local\.dev|192\.168\.86\.10\d)$/, 'localhost'))
}

// helper to determine host directory
function get_hostdir(hostname) {
  return ['mind.page', 'mindbox.io', 'olcan.com'].includes(hostname) ? hostname : 'other'
}

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
    const hostname = get_hostname(req)
    const hostdir = get_hostdir(hostname)
    // serve /manifest.json from any path (to allow scoping in manifest)
    if (req.path.endsWith('/manifest.json')) {
      const scope = req.originalUrl.replace(/manifest\.json[?]?.*$/, '')
      res.json({
        scope: scope,
        // NOTE: start_url is not allowed to be outside scope, and if there is redirect it can force address bar for app
        start_url: scope,
        name: hostname + scope.slice(0, -1),
        short_name: hostname + scope.slice(0, -1),
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
    } else if (hostname == 'localhost' && req.path.startsWith('/file/')) {
      res.sendFile(process.env['PWD'].replace('/mind.page', req.path.slice(5)))
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
          // force reload on re-connect; otherwise server restarts are NOT detected via proxy
          data = data.replace(
            `console.log(\`[SAPPER] dev client connected\`);`,
            `if (window._dev_client_connected) { location.reload() } else { console.log(\`[SAPPER] dev client connected\`) }; window._dev_client_connected = true`
          )
          res.send(data)
        }
      })
    } else if (hostname == 'localhost' && req.path == '/preview') {
      const html = `<!doctype html><html lang=en><head><meta charset=utf-8><title>preview</title><script>document.open('text/html');document.write(localStorage.getItem('mindpage_preview_html') ?? 'missing html');document.close()</script></head></html>`
      res.status(200).contentType('text/html').send(html)
    } else {
      next()
    }
  },

  // set up generic http proxy, see https://github.com/chimurai/http-proxy-middleware/tree/v2.0.4#readme
  // backend protocol://host:port is extracted from first path segment, as in /proxy/<backend>/<path>
  // redirects are followed instead of exposed to server for robust CORS bypass
  // note // in https?:// can be rewritted to / by browser or intemediaries
  // websockets can also be proxied
  createProxyMiddleware(path => /^\/proxy\/https?:\/\/?.+$/.test(path), {
    changeOrigin: true,
    pathRewrite: (path, req) => {
      path = path.replace(/^\/proxy\/https?:\/\/?[^/?#]+/, '')
      if (!path.startsWith('/')) path = '/' + path
      // console.debug('proxy path', path)
      return path
    },
    router: req => {
      const backend = req.url
        .match(/^\/proxy\/(https?:\/\/?[^/?#]+)/)
        .pop()
        .replace(/(https?:\/)([^/])/, '$1/$2') // in case double-forward-slash was dropped
      // console.debug('proxying to', backend)
      return backend
    },
    followRedirects: true, // follow redirects (instead of exposing to browser w/ potential CORS issues)
    ws: true, // proxy websockets also
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
    console.log('HTTP server listening on http://localhost:' + PORT)
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
      console.log('HTTPS server listening on https://localhost:443')
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
  // note we have never seen preload being invoked on client side, so we add this check to detect if that happens
  if (typeof window !== 'undefined') throw new Error('server-preload invoked on client side')
  // console.debug('preloading', page, session)

  // server session information included in all responses
  // these should match up with exported variables in index.svelte
  const resp = {
    server_name: session.server_name,
    server_ip: session.server_ip,
    client_ip: session.client_ip,
  }
  // return resp // skip preload

  // extract target item ids from show/hide parameters
  // take last entry in array-valued parameters (specified multiple times)
  const show_ids = page.query.show?.pop?.() ?? page.query.show
  const hide_ids = page.query.hide?.pop?.() ?? page.query.hide
  const ids = show_ids?.split(',')?.concat(hide_ids?.split(',') ?? [])

  let user = null
  if (session.cookie == 'signin_pending') {
    return resp // signin pending, do not waste time retrieving items
  } else if (!session.cookie || page.query.user == 'anonymous') {
    user = { uid: 'anonymous' }
  } else {
    if (!ids) return resp // skip non-anonymous full preload since firebase realtime can be much faster

    user = await firebase_admin.auth().verifyIdToken(session.cookie).catch(console.error)
    if (!user) return { ...resp, server_warning: 'invalid/expired signin' }
    // console.debug('user', user)
  }

  const start = Date.now()
  let items // items preloaded from firebase

  if (ids) {
    if (ids.every(id => id.length == 20)) {
      // using 20-byte firebase docids that require auth (unless item.user == 'anonymous')
      // NOTE: admin has access to all docs, so we have to perform auth check here
      console.debug(`retrieving ${ids.length} items for user ${user.email} (${user.uid}) ...`)
      const docs = await Promise.all(ids.map(id => firebase_admin.firestore().collection('items').doc(id).get()))
      const missing_ids = docs.filter(doc => !doc.exists).map(doc => doc.id)
      if (missing_ids.length) return { ...resp, server_error: 'missing item(s) ' + missing_ids }
      items = docs.map(doc => Object.assign(doc.data(), { id: doc.id }))
      const unauth_ids = items.filter(item => item.user != 'anonymous' && item.user != user.uid).map(item => item.id)
      if (unauth_ids.length) return { ...resp, server_error: 'unauthorized item(s) ' + unauth_ids }
    } else if (ids.every(id => id.startsWith('https://'))) {
      // using download urls, typically firebase storage download urls w/ security token, e.g. https://firebasestorage.googleapis.com/v0/b/olcanswiki.appspot.com/o/y2swh7JY2ScO5soV7mJMHVltAOX2%2Fuploads%2Fpublic%2F7cbf6e293452978a?alt=media&token=a1501c15-cd27-45ef-b72f-c1c5cecba41f
      // NOTE: download urls are always public (once shared), though can be revoked via console or deletion/re-upload (see #util/cloud)
      console.debug(`retrieving ${ids.length} items by downloading from urls ${ids} ...`)
      try {
        items = await Promise.all(
          ids.map(url => fetch(url).then(r => (r.ok ? r.json() : { url, error: `${r.status} ${r.statusText}` })))
        )
        const errors = items.filter(item => item.error).map(item => `${item.url} (${item.error})`)
        if (errors.length) return { ...resp, server_error: 'could not download item(s) ' + errors }
        items.forEach(item => (item.user = user.uid)) // just assign to authenticated user (if any)
        // console.debug(items)
      } catch (e) {
        return { ...resp, server_error: 'could not download item(s) ' + ids + '; ' + e }
      }
    } else if (ids.every(id => id.includes('/') && !id.startsWith('https://'))) {
      // using firebase storage paths, e.g. y2swh7JY2ScO5soV7mJMHVltAOX2/uploads/public/7cbf6e293452978a
      // only paths .../uploads/public/... or <user>/uploads/... are allowed for now
      // NOTE: admin has access to all files, so we have to perform auth check here
      // file metadata can be used for sharing w/ specific users in the future
      // see https://firebase.google.com/docs/storage/web/file-metadata#web-version-9_1
      console.debug(`retrieving ${ids.length} items by downloading from paths ${ids} ...`)
      const unauth_ids = ids.filter(
        path => !path.includes('/uploads/public/') && !path.startsWith(user.uid + '/uploads/')
      )
      if (unauth_ids.length) return { ...resp, server_error: 'unauthorized item(s) ' + unauth_ids }
      try {
        // see https://firebase.google.com/docs/storage/admin/start
        // see https://googleapis.dev/nodejs/storage/latest/index.html
        // see https://nodejs.org/api/stream.html#readabletoarrayoptions
        // see read_to_buffer above as an alternative to toArray (added in node 16.5)

        const data = await Promise.all(
          ids.map(path => firebase_admin.storage().bucket().file(path).createReadStream().toArray().then(Buffer.concat))
          // ids.map(path => read_to_buffer(firebase_admin.storage().bucket().file(path).createReadStream()))
        )
        const decoder = new TextDecoder('utf-8')
        items = data.map(bytes => JSON.parse(decoder.decode(bytes)))
        items.forEach(item => (item.user = user.uid)) // just assign to authenticated user (if any)
        // console.debug(items)
      } catch (e) {
        return { ...resp, server_error: 'could not download item(s) ' + ids + '; ' + e }
      }
    } else {
      return { ...resp, server_error: 'invalid items ' + ids }
    }
  } else {
    console.debug(`retrieving all items for user ${user.email} (${user.uid}) ...`)
    const resp = await firebase_admin
      .firestore()
      .collection('items') // server always reads from primary collection
      .where('user', '==', user.uid) // important since otherwise firebaseAdmin has full access
      .orderBy('time', 'desc')
      .get()
    items = resp.docs.map(doc => Object.assign(doc.data(), { id: doc.id }))
  }
  const bytes = JSON.stringify(items).length
  console.debug(
    `retrieved ${items.length} items (${bytes} bytes) for user ` +
      `${user.email} (${user.uid}) in ${Date.now() - start}ms`
  )

  resp['items_preload'] = items // _preload suffix avoids replacing client-side items[] on back/forward
  return resp
}

export { sapper_server } // for use as handler in functions.ts
