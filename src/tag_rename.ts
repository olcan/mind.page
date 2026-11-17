// `/_rename #tag #new_tag` (index.svelte): the matching and the replacing behind the command, kept
// pure so their table runs without a browser (tests/unit/tag_rename.spec.ts). A tag is renamed
// where the item index reads a tag: the pattern is parseTags' own (src/util.js, its exclusions
// included) over the inert grammar view (src/inert.ts), the text itemTextChanged parses. The
// two agree for text whose lowercase differs from it by case alone. They can differ for a few
// non-ASCII letters (review 0 of the thread tag_rename), because the index parses the LOWERCASED
// text and this matches the text as written: an html tag named with a letter whose lowercase is
// an ASCII letter (`İ`, the Kelvin sign) is no exclusion here, so a tag inside it is renamed
// though the index reads none; and a capital sigma lowercases by its place in the whole text
// (`#ΟΣ.A` is indexed as `#οσ`), which neither argument, lowercased alone, reproduces.

// the app's tag grammar (untyped util.js, as in src/inert.ts)
// @ts-ignore
import { tagRegex, tagRegexExclusions } from './util.js'
import { editInertText } from './inert.js'

// parseTags' pattern with the tag's prefix captured (to put it back) and the `i` flag: the index
// parses the LOWERCASED text, which a replacement cannot do (a text holding a character whose
// lowercase is longer, `İ`, has other offsets), so the text is matched as written and the flag
// reads the exclusions' ASCII letters (`script`, `style`, an html tag's name) as the lowercased
// text has them; a non-ASCII letter that lowercases to an ASCII one is the difference above
const TAGS = new RegExp(tagRegexExclusions + '|(^|\\s|\\()(' + tagRegex.source.slice(1, -1) + ')', 'gis')

// a tag the command takes: one tag of the app's syntax in its visible, absolute form. The hidden
// form (`#_tag`, a dependency) is the same tag and is renamed with it; a relative tag (`#/tag`)
// names a different tag in every item; a trailing slash names no level
export function renamableTag(tag: string): boolean {
  return tagRegex.test(tag) && !/^#[_\/]/.test(tag) && !tag.endsWith('/')
}

// one tag as the rename leaves it: `to` in place of `from` when the tag IS `from` or is nested
// under it, by whole levels (`#tagger` and `#tag_x` are other tags) and without case, as the index
// compares tags (item.lctext); the levels below and the hidden form are kept as written
export function renamedTag(tag: string, from: string, to: string): string {
  const hidden = tag.startsWith('#_') // parseTags: `#_tag` is the tag `#tag`, hidden
  const levels = (hidden ? '#' + tag.slice(2) : tag).split('/')
  const depth = from.split('/').length
  if (levels.slice(0, depth).join('/').toLowerCase() != from.toLowerCase()) return tag
  const renamed = [to, ...levels.slice(depth)].join('/')
  return hidden ? '#_' + renamed.slice(1) : renamed
}

// an item's text with the tag renamed at every place the index reads a tag: nothing inside an
// exclusion (code, math, html, a macro) or an inert region changes, nor a tag glued to other text
export function renameTag(text: string, from: string, to: string): string {
  return editInertText(text, grammar =>
    grammar.replace(TAGS, (match: string, prefix: string, tag?: string) =>
      tag === undefined ? match : prefix + renamedTag(tag, from, to),
    ),
  )
}

// the labels, as renamed, that more than one item would carry once the rename has given them to
// at least one of those items: the app keeps such items, but a label names an item only while it
// is unique (idsFromLabel), so none of them is found by it or resolves as a dependency any more
export function renameConflicts(labels: string[], from: string, to: string): string[] {
  const renamed = labels.filter(label => label).map(label => [label, renamedTag(label, from, to)])
  const counts = new Map<string, number>()
  for (const [, label] of renamed) counts.set(label.toLowerCase(), (counts.get(label.toLowerCase()) ?? 0) + 1)
  const shared = renamed.filter(([was, label]) => label != was && counts.get(label.toLowerCase())! > 1)
  return [...new Set(shared.map(([, label]) => label))]
}
