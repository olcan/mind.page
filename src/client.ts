import * as sapper from '@sapper/app'

// import/expose lodash as window._
import _ from 'lodash'
window['_'] = _

// import/expose firebase on window
import { firebaseConfig } from '../firebase-config.js'
import { initializeApp } from 'firebase/app'
const firebase = initializeApp(firebaseConfig)
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
Object.assign(window, {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  setPersistence,
  browserLocalPersistence,
})

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
  onSnapshot,
} from 'firebase/firestore'
Object.assign(window, {
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
  onSnapshot,
})

// import/expose firebase/storage on window
import { getStorage, ref, getDownloadURL, uploadBytes, uploadString } from 'firebase/storage'
Object.assign(window, { getStorage, ref, getDownloadURL, uploadBytes, uploadString })

// import/expose Octokit as window.Octokit
import { Octokit } from '../node_modules/@octokit/rest' // ~50K
window['Octokit'] = Octokit

// import/expose marked as window.marked
import { marked } from 'marked' // ~36K
window['marked'] = marked

// comment this out to see "unhydrated app" (https://stackoverflow.com/a/58645471)
window['_client_start_time'] = Math.round(performance.now())
sapper.start({ target: document.querySelector('#sapper') })
