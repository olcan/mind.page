import sirv from "sirv";
import express from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import * as sapper from "@sapper/server";

const { PORT, NODE_ENV } = process.env;
const dev = NODE_ENV === "development"; // NOTE: production for 'firebase serve'

function get_hostdir(req) {
  // see https://stackoverflow.com/a/51200572 about x-forwarded-host
  let hostname = (req.headers["x-forwarded-host"] || req.headers["host"]).toString();
  globalThis.hostname = hostname = hostname.replace(/:.+$/, ""); // drop port number
  return ["mind.page", "mindbox.io", "olcan.com"].includes(hostname) ? hostname : "other";
}

const sapperServer = express().use(
  "/",
  compression({ threshold: 0 }),
  // TODO: remove 'as any' when typescript error is fixed
  sirv("static", { dev, dotfiles: true /* in case .DS_Store is created */ }) as any,
  // serve dynamic manifest, favicon.ico, apple-touch-icon (in case browser does not load main page or link tags)
  // NOTE: /favicon.ico requests are NOT being sent to 'ssr' function by firebase hosting meaning it can ONLY be served statically OR redirected, so we redirect to /icon.png for now (see config in firebase.json).
  (req, res, next) => {
    const hostdir = get_hostdir(req);
    if (req.path == "/manifest.json") {
      res.json({
        background_color: "#111",
        theme_color: "#111",
        name: globalThis.hostname,
        short_name: globalThis.hostname,
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
    } else if (req.path == "/icon.png") {
      res.sendFile(process.env["PWD"] + "/static/" + hostdir + "/favicon.ico");
    } else {
      next();
    }
  },
  cookieParser(),
  (req, res, next) => {
    res.cookie = req.cookies["__session"] || "";
    next();
  },
  // TODO: remove 'as any' when typescript error is fixed
  sapper.middleware({
    session: (req, res) => ({
      cookie: res["cookie"],
    }),
  }) as any
);

if (!("FIREBASE_CONFIG" in process.env)) {
  // firebase handles the listening
  sapperServer.listen(PORT).on("error", (err) => {
    if (err) console.log("error", err);
  });
}

import { firebaseAdmin } from "../firebase.js";

// server-side preload hidden from client-side code
// NOTE: for development server, admin credentials require `gcloud auth application-default login`
process["server-preload"] = async (page, session) => {
  // console.debug("preloading, client?", typeof window !== undefined, page, session);
  return {}; // disable server preload for now, even for anonymous account

  let user = null;
  if (session.cookie == "signin_pending") {
    return {}; // signin pending, do not waste time retrieving data
  } else if (!session.cookie || page.query.user == "anonymous") {
    user = { uid: "anonymous" };
  } else {
    // NOTE: we no longer preload for non-anonymous accounts because it slows down initial page load for larger accounts, and firebase realtime can be much more efficient due to client-side caching
    return {};
    // user = await firebaseAdmin().auth().verifyIdToken(session.cookie).catch(console.error);
    // if (!user) return { error: "invalid/expired session cookie" };
  }
  let items = await firebaseAdmin()
    .firestore()
    .collection("items") // server always reads from primary collection
    .where("user", "==", user.uid) // important since otherwise firebaseAdmin has full access
    .orderBy("time", "desc")
    .get();
  // console.debug(`retrieved ${items.docs.length} items for user '${user.uid}'`);
  return {
    // NOTE: we use _preload suffix to avoid replacing items on back/forward
    items_preload: items.docs.map((doc) =>
      Object.assign(doc.data(), {
        id: doc.id,
        updateTime: doc.updateTime.seconds,
        createTime: doc.createTime.seconds,
      })
    ),
  };
};

export { sapperServer }; // for use as handler in index.js
