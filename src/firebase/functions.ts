import * as functions from 'firebase-functions'

// use sapper_server exported from server.ts
import { sapper_server } from '../../__sapper__/build/server/server.js'
exports.ssr = functions.https.onRequest((request, response) => {
  request.baseUrl = '' // fixes 404s with 'firebase serve'
  sapper_server(request, response)
})

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//     functions.logger.info("Hello logs!", {structuredData: true});
//     response.send("Hello from Firebase!");
// });
