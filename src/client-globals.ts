// window globals expected by index.svelte and by items (the app's original client.ts minus
// sapper.start, which kit replaces); loaded only in the browser, before the page component
// instantiates, via the dynamic import in src/routes/[[scope=pwa]]/+page.js

// import/expose lodash as window._
import _ from 'lodash' // ~72K
window['_'] = _

// import/expose firebase on window
import { firebaseConfig } from '../firebase-config.js' // ~0
import { isSharedOrigin } from './host.js'
import { initializeApp, onLog } from 'firebase/app' // ~10K
const firebase = initializeApp(firebaseConfig)
firebase['onLog'] = onLog // for use in index.svelte
window['firebase'] = firebase

// cache firestore data in IndexedDB (default is memory only): first snapshot comes from cache on
// reload (then reconciled w/ server as remote changes, see onSnapshot in index.svelte), offline
// writes survive reloads, and listeners resume from last state instead of re-reading every doc;
// multi-tab manager is required since several tabs (e.g. /0/../9/ scopes) can be open at once;
// must be called before getFirestore(firebase) (which then returns this instance); if IndexedDB
// is unavailable (e.g. private mode) the sdk logs a warning and falls back to memory cache
import { initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'
// BOTH isolated shared-page hosts use a MEMORY cache: every owner's page runs on that one origin,
// so anything persisted there is readable by the next owner's code. firestore caches every
// document a client reads, so a shared page's query would populate IndexedDB like any other — the
// app persists nothing else there (see itemStore in index.svelte), and this was the last thing it
// left behind. shared pages are read-only anyway, so the offline benefit is small.
// SHARED_LOCAL_HOST belongs here for the same reason it is absent from LOCAL_REQUEST_HOSTS: it is
// the local counterpart, and every rule naming one has to name the other
initializeFirestore(firebase, {
  localCache: isSharedOrigin(location.hostname)
    ? memoryLocalCache()
    : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})

// connect to local firebase emulators (see firebase.json) when served on the port dedicated to the
// e2e test stack (see tests/e2e), which is its own origin with its own storage, cache and sign-in
// state; must precede any auth/firestore use
import { connectAuthEmulator } from 'firebase/auth'
import { connectFirestoreEmulator } from 'firebase/firestore'
const EMULATOR_PORT = '3100'
// true only for the e2e stack's own origin (see tests/e2e), never in production
// localhost.dev is the LOCAL isolated origin foreign shared pages move to (see SHARED_LOCAL_HOST):
// a separate origin for storage and sign-in, but the same e2e backend, so it connects too
const USING_EMULATORS =
  ['localhost', '127.0.0.1', 'shared.localhost'].includes(location.hostname) && location.port == EMULATOR_PORT
if (USING_EMULATORS) {
  connectAuthEmulator(getAuth(firebase), 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(getFirestore(firebase), '127.0.0.1', 8080)
  console.warn(`using local firebase emulators (served on port ${EMULATOR_PORT})`)
}

// import/expose firebase/auth on window
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signInWithCustomToken,
  getRedirectResult,
  setPersistence,
  browserLocalPersistence,
} from 'firebase/auth'
Object.assign((firebase['auth'] = {}), {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  // signInWithCustomToken bypasses the authorized-domains check that gates the OAuth flows, so
  // it is exposed ONLY on the emulator origin the e2e stack runs on: it has no production use,
  // and shipping it left a sign-in path that domain authorization does not cover
  ...(USING_EMULATORS ? { signInWithCustomToken } : {}),
  getRedirectResult,
  setPersistence,
  browserLocalPersistence,
}) // ~115K

// import/expose firebase/firestore on window
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  getDocFromServer,
  getDocsFromServer,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  runTransaction,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  terminate,
  clearIndexedDbPersistence,
} from 'firebase/firestore' // ~262K
Object.assign((firebase['firestore'] = {}), {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  getDocFromServer,
  getDocsFromServer,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  runTransaction, // available to item code; the app itself uses ordinary queued writes
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  terminate,
  clearIndexedDbPersistence,
})

// import/expose firebase/storage on window
import {
  getStorage,
  ref,
  getMetadata,
  getDownloadURL,
  deleteObject,
  uploadBytes,
  getBytes,
  getBlob,
} from 'firebase/storage'
Object.assign((firebase['storage'] = {}), {
  getStorage,
  ref,
  getMetadata,
  getDownloadURL,
  deleteObject,
  uploadBytes,
  getBytes,
  getBlob,
}) // ~35K

// import/expose Octokit as window.Octokit
import { Octokit } from '@octokit/rest' // ~50K
window['Octokit'] = Octokit

// import/expose {mM}arked as window.Marked
// also import/expose extensions marked-highlight and marked-extended-tables
import { marked, Marked } from 'marked' // ~36K
import { markedHighlight } from 'marked-highlight'
// vendored: the package is unmaintained with peer marked <16 (see src/vendor)
import markedExtendedTables from './vendor/marked-extended-tables.js' // ~3K
window['Marked'] = Marked // for local instance, see https://marked.js.org/using_advanced#instance
window['markedHighlight'] = markedHighlight
window['markedExtendedTables'] = markedExtendedTables
marked.use(markedExtendedTables())
window['marked'] = marked // global instance w/ extended tables enabled

// import/expose jupyter services under window.jupyter
import { KernelManager, SessionManager, ServerConnection } from '@jupyterlab/services' // ~250K
window['jupyter'] = { KernelManager, SessionManager, ServerConnection }

// expose UAParser: vendored v1.0.41 (MIT) since v2 relicensed to AGPL; the umd module assigns
// window.UAParser itself when imported for side effects
import './vendor/ua-parser.js' // ~16K

// comment this out to see "unhydrated app" (https://stackoverflow.com/a/58645471)
window['_client_start_time'] = Math.round(performance.now())
