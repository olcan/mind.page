import * as sapper from "@sapper/app";

// // import firebase
// // see https://www.npmjs.com/package/firebase
// import firebase from "firebase/app";
// import "firebase/auth";
// import "firebase/firestore";
// window.firebase = firebase;

// // import lodash
// import _ from "lodash";
// window._ = _;

// comment this out to see "unhydrated app" (https://stackoverflow.com/a/58645471)
window["_client_start_time"] = Math.round(performance.now());
sapper.start({
  target: document.querySelector("#sapper"),
});

// disable service workers
if (navigator.serviceWorker) {
  navigator.serviceWorker.getRegistrations().then(function (registrations) {
    for (let registration of registrations) {
      registration.unregister();
    }
  });
}
