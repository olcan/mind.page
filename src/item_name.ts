// naming an unnamed item from the MindBox (index.svelte, onEditorDone): the create key on an item
// the box names by its id (`id:<id>`), which has no unique label to nest a child under, asks for
// the item's name first. The parts that need no page are here, kept pure so their table runs
// without a browser (tests/unit/item_name.spec.ts): the typed name as a label, why a label is
// refused, the name offered, and the item's text with the label in front.

// the app's tag grammar (untyped util.js, as in src/tag_rename.ts)
// @ts-ignore
import { tagRegex } from './util.js'
import { renamableTag } from './tag_rename.js'
import { removeZWSP } from './zwsp.js'

// the offered names are `thread_0`, `thread_1`, ...: from 0, as the app numbers an item's children
const BASE = 'thread_'
const OFFERED = new RegExp(`^#${BASE}(\\d+)(?:/|$)`)
// a first line the label can join: one that starts with a tag (`#todo ...`) or with a letter
const TAG_START = new RegExp('^' + tagRegex.source.slice(1, -1))

// the name as typed, with or without its `#`, as the label the item would get: without the
// zero-width spaces that a save drops from an item's text (itemTextChanged, saveItem), which the
// tag grammar allows in a tag. Left in, a name pasted with one was checked as one label and
// stored as another: taken or `#log` after all, or missed by the creation of its child
export function nameLabel(input: string): string {
  const name = removeZWSP(input).trim()
  return name.startsWith('#') ? name : '#' + name
}

// why a label cannot name an item of an account whose items are labeled `labels`, as the dialog
// says it, or '' when it can: a name is one tag of the app's syntax in its visible, absolute form
// (renamableTag), a label is unique without case (the index keys labels in lowercase), and the
// label `#log` makes a log item, which is never named by it (itemTextChanged)
export function nameRefusal(label: string, labels: Iterable<string>): string {
  if (!renamableTag(label)) return 'Invalid name: expected a visible absolute tag like `#name` (the `#` is optional).'
  const lower = label.toLowerCase()
  if (lower == '#log') return '`#log` is reserved for log items.'
  for (const other of labels) if (other.toLowerCase() == lower) return `An item is already labeled \`${label}\`.`
  return ''
}

// the name offered: `thread_<n>` with the smallest n, from 0, that is no item's label and has no
// label nested under it (a child left behind by an item deleted or renamed since would otherwise
// be adopted by the item named now, and the new child numbered after it)
export function freeName(labels: Iterable<string>): string {
  const taken = new Set<string>()
  for (const label of labels) {
    const n = label.toLowerCase().match(OFFERED)?.[1]
    if (n !== undefined) taken.add(n)
  }
  let n = 0
  while (taken.has(String(n))) n++
  return BASE + n
}

// an item's text with the label in front, where the index reads an item's label (itemTextChanged:
// the first visible tag, at the start of the first line): on the first line when that line starts
// with a tag (`#name #todo ...`, as the owner writes it by hand) or with a letter, else on a line
// of its own, since a prefix would change what the line is (a code fence, an indented block, a
// heading, a list item, html, a macro)
export function labeledText(text: string, label: string): string {
  return label + (TAG_START.test(text) || /^\p{L}/u.test(text) ? ' ' : '\n') + text
}
