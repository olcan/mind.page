import { expect, test } from '@playwright/test'
import { Marked } from 'marked'
import {
  parseWikiLinksConfig,
  wikiLinkExtension,
  wikiLinkHtml,
  wikiLinkRegExp,
  wikiLinkTarget,
  wikiLinkUrl,
  wikiLinkView,
} from '../../src/wiki_links.js'
// @ts-expect-error the vendored table extension is plain js without a declaration file
import markedExtendedTables from '../../src/vendor/marked-extended-tables.js'

// wiki links (src/wiki_links.ts; design: the vault's notes/design/wiki_links.md): the grammar
// (the vault's bin/extract_links.py pattern), the target rule, the view a fragment selects
// (`#diff`), the handler url in its two forms (packed into the setting's `{link}` placeholder,
// else a query), the one anchor form under both carriers, the config validation,
// and the Marked extension over a real instance with the app's table extension. the browser
// witness (tests/e2e/bridge.spec.ts) checks the dom the app builds, the owner's pipeline and
// the inert frames alike.

const config = { url: 'vscode-insiders://olcan.auto-open-obsidian/file', root: '/Users/o c/v' }
const HREF = 'vscode-insiders://olcan.auto-open-obsidian/file?path=docs%2Fx&root=%2FUsers%2Fo%20c%2Fv'
const ANCHOR = `<a href="${HREF.replace(/&/g, '&amp;')}" title="docs/x" data-wiki-link>docs/x</a>`
// the vault's setting: its url holds the placeholder, which takes a link's values packed into
// ONE text (the unpadded base64url of their JSON; `pack` is node's own encoder, not the
// module's) with no query after it. The diff view of a path travels in that form alone
const packed = { url: 'vscode-insiders://olcan.auto-open-obsidian/link/{link}', root: '/Users/o c/v' }
const pack = (link: object) => Buffer.from(JSON.stringify(link)).toString('base64url')
const PACKED = (link: object) => 'vscode-insiders://olcan.auto-open-obsidian/link/' + pack(link)
const DIFF_ANCHOR = `<a href="${PACKED({ v: 1, path: 'worktrees/t', root: '/Users/o c/v', view: 'diff' })}" title="diff of worktrees/t" data-wiki-link>worktrees/t#diff</a>`
// the same reference under a url without the placeholder (the query form): a plain file link
const PLAIN_ANCHOR = `<a href="${HREF.replace('docs%2Fx', 'worktrees%2Ft').replace(/&/g, '&amp;')}" title="worktrees/t" data-wiki-link>worktrees/t#diff</a>`

// every match of the grammar in `text`: [embed, target, text]
const matches = (text: string) => [...text.matchAll(wikiLinkRegExp())].map(m => [m[1], m[2], m[3]])

test('the grammar: target, display text, embed, a lone bracket, no newline', () => {
  expect(matches('see [[docs/x]] and [[a/b|shown]]')).toEqual([
    ['', 'docs/x', undefined],
    ['', 'a/b', 'shown'],
  ])
  expect(matches('![[agents/worker]]')).toEqual([['!', 'agents/worker', undefined]])
  expect(matches('[[a]b]] [[a|b|c]]')).toEqual([
    ['', 'a]b', undefined],
    ['', 'a', 'b|c'],
  ])
  expect(matches('[[]] [[a\nb]] [[[x]]] [[a|]]')).toEqual([['', '[x', undefined]])
})

test('the target rule: paths only, fragments dropped, everything else refused', () => {
  for (const [target, path] of [
    ['docs/x', 'docs/x'],
    ['docs/x.md', 'docs/x.md'],
    [' dot/editorconfig ', 'dot/editorconfig'],
    ['a b/c d', 'a b/c d'],
    ['notes/x#heading', 'notes/x'],
    ['x#^block', 'x'],
    ['worktrees/t#diff', 'worktrees/t'], // the view's fragment is no part of the path
    ['bin/tool', 'bin/tool'],
    ['notes/A&B', 'notes/A&B'],
  ])
    expect(wikiLinkTarget(target), target).toBe(path)
  for (const target of [
    '',
    ' ',
    '#heading',
    '../x',
    'a/../b',
    './x',
    'a//b',
    'docs/',
    '/etc/passwd',
    'https://x.y/z',
    'mailto:x',
    'javascript:x',
    'C:\\x',
    'a\\b',
    '<b>',
    'a"b',
    'a\u0001b',
  ])
    expect(wikiLinkTarget(target), JSON.stringify(target)).toBeNull()
})

test('the view: a fragment that is exactly `diff`; any other is dropped; a refused target has none', () => {
  for (const target of ['worktrees/t#diff', ' worktrees/t/AGENTS#diff ', 'worktrees/t #diff', 'a b/c d.md#diff'])
    expect(wikiLinkView(target), target).toBe('diff')
  for (const target of [
    'worktrees/t',
    'x#Diff',
    'x#diffs',
    'x# diff',
    'x#diff#y',
    'x#y#diff',
    'x#^diff',
    'x#heading',
    'x#',
    // a refused path selects nothing, whatever its fragment
    '#diff',
    '../x#diff',
    'a/../b#diff',
    'docs/#diff',
    '/abs#diff',
    'https://h/x#diff',
    'a\\b#diff',
    'a<b#diff',
  ])
    expect(wikiLinkView(target), JSON.stringify(target)).toBeNull()
})

test('the url and the anchor: encoding, the root optional, no target, rel or handler', () => {
  expect(wikiLinkUrl(config, 'docs/x')).toBe(HREF)
  expect(wikiLinkUrl({ url: 'x://h/f' }, 'a b/c&d+e%f.md')).toBe('x://h/f?path=a%20b%2Fc%26d%2Be%25f.md')
  expect(wikiLinkHtml(config, 'docs/x')).toBe(ANCHOR)
  expect(wikiLinkHtml(config, 'docs/x.md', ' shown "text" ')).toBe(
    `<a href="${HREF.replace('docs%2Fx', 'docs%2Fx.md').replace(/&/g, '&amp;')}" title="docs/x.md" data-wiki-link>shown &quot;text&quot;</a>`
  ) // an explicit suffix stays: the handler resolves the path as given
  expect(wikiLinkHtml(config, 'docs/x#h', '')).toContain('>docs/x#h</a>') // an empty text shows the target as written
  // the inert carrier: letters, digits and spaces literal, everything else a reference, so a
  // consumer's tag or url pass over the html finds nothing inside the anchor
  const refs = wikiLinkHtml({ url: 'x://h/f' }, 'a b', 'see #tag <x>', { refs: true })
  expect(refs).toBe(
    '<a href="x&#58;&#47;&#47;h&#47;f&#63;path&#61;a&#37;20b" title="a b" data-wiki-link>see &#35;tag &#60;x&#62;</a>'
  )
  for (const html of [ANCHOR, refs]) expect(html).not.toMatch(/target=|rel=|\son\w+=/)
  expect(wikiLinkHtml(null, 'docs/x')).toBeNull()
  expect(wikiLinkHtml(config, '../x')).toBeNull()
})

test('the packed form: a link as one text in the placeholder, no query, the view there alone', () => {
  // the keys in this order, the root and the view only when there are any
  expect(wikiLinkUrl(packed, 'docs/x')).toBe(PACKED({ v: 1, path: 'docs/x', root: '/Users/o c/v' }))
  expect(wikiLinkUrl(packed, 'worktrees/t', 'diff')).toBe(PACKED({ v: 1, path: 'worktrees/t', root: '/Users/o c/v', view: 'diff' }))
  expect(wikiLinkUrl({ url: 'x://h/{link}/open' }, 'a')).toBe('x://h/' + pack({ v: 1, path: 'a' }) + '/open')
  // whatever the path holds (every length of the last group, text a query would read as
  // fields, a literal escape, non-ASCII), the url is the setting's with letters, digits, `-`
  // and `_` in the placeholder's place: nothing for a decoder to change or to read a field in
  for (const path of ['a', 'ab', 'abc', 'x&root=/somewhere&view=diff&windowId=_blank', 'a b/c+d=e%2e/\u00fc\u2192\u{1F600}.md', '??>>~~']) {
    const url = wikiLinkUrl(packed, path, 'diff')
    const text = url.slice('vscode-insiders://olcan.auto-open-obsidian/link/'.length)
    expect(url, path).toBe(PACKED({ v: 1, path, root: '/Users/o c/v', view: 'diff' }))
    expect(text, path).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')), path).toEqual({ v: 1, path, root: '/Users/o c/v', view: 'diff' })
  }
  // the anchor: the view on its url and in its tooltip; any other fragment selects nothing
  expect(wikiLinkHtml(packed, 'worktrees/t#diff')).toBe(DIFF_ANCHOR)
  expect(wikiLinkHtml(packed, ' worktrees/t/a b.md#diff ', 'the change')).toBe(
    `<a href="${PACKED({ v: 1, path: 'worktrees/t/a b.md', root: '/Users/o c/v', view: 'diff' })}" title="diff of worktrees/t/a b.md" data-wiki-link>the change</a>`
  )
  expect(wikiLinkHtml(packed, 'docs/x#Diff')).toBe(
    `<a href="${PACKED({ v: 1, path: 'docs/x', root: '/Users/o c/v' })}" title="docs/x" data-wiki-link>docs/x#Diff</a>`
  )
  // the inert carrier over the packed url: its `-` and `_` are references like every other sign
  const text = pack({ v: 1, path: 'worktrees/t', root: '/r', view: 'diff' })
  const refs = wikiLinkHtml({ url: 'x://h/{link}', root: '/r' }, 'worktrees/t#diff', 'the proposal', { refs: true })
  expect(refs).toBe(
    `<a href="x&#58;&#47;&#47;h&#47;${text.replace(/-/g, '&#45;').replace(/_/g, '&#95;')}" title="diff of worktrees&#47;t" data-wiki-link>the proposal</a>`
  )
  for (const html of [DIFF_ANCHOR, refs]) expect(html).not.toMatch(/target=|rel=|\son\w+=/)
  expect(wikiLinkHtml(packed, '../x#diff')).toBeNull() // a refused target stays the caller's text
  expect(wikiLinkHtml(null, 'worktrees/t#diff')).toBeNull()
})

test('the query form carries no view: a `#diff` reference is a plain file link there', () => {
  expect(wikiLinkUrl(config, 'worktrees/t', 'diff')).toBe(HREF.replace('docs%2Fx', 'worktrees%2Ft'))
  expect(wikiLinkUrl({ url: 'x://h/f' }, 'worktrees/t', 'diff')).toBe('x://h/f?path=worktrees%2Ft')
  expect(wikiLinkHtml(config, 'worktrees/t#diff')).toBe(PLAIN_ANCHOR) // the tooltip the path's too
  expect(wikiLinkHtml({ url: 'x://h/f', root: '/r' }, 'worktrees/t#diff', 'the proposal', { refs: true })).toBe(
    '<a href="x&#58;&#47;&#47;h&#47;f&#63;path&#61;worktrees&#37;2Ft&#38;root&#61;&#37;2Fr" title="worktrees&#47;t" data-wiki-link>the proposal</a>'
  )
})

test('the config: a handler url with a scheme and no query, an optional root', () => {
  expect(parseWikiLinksConfig(config)).toEqual(config)
  expect(parseWikiLinksConfig({ url: 'vscode://olcan.auto-open-obsidian/file', root: '', extra: 1 })).toEqual({
    url: 'vscode://olcan.auto-open-obsidian/file',
  })
  expect(parseWikiLinksConfig({ url: 'x+y.z-1://h', root: null })).toEqual({ url: 'x+y.z-1://h' })
  // the editor's zero-width spaces (U+200B, inserted into long url runs after `.`, `-` and `/`)
  // are dropped from both values, so the url an account stored before the command path stripped
  // them (the live one of 2026-09-26) still resolves; every other character is the value's own,
  // a zero-width joiner (a joined emoji in a directory name), a non-joiner or a byte-order mark
  // included (review 3: deleting those would select a different directory)
  expect(
    parseWikiLinksConfig({ url: 'vscode-insiders://olcan.\u200bauto-open-\u200bobsidian/\u200bfile', root: '/Users/olcan/\u200bvault' })
  ).toEqual({ url: 'vscode-insiders://olcan.auto-open-obsidian/file', root: '/Users/olcan/vault' })
  for (const root of ['/Users/olcan/dev\u{1F469}\u200D\u{1F4BB}', '/Users/olcan/a\u200cb', '/Users/olcan/\ufeffvault'])
    expect(parseWikiLinksConfig({ url: 'x://h/f', root }), JSON.stringify(root)).toEqual({ url: 'x://h/f', root })
  // the placeholder: once, in the path, wherever there; any other brace is a character of the
  // url like every other and selects nothing (the query form, the brace written out)
  for (const url of ['x://h/link/{link}', 'x://h/{link}/open', 'x://h/a{link}b', 'x://h/{x}/f', 'x://h/{LINK}', 'x://h/{'])
    expect(parseWikiLinksConfig({ url, root: '/r' }), url).toEqual({ url, root: '/r' })
  expect(wikiLinkUrl({ url: 'x://h/{x}/f' }, 'a')).toBe('x://h/{x}/f?path=a')
  for (const value of [
    null,
    'x://h',
    {},
    { url: 'h/f' },
    { url: 'x://h/{link}/{link}' },
    { url: 'x://{link}/f' },
    { url: 'x://{link}' },
    { url: 'x://h/f?q=1' },
    { url: 'x://h/f#a' },
    { url: 'x://h/f g' },
    { url: 'javascript:alert(1)' },
    { url: 'x://h/f', root: 7 },
    { url: 'x://h/f', root: '/a\u0000b' },
  ])
    expect(parseWikiLinksConfig(value), JSON.stringify(value)).toBeNull()
})

test('the Marked extension: links in prose, cells and items; code untouched; refused spans literal', () => {
  let current: { url: string; root?: string } | null = config
  const marked = new Marked({ gfm: true })
  marked.use(markedExtendedTables())
  marked.use({ extensions: [wikiLinkExtension(() => current)] })
  const html = (text: string) => marked.parse(text, { async: false }) as string
  expect(html('see [[docs/x]] now')).toBe(`<p>see ${ANCHOR} now</p>\n`)
  expect(html('![[docs/x]]')).toBe(`<p>${ANCHOR}</p>\n`) // the embed's mark is consumed
  expect(html('[[docs/x|shown]]')).toContain('data-wiki-link>shown</a>')
  expect(html('- [[docs/x]]\n')).toContain(`<li>${ANCHOR}</li>`)
  // a table cell: the standard escaped pipe spells the alias (the table splits cells first)
  expect(html('| a |\n| - |\n| [[docs/x]] |\n')).toContain(`<td>${ANCHOR}</td>`)
  expect(html('| a |\n| - |\n| [[docs/x\\|shown]] |\n')).toContain('<td><a href="' + HREF.replace(/&/g, '&amp;') + '" title="docs/x" data-wiki-link>shown</a></td>')
  expect(html('`[[docs/x]]` and\n\n```\n[[docs/x]]\n```\n')).not.toContain('<a ')
  // a refused span is consumed and shown as written (never other grammar), an unmatched one is Marked's
  expect(html('[[../x]] [[/abs]] [[a<b]] [[]]')).toBe('<p>[[../x]] [[/abs]] [[a&lt;b]] [[]]</p>\n')
  expect(html('[[../foo]]\n\n[../foo]: https://example.com')).toBe('<p>[[../foo]]</p>\n')
  expect(html('[x][y]\n\n[y]: https://h/')).toBe('<p><a href="https://h/">x</a></p>\n') // Marked's own reference link
  // a `#diff` reference: a plain file link under this setting (the query form), the diff view
  // under a url with the placeholder, in prose and under an alias; a refused target is text
  expect(html('see [[worktrees/t#diff]] now')).toBe(`<p>see ${PLAIN_ANCHOR} now</p>\n`)
  current = packed
  expect(html('see [[worktrees/t#diff]] now')).toBe(`<p>see ${DIFF_ANCHOR} now</p>\n`)
  expect(html('[[worktrees/t#diff|the proposal]]')).toBe(`<p>${DIFF_ANCHOR.replace('>worktrees/t#diff<', '>the proposal<')}</p>\n`)
  expect(html('[[../x#diff]] [[/abs#diff|shown]]')).toBe('<p>[[../x#diff]] [[/abs#diff|shown]]</p>\n')
  // unconfigured: inert, Marked's grammar as before (the reference link included)
  current = null
  expect(html('see [[docs/x]] now')).toBe('<p>see [[docs/x]] now</p>\n')
  expect(html('[[../foo]]\n\n[../foo]: https://example.com')).toBe('<p>[<a href="https://example.com">../foo</a>]</p>\n')
})
