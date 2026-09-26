// Wiki links: `[[path]]` and `[[path|text]]` in item text open a file in the owner's editor
// (design: the vault's notes/design/wiki_links.md). A pure module: the grammar (the vault's
// bin/extract_links.py WIKILINK_PATTERN, ported), the target rule, the URL of the configured
// handler, the ONE anchor form, a Marked inline extension over a config GETTER (read at parse
// time, so one registration serves an account with or without the setting), and the config
// validation. Nothing here reads a global: index.svelte owns the setting (window._wiki_links,
// window._set_wiki_links) and the seams other renderers call (window._wiki_link_html,
// window._wiki_link_regexp).
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

// the accepted PATH of a target, or null: trimmed, a `#fragment` dropped (a heading or block
// reference is a backfill; a file name with a literal `#` is outside this rule), refused when
// it carries a `:` (any scheme, a drive letter), a backslash, html-significant characters, a
// C0 control character or DEL (C1 controls pass), a leading slash, an empty, `.` or `..`
// segment (so a trailing slash, a directory, is refused too), or nothing at all
export function wikiLinkTarget(target: string): string | null {
  let path = target.trim()
  const hash = path.indexOf('#')
  if (hash >= 0) path = path.slice(0, hash).trim()
  if (!path || path.startsWith('/')) return null
  if (/[:<>"\\\u0000-\u001f\u007f]/.test(path)) return null
  if (path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return null
  return path
}

// the handler's url for an accepted path: the query is the one place its form is spelled here
// (the handler reads `path` and `root`, decoded once by its URLSearchParams)
export function wikiLinkUrl(config: WikiLinksConfig, path: string): string {
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

// the ONE anchor form: the target's path resolved by the handler, the path as the tooltip, the
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
  const path = wikiLinkTarget(target)
  if (path === null) return null
  const carrier = refs ? refsHtml : escapeHtml
  const shown = (text ?? '').trim() || target.trim()
  return `<a href="${carrier(wikiLinkUrl(config, path))}" title="${carrier(path)}" data-wiki-link>${carrier(shown)}</a>`
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
// other keys are dropped, anything else is null
const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\/[^\s"'<>?#]+$/i
// the editor's augmentation (src/zwsp.ts inserts U+200B, and only U+200B, into long url runs so
// they wrap) is dropped from both values: a value stored before the command path stripped it
// holds those characters. Nothing else is touched: a zero-width joiner in a root (a joined
// emoji in a directory name) or a byte-order mark is that name, not the editor's
export function parseWikiLinksConfig(value: unknown): WikiLinksConfig | null {
  if (!value || typeof value != 'object') return null
  let { url, root } = value as Record<string, unknown>
  if (typeof url == 'string') url = url.replaceAll('\u200b', '')
  if (typeof root == 'string') root = root.replaceAll('\u200b', '')
  if (typeof url != 'string' || !URL_FORM.test(url)) return null
  if (root === undefined || root === null || root === '') return { url }
  if (typeof root != 'string' || /[\u0000-\u001f\u007f]/.test(root)) return null
  return { url, root }
}
