import { expect, test } from '@playwright/test'

import {
  isRecentDownKey,
  nextRecentItem,
  recentStart,
  stepRecentWalk,
  type RecentItem,
  type RecentWalk,
} from '../../src/recent_descendant.js'

// pure choice and walk state for Option+Down (src/recent_descendant.ts); the browser row is in
// tests/e2e/editor.spec.ts

type Item = RecentItem & { query: string }

const item = (
  id: string,
  time: number,
  ancestors: string[] = [],
  { pinned = false, query = `#${id} ` }: { pinned?: boolean; query?: string } = {},
): Item => ({ id, time, ancestors, pinned, query })

test('descendants only and at any depth, tag parents included, excluding self, siblings and escaped items', () => {
  const items: Item[] = [
    item('root', 900, []), // the selected item itself
    item('sibling', 950, []), // unrelated root, newer
    item('escaped', 940, ['#elsewhere']), // nested name moved away by a tag parent
    item('child', 400, ['#root']), // direct child
    item('grandchild', 700, ['#root/child', '#root']), // two levels down
    item('deep', 850, ['#root/child/grandchild', '#root/child', '#root']), // three levels down
    item('tagchild', 800, ['#root']), // tag-parent child under #root
  ]
  expect(nextRecentItem(items, '#root')?.id).toBe('deep')
  expect(nextRecentItem(items, '#ROOT ', ['deep'])?.id).toBe('tagchild')
  expect(nextRecentItem(items, '#root', ['deep', 'tagchild'])?.id).toBe('grandchild')
  expect(nextRecentItem(items, '#root', ['deep', 'tagchild', 'grandchild'])?.id).toBe('child')
  expect(nextRecentItem(items, '#root', ['deep', 'tagchild', 'grandchild', 'child'])).toBeNull()
})

test('orders candidates by time descending (newest first)', () => {
  const items: Item[] = [
    item('old', 100, ['#p']),
    item('newest', 500, ['#p/a', '#p']),
    item('mid', 300, ['#p']),
    item('pinned_descendant', 400, ['#p'], { pinned: true }), // pinned filter is global-only
  ]
  const seen: string[] = []
  const order: string[] = []
  for (;;) {
    const next = nextRecentItem(items, '#p', seen)
    if (!next) break
    order.push(next.id)
    seen.push(next.id)
  }
  expect(order).toEqual(['newest', 'pinned_descendant', 'mid', 'old'])
})

test('breaks equal times by the order the items list has them in', () => {
  const items: Item[] = [
    item('first', 200, ['#p']),
    item('second', 200, ['#p/a', '#p']),
    item('third', 200, ['#p']),
    item('older', 100, ['#p']),
  ]
  const seen: string[] = []
  const order: string[] = []
  for (;;) {
    const next = nextRecentItem(items, '#p', seen)
    if (!next) break
    order.push(next.id)
    seen.push(next.id)
  }
  expect(order).toEqual(['first', 'second', 'third', 'older'])
})

test('at a leaf returns null and starts no walk', () => {
  const items: Item[] = [item('root', 500, []), item('leaf', 400, ['#root'])]
  expect(nextRecentItem(items, '#leaf')).toBeNull()
  expect(stepRecentWalk(items, '#leaf ', null, i => i.query)).toEqual({ item: null, walk: null })
})

test('walks descendants to the end without wrapping, and starts anew when the box changes', () => {
  const items: Item[] = [
    item('p', 50, [], { query: '#p ' }),
    item('a', 200, ['#p'], { query: '#p/a ' }),
    item('deep', 300, ['#p/a', '#p'], { query: '#p/a/deep ' }),
    item('b', 100, ['#p'], { query: '#p/b ' }),
  ]
  const unique = (label: string) => ['#p', '#p/a', '#p/a/deep', '#p/b'].includes(label)

  let walk: RecentWalk | null = null
  const step = (box: string) => {
    const res = stepRecentWalk(items, box, walk, i => i.query, unique)
    walk = res.walk
    return res.item?.id ?? null
  }

  expect(step('#p ')).toBe('deep')
  expect(step('#p/a/deep ')).toBe('a')
  expect(step('#p/a ')).toBe('b')
  // at the end: does nothing and keeps the ended walk so another press does not wrap or restart
  expect(step('#p/b ')).toBeNull()
  expect(step('#p/b ')).toBeNull()

  // starting anew after the box changed (e.g. a click or plain arrow moved back to #p/a)
  expect(step('#p/a ')).toBe('deep')
  // once #p/a's only descendant was visited, the next press ends without jumping to #p/b
  expect(step('#p/a/deep ')).toBeNull()
})

test('a walk ends where its last selection was renamed or deleted elsewhere, and passes over a sibling that is gone', () => {
  // another tab or an agent renames or deletes the selected item and the box keeps its old query: the walk
  // must not go on to a sibling from a selection that selects nothing any more (review 0 of option_down)
  // (review 1: the item is known by what the box SELECTS, as the app resolves a query: a label without case and
  // unique, an id by its reference. Its name's case changed, or a first label given to an item selected by its
  // id, still selects it, and the walk goes on)
  const p = item('p', 100, [], { query: '#p ' })
  const a = item('a', 300, ['#p'], { query: '#p/a ' })
  const b = item('b', 200, ['#p'], { query: '#p/b ' })
  const labelOf = (i: Item) => i.query.trim().toLowerCase()
  const unique = (items: Item[]) => (label: string) => items.filter(i => labelOf(i) == label).length == 1
  const selects = (items: Item[]) => (box: string) => {
    const name = box.trim().toLowerCase()
    if (name.startsWith('id:')) return items.find(i => i.id == name.slice(3))?.id
    const named = items.filter(i => labelOf(i) == name)
    return named.length == 1 ? named[0].id : null
  }
  const press = (items: Item[], box: string, walk: RecentWalk | null) =>
    stepRecentWalk(items, box, walk, i => i.query, unique(items), selects(items))
  const first = press([p, a, b], '#p', null)
  expect([first.item?.id, first.walk?.query]).toEqual(['a', '#p/a '])
  const taker = item('c', 50, ['#p'], { query: '#p/a ' }) // another item that took the old label, with a child of its own
  const cases: [string, Item[], { item: string | null; start: string | null }][] = [
    ['unchanged: the walk goes on to the sibling', [p, a, b], { item: 'b', start: '#p' }],
    ["the name's case changed: the box still selects the item, and the walk goes on", [p, { ...a, query: '#p/A ' }, b], { item: 'b', start: '#p' }],
    ['deleted: the box names nothing', [p, b], { item: null, start: null }],
    ['renamed in place: the old label is missing', [p, { ...a, query: '#p/z ' }, b], { item: null, start: null }],
    ['renamed out of the tree: the same', [p, { ...a, ancestors: [], query: '#z ' }, b], { item: null, start: null }],
    ['the old label taken by another item: a fresh walk starts there', [p, { ...a, query: '#p/z ' }, b, taker, item('d', 40, ['#p/a', '#p'], { query: '#p/a/d ' })], { item: 'd', start: '#p/a' }],
  ]
  for (const [name, items, want] of cases) {
    const next = press(items, '#p/a ', first.walk)
    expect({ item: next.item?.id ?? null, start: next.walk?.start ?? null }, name).toEqual(want)
  }
  // an UNVISITED sibling that is gone is passed over: the walk ends at the last item left, and stays
  const gone = press([p, a], '#p/a ', first.walk)
  expect([gone.item, gone.walk]).toEqual([null, first.walk])
  // the global walk: an unnamed item selected by its id is given its first label elsewhere; its id still selects it
  const u = item('u', 300, [], { query: 'id:u' })
  const n = item('n', 200, [], { query: '#n ' })
  const global = press([u, n], '', null)
  expect([global.item?.id, global.walk?.query]).toEqual(['u', 'id:u'])
  expect(press([{ ...u, query: '#named ' }, n], 'id:u', global.walk).item?.id, 'a first label on the item selected by id').toBe('n')
  expect(press([n], 'id:u', global.walk), 'the item selected by id deleted').toEqual({ item: null, walk: null })
})

test('a start by id, #log, non-unique label, or search query has nothing below it', () => {
  const items: Item[] = [
    item('p', 500, [], { query: '#p ' }),
    item('child', 400, ['#p'], { query: '#p/child ' }),
    item('dup1', 300, [], { query: 'id:dup1' }),
    item('dup_child', 350, ['#dup'], { query: '#dup/child ' }),
  ]
  const unique = (label: string) => label == '#p' || label == '#p/child' || label == '#dup/child'

  for (const box of ['id:p', 'id:unnamed123', 'id:p ', '#log', '#dup', '#missing', '#p extra', 'search', '/cmd']) {
    expect(recentStart(box, unique), box).toBeUndefined()
    expect(
      stepRecentWalk(items, box, null, i => i.query, unique),
      box,
    ).toEqual({ item: null, walk: null })
  }
  expect(nextRecentItem(items, 'id:p')).toBeNull()
})

test('global case (empty box) skips pinned items, includes unnamed items, and walks to the end', () => {
  const items: Item[] = [
    item('pinned_newest', 900, [], { pinned: true, query: '#pin ' }),
    item('unnamed_newest', 800, [], { query: 'id:u1' }),
    item('named_mid', 700, [], { query: '#mid ' }),
    item('unnamed_old', 600, [], { query: 'id:u2' }),
    item('pinned_old', 500, [], { pinned: true, query: '#pin2 ' }),
  ]
  let walk: RecentWalk | null = null
  const picked: string[] = []
  let box = ''
  for (;;) {
    const res: { item: Item | null; walk: RecentWalk | null } = stepRecentWalk(items, box, walk, i => i.query)
    walk = res.walk
    if (!res.item) break
    picked.push(`${res.item.id}:${walk!.query}`)
    box = walk!.query
  }
  expect(picked).toEqual(['unnamed_newest:id:u1', 'named_mid:#mid ', 'unnamed_old:id:u2'])
  // another press at the end does nothing
  expect(stepRecentWalk(items, box, walk, i => i.query).item).toBeNull()
  // all-pinned corpus returns null
  expect(nextRecentItem([items[0], items[4]], null)).toBeNull()
})

test('key predicate matches Alt+ArrowDown alone and rejects any second modifier or other key', () => {
  expect(isRecentDownKey('ArrowDown', { altKey: true })).toBe(true)
  expect(isRecentDownKey('ArrowDown', { altKey: true, shiftKey: false, ctrlKey: false, metaKey: false })).toBe(true)
  // second modifiers rejected (two of Ctrl/Alt/Cmd is the scroll shortcut; Shift+Down toggles items)
  expect(isRecentDownKey('ArrowDown', { altKey: true, shiftKey: true })).toBe(false)
  expect(isRecentDownKey('ArrowDown', { altKey: true, ctrlKey: true })).toBe(false)
  expect(isRecentDownKey('ArrowDown', { altKey: true, metaKey: true })).toBe(false)
  expect(isRecentDownKey('ArrowDown', { altKey: true, ctrlKey: true, metaKey: true })).toBe(false)
  // plain ArrowDown and other keys rejected
  expect(isRecentDownKey('ArrowDown', {})).toBe(false)
  expect(isRecentDownKey('ArrowUp', { altKey: true })).toBe(false)
})
