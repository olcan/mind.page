import sirv from 'sirv'
import express from 'express'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import * as sapper from '@sapper/server'
import https from 'https'
import fs from 'fs'

const { PORT, NODE_ENV } = process.env
const dev = NODE_ENV === 'development' // NOTE: production for 'firebase serve'

const chokidar = dev ? require('chokidar') : null
const events = {} // recorded fs events for /watch/... requests

function get_hostdir(req) {
  // see https://stackoverflow.com/a/51200572 about x-forwarded-host
  let hostname = (req.headers['x-forwarded-host'] || req.headers['host']).toString()
  globalThis.hostname = hostname = hostname.replace(/:.+$/, '') // drop port number
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

const sapperServer = express().use(
  paths,
  compression({ threshold: 0 }),
  // TODO: remove 'as any' when typescript error is fixed
  sirv('static', { dev, dotfiles: true /* in case .DS_Store is created */ }) as any,
  // serve dynamic manifest, favicon.ico, apple-touch-icon (in case browser does not load main page or link tags)
  // NOTE: /favicon.ico requests are NOT being sent to 'ssr' function by firebase hosting meaning it can ONLY be served statically OR redirected, so we redirect to /icon.png for now (see config in firebase.json).
  (req, res, next) => {
    const hostdir = get_hostdir(req)
    // serve /manifest.json from any path (to allow scoping in manifest)
    if (req.path.endsWith('/manifest.json')) {
      const scope = req.originalUrl.replace(/manifest\.json[?]?.*$/, '')
      res.json({
        scope: scope,
        // NOTE: start_url is not allowed to be outside scope, and if there is redirect it can force address bar for app
        start_url: scope,
        name: globalThis.hostname + scope.slice(0, -1),
        short_name: globalThis.hostname + scope.slice(0, -1),
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
    } else if (globalThis.hostname == 'localhost' && req.path.startsWith('/file/')) {
      res.sendFile(process.env['PWD'].replace('/mind.page', req.path.slice(5)))
    } else if (globalThis.hostname == 'localhost' && req.path.startsWith('/watch/')) {
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
    } else {
      next()
    }
  },
  cookieParser(),
  (req, res, next) => {
    res.cookie = req.cookies['__session'] || ''
    next()
  },
  // handle POST for webhooks
  express.json(),
  (req, res, next) => {
    if (req.path == '/github_webhooks') {
      console.log('received /github_webhooks', req.body)
      firebaseAdmin().firestore().collection('github_webhooks').add({
        time: Date.now(), // to allow time range queries and cutoff (e.g. time>now)
        body: req.body,
      })
      res.status(200).end()
    } else {
      next()
    }
  },
  // TODO: remove 'as any' when typescript error is fixed
  sapper.middleware({
    session: (req, res) => ({
      cookie: res['cookie'],
    }),
  }) as any
)

// listen if firebase is not handling the server ...
if (!('FIREBASE_CONFIG' in process.env)) {
  sapperServer.listen(PORT).on('error', err => {
    if (err) console.log('error', err)
  })
  // also listen on HTTPS port ...
  const server = https
    .createServer(
      {
        key: fs.readFileSync('static/ssl-dev/ca.key'),
        cert: fs.readFileSync('static/ssl-dev/ca.crt'),
      },
      sapperServer
    )
    .listen(443, () => {
      console.log('HTTPS server listening on https://localhost:443')
    })
    .on('error', err => {
      if (err) console.log('error', err)
    })
}

import { firebaseAdmin } from '../firebase.js'

// server-side preload hidden from client-side code
// NOTE: for development server, admin credentials require `gcloud auth application-default login`
process['server-preload'] = async (page, session) => {
  // console.debug("preloading, client?", typeof window !== undefined, page, session);
  return {} // disable server preload for now, even for anonymous account

  let user = null
  if (session.cookie == 'signin_pending') {
    return {} // signin pending, do not waste time retrieving data
  } else if (!session.cookie || page.query.user == 'anonymous') {
    user = { uid: 'anonymous' }
  } else {
    // NOTE: we no longer preload for non-anonymous accounts because it slows down initial page load for larger accounts, and firebase realtime can be much more efficient due to client-side caching
    return {}
    // user = await firebaseAdmin().auth().verifyIdToken(session.cookie).catch(console.error);
    // if (!user) return { error: "invalid/expired session cookie" };
  }
  let items = await firebaseAdmin()
    .firestore()
    .collection('items') // server always reads from primary collection
    .where('user', '==', user.uid) // important since otherwise firebaseAdmin has full access
    .orderBy('time', 'desc')
    .get()
  // console.debug(`retrieved ${items.docs.length} items for user '${user.uid}'`);
  return {
    // NOTE: we use _preload suffix to avoid replacing items on back/forward
    items_preload: items.docs.map(doc =>
      Object.assign(doc.data(), {
        id: doc.id,
        updateTime: doc.updateTime.seconds,
        createTime: doc.createTime.seconds,
      })
    ),
  }
}

export { sapperServer } // for use as handler in index.js
