// Wiki links: `[[path]]` and `[[path|text]]` in item text open a file in the owner's editor
// (design: the vault's notes/design/wiki_links.md). A pure module: the grammar (the vault's
// bin/extract_links.py WIKILINK_PATTERN, ported), the target rule, the URL of the configured
// handler, the ONE anchor form, a Marked inline extension over a config GETTER (read at parse
// time, so one registration serves an account with or without the setting), and the config
// validation. Nothing here reads a global: index.svelte owns the setting (window._wiki_links,
// window._set_wiki_links) and the seams other renderers call (window._wiki_link_html,
// window._wiki_link_regexp).
//
// A target's fragment can select a VIEW of the path: `[[path#diff]]` asks the handler for the
// path's diff instead of the file. What the diff of a path is, the handler decides: nothing
// here knows what a path names. A view travels only in the PACKED form of the url (a setting
// whose url holds the `{link}` placeholder, see wikiLinkUrl); under any other setting the
// fragment is dropped like every other and the link is a plain file link.
//
// The anchor carries a `data-wiki-link` attribute and NO target, rel or handler: a protocol url
// with a target opens a browser tab that launches the editor and stays behind empty (the
// todoer's review link, mind.items 2026-09-20), and behavior is attached from the DOM by each
// host (Item.svelte's post-render pass, the todoer's row pass, the #vault item's table
// renderer), which also lets the inert policy keep its no-handler rule. Every anchor pass
// leaves an anchor with the attribute alone.

import type { TokenizerAndRendererExtension } from 'marked'

export type WikiLinksConfig = { url: string; root?: string }

// the grammar: an optional `!` (an embed in the vault; the same link here), a target without
// brackets, pipes or newlines (a lone bracket allowed), an optional display text after a pipe
const WIKI_LINK_SOURCE =
  '(!?)\\[\\[((?:[^\\[\\]|\\n\\r]|\\[(?!\\[)|\\](?!\\]))+)(?:\\|((?:[^\\[\\]\\n\\r]|\\[(?!\\[)|\\](?!\\]))+))?\\]\\]'
const WIKI_LINK_AT = new RegExp('^' + WIKI_LINK_SOURCE)
const WIKI_LINK_START = /!?\[\[/

// a fresh global regexp of the grammar (match groups: embed, target, text), for a text pass
// outside Marked (the todoer's rows, the #vault item's cells, the app's pre-Markdown line pass)
export function wikiLinkRegExp(): RegExp {
  return new RegExp(WIKI_LINK_SOURCE, 'g')
}

// the views a target's fragment can select: `diff` alone
export type WikiLinkView = 'diff'

// a target's two parts, or null for a refused one: the PATH (trimmed, everything from the
// first `#` dropped; a file name with a literal `#` is outside this rule) and the VIEW its
// fragment selects, which is `diff` for a fragment that is exactly `diff` and none for every
// other fragment (a heading or block reference is dropped, a backfill). The path is refused
// when it carries a `:` (any scheme, a drive letter), a backslash, html-significant
// characters, a C0 control character or DEL (C1 controls pass), a leading slash, an empty, `.`
// or `..` segment (so a trailing slash, a directory, is refused too), or nothing at all
function wikiLinkParts(target: string): { path: string; view: WikiLinkView | null } | null {
  let path = target.trim()
  let view: WikiLinkView | null = null
  const hash = path.indexOf('#')
  if (hash >= 0) {
    if (path.slice(hash + 1) === 'diff') view = 'diff'
    path = path.slice(0, hash).trim()
  }
  if (!path || path.startsWith('/')) return null
  if (/[:<>"\\\u0000-\u001f\u007f]/.test(path)) return null
  if (path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return null
  return { path, view }
}

// the accepted PATH of a target, or null for a refused one (the rule above)
export function wikiLinkTarget(target: string): string | null {
  return wikiLinkParts(target)?.path ?? null
}

// the VIEW an accepted target selects (`[[path#diff]]`: `diff`), or null: no fragment, any
// other fragment, or a refused target
export function wikiLinkView(target: string): WikiLinkView | null {
  return wikiLinkParts(target)?.view ?? null
}

// the place in a setting's url where a link's values go, packed into one text
const LINK_PLACE = '{link}'
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
// the unpadded base64url of a text's UTF-8 bytes
function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += BASE64URL[n >> 18] + BASE64URL[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += BASE64URL[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += BASE64URL[n & 63]
  }
  return out
}

// whether a setting's url takes a link's values PACKED (it holds the placeholder)
const packs = (config: WikiLinksConfig) => config.url.includes(LINK_PLACE)

// the handler's url for an accepted path, in one of two forms, by the setting's url:
// - PACKED, where the url holds `{link}`: the placeholder is replaced by ONE text, the unpadded
//   base64url of the UTF-8 JSON `{"v":1,"path":…}` with `"root"` when the setting has one and
//   `"view"` when the target selects one, and there is NO query. Letters, digits, `-` and `_`
//   pass every decoder between this page and the handler unchanged, and nothing on the way
//   finds a field in them: an editor's own url handling reads a link's query before any
//   handler does (VS Code takes a `windowId` field from it), and in a decoded query a
//   separator cannot be told from the same character inside a path, so a path's text there
//   could name the root or the view.
// - the QUERY form, for every other url: `url + '?path=' + path` and `'&root=' + root` when
//   the setting has one, each percent-encoded. It carries NO view: a link whose target selects
//   one is a plain file link under such a setting.
export function wikiLinkUrl(config: WikiLinksConfig, path: string, view?: WikiLinkView | null): string {
  if (packs(config)) {
    const link: { v: 1; path: string; root?: string; view?: WikiLinkView } = { v: 1, path }
    if (config.root) link.root = config.root
    if (view) link.view = view
    return config.url.replace(LINK_PLACE, () => base64url(JSON.stringify(link)))
  }
  let url = config.url + '?path=' + encodeURIComponent(path)
  if (config.root) url += '&root=' + encodeURIComponent(config.root)
  return url
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ESCAPES[ch])
// the grammar carrier of the inert policy (src/inert_markdown.ts grammarRefs): letters, digits
// and spaces literal, every other code point a decimal character reference. Under it a
// consumer's later text passes (a tag or url rewrite over html) find nothing to match
function refsHtml(text: string): string {
  let out = ''
  for (const ch of text) out += /[A-Za-z0-9 ]/.test(ch) ? ch : '&#' + ch.codePointAt(0) + ';'
  return out
}

// the ONE anchor form: the target's path resolved by the handler (with its view where the
// setting's url packs one, wikiLinkUrl), the path as the tooltip (`diff of <path>` when the
// link carries the diff view: the view ASKED for, since the handler decides what opens), the
// display text (the target as written without one), attributes and text through the html
// escape or, with `refs`, the inert policy's carrier; null without a config or for a refused
// target (the caller keeps its text)
export function wikiLinkHtml(
  config: WikiLinksConfig | null | undefined,
  target: string,
  text?: string | null,
  { refs = false }: { refs?: boolean } = {}
): string | null {
  if (!config) return null
  const parts = wikiLinkParts(target)
  if (parts === null) return null
  const path = parts.path
  const view = packs(config) ? parts.view : null // a view travels in the packed form alone
  const carrier = refs ? refsHtml : escapeHtml
  const shown = (text ?? '').trim() || target.trim()
  const title = view === 'diff' ? 'diff of ' + path : path
  return `<a href="${carrier(wikiLinkUrl(config, path, view))}" title="${carrier(title)}" data-wiki-link>${carrier(shown)}</a>`
}

// the Marked inline extension. Without a config it is inert (`start` finds nothing, so Marked's
// own grammar applies as before). With one, EVERY wiki-shaped span is consumed: an accepted
// target renders the anchor, a refused one renders its raw spelling as literal text (through
// the carrier), so an enabled account never sees a wiki span become other grammar (Marked
// would read `[[../x]]` over a `[../x]: url` definition as a reference link). Marked runs no
// inline tokenizer inside a code span or a code block, so code keeps its brackets
export function wikiLinkExtension(
  getConfig: () => WikiLinksConfig | null | undefined,
  { refs = false }: { refs?: boolean } = {}
): TokenizerAndRendererExtension {
  return {
    name: 'wikiLink',
    level: 'inline',
    start(src: string) {
      if (!getConfig()) return undefined
      const at = WIKI_LINK_START.exec(src)
      return at ? at.index : undefined
    },
    tokenizer(src: string) {
      if (!getConfig()) return undefined
      const m = WIKI_LINK_AT.exec(src)
      if (!m) return undefined
      return { type: 'wikiLink', raw: m[0], target: m[2], text: m[3] }
    },
    renderer(token) {
      const html = wikiLinkHtml(getConfig(), token['target'], token['text'], { refs })
      return html ?? (refs ? refsHtml : escapeHtml)(token.raw)
    },
  }
}

// the setting's shape: `url` the handler's base (`<scheme>://<host>/<path>`: a scheme of
// letters, digits, `+`, `.` and `-`, then no whitespace, quotes, `<`, `>`, `?` or `#`, since the
// query is the app's; the owner's trusted configuration, an editor's protocol or any other
// handler they choose), `root` an optional absolute path the handler resolves against (any
// non-empty text without control characters; without it the handler uses its own roots);
// other keys are dropped, anything else is null. The url may hold the placeholder `{link}`
// ONCE, in its path (after the host's slash): it selects the packed form of wikiLinkUrl. A
// second one, or one in the host, is refused. Any other brace is a character of the url like
// every other, as before: `{x}`, `{LINK}` or a lone `{` is written out as it stands
const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\/[^\s"'<>?#]+$/i
// the placeholder at most once, and then behind the first slash after the host
function linkPlaceOk(url: string): boolean {
  const at = url.indexOf(LINK_PLACE)
  if (at < 0) return true
  const host = url.indexOf('://') + 3
  const slash = url.indexOf('/', host)
  return slash >= 0 && at > slash && url.indexOf(LINK_PLACE, at + 1) < 0
}
// the editor's augmentation (src/zwsp.ts inserts U+200B, and only U+200B, into long url runs so
// they wrap) is dropped from both values: a value stored before the command path stripped it
// holds those characters. Nothing else is touched: a zero-width joiner in a root (a joined
// emoji in a directory name) or a byte-order mark is that name, not the editor's
export function parseWikiLinksConfig(value: unknown): WikiLinksConfig | null {
  if (!value || typeof value != 'object') return null
  let { url, root } = value as Record<string, unknown>
  if (typeof url == 'string') url = url.replaceAll('\u200b', '')
  if (typeof root == 'string') root = root.replaceAll('\u200b', '')
  if (typeof url != 'string' || !URL_FORM.test(url) || !linkPlaceOk(url)) return null
  if (root === undefined || root === null || root === '') return { url }
  if (typeof root != 'string' || /[\u0000-\u001f\u007f]/.test(root)) return null
  return { url, root }
}
