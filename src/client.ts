import * as sapper from '@sapper/app'

// import Octokit and expose as window.Octokit
// importing in index.ts gave deep import errors so we load here
// +50K to client.js (instead of index.js)
import { Octokit } from '../node_modules/@octokit/rest'
window['Octokit'] = Octokit

// comment this out to see "unhydrated app" (https://stackoverflow.com/a/58645471)
window['_client_start_time'] = Math.round(performance.now())
sapper.start({
  target: document.querySelector('#sapper'),
})

// disable service workers
// if (navigator.serviceWorker) {
//   navigator.serviceWorker.getRegistrations().then(function (registrations) {
//     for (let registration of registrations) {
//       registration.unregister();
//     }
//   });
// }
