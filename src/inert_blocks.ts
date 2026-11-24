// INERT SECTIONS THAT CLOSE (the owner, 2026-11-19: a running item's inert sections take most
// of its space while it stands at the top of the page). The dead frames of an item's inert
// regions (src/inert.ts; rendered by src/inert_markdown.ts into Item.svelte's `.vault-result`
// elements) are presented as BLOCKS: a block is one frame, or the frames that follow each other
// with nothing but blank lines between them (an agent's tree and the request under it), under
// ONE head line. Closed, a block is that one line: the first section's small name where it has
// one, and its STATUS LINE (the first line of what the section shows, with its links). Open, it
// is the sections, each under its small name (the first one's is the head's; a section without
// one, a reply, starts with its own first line). A CLICK OR A TAP ANYWHERE ON THE BLOCK toggles
// it, closed or open (the owner, 2026-11-20: as the #template item's toggle() does), unless
// something inside took it (a link, which is followed; a child tag's mark, whose click its
// frame stops) or a text selection made it no tap. No arrow shows: the block's MARKER is its
// disclosure control for a keyboard and a reader alone (a focusable button by its role, named
// after the section, that says whether the block is open: `sayExpanded`), laid over the block,
// where it takes no press and shows as a ring under a keyboard's focus. Nothing else in a
// section acts, as before.
//
// WHAT DECIDES (blockOpen, and the same rule in Item.svelte's css over the block's classes):
//   1. a MANUAL toggle, while it stands, decides, also over a search match (a click on a section
//      is never a dead one);
//   2. else a match of the current search inside the block opens it for as long as the match
//      lasts: one of the search's terms in a section's text (holdsTerm), or a child tag's mark in
//      it whose resolved tag is one of the terms (holdsTag: the mark the app shows selected);
//   3. else the block is open while its item is selected (the app's target) and closed otherwise.
// A manual toggle STANDS through every redraw of its item (the new block reads `toggles`), until
// its item's selection changes (that item's toggles are forgotten: forgetSelection) or the search
// changes in any way (every toggle is forgotten: forgetSearch); it then leaves the page with the
// memory (unmark). Nothing else is remembered: `toggles` below, in this module, so in the tab's
// memory, by item id and SECTION (sectionKeys), written for every section of the toggled block; a
// block shows the latest of its sections' (remembered). An item shown as the selected one's
// CONTEXT is not selected: nothing here reads that.
//
// Nothing of an item's text is read or changed here, and nothing of the grammar: the blocks are
// made of the rendered frames, after every (re)population of them (Item.svelte afterUpdate).

// what a manual toggle left: the state, its item's selection when it was made, and its turn among
// the tab's manual toggles (the later one decides where the sections of one block remember
// different ones)
export type Toggle = { open: boolean; selected: boolean; at: number }

const toggles = new Map<string, Toggle>()
let turn = 0

// a region's SMALL NAME: its body's first line where that is one lowercase word with more under
// it (`agent` over a task's tree, `request`, `parent`: the vault's lib/mindpage_task_edit.py);
// a reply has none
export function sectionName(body: string): string | null {
  return /^([a-z]+)\n/.exec(body)?.[1] ?? null
}

// whether a text holds one of the search's terms (the highlighter's terms: lowercase, separated
// by spaces), read as the highlighter reads a text node, without case
export function holdsTerm(text: string, terms: string): boolean {
  const list = terms.split(' ').filter(term => term)
  if (!list.length) return false
  const lower = text.toLowerCase()
  return list.some(term => lower.includes(term))
}

// rules 1-3 over a block's inputs: the toggle that stands, the search's match inside, the selection
export function blockOpen(toggle: Toggle | undefined, matched: boolean, selected: boolean): boolean {
  return toggle ? toggle.open : matched || selected
}

// the toggle a click on the head leaves: the opposite of what the block shows, under the selection
export function toggled(toggle: Toggle | undefined, matched: boolean, selected: boolean, at: number): Toggle {
  return { open: !blockOpen(toggle, matched, selected), selected, at }
}

// whether one of the titles (the resolved tags of a section's marks) IS one of the search's terms,
// primary or secondary: the app's own rule for the marks it shows selected (Item.svelte, the
// selected and secondary-selected classes). a search by a child's tag has no word of the reply
// to find, where the mark reads `#/alpha` or `alpha`: its match inside the section is that mark
export function holdsTag(titles: string[], terms: string): boolean {
  const set = new Set(terms.split(' ').filter(term => term))
  return titles.some(title => set.has(title.toLowerCase()))
}

// the SECTION KEYS of an item's sections, in the item's order: a named section (the bridge's
// `agent`, `request`, `parent`) is its name and its occurrence among the sections of that name, an
// unnamed one (a reply) its place among the unnamed ones. so a section keeps its key when another
// is written above it (an agent's first tree lands above the request), which a place among all of
// the item's blocks did not. (replies that change places among themselves change keys: they are
// not told apart)
export function sectionKeys(names: (string | null)[]): string[] {
  const seen = new Map<string, number>()
  return names.map(name => {
    const n = seen.get(name ?? '') ?? 0
    seen.set(name ?? '', n + 1)
    return (name ?? '') + ':' + n
  })
}

// what a block remembers: the latest manual toggle among its sections' (a new tree and the
// request under it are one block, which takes what was chosen for the request before the tree came)
export function remembered(members: (Toggle | undefined)[]): Toggle | undefined {
  return members.reduce<Toggle | undefined>((latest, toggle) => (toggle && (!latest || toggle.at > latest.at) ? toggle : latest), undefined)
}

// (a blank line's spacer is a no-break space, which \s takes)
const BLANK = /^\s*$/
const BLOCK = /^(?:P|DIV|UL|OL|LI|BLOCKQUOTE|H[1-6]|PRE|TABLE|THEAD|TBODY|TR|TH|TD)$/

// nothing to show: a line break, blank text, a comment
const blank = (node: Node) => node.nodeName == 'BR' || node.nodeType == 8 || (node.nodeType == 3 && BLANK.test(node.nodeValue ?? ''))

// the nodes between frame `a` and frame `b` where `b` follows `a` IN THE SAME FLOW with nothing
// but blank lines between them, else null. the same flow is: the two are siblings (the lines of
// one paragraph), or each stands in a paragraph and the two paragraphs are siblings (the app's
// line pass ends a paragraph at a blank line, and a paragraph of blank lines alone can stand
// between them). never across the end of anything else: a frame inside a hidden section, a link's
// label, a list item or a quote is not joined by the frame after that container, which would
// move into it (hidden with it, or part of the owner's link)
function between(a: Element, b: Element): Node[] | null {
  const gap: Node[] = []
  // the siblings from `from` up to `to` (to the last one for null) join the gap where all are blank
  const blanks = (from: Node | null, to: Node | null) => {
    for (let node = from; node !== to; node = node.nextSibling) {
      if (!node || !(blank(node) || (node.nodeName == 'P' && [...node.childNodes].every(blank)))) return false
      gap.push(node)
    }
    return true
  }
  const [pa, pb] = [a.parentNode!, b.parentNode!]
  if (pa === pb) return blanks(a.nextSibling, b) ? gap : null
  if (pa.nodeName != 'P' || pb.nodeName != 'P' || pa.parentNode !== pb.parentNode) return null
  return blanks(a.nextSibling, null) && blanks(pa.nextSibling, pb) && blanks(pb.firstChild, b) ? gap : null
}

const meaningful = (node: Node | null): Node | null => {
  while (node && node.nodeType == 3 && BLANK.test(node.nodeValue ?? '')) node = node.nextSibling
  return node
}

// a frame's small name as an element of its own, in place of the name's line in the rendered
// body (the first paragraph's first line), or null where the body is not rendered that way
function takeName(frame: Element, name: string): HTMLElement | null {
  const first = frame.firstElementChild?.firstElementChild
  const text = first?.firstChild
  if (first?.tagName != 'P' || text?.nodeType != 3 || text.nodeValue != name) return null
  const next = text.nextSibling
  if (next && next.nodeName != 'BR') return null // the line holds more than the name
  next?.remove()
  text.remove()
  if (!meaningful(first.firstChild)) first.remove()
  const label = frame.ownerDocument.createElement('span')
  label.className = 'inert-name'
  label.textContent = name
  frame.prepend(label)
  return label
}

// a node of the status line as text and links alone (an anchor keeps its attributes, so it is
// followed as in the section; a TAG LINK or COMMAND LINK, src/inert_markdown.ts, keeps its own too,
// so the closed line shows it in the plain inline code look: there it is the line's, no link, and a
// click on it opens the block; anything else is its text: no math span, no mark and no box of the
// frame is repeated outside the frame, where the app's own passes would take it for the owner's)
function flat(node: Node, into: Node) {
  if (node.nodeType == 3) return void into.appendChild(into.ownerDocument!.createTextNode(node.nodeValue ?? ''))
  if (node.nodeType != 1) return
  const elem = node as Element
  if (elem.tagName == 'BR') return void into.appendChild(into.ownerDocument!.createTextNode(' '))
  if ((elem.tagName == 'A' && elem.hasAttribute('href')) || elem.matches('code.tag-link, code.command-link')) {
    const anchor = elem.cloneNode(false) as Element
    anchor.textContent = elem.textContent
    return void into.appendChild(anchor)
  }
  elem.childNodes.forEach(child => flat(child, into))
}

// the STATUS LINE of a frame: the first line of what it shows (after its small name), down
// through the blocks that open it (a list's first item, a heading, a table's first cell) and up
// to the first line break or nested block
function statusLine(frame: Element): HTMLElement {
  const status = frame.ownerDocument.createElement('span')
  status.className = 'inert-status'
  let box: Element | null = frame.querySelector(':scope > .inert-markdown')
  if (!box) return status
  for (;;) {
    const first = meaningful(box.firstChild) as Element | null
    if (first?.nodeType == 1 && (BLOCK.test(first.tagName) || first.classList.contains('list-item'))) box = first
    else break
  }
  // a code block's first line is its text up to the first newline
  if (box.closest('pre')) return (status.textContent = (box.textContent ?? '').trim().split('\n')[0]), status
  for (let node = meaningful(box.firstChild); node; node = node.nextSibling) {
    if (node.nodeName == 'BR' || (node.nodeType == 1 && BLOCK.test((node as Element).tagName))) break
    flat(node, status)
  }
  return status
}

// what a block's marker says of it (`aria-expanded`): the css rule of Item.svelte over the
// block's classes and the item's selection
function says(block: Element, selected: boolean) {
  const open = String(block.matches('.opened') || ((selected || block.matches('.matched')) && !block.matches('.closed')))
  const marker = block.querySelector(':scope > .inert-line > .inert-toggle')
  if (marker && marker.getAttribute('aria-expanded') != open) marker.setAttribute('aria-expanded', open)
}

// every block's marker says whether its block is open. Item.svelte calls this after the blocks
// are made and when the item's selection changed: a selection opens and closes blocks by css
// alone, with no build (a manual toggle tells its own marker; nothing of the layout is read)
export function sayExpanded(root: Element, selected: boolean): void {
  root.querySelectorAll('.inert-block').forEach(block => says(block, selected))
}

// optional per-block listener run when a block's open/closed state changes (manual toggle or
// forgotten toggle in unmark): lets Item.svelte re-sync repeated drawn child tags without re-entering
// its full update pass
const onBlockStateChange = new WeakMap<Element, () => void>()

// the blocks under `root` that carry a forgotten toggle's class lose it, and their markers say
// what shows then (one query, nothing of the layout)
function unmark(root: ParentNode) {
  const changed = new Set<() => void>()
  root.querySelectorAll('.inert-block:is(.opened, .closed)').forEach(block => {
    block.classList.remove('opened', 'closed')
    says(block, !!block.closest('.container.target'))
    const cb = onBlockStateChange.get(block)
    if (cb) changed.add(cb)
  })
  changed.forEach(cb => cb())
}

// AN ITEM'S SELECTION, told by its component when that is new and when the selection changed
// (Item.svelte afterUpdate): the item's toggles made under the other selection are forgotten
export function forgetSelection(id: string, selected: boolean, root?: Element | null): void {
  if (!toggles.size) return // (most items, at every turn)
  let any = false
  for (const [key, toggle] of toggles) if (toggle.selected != selected && key.startsWith(id + '|')) any = toggles.delete(key)
  if (any && root) unmark(root) // (no body shows while the item's editor is open: nothing to take a class off)
}

// THE SEARCH, told by the page with every query it applies (index.svelte onEditorChange): another
// query than the last forgets every toggle (no query of the document where nothing is toggled)
let search = ''
export function forgetSearch(query: string): void {
  if (query == search) return
  search = query
  if (!toggles.size) return
  toggles.clear()
  unmark(document)
}

// WHAT HAD THE KEYBOARD FOCUS AT A PRESS ON A BLOCK, for the tap that gives it back (inertBlocks). ONE
// note, for one gesture: a primary press writes it, the click on THAT block takes it, once, and the
// gesture's end drops it whatever ended it, a moment after the release (a click stopped inside the
// block, a release outside it, a drag). kept per block until its next click, it held a closed editor's
// textarea (the code review of 2026-11-20). (`focusNoted` reads it for the unit table)
// ONE SET OF LISTENERS AT MOST, with the note (`over`): a press whose end was never heard is ended by the next
// press, which aborts its listeners before it registers its own (kept by each press's own closure, an interrupted
// press held its editor until some later release: the review's third reading)
let note: { block: Element; had: Element | null; over: AbortController } | null = null
export const focusNoted = () => note

// make the blocks of an item's frames that are in none yet (Item.svelte afterUpdate, after a
// population of frames: the item's children are new then, so in practice all of its frames).
// `body` gives a frame's decoded text, `id` and `terms` the item and the highlighter's terms of
// this render, `selected` whether the item is the app's target when asked, `selecting` the item's
// own test of a text selection in a node (the one of its edit taps), and `resized` is called
// after a manual toggle (the item's height changed with no update of its component)
export function inertBlocks(
  root: Element,
  body: (frame: Element) => string,
  {
    id,
    terms,
    selected,
    selecting,
    resized,
    onStateChange,
  }: {
    id: string
    terms: string
    selected: () => boolean
    selecting: (node: Node) => boolean
    resized: () => void
    onStateChange?: () => void
  },
): void {
  // every filled frame of the item in its order, with its section's name and key
  const all = [...root.querySelectorAll('.vault-result[data-inert-rendered]')]
  const frames = all.filter(frame => !frame.parentElement!.classList.contains('inert-block'))
  if (!frames.length) return
  const named = all.map(frame => sectionName(body(frame)))
  const keys = sectionKeys(named)
  const place = new Map(all.map((frame, n) => [frame, n]))
  const runs: { frames: Element[]; gaps: Node[] }[] = []
  for (const frame of frames) {
    const run = runs[runs.length - 1]
    const gap = run ? between(run.frames[run.frames.length - 1], frame) : null
    if (gap) run.frames.push(frame), run.gaps.push(...gap)
    else runs.push({ frames: [frame], gaps: [] })
  }
  for (const { frames: run, gaps } of runs) {
    const members = run.map(frame => id + '|' + keys[place.get(frame)!])
    const doc = root.ownerDocument
    const block = doc.createElement('span')
    block.className = 'inert-block'
    const head = doc.createElement('span')
    head.className = 'inert-line'
    // the marker: the disclosure control (css lays it over the block; `sayExpanded` gives it its state)
    const marker = doc.createElement('span')
    marker.className = 'inert-toggle'
    marker.setAttribute('role', 'button')
    marker.tabIndex = 0
    const first = named[place.get(run[0])!]
    marker.setAttribute('aria-label', first ? first + ' section' : 'section')
    run[0].before(block)
    const home = block.parentElement
    // the blank lines between the run's frames go: the sections follow each other in the block.
    // a frame that leaves its own paragraph for the block takes the line break after it along
    // (hidden while the frame stood before it, it would open that paragraph with an empty line)
    gaps.forEach(node => node.parentNode?.removeChild(node))
    for (const frame of run.slice(1)) {
      const from = frame.parentElement!
      if (from === home) continue
      if (frame.nextSibling?.nodeName == 'BR') frame.nextSibling.remove()
      frame.remove()
      if (!from.firstChild) from.remove()
    }
    const matched =
      !!terms.trim() &&
      run.some(
        frame =>
          holdsTerm(frame.textContent ?? '', terms) ||
          holdsTag(
            [...frame.querySelectorAll('mark')].map(mark => mark.title),
            terms,
          ),
      )
    const names = run.map(frame => {
      const name = named[place.get(frame)!]
      return name ? takeName(frame, name) : null
    })
    // the head carries the marker, the first section's name (its own copy in the frame is hidden by css) and status line
    head.appendChild(marker)
    if (names[0]) head.appendChild(names[0].cloneNode(true))
    head.appendChild(statusLine(run[0]))
    block.append(head, ...run)
    const left = () => remembered(members.map(key => toggles.get(key)))
    const show = () => {
      const toggle = left()
      block.classList.toggle('opened', !!toggle?.open)
      block.classList.toggle('closed', !!toggle && !toggle.open)
    }
    block.classList.toggle('matched', matched)
    show()
    if (onStateChange) onBlockStateChange.set(block, onStateChange)
    // a manual toggle, by a click or by a key: remembered for every section of the block
    const flip = () => {
      const next = toggled(left(), matched, selected(), ++turn)
      members.forEach(key => toggles.set(key, next))
      show()
      says(block, selected())
      onStateChange?.()
      resized()
    }
    // A BLOCK INSIDE A LINK OF THE OWNER'S (a region in a link's label) is no part of that link, be it
    // a link to a url (an anchor) or to a tag (a mark, on whose PRESS the app goes to the tag:
    // Item.svelte, _handleTagClick on the mark's onmousedown): the block's press and its click stop
    // at the block. a link inside the block keeps its default action there (the click handler of
    // an enclosing tag link would cancel it)
    const enclosed = !!block.closest('a, mark')
    // A CLICK THAT REACHES THE BLOCK toggles it, from the closed line and from an open section
    // alike. the listener is an ordinary one, in the bubbling phase: what handles its own click
    // inside and stops it keeps it (a frame does so for a child tag's mark). a link in the block
    // is followed and toggles nothing, whether or not its handler stops the click. and a TEXT
    // SELECTION is no tap, by the item's own test for its edit taps (`selecting`), read twice:
    // at the click (a drag that selects ends in a click on what holds the selection), and at the
    // PRESS (`ended`: a press beside a selection that stands in the block ends that selection,
    // which the browser has collapsed before the click comes)
    let ended = false
    // THE KEYBOARD FOCUS IS GIVEN BACK BY THE TAP THAT TOGGLES (`note`). the press is an ordinary
    // one on text: its default takes the focus from whatever has it (another item's editor, the
    // MindBox) and starts the selection a drag extends, so it is not prevented. the press notes
    // what has the focus, and the click that toggles focuses it again, without a scroll (a text
    // box restores its own caret and selection). a click that toggles nothing gives nothing back
    // (a followed link, the click that only ends a selection): a drag keeps the focus it took, so
    // that a copy takes the selected text
    block.addEventListener('mousedown', e => {
      if (enclosed) e.stopPropagation()
      ended = selecting(block)
      if (e.button) return
      note?.over.abort()
      const [pressed, view] = [(note = { block, had: doc.activeElement, over: new AbortController() }), doc.defaultView!]
      // the gesture's end: a release, a drag's end, a cancelled pointer, or the WINDOW's own blur (an element's blur
      // is heard at the window too: the press's default blurs the editor itself). from a timer, after a release's own click
      const end = (e: Event) => void ((e.type != 'blur' || e.target === view) && (pressed.over.abort(), setTimeout(() => void (note === pressed && (note = null)))))
      for (const type of ['mouseup', 'dragend', 'pointercancel', 'blur']) view.addEventListener(type, end, { capture: true, signal: pressed.over.signal })
    })
    block.addEventListener('click', (e: MouseEvent) => {
      const spent = ended
      ended = false
      const had = note?.block === block ? note.had : null
      note = null
      const link = (e.target as Element).closest('a')
      if (link && block.contains(link)) {
        if (enclosed) e.stopPropagation()
        return
      }
      if (enclosed) e.preventDefault(), e.stopPropagation() // nothing of the owner's link is followed from the block
      if (spent || selecting(e.target as Node)) return
      flip()
      if (had instanceof HTMLElement && had.isConnected && had !== doc.activeElement) had.focus({ preventScroll: true })
    })
    // the keyboard: Enter and Space on the marker toggle as a click does. the key is the marker's
    // alone (at the window the app takes Enter for its editor and Tab, Space and every key's
    // release for itself), so nothing is left to a click that the key would make
    marker.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key != 'Enter' && e.key != ' ') return
      e.preventDefault()
      e.stopPropagation()
      flip()
    })
  }
}
