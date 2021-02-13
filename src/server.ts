import sirv from "sirv";
import express from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import * as sapper from "@sapper/server";

const { PORT, NODE_ENV } = process.env;
const dev = NODE_ENV === "development"; // NOTE: production for 'firebase serve'

const sapperServer = express().use(
  compression({ threshold: 0 }),
  // serve dynamic manifest, favicon.ico, apple-touch-icon (in case browser does not load main page or link tags)
  (req, res, next) => {
    // see https://stackoverflow.com/a/51200572 about x-forwarded-host
    let hostname = (req.headers["x-forwarded-host"] || req.headers["host"]).toString();
    globalThis.hostname = hostname = hostname.replace(/:.+$/, ""); // drop port number
    const hostdir = ["mind.page", "mindbox.io", "olcan.com"].includes(hostname) ? hostname : "other";
    if (req.path == "/manifest.json") {
      res.json({
        background_color: "#111",
        theme_color: "#111",
        name: hostname,
        short_name: hostname,
        display: "minimal-ui",
        start_url: "/",
        icons: [
          {
            src: hostdir + "/apple-touch-icon.png",
            sizes: "180x180",
            type: "image/png",
          },
          {
            src: hostdir + "/android-chrome-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: hostdir + "/android-chrome-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      });
    } else if (req.path == "/apple-touch-icon.png") {
      res.sendFile(process.env["PWD"] + "/static/" + hostdir + req.path);
    } else if (req.path == "/favicon.ico") {
      res.sendFile(process.env["PWD"] + "/static/" + hostdir + req.path);
    } else {
      next();
    }
  },
  sirv("static", { dev, dotfiles: true /* in case .DS_Store is created */ }),
  cookieParser(),
  (req, res, next) => {
    res.cookie = req.cookies["__session"] || "";
    next();
  },
  sapper.middleware({
    session: (req, res) => ({
      cookie: res.cookie,
    }),
  })
);

if (!("FIREBASE_CONFIG" in process.env)) {
  // firebase handles the listening
  sapperServer.listen(PORT).on("error", (err) => {
    if (err) console.log("error", err);
  });
}

import { firebaseAdmin } from "../firebase.js";

// server-side preload hidden from client-side code
process["server-preload"] = async (page, session) => {
  // console.debug("preloading, client?", isClient);
  // NOTE: for development server, admin credentials require `gcloud auth application-default login`
  let user = null;
  if (session.cookie == "signin_pending") {
    return {}; // do not waste time retrieving data
  } else if (!session.cookie || page.query.user == "anonymous") {
    user = { uid: "anonymous" };
  } else {
    // uncomment this to disable server-side init for non-anonymous accounts
    // return {}
    user = await firebaseAdmin().auth().verifyIdToken(session.cookie).catch(console.error);
    if (!user) return { error: "invalid session cookie: " + session.cookie };
  }
  let items = await firebaseAdmin()
    .firestore()
    .collection("items") // server always reads from primary collection
    .where("user", "==", user.uid) // important since otherwise firebaseAdmin has full access
    .orderBy("time", "desc")
    .get();
  return {
    items: items.docs.map((doc) =>
      Object.assign(doc.data(), {
        id: doc.id,
        updateTime: doc.updateTime.seconds,
        createTime: doc.createTime.seconds,
      })
    ),
  };
};

export { sapperServer }; // for use as handler in index.js
