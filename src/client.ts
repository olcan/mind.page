import * as sapper from '@sapper/app'

// import/expose Octokit as window.Octokit
import { Octokit } from '../node_modules/@octokit/rest' // ~50K
window['Octokit'] = Octokit

// import/expose marked as window.marked
import { marked } from 'marked' // ~36K
window['marked'] = marked

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
