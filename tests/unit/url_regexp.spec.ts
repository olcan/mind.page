import { expect, test } from '@playwright/test'
import { Marked } from 'marked'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// the bare-url rule of src/util.js: the app's pre-Markdown url rewrite (replaceURLs in
// Item.svelte's toHTML), its code-comment linkifier and the `_log`/`_output` highlighter all
// match urls with urlRegExp, which reads the browser globals `window._shortcut_hosts` and
// lodash `_` at CALL time; stub both before the calls below -- no other browser surface is touched
;(globalThis as any).window = { _shortcut_hosts: [] }
// the module reads the global `_` at call time; keep a local handle too -- the escaped-html
// cases below escape their own input the way the callers do, and a bare `_` is a UMD global
// here (TS2686 under `npm run check:tests`)
const lodash = createRequire(import.meta.url)('lodash')
;(globalThis as any)._ = lodash

// @ts-expect-error util.js is plain js (the app's client lib) without a declaration file
import { escapedUrlChar, escapedUrlEntity, highlight, urlRegExp } from '../../src/util.js'
import { highlightLinks } from '../../src/editor_links.js'

// each url the rule matches in `text`, marked in place as «url» (the text around it stays)
const mark = (text: string): string => text.replace(urlRegExp(), (m: string, pfx: string, url: string) => `${pfx}«${url}»`)

// the gmail-imported item that surfaced the bug (2026-09-20): the bare url ends at the tweet
// title's closing quote, which the rule took as part of the url (an unencoded `"` can never be
// part of a url, RFC 3986), so the rendered anchor's href carried it and the link was broken
const IMPORTED =
  'Rafal Wilinski on X: "Jev is now in charge of this account\'s humor https://t.co/ojSOHeMFT2" / X ' +
  '[gmail](https://mail.google.com/mail/u/0/#inbox/1a0b6fc15733b648) ' +
  '[mail](message://%3CCAFXOJNGm5jvC03HFfNq10JbfA%3DXfEPkV7BHRbtzniHuDM5hUsg%40mail.gmail.com%3E)'

test('a double-quote is never part of a bare url', () => {
  // the markdown links' destinations match too (their `(` prefix): replaceURLs skips those by
  // their `](` prefix, which is the caller's rule, not this one's
  expect(mark(IMPORTED)).toBe(
    'Rafal Wilinski on X: "Jev is now in charge of this account\'s humor «https://t.co/ojSOHeMFT2»" / X ' +
      '[gmail](«https://mail.google.com/mail/u/0/#inbox/1a0b6fc15733b648») ' +
      '[mail](«message://%3CCAFXOJNGm5jvC03HFfNq10JbfA%3DXfEPkV7BHRbtzniHuDM5hUsg%40mail.gmail.com%3E»)'
  )
  // without the quote the same url matches as before
  expect(mark('humor https://t.co/ojSOHeMFT2 / X')).toBe('humor «https://t.co/ojSOHeMFT2» / X')
  // a quote inside the run ends the url as well
  expect(mark('see https://t.co/a"b')).toBe('see «https://t.co/a»"b')
})

test('trailing punctuation and a closing parenthesis stay out of the url as before', () => {
  expect(mark('see https://example.com/x, then https://example.com/y. (https://example.com/z) or https://example.com/w:')).toBe(
    'see «https://example.com/x», then «https://example.com/y». («https://example.com/z») or «https://example.com/w»:'
  )
})

// the one custom last-character class in the app: the editor overlay's highlightLinks, its
// comment linkifier link_urls (Editor.svelte) and insertZWSP (zwsp.ts) admit `;` (an html
// entity's end, fine for display in the editor). the body class stops before a `"`, so a
// last-character class that admits the quote takes a closing quote as the url's last character
// (`https://t.co/ojSOHeMFT2"` matched whole, 2026-09-20): the callers' exact class, pinned here
const EDITOR_SUFFIX = /[^\s)<>:,."]/

test("a caller's own last-character class excludes the quote as the default does", () => {
  const markEditor = (text: string): string =>
    text.replace(urlRegExp({ suffix: EDITOR_SUFFIX }), (m: string, pfx: string, url: string) => `${pfx}«${url}»`)
  expect(markEditor(IMPORTED)).toContain('humor «https://t.co/ojSOHeMFT2»" / X')
  // the class's own difference stays: a `;` ends the default's url, not the editor's
  expect(markEditor('see https://example.com/a&amp;')).toBe('see «https://example.com/a&amp;»')
  expect(mark('see https://example.com/a&amp;')).toBe('see «https://example.com/a&amp»;')
})

// ALREADY-ESCAPED html -- the editor overlay (highlightLinks and the comment linkifier of
// Editor.svelte), the code-comment linkifier of Item.svelte, the `_log`/`_output` highlighter of
// util.js, the todoer's rows and the modal all match urls in text that is already escaped, where
// the closing quote is `&quot;`: its letters pass the body class and its `;` passes the editor's
// last-character class, so the whole entity rode into the highlighted url and the owner still
// saw the quote inside the link after the raw-case fix (2026-09-20). `escaped: true` reads an
// `&` as a url character only in `&amp;`, so no entity is ever half-consumed and only a real
// `&` (the one query strings depend on) stays inside the url
const markEscaped = (text: string, options = {}): string =>
  text.replace(urlRegExp({ escaped: true, ...options }), (m: string, pfx: string, url: string) => `${pfx}«${url}»`)

test('an escaped closing quote ends the url', () => {
  const escaped = lodash.escape(IMPORTED) // exactly what Editor.svelte's updateTextDivs feeds highlightLinks
  expect(escaped).toContain('humor https://t.co/ojSOHeMFT2&quot; / X')
  // the editor overlay's own options (highlightLinks and its comment link_urls)
  expect(markEscaped(escaped, { suffix: EDITOR_SUFFIX })).toContain('humor «https://t.co/ojSOHeMFT2»&quot; / X')
  // the default class (Item.svelte's comment linkifier, the `_log`/`_output` highlighter)
  expect(markEscaped(escaped)).toContain('humor «https://t.co/ojSOHeMFT2»&quot; / X')
  // an entity ends the AUTHORITY too, before any path
  expect(markEscaped(lodash.escape('see https://example.com"x'))).toBe('see «https://example.com»&quot;x')
  // the other characters the raw rule excludes, in their escaped form
  expect(markEscaped(lodash.escape('see https://example.com/a<b'))).toBe('see «https://example.com/a»&lt;b')
  expect(markEscaped(lodash.escape('see https://example.com/a>b'))).toBe('see «https://example.com/a»&gt;b')
  // the numeric forms of the quote too (marked leaves an already-escaped entity as written)
  expect(markEscaped('see https://example.com/a&#34;b')).toBe('see «https://example.com/a»&#34;b')
  expect(markEscaped('see https://example.com/a&#x22;b')).toBe('see «https://example.com/a»&#x22;b')
})

test('an escaped apostrophe ends the url', () => {
  // the closing quote of a SINGLE-quoted title rode in the same way `&quot;` did: only `&amp;`
  // is a url character here (lodash and marked write `&#39;`, highlight.js `&#x27;`). an
  // unencoded `'` inside a url (`%27` is the usual form) therefore ends the escaped link early,
  // where the raw rule -- unchanged, an apostrophe is legal in a url -- keeps it
  expect(markEscaped(lodash.escape("on X: 'humor https://t.co/ojSOHeMFT2' / X"))).toBe(
    'on X: &#39;humor «https://t.co/ojSOHeMFT2»&#39; / X'
  )
  expect(markEscaped('see https://example.com/a&#x27;b')).toBe('see «https://example.com/a»&#x27;b')
  expect(markEscaped('see https://example.com/a&apos;b')).toBe('see «https://example.com/a»&apos;b')
  expect(mark("on X: 'humor https://t.co/ojSOHeMFT2' / X")).toBe("on X: 'humor «https://t.co/ojSOHeMFT2'» / X")
})

test('an escaped ampersand stays inside the url', () => {
  const escaped = lodash.escape('see https://example.com/q?a=1&b=2&c=3 end')
  expect(escaped).toBe('see https://example.com/q?a=1&amp;b=2&amp;c=3 end')
  expect(markEscaped(escaped)).toBe('see «https://example.com/q?a=1&amp;b=2&amp;c=3» end')
  // a TRAILING entity is kept whole under both classes, though the default one excludes its `;`
  expect(markEscaped(lodash.escape('see https://example.com/a&'))).toBe('see «https://example.com/a&amp;»')
  expect(markEscaped(lodash.escape('see https://example.com/a&'), { suffix: EDITOR_SUFFIX })).toBe(
    'see «https://example.com/a&amp;»'
  )
})

// highlightLinks is imported directly from src/editor_links.ts (the pure module Editor.svelte imports)

test('the editor overlay highlights the reported line without the closing quote', () => {
  expect(highlightLinks(lodash.escape(IMPORTED))).toContain('humor <span class="link">https://t.co/ojSOHeMFT2</span>&quot; / X')
  // a real `&` in a query string keeps the whole url highlighted, query and all
  expect(highlightLinks(lodash.escape('see https://example.com/q?a=1&b=2&c=3 end'))).toBe(
    'see <span class="link">https://example.com/q?a=1&amp;b=2&amp;c=3</span> end'
  )
  // trailing punctuation stays out of the highlight, as it did before
  expect(highlightLinks(lodash.escape('see https://example.com/a, end'))).toBe(
    'see <span class="link">https://example.com/a</span>, end'
  )
})

test('the raw rule is untouched by the escaped option', () => {
  expect(urlRegExp().source).toBe(urlRegExp({ escaped: false }).source)
  // a literal `&quot;` typed in RAW text is url characters, as it was: the item text and the
  // editor's textarea are raw (Item.svelte's replaceURLs, insertZWSP, the logger's log rule)
  expect(mark('see https://example.com/a&quot;b')).toBe('see «https://example.com/a&quot;b»')
})

// only highlightLinks is evaluated above, so nothing else would notice a call site quietly
// losing `escaped: true` -- and that is exactly the failure mode of this bug, which survived a
// whole round because every witness fed the rule RAW text. the inventory of call sites, pinned:
// which text each one reads is a property of the CALLER, not of the rule
test('every call site reads the text it actually gets: escaped or raw', () => {
  // [file, calls that must pass `escaped: true`, calls that must not]
  const sites: [string, number, number][] = [
    ['src/util.js', 1, 0], // the `_log`/`_output` highlighter, over `_.escape(code)`
    ['src/editor_links.ts', 1, 0], // highlightLinks, over `_.escape(line)`
    ['src/components/Editor.svelte', 1, 0], // the comment link_urls, over `_.escape(line)`
    ['src/components/Item.svelte', 1, 1], // the code-comment linkifier, over hljs output; replaceURLs is RAW item text
    ['src/zwsp.ts', 0, 1], // insertZWSP, over the raw textarea
  ]
  for (const [file, escaped, raw] of sites) {
    const source = readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
    // every call but the definition (`function urlRegExp(`), with its options object if any
    const calls = [...source.matchAll(/(?<!function )urlRegExp\((\{[\s\S]*?\})?\)/g)].map(m => m[1] ?? '')
    expect({ file, escaped: calls.filter(o => o.includes('escaped: true')).length, raw: calls.filter(o => !o.includes('escaped: true')).length }).toEqual({ file, escaped, raw })
  }
})

// the modal linkifies the html marked produced (Modal.svelte's replaceNakedURLs), with its own
// pattern -- a bare `https?://` run, no prefix class, `>` allowed -- built from the shared atom
// above. the function is READ FROM THE COMPONENT and evaluated here, so this is the real code
const replaceNakedURLs: (text: string) => string = (() => {
  const source = readFileSync(new URL('../../src/components/Modal.svelte', import.meta.url), 'utf8')
  const picked = source.match(/\n {2}function replaceNakedURLs\(text\) \{[\s\S]*?\n {2}\}\n/)
  if (!picked) throw new Error('function replaceNakedURLs not found in Modal.svelte')
  return new Function(
    'escapedUrlChar',
    'escapedUrlEntity',
    `${picked[0]}\nreturn replaceNakedURLs`
  )(escapedUrlChar, escapedUrlEntity)
})()

test('the modal links escaped html without taking the closing quote or breaking an entity', () => {
  expect(replaceNakedURLs('<p>on X: &quot;humor https://t.co/ojSOHeMFT2&quot; / X</p>')).toBe(
    '<p>on X: &quot;humor <a href="https://t.co/ojSOHeMFT2" target="_blank">https://t.co/ojSOHeMFT2</a>&quot; / X</p>'
  )
  // a real `&` in a query string stays in the href, and its `;` is not moved out as punctuation
  const amp = 'https://example.com/q?a=1&amp;b=2'
  expect(replaceNakedURLs(`<p>see ${amp} end</p>`)).toBe(`<p>see <a href="${amp}" target="_blank">${amp}</a> end</p>`)
  const trailing = 'https://example.com/a&amp;'
  expect(replaceNakedURLs(`<p>see ${trailing}</p>`)).toContain(
    `<a href="${trailing}" target="_blank">${trailing}</a>`
  )
  // trailing punctuation still moves out of the url as before
  expect(replaceNakedURLs('<p>see https://example.com/a, end</p>')).toBe(
    '<p>see <a href="https://example.com/a" target="_blank">https://example.com/a</a>, end</p>'
  )
})

// the code-comment linkifier of Item.svelte (the same pick as highlightLinks above): its anchor
// for a url matched in already-escaped html, with the page host and lodash it reads at call time
const commentLinkUrls: (text: string) => string = (() => {
  const source = readFileSync(new URL('../../src/components/Item.svelte', import.meta.url), 'utf8')
  const picked = source.match(/\n {4}const link_urls = text =>\n {6}text\.replace\(urlRegExp\(\{ escaped: true \}\)[\s\S]*?\n {6}\}\)\n/)
  if (!picked) throw new Error('const link_urls not found in Item.svelte')
  return new Function('urlRegExp', 'host_base', '_', `${picked[0]}\nreturn link_urls`)(urlRegExp, 'mind.page', lodash)
})()

test('an already-escaped href is not escaped again', () => {
  // both linkifiers match urls in ALREADY-ESCAPED html, so the `&amp;` inside a match is the
  // escaped `&` (the one entity the escaped rule keeps in a url). escaping the match again wrote
  // `&amp;amp;` into href and title, and the browser opened `?a=1&amp;b=2`: the parameter `amp;b`
  // instead of `b` on hover, copy-link and open-in-new-tab (2026-09-21, issues/Escaped Url Entity
  // Backfills); the app's own click handler unescapes once, so only it ever saw the right url
  const url = 'https://example.com/q?a=1&amp;b=2' // the escaped form, as the attribute must carry it
  expect(commentLinkUrls(lodash.escape('see https://example.com/q?a=1&b=2 end'))).toBe(
    `see <a href="${url}" target="_blank" rel="noopener noreferrer" title="${url}" data-link-click>example.com/…</a> end`
  )
  // a configured shortcut host's label carries the PARSED path, plain text: escaped once (an
  // unescaped `/a&notebook` rendered as `/a¬ebook`, review 0)
  ;(globalThis as any).window._shortcut_hosts = ['example.com']
  const shortcut = 'https://example.com/a&amp;notebook'
  expect(commentLinkUrls(lodash.escape('see https://example.com/a&notebook end'))).toBe(
    `see <a href="${shortcut}" target="_blank" rel="noopener noreferrer" title="${shortcut}" data-link-click>example.com/a&amp;notebook</a> end`
  )
  ;(globalThis as any).window._shortcut_hosts = []
  // the `_log`/`_output` highlighter escapes the code itself, then links; its label is the url too
  ;(globalThis as any).window.hljs = {} // present: the `_log`/`_output` branches never call it
  expect(highlight('see https://example.com/q?a=1&b=2 end', '_output')).toBe(
    `see <a href="${url}" title="${url}" target="_blank">${url}</a> end`
  )
  expect(highlight('INFO: see https://example.com/q?a=1&b=2', '_log')).toBe(
    `<span class="console-info">INFO: see <a href="${url}" title="${url}" target="_blank">${url}</a></span>`
  )
  delete (globalThis as any).window.hljs
})

// readwise links (2026-11-27): text-fragment destinations carry `:~:text=...` after the host,
// where bare urlRegExp stops before `:`, leaving the tail of the destination outside the inner
// span.link (blue instead of grey). inside a markdown link the inner span covers the whole
// destination (keeping balanced round brackets inside it, and any title and the link's own
// closing `)` outside the inner span), and on a definition line the address gets one bare span
const READWISE_APP_URL = 'https://read.readwise.io/read/01m8b6pz0vv3wqhn3syg19ycvg'
const READWISE_ARTICLE_URL =
  'https://alexwang.ai/posts/associative-memory/?__readwiseLocation=0%2F152%3A104%2C0%2F152%3A285#rw=01m8b6pz0vv3wqhn3syg19ycvg:~:text=the%20capacity%20is%20about,about%201.2%20million%20too'
const READWISE_TWITTER_URL =
  'https://twitter.com/PredictParity/status/2033696078889927043/?rw_tt_thread=True&__readwiseLocation=0%2F2%2F0%3A0%2C0%2F3%2F0%3A112#rw=01m8b6sae695kjkf8nm4t7s22k:~:text=Out%20of%20146%2C960%20resolved,yes%20as%20a%20outcome'
const READWISE_TWITTER_URL_ESCAPED = lodash.escape(READWISE_TWITTER_URL)
const READWISE_DEF_W1_URL =
  'https://alexwang.ai/posts/associative-memory/?__readwiseLocation=0%2F152%3A104%2C0%2F152%3A285#rw=01m8b6pz0vv3wqhn3syg19ycvg;lead=With:~:text=the%20capacity%20is%20about,about%201.2%20million%20too'

// the released helper (Editor.svelte's own `highlightLinks` before it moved to src/editor_links.ts),
// copied here as the reference of the comparisons below
function masterHighlightLinks(text: string): string {
  return text
    .replace(/\[(?:[^\]]|\\\])*[^\\]\]\((?:[^\)]|\\\))*[^\\)]\)/g, link => `<span class="link">${link}</span>`)
    .replace(
      // same as in link_urls above, see comments there
      urlRegExp({ suffix: /[^\s)<>:,."]/, escaped: true }),
      (_m: string, pfx: string, href: string) => pfx + `<span class="link">${href}</span>`
    )
}

test('markdown link with a colon after its host keeps the whole destination in one inner span', () => {
  // link without a colon after its host: one outer span, one inner span, closing `)` outside
  expect(highlightLinks(lodash.escape(`[app](${READWISE_APP_URL})`))).toBe(
    `<span class="link">[app](<span class="link">${READWISE_APP_URL}</span>)</span>`
  )
  // readwise article link with `:~:text=`: whole destination inside the inner span, `)` outside
  expect(highlightLinks(lodash.escape(`[web](${READWISE_ARTICLE_URL})`))).toBe(
    `<span class="link">[web](<span class="link">${READWISE_ARTICLE_URL}</span>)</span>`
  )
  // shortcut host with a colon after the host gets the same full-destination span
  ;(globalThis as any).window._shortcut_hosts = ['go']
  try {
    expect(highlightLinks(lodash.escape('[doc](go/item:tail)'))).toBe(
      '<span class="link">[doc](<span class="link">go/item:tail</span>)</span>'
    )
  } finally {
    ;(globalThis as any).window._shortcut_hosts = []
  }
})

test('markdown link with an escaped ampersand and colon tail keeps both inside one inner span', () => {
  expect(READWISE_TWITTER_URL_ESCAPED).toContain('rw_tt_thread=True&amp;__readwiseLocation=')
  expect(highlightLinks(lodash.escape(`[web](${READWISE_TWITTER_URL})`))).toBe(
    `<span class="link">[web](<span class="link">${READWISE_TWITTER_URL_ESCAPED}</span>)</span>`
  )
  // a title after a colon-bearing destination stays outside the inner span, and a `(` + url
  // inside the destination never opens a third nested span
  expect(highlightLinks(lodash.escape('[note](https://example.com/a:~:text=x "My Title")'))).toBe(
    '<span class="link">[note](<span class="link">https://example.com/a:~:text=x</span> &quot;My Title&quot;)</span>'
  )
  expect(highlightLinks(lodash.escape('[nested](https://example.com/q=(https://other.com/b))'))).toBe(
    '<span class="link">[nested](<span class="link">https://example.com/q=(https://other.com/b)</span>)</span>'
  )
})

test('two readwise links in round brackets after prose highlight each whole destination', () => {
  const withAppAndArticle = `Note on associative memory ([app](${READWISE_APP_URL}) [web](${READWISE_ARTICLE_URL}))`
  expect(highlightLinks(lodash.escape(withAppAndArticle))).toBe(
    'Note on associative memory (' +
      `<span class="link">[app](<span class="link">${READWISE_APP_URL}</span>)</span> ` +
      `<span class="link">[web](<span class="link">${READWISE_ARTICLE_URL}</span>)</span>)`
  )
  const withBothWeb = `Note on forecasts ([web](${READWISE_ARTICLE_URL}), [web](${READWISE_TWITTER_URL}))`
  expect(highlightLinks(lodash.escape(withBothWeb))).toBe(
    'Note on forecasts (' +
      `<span class="link">[web](<span class="link">${READWISE_ARTICLE_URL}</span>)</span>, ` +
      `<span class="link">[web](<span class="link">${READWISE_TWITTER_URL_ESCAPED}</span>)</span>)`
  )
})

test('link definition lines colour the whole address including colon tails, titles, and up to three leading spaces', () => {
  // owner's two definition lines: exact HTML, single bare-address span over the full URL
  expect(highlightLinks(lodash.escape(`[a1]: ${READWISE_APP_URL}`))).toBe(
    `[a1]: <span class="link">${READWISE_APP_URL}</span>`
  )
  expect(highlightLinks(lodash.escape(`[w1]: ${READWISE_DEF_W1_URL}`))).toBe(
    `[w1]: <span class="link">${READWISE_DEF_W1_URL}</span>`
  )
  // escaped ampersand and colon tail together in a definition address
  expect(highlightLinks(lodash.escape(`[t1]: ${READWISE_TWITTER_URL}`))).toBe(
    `[t1]: <span class="link">${READWISE_TWITTER_URL_ESCAPED}</span>`
  )
  // shortcut host with a colon tail on a definition line
  ;(globalThis as any).window._shortcut_hosts = ['go']
  try {
    expect(highlightLinks(lodash.escape('[doc]: go/item:tail'))).toBe(
      '[doc]: <span class="link">go/item:tail</span>'
    )
  } finally {
    ;(globalThis as any).window._shortcut_hosts = []
  }
  // definitions with double-quoted, single-quoted, and parenthesized titles: title stays outside the span
  expect(highlightLinks(lodash.escape('[w1]: https://alexwang.ai/posts/a:~:text=x "Associative Memory"'))).toBe(
    '[w1]: <span class="link">https://alexwang.ai/posts/a:~:text=x</span> &quot;Associative Memory&quot;'
  )
  expect(highlightLinks(lodash.escape("[w1]: https://alexwang.ai/posts/a:~:text=x 'Associative Memory'"))).toBe(
    '[w1]: <span class="link">https://alexwang.ai/posts/a:~:text=x</span> &#39;Associative Memory&#39;'
  )
  expect(highlightLinks(lodash.escape('[w1]: https://alexwang.ai/posts/a:~:text=x (Associative Memory)'))).toBe(
    '[w1]: <span class="link">https://alexwang.ai/posts/a:~:text=x</span> (Associative Memory)'
  )
  // indented up to three spaces: still a definition line, coloured whole
  expect(highlightLinks(lodash.escape(`   [w1]: ${READWISE_DEF_W1_URL}`))).toBe(
    `   [w1]: <span class="link">${READWISE_DEF_W1_URL}</span>`
  )
  // angle-bracketed destination on a definition line
  expect(highlightLinks(lodash.escape('[w1]: <https://example.org/a:~:text=x> "Title"'))).toBe(
    '[w1]: &lt;<span class="link">https://example.org/a:~:text=x</span>&gt; &quot;Title&quot;'
  )
  // a bare url inside a definition title keeps its highlight
  expect(highlightLinks(lodash.escape('[w1]: https://alexwang.ai/posts/a:~:text=x "see https://other.org/b"'))).toBe(
    '[w1]: <span class="link">https://alexwang.ai/posts/a:~:text=x</span> &quot;see <span class="link">https://other.org/b</span>&quot;'
  )
})

test('non-url link definitions (tags, fragments) and four-space definitions stay as on master', () => {
  // four leading spaces: not a definition line (0-3 spaces only), falls back to master's bare url
  const fourSpaces = lodash.escape(`    [w1]: ${READWISE_DEF_W1_URL}`)
  expect(highlightLinks(fourSpaces)).toBe(masterHighlightLinks(fourSpaces))
  expect(highlightLinks(fourSpaces)).toContain(';lead=With</span>:~:text=')
  // a definition of a tag (raw and as highlightTags hands it to highlightLinks) or a fragment
  for (const line of [
    '[t1]: <mark>#mytag</mark>',
    lodash.escape('[t1]: #mytag'),
    lodash.escape('[s1]: #heading-1'),
    lodash.escape('[bad]: https://example.org/a:~:text=x extra words'),
  ]) {
    expect(highlightLinks(line), line).toBe(masterHighlightLinks(line))
  }
})

test('balanced round brackets in a destination and titles holding a closing bracket stay inside the link', () => {
  const markedPlain = new Marked({ gfm: true, breaks: true })
  // reviewer's exact example: balanced pair followed by a text fragment
  const mercury = 'https://example.org/Mercury_(planet)#:~:text=small'
  expect(markedPlain.parseInline(`[web](${mercury})`)).toContain(`href="${mercury}"`)
  const cases: [string, string, string][] = [
    [
      'fragment after a balanced pair',
      `[web](${mercury})`,
      `<span class="link">[web](<span class="link">${mercury}</span>)</span>`,
    ],
    [
      'balanced pair at the end of a destination',
      '[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))',
      '<span class="link">[Mercury](<span class="link">https://en.wikipedia.org/wiki/Mercury_(planet)</span>)</span>',
    ],
    [
      'nested balanced pairs followed by a fragment',
      '[web](https://example.org/A_(b_(c))#:~:text=tail)',
      '<span class="link">[web](<span class="link">https://example.org/A_(b_(c))#:~:text=tail</span>)</span>',
    ],
    [
      'surrounding prose parentheses stay outside the link',
      `Note ([web](${mercury}))`,
      `Note (<span class="link">[web](<span class="link">${mercury}</span>)</span>)`,
    ],
    [
      'double-quoted title holding a closing bracket leaves the link delimiter in the outer span',
      '[note](https://example.org/a "hello ) world")',
      '<span class="link">[note](<span class="link">https://example.org/a</span> &quot;hello ) world&quot;)</span>',
    ],
    [
      'single-quoted title holding a closing bracket',
      "[note](https://example.org/a 'hello ) world')",
      '<span class="link">[note](<span class="link">https://example.org/a</span> &#39;hello ) world&#39;)</span>',
    ],
    [
      'double-quoted title with escaped quote and closing bracket',
      '[note](https://example.org/a "say \\" ) hi")',
      '<span class="link">[note](<span class="link">https://example.org/a</span> &quot;say \\&quot; ) hi&quot;)</span>',
    ],
    [
      'parenthesized title leaves the link delimiter in the outer span',
      '[note](https://example.org/a (My Title))',
      '<span class="link">[note](<span class="link">https://example.org/a</span> (My Title))</span>',
    ],
    [
      'parenthesized title with escaped closing bracket',
      '[note](https://example.org/a (paren \\) title))',
      '<span class="link">[note](<span class="link">https://example.org/a</span> (paren \\) title))</span>',
    ],
    [
      'balanced pair + fragment + quoted title holding a closing bracket',
      `[web](${mercury} "see ) 1")`,
      `<span class="link">[web](<span class="link">${mercury}</span> &quot;see ) 1&quot;)</span>`,
    ],
    [
      'angle-bracketed destination holding a closing bracket + quoted title holding one',
      '[web](<https://example.org/a)b> "see ) 1")',
      '<span class="link">[web](&lt;<span class="link">https://example.org/a)b</span>&gt; &quot;see ) 1&quot;)</span>',
    ],
    [
      'near neighbour: apostrophe inside bare destination still closes normally',
      "[wiki](https://en.wikipedia.org/wiki/Murphy's_law)",
      '<span class="link">[wiki](<span class="link">https://en.wikipedia.org/wiki/Murphy&#39;s_law</span>)</span>',
    ],
    [
      'near neighbour: unclosed title quote does not form a broken outer link span',
      '[x](https://example.org/a "unclosed)',
      '[x](<span class="link">https://example.org/a</span> &quot;unclosed)',
    ],
  ]
  for (const [name, raw, expected] of cases) {
    expect(highlightLinks(lodash.escape(raw)), name).toBe(expected)
  }
  expect(markedPlain.parseInline('[x](https://example.org/a "unclosed)')).not.toContain('>x</a>')
})

// the released helper's output is kept for the lines listed here, not for every line. Two known
// differences, both kept: in `[see https://example.org/x](rel)` the released grey span ran on over
// `](rel`, and here the label's address ends at `/x`; and `[x](https://example.org/a "unclosed)`
// was wrapped as a link by the released helper and is none here (the case above)
test('the listed lines without a colon-tail destination or url definition match the released helper', () => {
  const masterLines: [string, string][] = [
    ['tag link (raw)', lodash.escape('[tag](#mytag)')],
    ['tag link (after highlightTags)', '[tag](<mark>#mytag</mark>)'],
    ['fragment link', lodash.escape('[section](#heading-1)')],
    ['script link', lodash.escape('[run](javascript:window._x=1)')],
    ['label that is an address', lodash.escape('[https://example.com/a](https://example.com/b)')],
    ['label containing an address', lodash.escape('[see https://example.com/a here](https://example.com/b)')],
    ['two links in a line', lodash.escape('see [one](https://example.com/1) and [two](https://example.com/2)')],
    ['link inside a code span', 'see <span class="code">`[a](https://example.com/a)`</span> here'],
    ['link inside math', '<span class="math">$`[a](https://example.com/a)`$</span>'],
    [
      'link inside a macro',
      '<span class="macro"><span class="macro-delimiter">&lt;&lt;</span>[a](https://example.com/a)<span class="macro-delimiter">&gt;&gt;</span></span>',
    ],
    ['earlier-pass code span inside target', '[x](https://example.com/a<span class="code">`code`</span>)'],
    [
      'bare address with a colon after its host',
      lodash.escape('see https://alexwang.ai/posts/associative-memory/#rw=01m8:~:text=foo end'),
    ],
    ['bare address in round brackets with a colon after its host', lodash.escape('(https://example.com/a:~:text=foo)')],
    ['reference [app][a1]', lodash.escape('see [app][a1] here')],
    ['wiki link', lodash.escape('see [[docs/mind_page]] and [[docs/mind_page|MindPage]]')],
    ['x[i][j]', lodash.escape('x[i][j]')],
    ['unfinished link (address)', lodash.escape('[unfinished](https://example.com/a')],
    ['unfinished link (colon tail)', lodash.escape('[unfinished](https://example.com/a:~:text=foo')],
    ['unfinished link (tag)', lodash.escape('[unfinished](#mytag')],
    ['unfinished link (empty)', lodash.escape('[unfinished](')],
    ['ordinary link', lodash.escape(`[app](${READWISE_APP_URL})`)],
    ['double-quoted title', lodash.escape('[note](https://example.com/a "My Title")')],
    ['single-quoted title', lodash.escape("[note](https://example.com/a 'My Title')")],
    ['definition inside a code span', '<span class="code">`[w1]: https://example.com/a:~:text=x`</span>'],
    ['tag inside label', '[see <mark>#tag</mark>](https://example.com/a)'],
    ['link inside a heading title', '# <span class="title">Heading [a](https://example.com/a)</span>'],
  ]
  // sanity check: master really does colour links inside code spans, math and macros, and so do we
  expect(masterHighlightLinks('see <span class="code">`[a](https://example.com/a)`</span> here')).toContain(
    '<span class="link">[a](<span class="link">https://example.com/a</span>)</span>'
  )
  for (const [name, line] of masterLines) {
    expect(highlightLinks(line), name).toBe(masterHighlightLinks(line))
  }
})
