import { expect, test } from '@playwright/test'

import _ from 'lodash'

// parseTags (util.js: the app's own parser, which every row below is read back with) reads the
// browser globals `_` (lodash) and `window._shortcut_hosts` at call time; stub both before the calls
;(globalThis as any)._ = _
;(globalThis as any).window = { _shortcut_hosts: [] }

// @ts-expect-error util.js is plain js (the app's client lib) without a declaration file
import { parseLabel, parseTags } from '../../src/util.js'
import { encodeInert, scanInert } from '../../src/inert.js'
import { renamableTag, renameConflicts, renamedTag, renameTag } from '../../src/tag_rename.js'

// the matching and the replacing behind `/_rename #tag #new_tag` (src/tag_rename.ts): a tag is
// renamed where the item index reads one and nowhere else

// the tags the index reads in a text (itemTextChanged: parseTags over the lowercased grammar view)
const indexed = (text: string): string[] => parseTags(scanInert(text).grammarText.toLowerCase()).raw

// a text is renamed to exactly `expected`, and the index then reads the renamed tags it read before
function renames(text: string, expected: string, from = '#tag', to = '#new_tag') {
  const renamed = renameTag(text, from, to)
  expect(renamed, text).toBe(expected)
  const tags = indexed(text).map(tag => renamedTag(tag, from, to).toLowerCase())
  expect(indexed(renamed), text).toEqual([...new Set(tags)])
}
const kept = (text: string) => renames(text, text)

test('the whole tag is renamed wherever it stands, what delimits it kept', () => {
  renames('#tag', '#new_tag')
  renames('a #tag b', 'a #new_tag b')
  renames('#tag\n#tag\n\n\t#tag #tag', '#new_tag\n#new_tag\n\n\t#new_tag #new_tag')
  renames('(#tag) #tag, #tag. #tag! #tag: "x"', '(#new_tag) #new_tag, #new_tag. #new_tag! #new_tag: "x"')
})

test('a tag nested under it is renamed by its parent prefix, the levels below kept', () => {
  renames('#tag/x #tag/x/y #tag/', '#new_tag/x #new_tag/x/y #new_tag/')
  renames('#a/b #a/b/c #a/bc #a', '#z #z/c #a/bc #a', '#a/b', '#z') // a nested tag renamed, its parent and its look-alike not
  renames('#tag #tag/x', '#tag/new #tag/new/x', '#tag', '#tag/new') // one pass: a renamed tag is not read again
})

test('a longer tag that only starts with it, or holds it at another level, is another tag', () => {
  kept('#tagger #tag_x #tag-1 #tags #tag2/x #ta #xtag #x/tag #x/tag/y')
})

test('text the index reads no tag in is left as written', () => {
  kept('see `#tag` and $`#tag`$')
  kept('```js\nconst item = _item("#tag") // #tag\n```')
  kept('    #tag on an indented code line')
  kept('<a href="#tag">x</a> <b>#tag</b> <!-- #tag -->')
  kept('<SCRIPT>\nlet a = " #tag "\n</SCRIPT>\n<style>\n #tag { color: red }\n</style>')
  kept('<<link( #tag )>> @{ #tag }@')
  kept('https://example.com/#tag word#tag a/#tag "#tag" [#tag] ##tag')
  // an inert region (the bridge's replies) is opaque to the index: its bytes stay, the text around it is renamed
  const region = encodeInert('a reply naming #tag and #tag/x')
  renames(`#tag asks\n${region}\n#tag again`, `#new_tag asks\n${region}\n#new_tag again`)
})

test('several occurrences in one item are all renamed, each as its own form says', () => {
  renames(
    '#tag/sub #_tag the label line\nsee #tag, #tag/a and `#tag` (#tag)\n- #tagger stays',
    '#new_tag/sub #_new_tag the label line\nsee #new_tag, #new_tag/a and `#tag` (#new_tag)\n- #tagger stays',
  )
})

test('the label is renamed with the tag: the item is named by the new tag, or stays under the renamed parent', () => {
  // the label the app reads before and after (parseLabel, as /_install reads one), in the text's case
  const label = (text: string) => parseLabel(text, true /* keep_case */)
  const relabels = (text: string, expected: string, labels: [string, string]) => {
    renames(text, expected)
    expect([label(text), label(expected)], text).toEqual(labels)
  }
  relabels('#tag the label line\nbody', '#new_tag the label line\nbody', ['#tag', '#new_tag'])
  relabels('#Tag/Sub #_dep\nbody #tag', '#new_tag/Sub #_dep\nbody #new_tag', ['#Tag/Sub', '#new_tag/Sub'])
  relabels('<span class="x"></span> #tag styled', '<span class="x"></span> #new_tag styled', ['#tag', '#new_tag'])
  relabels('#other mentions #tag', '#other mentions #new_tag', ['#other', '#other']) // another item's label stays
  relabels('no label, a mention of #tag', 'no label, a mention of #new_tag', ['', ''])
})

test('case: a tag is matched without case, as the index reads it; the new tag and the levels below are kept as written', () => {
  renames('#Tag #TAG/Sub #tAg/X #Tagger', '#new_tag #new_tag/Sub #new_tag/X #Tagger')
  renames('#tag #Tag/x', '#New #New/x', '#TAG', '#New')
  renames('#tag #Tag #TAG', '#Tag #Tag #Tag', '#tag', '#Tag') // a change of case alone
  renames('İstanbul #Tag', 'İstanbul #new_tag') // a lowercase longer than its capital shifts no offset
})

test('the hidden form is the same tag and is renamed in its form', () => {
  renames('#_tag #_tag/x #_Tag', '#_new_tag #_new_tag/x #_new_tag')
  kept('#_tagger #_x/tag #__tag') // `#__tag` hides the tag `#_tag`, which is not `#tag`
})

test('a relative tag is left as written: it names another tag in every item', () => {
  kept('#/tag #//tag #///tag #_/tag')
})

test('one tag as renamed', () => {
  const renamed = (tag: string) => renamedTag(tag, '#tag', '#new_tag')
  const tags = ['#tag', '#tag/x', '#TAG/X', '#_tag', '#_tag/x']
  expect(tags.map(renamed)).toEqual(['#new_tag', '#new_tag/x', '#new_tag/X', '#_new_tag', '#_new_tag/x'])
  const others = ['#tagger', '#ta', '#x/tag', '#_tagger', '#__tag', '#/tag', '#', '']
  expect(others.map(renamed)).toEqual(others)
})

test('the command takes visible, absolute tags of the app syntax', () => {
  for (const tag of ['#tag', '#tag/x', '#new_tag', '#a-b', '#θ', '#a//b']) expect(renamableTag(tag), tag).toBe(true)
  for (const tag of ['', 'tag', '#', '#a.b', '#a,b', '#a#b', '#a b', '#_tag', '#_tag/x', '#/tag', '#//tag', '#tag/'])
    expect(renamableTag(tag), tag).toBe(false)
})

test('the labels a rename would give to more than one item', () => {
  const conflicts = (labels: string[], from = '#tag', to = '#new_tag') => renameConflicts(labels, from, to)
  expect(conflicts(['#tag', '#tag/a', '#other', '', ''])).toEqual([])
  expect(conflicts(['#tag', '#new_tag', '#tag/a', '#new_tag/a', '#new_tag/b'])).toEqual(['#new_tag', '#new_tag/a'])
  expect(conflicts(['#tag', '#tag'])).toEqual(['#new_tag']) // shared before, and still
  expect(conflicts(['#x', '#x', '#tag'])).toEqual([]) // a label the rename gives to no item
  expect(conflicts(['#tag', '#new'], '#TAG', '#New')).toEqual(['#New']) // without case, shown as renamed
  expect(conflicts(['#tag'], '#tag', '#Tag')).toEqual([]) // a change of case alone
})
