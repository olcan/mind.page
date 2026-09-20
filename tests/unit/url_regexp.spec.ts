import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'

// the bare-url rule of src/util.js: the app's pre-Markdown url rewrite (replaceURLs in
// Item.svelte's toHTML), its code-comment linkifier and the `_log`/`_output` highlighter all
// match urls with urlRegExp, which reads the browser globals `window._shortcut_hosts` and
// lodash `_` at CALL time; stub both before the calls below -- no other browser surface is touched
;(globalThis as any).window = { _shortcut_hosts: [] }
;(globalThis as any)._ = createRequire(import.meta.url)('lodash')

// @ts-expect-error util.js is plain js (the app's client lib) without a declaration file
import { urlRegExp } from '../../src/util.js'

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
