// server-rendered page content for crawlers and link unfurlers (see +page.server.js): the app
// renders items only client-side, so public (anonymous) and shared pages would otherwise be
// invisible to clients that do not run javascript; items are fetched with firebase-admin and
// rendered as plain markdown (no item evaluation), cached briefly per query
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'
import { firebaseConfig } from '../../../firebase-config.js'

function firestore() {
  return getFirestore(getApps()[0] ?? initializeApp(firebaseConfig))
}

// outside the emulator, content fetches need google credentials (adc) — and a missing credential
// must disable content with one warning rather than crash the server: the firestore grpc channel
// authenticates on a DETACHED promise (inside a timer), so its rejection cannot be caught from
// query.get() and takes down `npm run dev` on a host without `gcloud auth application-default
// login`. checked once via the token path, whose rejection is catchable
let credentialsOk // promise, resolved once
function checkCredentials() {
  credentialsOk ??= (async () => {
    if (process.env.FIRESTORE_EMULATOR_HOST || process.env.GOOGLE_APPLICATION_CREDENTIALS) return true
    try {
      await applicationDefault().getAccessToken()
      return true
    } catch (e) {
      console.warn(
        'crawler/page content disabled: no google credentials',
        '(run `gcloud auth application-default login` to enable):',
        e.message
      )
      return false
    }
  })()
  return credentialsOk
}

// tiny ttl cache so busy public pages do not re-read the account on every request
const cache = new Map() // key -> { time, items }
const CACHE_MS = Number(process.env.CONTENT_CACHE_MS ?? 60_000) // serve.sh lowers this for local iteration

async function fetchItems(key, query) {
  const cached = cache.get(key)
  if (cached && Date.now() - cached.time < CACHE_MS) return cached.items
  if (!(await checkCredentials())) return [] // disabled (see above): pages serve without content
  // hard-capped: page content must never block ssr (e.g. firestore unreachable serves no content)
  const docs = await Promise.race([
    query.get(),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(`content fetch timed out (${key})`)), 5_000)),
  ])
  const items = docs.docs.map(doc => Object.assign(doc.data(), { id: doc.id }))
  cache.set(key, { time: Date.now(), items })
  return items
}

// plain-text snippet for meta descriptions
function snippet(text, length = 160) {
  const plain = text
    .replace(/```.*?```/gs, ' ') // code blocks
    .replace(/<[^>]*>/g, ' ') // html tags
    .replace(/#[\w/]+/g, ' ') // tags
    .replace(/[*_`>#|-]+/g, ' ') // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > length ? plain.slice(0, length - 1).trimEnd() + '…' : plain
}

// wraps rendered item html into the block injected into the page (see hooks.server.js): the
// noscript style hides the app's loading overlay and empty shell so the content is readable
// SECURITY: everything injected into the page is item-authored (a shared page renders ANOTHER
// user's items) and lands in the mind.page origin ahead of the app container, where a script or
// event handler would run before client boot can remove it — and could read the secret in
// localStorage. marked deliberately preserves raw html and unsafe url schemes, and the frozen
// render's capture-time cleanup is an optimization, not a trust boundary, so every path is
// sanitized here at the final insertion point with an allow-list
// sanitizing is deterministic, so results are memoized: the item fetch is cached (see
// fetchItems) but rendering and sanitizing ran on EVERY request, which for a full account is
// large enough to slow every page load
const sanitized = new Map() // inner html -> sanitized html (bounded, cleared wholesale)
// svg presentation attributes shared by the constrained svg profile below: geometry, paint and
// text layout only — no event handlers (sanitize-html drops on* by default since they are not
// listed), no style (see the NOTE below), no external references (use/href is fragment-gated)
// NOTE: attribute names are matched lowercased by sanitize-html, and the html parser
// re-adjusts known svg attributes (viewbox -> viewBox etc.) when the page is parsed, so
// this list is all-lowercase on purpose
const SVG_PRESENTATION = [
  'viewbox',
  'preserveaspectratio',
  'transform',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'dx',
  'dy',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'pathlength',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'opacity',
  'color',
  'display',
  'visibility',
  'overflow',
  'clip-path',
  'clip-rule',
  'mask',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'vector-effect',
  'shape-rendering',
  'text-rendering',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'patternunits',
  'patterncontentunits',
  'patterntransform',
  'markerunits',
  'markerwidth',
  'markerheight',
  'refx',
  'refy',
  'orient',
  'maskunits',
  'maskcontentunits',
  'clippathunits',
  'xmlns',
  'xmlns:xlink',
  'role',
  'aria-hidden',
  'aria-label',
  'focusable',
]

// the constrained svg profile: enough for mathjax svg output (fontCache 'local' keeps each
// equation's glyph defs inside its own svg, referenced via fragment-only <use>) and item-drawn
// charts, without foreignObject (html injection inside svg), smil animation elements (event-like
// begin/end attributes), script, or external references
const SVG_TAGS = [
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'title',
  'desc',
  'clipPath',
  'mask',
  'marker',
  'pattern',
  'linearGradient',
  'radialGradient',
  'stop',
]

function sanitize(html) {
  const hit = sanitized.get(html)
  if (hit !== undefined) return hit
  const clean = sanitizeInner(html)
  if (sanitized.size >= 8) sanitized.clear()
  sanitized.set(html, clean)
  return clean
}

function sanitizeInner(html) {
  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags, // no script/style/iframe/object/embed/form/input
      'img',
      'figure',
      'figcaption',
      'article',
      'section',
      'span',
      'del',
      'ins',
      'sup',
      'sub',
      'mark',
      'details',
      'summary',
      // charts drawn and math typeset are part of the frozen render's contract (see
      // prerender.mjs): svg survives under the constrained profile below, and canvas survives
      // as an empty husk (its pixels never serialize; the husk keeps layout and is inert)
      ...SVG_TAGS,
      'canvas',
    ],
    allowedAttributes: {
      // NOTE: no 'style': the frozen render carries thousands of inline declarations, and
      // parsing/validating each one (the only safe way to keep them) cost enough per request to
      // stall page loads; the block's own stylesheet linearizes the layout anyway
      // (contentBlock). this also drops mathjax's vertical-align on equation roots — a baseline
      // shift, accepted over reintroducing style parsing
      '*': ['class', 'title', 'align', 'width', 'height', 'colspan', 'rowspan', 'start', 'id'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'srcset', 'sizes', 'loading'],
      ...Object.fromEntries(SVG_TAGS.map(tag => [tag, SVG_PRESENTATION])),
      use: [...SVG_PRESENTATION, 'href'], // fragment-gated by the transform below
    },
    allowedSchemes: ['http', 'https', 'mailto'], // no javascript:/data: hrefs
    allowedSchemesByTag: { img: ['http', 'https', 'data'] }, // inline images are used by items
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      // <use> may reference only same-document fragments (mathjax glyph defs): an external href
      // would make the frozen page fetch and render foreign svg content
      use: (tagName, attribs) => {
        const href = attribs['xlink:href'] ?? attribs.href
        const safe = typeof href == 'string' && href.startsWith('#') ? href : null
        const kept = { ...attribs }
        delete kept.href
        delete kept['xlink:href']
        if (safe) kept.href = safe
        return { tagName, attribs: kept }
      },
    },
  })
}

// exported for tests: the exact sanitizer applied to every injected content block
export const sanitizeBlock = sanitize

// item text rendered as markdown with its raw html ESCAPED: item html is author-controlled (a
// shared page renders ANOTHER user's items into this origin) and marked deliberately passes raw
// html through, so for the crawler/no-javascript view it is shown as text rather than parsed —
// inert by construction. only '<' is escaped: no tag can open without it, while '>' (blockquotes)
// and '&' (entities) are meaningful markdown that cannot create markup on their own
function renderMarkdown(text) {
  return marked.parse(text.replace(/</g, '&lt;'), { breaks: true })
}

function contentBlock(inner) {
  // every path is sanitized at this final insertion point: for markdown paths the raw html is
  // already escaped, but marked GENERATES anchors from link/image syntax with their url schemes
  // passed through unchecked ([x](javascript:...) becomes a live href) — the allow-list drops
  // those, and doubles as the trust boundary for the app-generated frozen render
  inner = sanitize(inner)
  return (
    // without javascript the app shell is useless, so hide all of it; the frozen render is an
    // .items clone whose layout the app computes at runtime (absolutely positioned columns and
    // containers), so linearize it into one flowing column
    '<noscript><style>' +
    ' #sapper > * { display: none !important }' +
    ' .ssr-content { max-width: 40em; margin: 0 auto; padding: 1em; font-family: sans-serif }' +
    ' .ssr-content article { margin-bottom: 1.5em }' +
    ' .ssr-content :is(.items, .column, .super-container, .container) {' +
    '   position: static !important; top: auto !important; left: auto !important;' +
    '   width: auto !important; height: auto !important; display: block !important }' +
    ' .ssr-content .super-container { margin: 0 0 1.5em !important }' +
    '</style></noscript>' +
    `<div class="ssr-content">${inner}</div>`
  )
}

// content ({ meta: { title, description }, html }) for the page at the given url, or null when the
// page is not public: a signed-in session (cookie) renders client-side only (encrypted anyway)
export async function pageContent({ url, cookie, hostname }) {
  const shared = url.searchParams.get('shared')
  try {
    if (shared?.match(/^\w+\/[\w-]+$/)) {
      // a shared page: plaintext by definition, rendered for any visitor
      const [owner, key] = shared.split('/')
      let items = await fetchItems(
        `shared:${owner}/${key}`,
        firestore().collection('items').where('user', '==', owner).where('attr.shared.keys', 'array-contains', key)
      )
      // as on the page itself, only items shared with an index are shown, in index order
      items = items
        .filter(item => item.attr?.shared?.indices?.[key] >= 0)
        .sort((a, b) => a.attr.shared.indices[key] - b.attr.shared.indices[key])
      if (!items.length) return null
      return {
        meta: { title: `${key} @ ${hostname}`, description: snippet(items[0].text) },
        html: contentBlock(items.map(item => `<article>${renderMarkdown(item.text)}</article>`).join('')),
      }
    }
    if (!cookie || url.searchParams.get('user') == 'anonymous') {
      // the anonymous account (the signed-out view on any host): serve the frozen render when one
      // is available (the app's default view captured in a real browser, see prerender.mjs at the
      // repo root), else fall back to the items as plain markdown
      const meta = { title: hostname, description: 'Secure private notebook for your mind.' }
      const [frozen] = await fetchItems('prerender', firestore().collection('prerender'))
      if (frozen?.html) {
        if (frozen.description) meta.description = frozen.description
        // the frozen render is app-generated html (already cleaned at capture, see
        // prerender.mjs) and the one path that keeps its tags; contentBlock sanitizes it
        return { meta, html: contentBlock(frozen.html) }
      }
      const items = await fetchItems(
        'anonymous',
        firestore().collection('items').where('user', '==', 'anonymous').orderBy('time', 'desc')
      )
      const visible = items.filter(item => !item.hidden && item.text)
      if (!visible.length) return null
      return {
        meta,
        html: contentBlock(
          visible.map(item => `<article>${renderMarkdown(item.text)}</article>`).join('')
        ),
      }
    }
  } catch (e) {
    console.error('could not render page content:', e)
  }
  return null // signed-in (or failed): client-side rendering only
}
