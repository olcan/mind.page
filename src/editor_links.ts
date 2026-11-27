// Editor overlay link highlighting (Editor.svelte).
// Pure module imported directly by both Editor.svelte and unit tests
// (tests/unit/url_regexp.spec.ts, tests/unit/editor_links.spec.ts).

// @ts-ignore -- util.js is untyped; see src/zwsp.ts
import { urlRegExp } from './util.js'
import { wikiLinkRegExp, wikiLinkTarget } from './wiki_links.js'

// HTML-escaped Markdown title (`"..."`, `'...'`, or `(...)`) and angle-bracketed destination `<...>`
// with disjoint branches at every step so unmatched quotes/brackets scan in linear time
const TITLE_SRC =
  '(?:&quot;(?:\\\\(?:&quot;|(?!&quot;)[^\\n])|(?!&quot;)[^\\\\\\n])*&quot;' +
  '|&#39;(?:\\\\(?:&#39;|(?!&#39;)[^\\n])|(?!&#39;)[^\\\\\\n])*&#39;' +
  '|\\((?:\\\\[^\\n]|[^()\\\\\\n])*\\))'
const ANGLE_DEST_SRC = '&lt;(?:\\\\(?:&(?:lt|gt);|(?!&(?:lt|gt);)[^<>\\n])|(?!&(?:lt|gt);)[^<>\\\\\\n])+&gt;'

const DEF_LINE = new RegExp(
  `^( {0,3}\\[(?!\\s*\\])(?:\\\\.|[^\\[\\]\\\\])+\\]:[ \\t]*)(${ANGLE_DEST_SRC}|[^\\s<>]+)((?:[ \\t]+${TITLE_SRC})?[ \\t]*)$`
)
const ANGLE_DEST_RE = new RegExp(ANGLE_DEST_SRC, 'y')
const AFTER_DEST_RE = new RegExp(`((?:[ \\t]+${TITLE_SRC})?[ \\t]*)\\)`, 'y')

// scan a bare Markdown link destination starting at `start`, keeping balanced round brackets inside;
// returns its end index and whether an earlier-pass HTML tag stopped it, or null if malformed
function scanBareDest(text: string, start: number): { end: number; hitTag: boolean } | null {
  let p = start
  let depth = 0
  while (p < text.length) {
    const ch = text[p]
    if (ch == '\n') return null
    if (ch == '<' || ch == '>') return depth == 0 && p > start ? { end: p, hitTag: true } : null
    if (ch == '\\') {
      if (p + 1 < text.length && text[p + 1] != '\n') {
        p += 2
        continue
      }
      return null
    }
    if (ch == '(') {
      depth++
      p++
      continue
    }
    if (ch == ')') {
      if (depth > 0) {
        depth--
        p++
        continue
      }
      break
    }
    if (ch == ' ' || ch == '\t') {
      if (depth > 0) return null
      break
    }
    p++
  }
  return depth == 0 && p > start ? { end: p, hitTag: false } : null
}

export function highlightLinks(text: string, defs?: ReadonlySet<string> | null): string {
  // same options as in Editor.svelte's comment link_urls, see comments there
  const bareUrl = urlRegExp({ suffix: /[^\s)<>:,."]/, escaped: true })
  const startsWithUrl = new RegExp(`^(?:${bareUrl.source})`, 'i')
  const isUrlStart = (s: string): boolean => {
    const m = s.match(startsWithUrl)
    return !!m && !m[1]
  }
  const linkBare = (s: string, prefix = ''): string =>
    (prefix + s)
      .replace(bareUrl, (_m: string, pfx: string, href: string) => pfx + `<span class="link">${href}</span>`)
      .slice(prefix.length)

  // link reference definition line (0-3 spaces, `[label]: dest [title]`): colour the whole
  // destination as one bare-address span whenever the bare pattern begins to match it
  const defLine = text.match(DEF_LINE)
  if (defLine) {
    const rawDest = defLine[2]
    const angle = rawDest.startsWith('&lt;') && rawDest.endsWith('&gt;')
    const inner = angle ? rawDest.slice(4, -4) : rawDest
    if (isUrlStart(inner)) {
      const wrapped = angle ? `&lt;<span class="link">${inner}</span>&gt;` : `<span class="link">${inner}</span>`
      return `${linkBare(defLine[1])}${wrapped}${linkBare(defLine[3], '>')}`
    }
  }

  // inside a markdown link, urlRegExp stops before a colon after the host (e.g. a text fragment's
  // `:~:text=`), leaving the tail blue instead of grey; wrap the whole destination (keeping balanced
  // round brackets inside it, and leaving any title and the link's own closing `)` outside the inner
  // span) whenever the bare pattern begins to match it, and keep master's matching everywhere else
  const mdLabelRe = /(\[(?:[^\]]|\\\])*[^\\])(\]\()/g
  const masterTargetRe = /((?:[^\)]|\\\))*[^\\)])\)/y
  let out = ''
  let last = 0
  let lm: RegExpExecArray | null
  while ((lm = mdLabelRe.exec(text))) {
    const [, label, mid] = lm
    const targetStart = mdLabelRe.lastIndex
    let destStart = targetStart
    while (destStart < text.length && (text[destStart] == ' ' || text[destStart] == '\t')) destStart++
    const ws1 = text.slice(targetStart, destStart)

    let innerTarget: string | null = null
    let end = -1

    ANGLE_DEST_RE.lastIndex = destStart
    const angleMatch = text.startsWith('&lt;', destStart) ? ANGLE_DEST_RE.exec(text) : null
    if (angleMatch && isUrlStart(angleMatch[0].slice(4, -4))) {
      AFTER_DEST_RE.lastIndex = ANGLE_DEST_RE.lastIndex
      const after = AFTER_DEST_RE.exec(text)
      if (!after) continue
      const inner = angleMatch[0].slice(4, -4)
      innerTarget = `${ws1}&lt;<span class="link">${inner}</span>&gt;${linkBare(after[1], '>')}`
      end = AFTER_DEST_RE.lastIndex
    } else if (!angleMatch && isUrlStart(text.slice(destStart))) {
      const scanned = scanBareDest(text, destStart)
      if (!scanned) continue
      const dest = text.slice(destStart, scanned.end)
      if (scanned.hitTag) {
        masterTargetRe.lastIndex = scanned.end
        const tail = masterTargetRe.exec(text)
        if (!tail) continue
        innerTarget = `${ws1}<span class="link">${dest}</span>${linkBare(tail[1], '>')}`
        end = masterTargetRe.lastIndex
      } else {
        AFTER_DEST_RE.lastIndex = scanned.end
        const after = AFTER_DEST_RE.exec(text)
        if (!after) continue
        innerTarget = `${ws1}<span class="link">${dest}</span>${linkBare(after[1], '>')}`
        end = AFTER_DEST_RE.lastIndex
      }
    } else {
      // non-address markdown link: exact master target rule
      masterTargetRe.lastIndex = targetStart
      const tm = masterTargetRe.exec(text)
      if (!tm) continue
      innerTarget = linkBare(tm[1], '(')
      end = masterTargetRe.lastIndex
    }

    out += linkBare(text.slice(last, lm.index), last ? '>' : '')
    out += `<span class="link">${linkBare(label, '>')}${mid}${innerTarget})</span>`
    last = end
    mdLabelRe.lastIndex = last
  }
  const result = out + linkBare(text.slice(last), last ? '>' : '')
  return defs ? highlightRefsAndWikis(result, defs) : result
}

const lodash = (): { unescape: (s: string) => string } =>
  (globalThis as unknown as { _: { unescape: (s: string) => string } })._

// Same single-line definition shape (`0-3` spaces, `[label]: dest [title]`) as `DEF_LINE`,
// over raw item text. One pass over lines: no block, fence, paragraph or comment state.
const DEF_LINE_RAW =
  /^ {0,3}\[((?!\s*\])(?:\\.|[^\[\]\\])+)\]:[ \t]*(?:<(?:\\.|[^<>\\\n])+>|[^\s<>]+)(?:[ \t]+(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\((?:\\.|[^()\\\n])*\)))?[ \t]*$/

const normLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase()

export function collectLinkDefs(text: string): Set<string> {
  const defs = new Set<string>()
  for (const line of text.split('\n')) {
    const def = DEF_LINE_RAW.exec(line)
    if (def) defs.add(normLabel(def[1]))
  }
  return defs
}

const REF_LINK_RE =
  /\[(?:<mark>[^<]*<\/mark>|<span class="code">[^<]*<\/span>|\\.|[^\[\]\\<>\n])+\]\[(?!\s*\])((?:<mark>[^<]*<\/mark>|\\.|[^\[\]\\<>\n])+)\]/y
const WIKI_LINK_RE = new RegExp(wikiLinkRegExp().source, 'y')
const NEW_SHAPE_TOKEN_RE = /<span class="(?:link|code|math|macro|hljs-[^"]*)">|!?\[\[|\[/g
const SPAN_TAG_RE = /<\/?span\b[^>]*>/g

function endOfSpan(html: string, start: number): number {
  SPAN_TAG_RE.lastIndex = start
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = SPAN_TAG_RE.exec(html))) {
    depth += m[0][1] == '/' ? -1 : 1
    if (depth == 0) return m.index + m[0].length
  }
  return html.length
}

function isEscaped(text: string, pos: number): boolean {
  let n = 0
  while (pos - 1 - n >= 0 && text[pos - 1 - n] == '\\') n++
  return n % 2 == 1
}

function highlightRefsAndWikis(html: string, defs: ReadonlySet<string>): string {
  if (!html.includes('[')) return html
  let out = ''
  let last = 0
  NEW_SHAPE_TOKEN_RE.lastIndex = 0
  let tm: RegExpExecArray | null
  while ((tm = NEW_SHAPE_TOKEN_RE.exec(html))) {
    const idx = tm.index
    if (tm[0][0] == '<') {
      NEW_SHAPE_TOKEN_RE.lastIndex = endOfSpan(html, idx)
      continue
    }
    if (tm[0].endsWith('[[') && !isEscaped(html, idx)) {
      WIKI_LINK_RE.lastIndex = idx
      const wm = WIKI_LINK_RE.exec(html)
      if (wm && !/[<>]/.test(wm[0].replace(/<\/?mark>/g, ''))) {
        const end = idx + wm[0].length
        if (wikiLinkTarget(lodash().unescape(wm[2].replace(/<\/?mark>/g, ''))) !== null) {
          out += html.slice(last, idx) + `<span class="link">${wm[0]}</span>`
          last = end
        }
        NEW_SHAPE_TOKEN_RE.lastIndex = end
        continue
      }
    }
    if (html[idx] == '[' && defs.size > 0 && !isEscaped(html, idx)) {
      REF_LINK_RE.lastIndex = idx
      const rm = REF_LINK_RE.exec(html)
      if (rm) {
        const key = normLabel(lodash().unescape(rm[1].replace(/<\/?mark>/g, '')))
        if (defs.has(key)) {
          out += html.slice(last, idx) + `<span class="link">${rm[0]}</span>`
          last = idx + rm[0].length
          NEW_SHAPE_TOKEN_RE.lastIndex = last
          continue
        }
      }
    }
    NEW_SHAPE_TOKEN_RE.lastIndex = idx + 1
  }
  return last ? out + html.slice(last) : html
}
