// host helpers shared by client code (via util.js) and the server (src/server/app.js), which
// must be importable from plain node esm without bundling (unlike the rest of util.js)
// canonicalize host name given a host(:port) string
// get host from url using new URL(url).host
// mainly to canonicalize/detect 'localhost'
export function canonicalizeHost(host) {
  return host.replace(/:.+$/, '').replace(/^(?:127\.0\.0\.1|local\.dev|localhost\..+|192\.168\.86\.10\d)$/, 'localhost')
}

// url regex constructor
// url scheme regex from https://stackoverflow.com/a/190405
// we are fairly restrictive on the tail (last character) by default, disallowing common punctuation
export function getHostDir(host) {
  return ['mind.page', 'mindbox.io', 'olcan.com'].includes(host) ? host : 'other'
}
