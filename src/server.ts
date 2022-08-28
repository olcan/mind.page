import sirv from 'sirv'
import express from 'express'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import * as sapper from '@sapper/server'
import https from 'https'
import { WebSocketServer } from 'ws'
import fs from 'fs'

const { PORT, NODE_ENV } = process.env
const dev = NODE_ENV === 'development' // NOTE: production for 'firebase serve'

const chokidar = dev ? require('chokidar') : null
const events = {} // recorded fs events for /watch/... requests
const jupyter_ws = {} // jupyter websocket connections for live output

// initialize firebase admin client
// NOTE: we are using v8 client on server because we could not get v9 client to work properly ...
//       using getFirestore from firebase-admin/firestore causes an 'invalid argument' error for collection
//       using getFirestore from firebase/firestore causes an undefined object error during a getProvider call
//       trying to import collection from firebase-admin fails (no such export)
//       some errors (e.g. invalid argument) are logged at debug level (search for text "FirebaseError")
import { firebaseConfig } from '../firebase-config.js'
//const { initializeApp } = require('firebase-admin/app')
//const { getFirestore } = require('firebase-admin/firestore')
//const { addDoc, collection, query, where, orderBy, getDocs } = require('firebase/firestore')
//const { getAuth } = require('firebase/auth')
//const firebase = initializeApp(firebaseConfig)
const admin = require('firebase-admin')
const firebase = admin.initializeApp(firebaseConfig)

// helper to determine host name
// also sets globalThis.hostname for easy access from other files (e.g. index.svelte)
// rewrites 127.0.0.1 as localhost for convenience in localhost checks
function get_hostname(req) {
  // see https://stackoverflow.com/a/51200572 about x-forwarded-host
  const hostport = (req.headers['x-forwarded-host'] || req.headers['host']).toString()
  return (globalThis.hostname = hostport.replace(/:.+$/, '').replace('127.0.0.1', 'localhost'))
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
  sirv('static', { dev, dotfiles: true /* in case .DS_Store is created */ }),
  // serve dynamic manifest, favicon.ico, apple-touch-icon (in case browser does not load main page or link tags)
  // NOTE: /favicon.ico requests are NOT being sent to 'ssr' function by firebase hosting meaning it can ONLY be served statically OR redirected, so we redirect to /icon.png for now (see config in firebase.json).
  (req, res, next) => {
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
    } else {
      next()
    }
  },
  cookieParser(),
  (req, res, next) => {
    res.cookie = req.cookies['__session'] || ''
    // enable cross-origin isolated state, see https://web.dev/coop-coep/
    // enables advanced features (e.g. SharedArrayBuffer), self.crossOriginIsolated === true
    // res.set('Cross-Origin-Embedder-Policy', 'require-corp')
    // res.set('Cross-Origin-Opener-Policy', 'same-origin')
    next()
  },
  // handle POST for webhooks
  express.json(),
  (req, res, next) => {
    if (req.path == '/github_webhooks') {
      console.log('received /github_webhooks', req.body)
      firebase.firestore().collection('github_webhooks').add({
        // addDoc(collection(getFirestore(firebase), 'github_webhooks'), {
        time: Date.now(), // to allow time range queries and cutoff (e.g. time>now)
        body: req.body,
      })
      res.status(200).end()
    } else {
      next()
    }
  },
  // handle POST for jupyter
  (req, res, next) => {
    const hostname = get_hostname(req)
    if (hostname == 'localhost' && req.path.startsWith('/jupyter/')) {
      console.log('received ', req.path, req.body)
      let [client_id, session_path] = req.path.match(/^\/jupyter\/(\d+?)\/(.+)$/)?.slice(1) ?? []
      if (!client_id || !session_path) {
        console.warn('invalid jupyter path ' + req.path)
        res.status(400).send('invalid jupyter path ' + req.path)
        return
      }
      session_path = client_id + '/' + session_path // prefix client_id to session_path
      const { KernelManager, SessionManager, ServerConnection } = require('@jupyterlab/services')
      const serverSettings = ServerConnection.makeSettings({
        baseUrl: 'http://localhost:8888', // required
        wsUrl: 'ws://localhost:8888', // required
      })
      const kernelManager = new KernelManager({ serverSettings })
      const sessionManager = new SessionManager({ kernelManager, serverSettings })
      ;(async () => {
        let sessionConnection
        await sessionManager.requestRunning()
        const sessionModel = (await sessionManager.findByPath(session_path)) as any
        if (sessionModel) {
          console.log(`Connecting to existing session ${sessionModel.path} on kernel ${sessionModel.kernel.id}`)
          sessionConnection = await sessionManager.connectTo({ model: sessionModel })
        } else {
          console.log(`Starting new session ${session_path} ...`)
          sessionConnection = await sessionManager.startNew({
            path: session_path,
            type: 'notebook',
            name: session_path,
          })
        }
        // send exec spec to kernel and forward response
        const { shutdown, ...spec } = req.body
        if (Object.keys(spec).length) {
          const future = sessionConnection.kernel!.requestExecute(spec)
          let output = [] // stdout/stderr
          future.onIOPub = msg => {
            if (msg.msg_type == 'stream') {
              let { name, text } = msg.content
              if (text.length > 240) text = text.slice(0, 240) + `…+${text.length - 240} chars`
              if (name == 'stdout') console.log(text)
              else if (name == 'stderr') console.error(text)
              else console.warn(`message on unknown stream ${name}: ${text}`)
              output.push(msg.content)
              // if websocket connection exists, we send output live instead of buffering
              if (jupyter_ws[session_path]) {
                jupyter_ws[session_path].send(JSON.stringify(output))
                output = [] // reset buffer
              }
            }
          }
          const reply = await future.done
          const result = {
            ...reply.content,
            session: sessionModel,
            output,
          }
          res.status(200).json(result).end()
        } else {
          res.status(400).send('missing exec spec in body')
        }
        // shut down session/kernel if requested
        if (shutdown) {
          await sessionConnection.shutdown()
          console.log(`Shut down session ${session_path}`)
        }
      })()
    } else {
      next()
    }
  },
  sapper.middleware({
    session: (req, res) => ({
      cookie: res['cookie'],
    }),
  })
)

// listen if firebase is not handling the server ...
if (!('FIREBASE_CONFIG' in process.env)) {
  // listen on standard HTTP port
  sapper_server.listen(PORT)

  // also listen on HTTPS port
  const sapper_https_server = https
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

  // also set up a secure WebSocket (WSS) server
  const wss = new WebSocketServer({ server: sapper_https_server })
  wss.on('connection', function connection(ws, req) {
    // handle jupyter wss connections for output messages
    // hostname/path checks/parsing are identical to HTTP handler above
    const hostname = get_hostname(req)
    req.path = req.url.replace(/^.+?:\/\/[^/]*/, '') // extract path from url (that _may_ contain scheme/host/port)
    if (hostname == 'localhost' && req.path.startsWith('/jupyter/')) {
      let [client_id, session_path] = req.path.match(/^\/jupyter\/(\d+?)\/(.+)$/)?.slice(1) ?? []
      if (!client_id || !session_path) {
        console.warn('ignoring wss connection w/ invalid jupyter path ' + req.path)
        return // ignore connection
      }
      session_path = client_id + '/' + session_path // prefix client_id to session_path
      jupyter_ws[session_path] = ws
      ws.on('close', () => delete jupyter_ws[session_path])
    }
  })
  wss.on('close', function close() {})
}

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
    // user = await getAuth(firebase).verifyIdToken(session.cookie).catch(console.error);
    // if (!user) return { error: "invalid/expired session cookie" };
  }
  let items = await firebase
    .firestore()
    .collection('items') // server always reads from primary collection
    .where('user', '==', user.uid) // important since otherwise firebaseAdmin has full access
    .orderBy('time', 'desc')
    .get()
  // let items = await getDocs(
  //   query(collection(getFirestore(firebase), 'items'), where('user', '==', user.uid), orderBy('time', 'desc'))
  // )

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

export { sapper_server } // for use as handler in functions.ts
