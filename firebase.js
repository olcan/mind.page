export const firebaseConfig = {
  apiKey: "AIzaSyArfytkqMVwd_5TdIaKSun0iSxzjEbaRkU",
  // authDomain: "olcanswiki.firebaseapp.com",
  // NOTE: (sub-)domain must be added under OAuth settings on Google Cloud console:
  // https://console.developers.google.com/apis/credentials?folder=&organizationId=&project=olcanswiki
  authDomain: "olcan.com",
  databaseURL: "https://olcanswiki.firebaseio.com",
  projectId: "olcanswiki",
  storageBucket: "olcanswiki.appspot.com",
  messagingSenderId: "149723699565",
  appId: "1:149723699565:web:3027486fcea9b9b74ce264",
  measurementId: "G-L48G2D72Q9",
};

export const isClient = typeof window !== "undefined";

export function firebase() {
  let lib = isClient ? window.firebase : require("firebase");
  return lib.apps.length > 0 ? lib.apps[0] : lib.initializeApp(firebaseConfig);
}

export function firestore() {
  return firebase().firestore();
}

export function firebaseAdmin() {
  let admin = require("firebase-admin");
  if (admin.apps.length == 0) admin.initializeApp(firebaseConfig);
  return admin;
}
