import * as sapper from '@sapper/app'

// import/expose lodash as window._
import _ from 'lodash' // ~72K
window['_'] = _

// import/expose firebase on window
import { firebaseConfig } from '../firebase-config.js' // ~0
import { initializeApp, onLog } from 'firebase/app' // ~10K
const firebase = initializeApp(firebaseConfig)
firebase['onLog'] = onLog // for use in index.svelte
window['firebase'] = firebase

// import/expose firebase/auth on window
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
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
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
} from 'firebase/firestore' // ~262K
Object.assign((firebase['firestore'] = {}), {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
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
import markedExtendedTables from 'marked-extended-tables' // ~3K
window['Marked'] = Marked // for local instance, see https://marked.js.org/using_advanced#instance
window['markedHighlight'] = markedHighlight
window['markedExtendedTables'] = markedExtendedTables
marked.use(markedExtendedTables())
window['marked'] = marked // global instance w/ extended tables enabled

// import/expose jupyter services under window.jupyter
import { KernelManager, SessionManager, ServerConnection } from '@jupyterlab/services' // ~250K
window['jupyter'] = { KernelManager, SessionManager, ServerConnection }

// import/expose UAParser
import { UAParser } from 'ua-parser-js' // ~16K
window['UAParser'] = UAParser

// comment this out to see "unhydrated app" (https://stackoverflow.com/a/58645471)
window['_client_start_time'] = Math.round(performance.now())
sapper.start({ target: document.querySelector('#sapper') })
