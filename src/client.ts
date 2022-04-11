import * as sapper from '@sapper/app'

// import/expose lodash as window._
import _ from 'lodash'
window['_'] = _

// import firebase from 'firebase/compat/app'
// import 'firebase/compat/auth'
// import 'firebase/compat/storage'
// import 'firebase/compat/firestore'
// window['fire' + 'base'] = firebase

// import/expose Octokit as window.Octokit
import { Octokit } from '../node_modules/@octokit/rest' // ~50K
window['Octokit'] = Octokit

// import/expose marked as window.marked
import { marked } from 'marked' // ~36K
window['marked'] = marked

// comment this out to see "unhydrated app" (https://stackoverflow.com/a/58645471)
window['_client_start_time'] = Math.round(performance.now())
sapper.start({ target: document.querySelector('#sapper') })
