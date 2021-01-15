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

sapper.start({
  target: document.querySelector("#sapper"),
});
