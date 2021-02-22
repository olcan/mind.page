export const firebaseConfig = {
  // firebase api key is NOT a secret, see https://stackoverflow.com/a/37484053 and https://firebase.google.com/docs/projects/api-keys#api-keys-for-firebase-are-different
  apiKey: "AIzaSyArfytkqMVwd_5TdIaKSun0iSxzjEbaRkU",
  authDomain: "mind.page",
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
