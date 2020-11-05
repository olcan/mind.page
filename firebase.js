export const firebaseConfig = {
    apiKey: "AIzaSyArfytkqMVwd_5TdIaKSun0iSxzjEbaRkU",
    authDomain: "olcanswiki.firebaseapp.com",
    databaseURL: "https://olcanswiki.firebaseio.com",
    projectId: "olcanswiki",
    storageBucket: "olcanswiki.appspot.com",
    messagingSenderId: "149723699565",
    appId: "1:149723699565:web:3027486fcea9b9b74ce264",
    measurementId: "G-L48G2D72Q9"
}

export function firebase() {
    let lib = typeof window !== 'undefined' ? window.firebase: require("firebase");
    return lib.apps.length > 0 ? lib.apps[0] : lib.initializeApp(firebaseConfig)
}

export function firestore() { return firebase().firestore() }