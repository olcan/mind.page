// @ts-ignore -- util.js is untyped; the app tsconfig is non-strict and tolerates the import,
// while the strict tests tsconfig (check:tests) needs the suppression (its own allowJs was
// tried and rejected: it broke the existing @ts-expect-error baseline)
import { urlRegExp } from './util.js'

// the editor's textarea holds an AUGMENTED value: zero-width spaces (U+200B) are inserted into
// long unbroken url runs so they can line-wrap. these helpers own that transform and the offset
// mapping between the raw and augmented domains. every consumer that computes offsets against
// the RAW text — e.g. the `data-selection` attribute written by mind.items' MindBox
// select_in_target/edit_target — must map through zwspOffset before touching the textarea, or
// the selection is dragged back one raw character per preceding ZWSP (the todoer
// tail-truncation bug, 2026-08-29: a two-url todo lost its last ~13 characters of selection)

// inserts ZWSPs into long url runs; `insertions` (if given) records each pre-insertion offset
export function insertZWSP(text: string, insertions: number[] | null = null): string {
  return text.replace(urlRegExp({ suffix: /[^\s)<>:,.]/ }), (m: string, pfx: string, _url: string, offset: number) => {
    offset += pfx.length
    let [_, scheme, url] = _url.match(/^((?:.+?:\/\/)?)(.+)$/)! // always matches: _url is nonempty
    offset += scheme.length
    url = url.replace(/([^\u200B]{5,}?[^a-zA-Z\u200B])(?!\u200B)/g, (m: string, url_pfx: string, url_offset: number) => {
      insertions?.push(offset + url_offset) // record (pre-)insertion offset
      return url_pfx + '\u200B'
    })
    return pfx + scheme + url
  })
}

export function removeZWSP(text: string): string {
  return text.replaceAll('\u200B', '')
}

// maps an offset in the RAW text to the corresponding offset in the ZWSP-augmented `value`:
// the position after `raw` non-ZWSP characters. an offset at an insertion boundary lands
// BEFORE the ZWSP — zero-width either way, and onInput re-normalizes the augmentation
export function zwspOffset(value: string, raw: number): number {
  let i = 0
  let n = 0
  while (i < value.length && n < raw) if (value[i++] != '\u200B') n++
  return i
}
