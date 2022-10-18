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
  setPersistence,
  browserLocalPersistence,
} from 'firebase/auth'
Object.assign((firebase['auth'] = {}), {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
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
import { getStorage, ref, getMetadata, getDownloadURL, deleteObject, uploadBytes, getBytes } from 'firebase/storage'
Object.assign((firebase['storage'] = {}), {
  getStorage,
  ref,
  getMetadata,
  getDownloadURL,
  deleteObject,
  uploadBytes,
  getBytes,
}) // ~35K

// import/expose Octokit as window.Octokit
import { Octokit } from '../node_modules/@octokit/rest' // ~50K
window['Octokit'] = Octokit

// import/expose marked as window.marked
import { marked } from 'marked' // ~36K
window['marked'] = marked

// import/expose jupyter services under window.jupyter
import { KernelManager, SessionManager, ServerConnection } from '@jupyterlab/services' // ~250K
window['jupyter'] = { KernelManager, SessionManager, ServerConnection }

// import/expose UAParser
import { UAParser } from 'ua-parser-js' // ~16K
window['UAParser'] = UAParser

// comment this out to see "unhydrated app" (https://stackoverflow.com/a/58645471)
window['_client_start_time'] = Math.round(performance.now())
sapper.start({ target: document.querySelector('#sapper') })
