import { expect, test } from '@playwright/test'
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
import { escapedUrlChar, escapedUrlEntity, urlRegExp } from '../../src/util.js'

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

// the editor overlay's own function, READ FROM THE COMPONENT and evaluated here (as the modal's
// is below), so the reported line goes through the REAL highlight path: updateTextDivs feeds it
// `lodash.escape(line)`, and the overlay kept showing the closing `&quot;` inside the highlighted url
// after the raw-text fix of rounds 1+2 -- the report this round started from
const highlightLinks: (text: string) => string = (() => {
  const source = readFileSync(new URL('../../src/components/Editor.svelte', import.meta.url), 'utf8')
  const picked = source.match(/\n {2}function highlightLinks\(text\) \{[\s\S]*?\n {2}\}\n/)
  if (!picked) throw new Error('function highlightLinks not found in Editor.svelte')
  return new Function('urlRegExp', `${picked[0]}\nreturn highlightLinks`)(urlRegExp)
})()

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
    ['src/components/Editor.svelte', 2, 0], // highlightLinks and the comment link_urls, over `_.escape(line)`
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
