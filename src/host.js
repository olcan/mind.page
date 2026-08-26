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
  // NOTE: the isolated shared-page origin (see SHARED_HOST) deliberately falls through to
  // 'other'. its icons then differ from the account domains', so a foreign shared page is
  // visibly not the tab where you are signed in — a small cue that costs nothing
  return ['mind.page', 'mindbox.io', 'olcan.com'].includes(host) ? host : 'other'
}

// ISOLATED ORIGIN for other people's shared pages. a shared page runs its OWNER's code, and the
// only real boundary against that code is the origin itself: firebase auth persistence, the
// session cookie, localStorage (including the encryption secret) and indexeddb are all
// per-origin, so owner code loaded here can reach none of them. see redirectToSharedOrigin in
// index.svelte — this is what replaced asking the visitor to make the judgement call
export const SHARED_HOST = 'shared.mind.page'

// where signing in happens. the isolated origin cannot authenticate anyone — it is deliberately
// not an authorized auth domain — so a sign-in gesture there has to go somewhere that is
export const ACCOUNT_HOST = 'mind.page'

// decides whether a shared page must be served from the isolated origin instead of here, and
// returns the url to move to (or null to stay). kept pure and separate because it is a security
// control: everything it needs is passed in, so it can be tested directly.
// - only shared pages move, and only SOMEONE ELSE'S: the owner's own shared page stays on their
//   domain, where it is theirs to write to
// - never when already on the isolated origin (that would loop), and never on localhost, which
//   has no second origin
// - an UNKNOWN visitor moves. erring that way costs a redirect to a working page; erring the
//   other way runs a stranger's code beside a live session
export function sharedOriginRedirect({ host, shared, uid, path = '/', search = '', hash = '' }) {
  if (!shared) return null // not a shared page
  const owner = shared.match(/^(\w+)\//)?.pop()
  if (!owner) return null // '?shared=<key>' has no owner prefix: the visitor's own page
  if (host == SHARED_HOST || canonicalizeHost(host) == 'localhost') return null
  if (uid && uid == owner) return null // the owner's own page
  return `https://${SHARED_HOST}${path}${search}${hash}`
}

// true for any loopback remote address, in every form node reports one: IPv4 127.0.0.0/8 (not
// just 127.0.0.1), IPv6 ::1, and IPv4-mapped IPv6. used to gate the development-only proxy, so
// an exact string check would both miss valid loopback callers and be easy to get subtly wrong
export function isLoopbackAddress(address) {
  if (!address) return false
  const addr = String(address).replace(/^::ffff:/, '') // IPv4-mapped IPv6
  if (addr == '::1') return true
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!v4) return false
  return v4.slice(1).every(n => Number(n) <= 255) && Number(v4[1]) == 127
}
