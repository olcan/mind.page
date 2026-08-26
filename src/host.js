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

// the LOCAL isolated origin, the counterpart of SHARED_HOST for development and the e2e stack. a
// dedicated name used for nothing else: absent from LOCAL_REQUEST_HOSTS so the proxy refuses it,
// and a separate origin from `localhost`/`local.dev`, so it holds none of the developer's storage,
// cache or sign-in state.
// `*.localhost` resolves to loopback by convention (RFC 6761) with no /etc/hosts entry. it is
// deliberately NOT a `.dev` name: that whole TLD is HSTS-preloaded, so chrome force-upgrades
// http://<name>.dev to https and the plain-http e2e stack on port 3100 cannot answer it
export const SHARED_LOCAL_HOST = 'shared.localhost'

// true on EITHER isolated shared-page origin. every persistence rule must use this rather than
// compare against one hostname: the deployed and local origins are the same trust boundary, and
// pairing the comparisons by hand is exactly how the local origin kept persisting item state and
// github tokens after its firestore cache had already been fixed
export const isSharedOrigin = host => host == SHARED_HOST || host == SHARED_LOCAL_HOST

// exact local names, plus loopback literals. exact matches only, and callers must pass the RAW
// hostname: canonicalizeHost maps `localhost.<anything>` — including SHARED_LOCAL_HOST — to
// 'localhost' for DISPLAY, so a canonicalized host makes this function redirect the isolated
// origin to itself in a loop
const isLocalHost = host =>
  ['localhost', 'local.dev', 'localhost.dev', SHARED_LOCAL_HOST].includes(host) || isLoopbackAddress(host)

// decides whether a shared page must be served from the isolated origin instead of here, and
// returns the url to move to (or null to stay). kept pure and separate because it is a security
// control: everything it needs is passed in, so it can be tested directly.
// - only shared pages move, and only SOMEONE ELSE'S: the owner's own shared page stays on their
//   domain, where it is theirs to write to
// - never when already on either isolated origin (that would loop)
// - LOCAL HOSTS ARE NOT EXEMPT. A foreign shared page opened locally used to stay on the
//   developer's own origin, beside their session and with the local proxy reachable — the one
//   place the origin split did not apply. It now moves to SHARED_LOCAL_HOST, keeping scheme and
//   port so the dev server and the e2e stack still serve it. A different PORT alone would not
//   have done: cookies are not port-scoped, so only a distinct hostname isolates.
// - an UNKNOWN visitor moves. erring that way costs a redirect to a working page; erring the
//   other way runs a stranger's code beside a live session
export function sharedOriginRedirect({
  host,
  shared,
  uid,
  path = '/',
  search = '',
  hash = '',
  protocol = 'https:',
  port = '',
}) {
  if (!shared) return null // not a shared page
  const owner = shared.match(/^(\w+)\//)?.pop()
  if (!owner) return null // '?shared=<key>' has no owner prefix: the visitor's own page
  if (host == SHARED_HOST || host == SHARED_LOCAL_HOST) return null // already isolated
  if (uid && uid == owner) return null // the owner's own page
  if (isLocalHost(host)) return `${protocol}//${SHARED_LOCAL_HOST}${port ? ':' + port : ''}${path}${search}${hash}`
  return `https://${SHARED_HOST}${path}${search}${hash}`
}

// whether ONE request may use the local proxy.
//
// `(address, origin)` was not enough, and neither is any pair:
// - a loopback REMOTE ADDRESS identifies the browser process, not the page inside it. any page on
//   any origin can reach 127.0.0.1, and a WebSocket has no CORS response gate at all.
// - an ABSENT `Origin` does NOT mean a non-browser caller. browsers omit it on GET/HEAD
//   navigations and on `no-cors` requests — which is the dangerous case, since a top-level
//   navigation would serve attacker HTML UNDER our own local origin, with access to its
//   localStorage and IndexedDB (the encryption secret included).
// - comparing only the origin's HOSTNAME is not a same-origin check: it ignores scheme and port,
//   so any page on any port of an allowed name qualified.
//
// so the whole request is inspected:
// 1. the REQUEST HOST must be an approved local alias or loopback literal. exact names only —
//    canonicalizeHost maps `localhost.<anything>` (and some LAN addresses) to 'localhost' for
//    DISPLAY, and an attacker who registers `localhost.attacker.example` would pass that. this is
//    also the DNS-rebinding defense.
// 2. with an `Origin`, it must equal the request's own origin ENTIRELY — scheme, host and port.
// 3. without one, `Sec-Fetch-Site` must say `same-origin`; `cross-site`, `same-site` and `none`
//    are all refused.
// 4. with neither, fail CLOSED. a local tool that is not a browser opts in with an explicit
//    header, which a cross-origin page cannot set on a `no-cors` request or a navigation.
//
// NOTE none of this isolates mutually untrusted code that is already same-origin. a foreign shared
// page served from localhost passes every check here. only serving it from a distinct, proxy-free
// origin does — and since cookies are not port-scoped, a different port alone is not enough.

// approved local REQUEST hosts: exact names only, never suffixes. keep in step with the dev
// server's advertised hosts (see vite.config.mts)
// NOTE SHARED_LOCAL_HOST is deliberately ABSENT: it is the local isolated origin for foreign
// shared pages, and the proxy must refuse the code that runs there
const LOCAL_REQUEST_HOSTS = ['localhost', 'local.dev', 'localhost.dev']

// the header a non-browser local tool sends to opt in. a cross-origin page cannot set it on a
// navigation or a `no-cors` request, so it cannot be used to smuggle one past the gate
export const PROXY_OPT_IN_HEADER = 'x-mindpage-local-proxy'

export function isProxyRequestAllowed({ address, host, origin, secFetchSite, optIn, secure }) {
  if (!isLoopbackAddress(address)) return false
  if (!host) return false
  const hostname = String(host)
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
  if (!(LOCAL_REQUEST_HOSTS.includes(hostname) || isLoopbackAddress(hostname))) return false
  if (origin) return origin === `${secure ? 'https' : 'http'}://${host}` // full origin equality
  if (secFetchSite) return secFetchSite === 'same-origin'
  return optIn === true // fail closed
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
