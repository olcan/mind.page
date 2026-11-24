// Drawn child tags for an item (pure helpers shared by Item.svelte, index.svelte and tests/unit/child_tags.spec.ts).
//
// An item with a unique label draws every direct tree child (from src/lineage.ts) as a real tag mark
// without writing them into the item's text. Whether a child is already shown visibly by another mark
// (written prose or an open agent inert section) is decided on the rendered DOM using `isMarkVisible`.
// Arrow-key navigation uses `isMarkWalkable` instead: it follows `isMarkVisible` except that marks
// inside a folded `.inert-block > .vault-result` whose enclosing block itself shows stay eligible so
// the walk order does not flip when a reply auto-opens on a matching child.
// Placement depends on the item's rendered content alone: an item that shows nothing besides its label
// mark receives its children inline right after the label; an item with any other visible content
// receives them in a block of their own below the content.

import { prefixOf } from './lineage.js'

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ESCAPE_MAP[c])
const renderTag = (tag: string) => tag.replace(/^#_?\/*(?=[^/])/, '')

// whether a rendered `<mark>` is visible in the page's layout: checks the browser's own box/display
// visibility (`checkVisibility()`, fallback `getClientRects().length > 0`) for the supported hiding
// cases (`<!--hidden-->`, `[hidden]`, closed `<details>`, folded `.inert-block` frames, closed
// `#template` toggles / `display: none`, `mark.hidden`, and `mark.child-tag.repeated`). Does NOT
// handle `visibility: hidden` (ignored so items rendered off-screen in `.column.hidden` still
// classify their own marks accurately)
export function isMarkVisible(mark: Element): boolean {
  return typeof mark.checkVisibility == 'function' ? mark.checkVisibility() : mark.getClientRects().length > 0
}

// whether a rendered `<mark>` is eligible for arrow-key navigation (`onKeyDown` only). Handles the
// supported hiding cases above (marks hidden by the owner's own CSS inside a reply, or by
// `visibility: hidden`, are NOT handled). Differs from `isMarkVisible` in one case: a mark inside a
// folded `.inert-block > .vault-result` whose enclosing `.inert-block` itself shows stays walkable,
// because such a reply opens by itself when the walk reaches a child it lists and dropping it while
// folded would flip the walk's order mid-way. Repeated drawn-tag deduplication
// (`syncRepeatedChildTags`) stays purely on `isMarkVisible` so a folded reply does not hide drawn
// children.
export function isMarkWalkable(mark: Element): boolean {
  if (isMarkVisible(mark)) return true
  const frame = mark.closest('.inert-block > .vault-result')
  return !!frame && !isMarkVisible(frame) && !!frame.parentElement && isMarkVisible(frame.parentElement)
}

// remove balanced `<div style="display: none;">...</div>` wrappers emitted by Item.svelte for
// `<!--hidden-->` sections and `*_hidden` blocks; returns null if a hidden wrapper is left unclosed
// so callers can fall back safely (never misclassify malformed HTML as name-only)
const HIDDEN_DIV_OPEN = '<div style="display: none;">'
const DIV_TAG_RE = /<\/?div\b[^>]*>/gi

function stripHiddenDivs(html: string): string | null {
  let out = ''
  let pos = 0
  while (pos < html.length) {
    const start = html.indexOf(HIDDEN_DIV_OPEN, pos)
    if (start < 0) return out + html.slice(pos)
    out += html.slice(pos, start)
    DIV_TAG_RE.lastIndex = start + HIDDEN_DIV_OPEN.length
    let depth = 1
    let m: RegExpExecArray | null
    while (depth > 0 && (m = DIV_TAG_RE.exec(html))) {
      if (m[0][1] == '/') depth--
      else depth++
    }
    if (depth > 0) return null
    pos = DIV_TAG_RE.lastIndex
  }
  return out
}

const classListOf = (attrs: string): string[] => {
  const m = /\bclass=(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
  return (m?.[1] ?? m?.[2] ?? '').split(/\s+/).filter(Boolean)
}

const stripNonMissingHiddenMarks = (html: string): string =>
  html.replace(/<mark\b([^>]*)>[\s\S]*?<\/mark>/gi, (m, attrs: string) => {
    const classes = classListOf(attrs)
    if (!classes.includes('hidden') || classes.includes('missing')) return m
    return ''
  })

// strip constructs that render no visible content on screen for the name-only placement test:
// hidden sections (`<!--hidden-->` and `*_hidden`), HTML comments, item-specific `<style>` blocks,
// hidden `_log` blocks, and non-missing hidden tag marks (a `mark.hidden.missing` IS visible as a
// red dashed tag, so it is kept and counts as visible content)
function stripNonShowing(html: string): string | null {
  const withoutHidden = stripHiddenDivs(html)
  if (withoutHidden === null) return null
  const cleaned = withoutHidden
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<pre><code class="_log">[\s\S]*?<\/code><\/pre>/gi, '')
  return stripNonMissingHiddenMarks(cleaned)
}

// whether the item's rendered content shows ONLY its own label mark and nothing else:
// hidden sections (`<!--hidden-->`, `*_hidden`), HTML comments, `<style>` blocks, `_log` blocks,
// non-missing hidden tags, blank lines (`<br>`, `&nbsp;`, whitespace, empty `<p>`s) do not count as
// content; any visible text, other mark (including `mark.hidden.missing`), list, code block, table,
// media, inert frame, script, or open wrapper HTML counts as content
export function isNameOnlyContent(contentHtml: string): boolean {
  const stripped = stripNonShowing(contentHtml)
  if (stripped === null) return false
  const compact = stripped
    .replace(/<br\s*\/?>|&nbsp;/gi, ' ')
    .replace(/<p>\s*<\/p>/gi, ' ')
    .trim()
  const m = /^<p>\s*<mark\b([^>]*)>([^<]*)<\/mark>\s*<\/p>$/i.exec(compact)
  if (!m) return false
  const classes = classListOf(m[1])
  return classes.includes('label') && !classes.includes('hidden')
}

// the cased tag of an item's label: the leading part of `header` (the item's header, or its
// labelText) that the lowercase `label` was read from. Lowercasing can lengthen a text (`İ`
// becomes two characters), so the app's labelText, a slice of the header by the lowercase
// label's length, can run past the cased tag and take in what follows it: a space and the next
// word's first letter, a colon (a quirk of the app's reading, kept as it is). The drawn children
// take each child's tag from here instead, or that letter would be drawn as a child of its own.
// The boundary is found by LENGTH, never by comparing texts: the label is parsed from the whole
// lowercased text, where a capital sigma lowercases by what follows it (`σ` or `ς`, of one width),
// so no lowercased prefix need equal the label. One pass over the header's code points, adding up
// their lowercase lengths to the label's; for every ordinary label the slice itself is returned
export function labelTextOf(header: string, label: string): string {
  const slice = header.slice(0, label.length)
  if (slice.toLowerCase().length == label.length) return slice // lowercasing kept every length
  let lower = 0
  let end = 0
  for (const point of header) {
    if (lower >= label.length) break
    lower += point.toLowerCase().length
    end += point.length
  }
  return header.slice(0, end)
}

// where a cased label's first `levels` levels end: its slash of that count (slashes keep their
// place whatever lowercasing does to a label's length), or its end
function levelsEnd(labelText: string, levels: number): number {
  let at = -1
  for (let level = 0; level < levels; level++) {
    at = labelText.indexOf('/', at + 1)
    if (at < 0) return labelText.length
  }
  return at
}
const levelsOf = (label: string) => label.split('/').length

// shorten a child's cased label relative to its parent's lowercase label, mirroring Item.svelte's
// written-tag shortening (direct child -> `#/child`, sibling/cousin under parent/grandparent ->
// `#/segment...`, else the full tag). The cased label is cut at its own slash, never by the
// lowercase label's length, which can be longer (see labelTextOf)
export function shortenChildTag(childLabelText: string, parentLabel: string): string {
  const child = childLabelText.toLowerCase()
  const rest = (above: string) => '#' + childLabelText.slice(levelsEnd(childLabelText, levelsOf(above)))
  if (parentLabel && child.startsWith(parentLabel + '/')) return rest(parentLabel)
  const parent = prefixOf(parentLabel)
  if (parent && child != parentLabel && child.startsWith(parent + '/')) return rest(parent)
  const grand = prefixOf(parent)
  if (grand && child != parentLabel && child.startsWith(grand + '/')) return rest(grand)
  return childLabelText
}

// render drawn child tags as real `<mark class="child-tag">` elements with the same attributes and
// click handler as written tags
export function renderChildMarks(id: string, parentLabel: string, children: string[]): string {
  const idArg = escapeHtml(JSON.stringify(id))
  return children
    .map(tag => {
      const reltag = shortenChildTag(tag, parentLabel)
      const tagArg = escapeHtml(JSON.stringify(escapeHtml(tag)))
      const relArg = escapeHtml(JSON.stringify(escapeHtml(reltag)))
      return (
        `<mark class="child-tag" title="${escapeHtml(tag)}" ` +
        `onmousedown="_handleTagClick(${idArg},${tagArg},${relArg},event)" ` +
        `onclick="event.preventDefault();event.stopPropagation();">${escapeHtml(renderTag(reltag))}</mark>`
      )
    })
    .join(' ')
}

// insert inline `<span class="child-tags">...</span>` immediately after the label mark of a
// name-only item, dropping any trailing `<br>` inside the same paragraph that only preceded
// non-showing elements (e.g. `#parent\n<style>...</style>`)
export function insertInlineChildTags(contentHtml: string, marksHtml: string): string {
  const re = /<mark\b([^>]*)>[^<]*<\/mark>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(contentHtml))) {
    const classes = classListOf(m[1])
    if (!classes.includes('label') || classes.includes('hidden')) continue
    const end = m.index + m[0].length
    const before = contentHtml.slice(0, end)
    let after = contentHtml.slice(end)
    const pClose = after.search(/<\/p>/i)
    if (pClose >= 0) {
      const inP = after
        .slice(0, pClose)
        .replace(/(<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->)|<br\s*\/?>/gi, (m, keep) => keep ?? '')
      after = inP + after.slice(pClose)
    }
    return `${before} <span class="child-tags">${marksHtml}</span>${after}`
  }
  return contentHtml
}
