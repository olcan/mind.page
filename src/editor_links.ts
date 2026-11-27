// Editor overlay link highlighting (Editor.svelte).
// Pure module imported directly by both Editor.svelte and unit tests (tests/unit/url_regexp.spec.ts).

// @ts-ignore -- util.js is untyped; see src/zwsp.ts
import { urlRegExp } from './util.js'

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

export function highlightLinks(text: string): string {
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
  return out + linkBare(text.slice(last), last ? '>' : '')
}
