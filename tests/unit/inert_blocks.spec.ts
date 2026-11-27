import { expect, test } from '@playwright/test'

import { blockOpen, focusNoted, forgetSearch, holdsTag, holdsTerm, inertBlocks, remembered, renameSearch, sectionKeys, sectionName, toggled, type Toggle } from '../../src/inert_blocks.js'

// what decides whether an inert section shows open (src/inert_blocks.ts): what a manual toggle
// left while it stands, the search, the selection; a region's small name; and the keys a toggle is remembered by. The blocks themselves (the
// frames that follow each other, the head line, the click) and how long a toggle stands (until its item's
// selection or the search changes) are made of rendered frames: their rows are the collapse rows of tests/e2e/bridge.spec.ts

const open: Toggle = { open: true, selected: false, at: 1 }
const closed: Toggle = { open: false, selected: false, at: 1 }

test('a section is closed by default and open while its item is selected', () => {
  expect([blockOpen(undefined, false, false), blockOpen(undefined, false, true)]).toEqual([false, true])
})

test('what a manual toggle left decides while it stands: selected or not, and over a search match', () => {
  // [matched, selected]: a section closed by hand is closed and one opened by hand is open in all four
  const inputs = [false, true].flatMap(matched => [false, true].map(selected => [matched, selected]))
  expect(inputs.map(([matched, selected]) => [blockOpen(closed, matched, selected), blockOpen(open, matched, selected)])).toEqual(inputs.map(() => [false, true]))
})

test('with no toggle, a search match inside opens a section, selected or not', () => {
  expect([false, true].map(selected => blockOpen(undefined, true, selected))).toEqual([true, true])
})

test('a click leaves the opposite of what the section shows, with the selection it was made under', () => {
  // closed by default: opened; open by the selection: closed; open by a match: closed (never a dead click)
  expect(toggled(undefined, false, false, 1)).toEqual({ open: true, selected: false, at: 1 })
  expect(toggled(undefined, false, true, 2)).toEqual({ open: false, selected: true, at: 2 })
  expect(toggled(undefined, true, false, 3)).toEqual({ open: false, selected: false, at: 3 })
  // and a click on what a toggle left is the opposite again, which holds under the match and the selection
  const left = toggled(open, true, true, 4)
  expect(left).toEqual({ open: false, selected: true, at: 4 })
  expect(blockOpen(left, true, true)).toBe(false)
})

test('a term is found in a text without case, and no terms find nothing', () => {
  expect(holdsTerm('Reading the Code', 'code #tag')).toBe(true)
  expect(holdsTerm('reading the code', 'tree  list')).toBe(false)
  expect([holdsTerm('anything', ''), holdsTerm('anything', ' ')]).toEqual([false, false])
})

test("a region's small name is a first line of one lowercase word with more under it", () => {
  expect(['agent\n- working', 'request\ntext', 'parent\n\ntext'].map(sectionName)).toEqual(['agent', 'request', 'parent'])
  // a reply has none: a sentence, a capitalized word, a word alone, a word with its text on the line
  expect(['Here is the answer.\nmore', 'Done\nmore', 'agent', 'agent: no\nmore', 'agent plan\n- [ ] a', ''].map(sectionName)).toEqual([
    null,
    null,
    null,
    null,
    null,
    null,
  ])
})

test('a section is remembered by its name and its occurrence among that name, an unnamed one by its place among the unnamed', () => {
  // a todo made from a chat with a directive line: the request alone, then the agent's first tree above it.
  // the request keeps its key, and the new tree has one of its own (the tree does not take the request's)
  expect(sectionKeys(['request'])).toEqual(['request:0'])
  expect(sectionKeys(['agent', 'request'])).toEqual(['agent:0', 'request:0'])
  // a chat's replies have no name: the one written last has the next place, the earlier ones keep theirs
  expect(sectionKeys([null, null])).toEqual([':0', ':1'])
  expect(sectionKeys([null, null, null]).slice(0, 2)).toEqual([':0', ':1'])
  // names and replies are counted apart, each name by itself
  expect(sectionKeys(['agent', null, 'request', 'agent', null, 'parent'])).toEqual(['agent:0', ':0', 'request:0', 'agent:1', ':1', 'parent:0'])
  expect(sectionKeys([])).toEqual([])
})

test("a block remembers the latest manual toggle among its sections'", () => {
  const request: Toggle = { open: true, selected: false, at: 3 }
  // the new tree has none and the request under it was opened before: the block of the two is open
  expect(remembered([undefined, request])).toBe(request)
  expect(remembered([request, undefined])).toBe(request)
  // two sections that were toggled apart: the later toggle decides, wherever its section stands
  const later: Toggle = { open: false, selected: false, at: 5 }
  expect([remembered([request, later]), remembered([later, request])]).toEqual([later, later])
  expect([remembered([undefined, undefined]), remembered([])]).toEqual([undefined, undefined])
})

test("a child tag's mark is a match where its resolved tag is one of the terms, primary or secondary", () => {
  // the mark's title is its resolved tag (the reply reads `#/alpha`): the app's rule for a selected mark
  expect(holdsTag(['#e2e_cc/alpha', '#e2e_cc/beta'], '#e2e_cc/alpha ')).toBe(true)
  expect(holdsTag(['#E2E_cc/Alpha'], '#e2e_cc/alpha ')).toBe(true)
  expect(holdsTag(['#e2e_cc/alpha'], '#e2e_cc #e2e_cc/alpha'), 'a secondary term').toBe(true)
  // the whole tag, not a part of it: the parent's tag or a longer one is no match
  expect([holdsTag(['#e2e_cc/alpha'], '#e2e_cc '), holdsTag(['#e2e_cc/alpha'], '#e2e_cc/alpha/deep '), holdsTag(['#e2e_cc/alpha'], 'alpha ')]).toEqual([false, false, false])
  expect([holdsTag([], '#e2e_cc/alpha '), holdsTag(['#e2e_cc/alpha'], ' ')]).toEqual([false, false])
})

// THE BLOCK'S OWN LISTENERS (the press, the click, the marker's key), run without a browser over stand-ins of the
// document: just what the builder asks of an element for one unnamed section, a document that keeps its listeners
// (taken off together by their signal) and knows what has the focus. What they do on a rendered item, with a real
// press's default, is the collapse rows' (tests/e2e/bridge.spec.ts)
class Elem {
  className = ''
  tabIndex = 0
  isConnected = true
  parentElement: Elem | null = null
  children: Elem[] = []
  heard = new Map<string, (e: unknown) => void>()
  focused: (FocusOptions | undefined)[] = []
  constructor(readonly ownerDocument: Doc) {}
  get classList() {
    const names = () => new Set(this.className.split(' ').filter(Boolean))
    const toggle = (name: string, on: boolean) => {
      const set = names()
      if (on) set.add(name)
      else set.delete(name)
      this.className = [...set].join(' ')
    }
    const remove = (...drop: string[]) => {
      const set = names()
      drop.forEach(name => set.delete(name))
      this.className = [...set].join(' ')
    }
    return { contains: (name: string) => names().has(name), toggle, remove }
  }
  setAttribute() {}
  appendChild(child: Elem) {
    child.parentElement = this
    this.children.push(child)
  }
  append(...children: Elem[]) {
    children.forEach(child => this.appendChild(child))
  }
  before(sibling: Elem) {
    sibling.parentElement = this.parentElement
  }
  matches = (selector: string) => this.classList.contains(selector.slice(1))
  closest = () => null
  contains = () => false
  querySelector = () => null
  addEventListener(type: string, listener: (e: unknown) => void) {
    this.heard.set(type, listener)
  }
  focus(options?: FocusOptions) {
    this.focused.push(options)
    this.ownerDocument.activeElement = this
  }
}
class Doc {
  activeElement: Elem | null = null
  heard: [string, (e: unknown) => void][] = []
  most = 0 // the most listeners that were live at any one time
  defaultView = this // (the stand-in is its own window: the gesture's end is heard there)
  createElement = () => new Elem(this)
  addEventListener(type: string, listener: (e: unknown) => void, options: { signal: AbortSignal }) {
    const entry: [string, (e: unknown) => void] = [type, listener]
    this.most = Math.max(this.most, this.heard.push(entry))
    options.signal.addEventListener('abort', () => void this.heard.splice(this.heard.indexOf(entry), 1))
  }
}
// one block of one section in a document, with the item's editor that has the focus: the gesture's steps, and
// what the toggle did (`flips`: its reports of the height)
function staged(doc = new Doc(), id = 'item') {
  const [home, frame, editor] = [new Elem(doc), new Elem(doc), new Elem(doc)]
  home.appendChild(frame)
  let flips = 0
  const root = { ownerDocument: doc, querySelectorAll: () => [frame] } as unknown as Element
  inertBlocks(root, () => 'a reply', { id, terms: '', selected: () => false, selecting: () => false, resized: () => void flips++ })
  const block = frame.parentElement!
  const press = (button = 0) => {
    block.heard.get('mousedown')!({ button, stopPropagation() {} })
    if (!button) doc.activeElement = null // (the press's default: the focus leaves what had it)
  }
  // an event of the window's (a release, a drag's end, a cancelled pointer, a blur: the window's own, or `of`'s)
  const release = (type = 'mouseup', of: unknown = doc) => doc.heard.filter(entry => entry[0] == type).forEach(entry => entry[1]({ type, target: of }))
  const click = () => block.heard.get('click')!({ target: { closest: () => null }, preventDefault() {}, stopPropagation() {} })
  const key = () => block.children[0].children[0].heard.get('keydown')!({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  const hold = () => void (doc.activeElement = editor)
  return { doc, block, editor, press, release, click, key, hold, flips: () => flips }
}
const later = () => new Promise(resolve => setTimeout(resolve, 0)) // (past the timer a gesture's end sets)
test.beforeAll(() => void ((globalThis as any).HTMLElement = Elem))
test.afterAll(() => void delete (globalThis as any).HTMLElement)

test('a tap that toggles gives the focus back to what had it at the press, and the note of it is empty at once', async () => {
  const s = staged()
  s.hold()
  s.press()
  expect([focusNoted()?.block === (s.block as unknown), focusNoted()?.had === (s.editor as unknown), s.doc.heard.map(entry => entry[0])], 'the press notes the block and what has the focus, and waits for the release').toEqual([true, true, ['mouseup', 'dragend', 'pointercancel', 'blur']])
  s.release()
  s.click()
  expect([s.flips(), s.editor.focused, focusNoted(), s.doc.heard.length], 'the click toggles and focuses it again, without a scroll: no note, no listener left').toEqual([1, [{ preventScroll: true }], null, 0])
  await later()
  expect(focusNoted()).toBeNull()
})

test('the note of what had the focus is gone when the gesture ends, whatever ended it; an activation without a press of its own leaves the focus alone', async () => {
  const s = staged()
  // a click that never reaches the block (stopped inside it: a dangling child tag's mark; a release outside it)
  s.hold()
  s.press()
  s.release()
  await later()
  expect([focusNoted(), s.doc.heard.length], 'a release with no click on the block').toEqual([null, 0])
  // a drag the browser takes over has no release: it ends
  s.hold()
  s.press()
  s.release('dragend')
  await later()
  expect([focusNoted(), s.doc.heard.length], 'a drag').toEqual([null, 0])
  // a press that is not the primary one notes nothing
  s.hold()
  s.press(2)
  expect([focusNoted(), s.doc.heard.length], 'a secondary press').toEqual([null, 0])
  // a click with no press of its own (a scripted one), and the marker's key: they toggle, and focus nothing
  s.doc.activeElement = null
  s.click()
  s.key()
  expect([s.flips(), s.editor.focused], 'activations without a press').toEqual([2, []])
})

test("only the block of the press gives the focus back, only to an element still in the document, and an older gesture's end leaves a newer note", async () => {
  const doc = new Doc()
  const [a, b] = [staged(doc, 'item a'), staged(doc, 'item b')]
  // pressed on one block, clicked on the other: the note is taken, nothing is given back
  a.hold()
  a.press()
  a.release()
  b.click()
  expect([b.flips(), a.editor.focused, focusNoted()]).toEqual([1, [], null])
  await later()
  // the editor is closed while the press is held: its textarea is out of the document
  a.hold()
  a.press()
  a.editor.isConnected = false
  a.release()
  a.click()
  expect([a.flips(), a.editor.focused, focusNoted()]).toEqual([1, [], null])
  await later()
  // a first gesture's end, still to come, and a second press: the second note stands
  b.hold()
  b.press()
  b.release()
  b.hold()
  b.press()
  await later()
  expect(focusNoted()?.block === (b.block as unknown), "the second press's note is not the first gesture's to drop").toBe(true)
  b.release()
  b.click()
  expect(b.editor.focused).toEqual([{ preventScroll: true }])
})

test("one outstanding note at most, whatever interrupts a press: a cancelled pointer and the window's own blur end the gesture, an element's blur does not, and a new press takes the listeners of a press that never ended", async () => {
  const s = staged()
  // the press's own default blurs the editor: that blur is heard at the window too, and is no end
  s.hold()
  s.press()
  s.release('blur', s.editor)
  await later()
  expect([focusNoted()?.had === (s.editor as unknown), s.doc.heard.length], "an element's blur leaves the note and its listeners").toEqual([true, 4])
  // two interrupted presses, the editor closed between them: a cancelled pointer, then the window's blur
  s.release('pointercancel')
  await later()
  const cancelled = [focusNoted(), s.doc.heard.length]
  s.editor.isConnected = false
  s.hold()
  s.press()
  s.release('blur')
  await later()
  expect([cancelled, focusNoted(), s.doc.heard.length], 'no note and no listener after either').toEqual([[null, 0], null, 0])
  // a press that never ends at all (no event of any kind), then another: the first one's listeners are taken off
  s.hold()
  s.press()
  s.hold()
  s.press()
  expect([s.doc.heard.length, s.doc.most], 'one set of listeners, then and at any time').toEqual([4, 4])
  s.release('pointercancel')
  await later()
  // and a click with no press of its own focuses nothing
  s.doc.activeElement = null
  s.click()
  expect([s.editor.focused, focusNoted(), s.doc.heard.length]).toEqual([[], null, 0])
})

test('renameSearch moves the active search key without forgetting open toggles, while a different query still forgets them', () => {
  const s = staged(new Doc(), 'rename_item')
  const prevDocument = (globalThis as any).document
  ;(globalThis as any).document = {
    querySelectorAll: () => (s.block.classList.contains('opened') || s.block.classList.contains('closed') ? [s.block] : []),
  }
  try {
    forgetSearch(' id:tab_old')
    s.click()
    expect(s.block.classList.contains('opened'), 'manual click opens the block').toBe(true)
    renameSearch(' id:tab_old', ' id:saved_new')
    expect(s.block.classList.contains('opened'), 'renameSearch preserves an already-open toggle').toBe(true)
    forgetSearch(' id:saved_new')
    expect(s.block.classList.contains('opened'), 'same-query forgetSearch after renameSearch keeps the toggle').toBe(true)
    renameSearch(' id:unrelated', ' id:other')
    forgetSearch(' id:saved_new')
    expect(s.block.classList.contains('opened'), 'renameSearch with a non-matching old key leaves the active key alone').toBe(true)
    forgetSearch(' different_query')
    expect(s.block.classList.contains('opened'), 'a genuinely different query forgets the toggle').toBe(false)
  } finally {
    ;(globalThis as any).document = prevDocument
  }
})
