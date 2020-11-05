import * as functions from 'firebase-functions';

// use sapperServer exported from server.ts
import { sapperServer } from '../../__sapper__/build/server/server.js';
exports.ssr = functions.https.onRequest((request, response) => {
    request.baseUrl = ""; // fixes 404s with 'firebase serve'
    sapperServer(request, response)
});

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//     functions.logger.info("Hello logs!", {structuredData: true});
//     response.send("Hello from Firebase!");
// });
