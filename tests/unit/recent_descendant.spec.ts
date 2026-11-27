import { expect, test } from '@playwright/test'

import {
  isRecentDownKey,
  isRecentUpKey,
  nextRecentItem,
  recentStart,
  stepRecentWalk,
  stepRecentWalkBack,
  type RecentItem,
  type RecentWalk,
} from '../../src/recent_descendant.js'

// pure choice and walk state for Option+Down / Option+Up (src/recent_descendant.ts); the browser
// rows are in tests/e2e/editor.spec.ts

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
    item('log_item', 360, [], { query: '#log ' }),
    item('log_child', 370, ['#log'], { query: '#log/child ' }),
  ]
  const unique = (label: string) =>
    label == '#p' || label == '#p/child' || label == '#dup/child' || label == '#log' || label == '#log/child'

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

  // Option+Up predicate matches Alt+ArrowUp alone and rejects any second modifier or other key
  expect(isRecentUpKey('ArrowUp', { altKey: true })).toBe(true)
  expect(isRecentUpKey('ArrowUp', { altKey: true, shiftKey: false, ctrlKey: false, metaKey: false })).toBe(true)
  expect(isRecentUpKey('ArrowUp', { altKey: true, shiftKey: true })).toBe(false)
  expect(isRecentUpKey('ArrowUp', { altKey: true, ctrlKey: true })).toBe(false)
  expect(isRecentUpKey('ArrowUp', { altKey: true, metaKey: true })).toBe(false)
  expect(isRecentUpKey('ArrowUp', { altKey: true, ctrlKey: true, metaKey: true })).toBe(false)
  expect(isRecentUpKey('ArrowUp', {})).toBe(false)
  expect(isRecentUpKey('ArrowDown', { altKey: true })).toBe(false)
})

test('Option+Up steps back from each place of a labelled walk, stops at the start, and Option+Down goes forward again', () => {
  const items: Item[] = [
    item('p', 50, [], { query: '#P ' }),
    item('a', 200, ['#p'], { query: '#p/a ' }),
    item('deep', 300, ['#p/a', '#p'], { query: '#p/a/deep ' }),
    item('b', 100, ['#p'], { query: '#p/b ' }),
  ]
  const labelOf = (i: Item) => i.query.trim().toLowerCase()
  const unique = (label: string) => items.filter(i => labelOf(i) == label).length == 1
  const selects = (box: string) => {
    const name = box.trim().toLowerCase()
    const named = items.filter(i => labelOf(i) == name)
    return named.length == 1 ? named[0].id : null
  }

  let walk: RecentWalk | null = null
  let box = '#p'
  const down = () => {
    const res = stepRecentWalk(items, box, walk, i => i.query, unique, selects)
    walk = res.walk
    if (res.item && res.walk) box = res.walk.query
    return { id: res.item?.id ?? null, box }
  }
  const up = () => {
    const res = stepRecentWalkBack(items, box, walk, i => i.query, unique, selects)
    walk = res.walk
    if (res.query !== null) box = res.query
    return { id: res.item?.id ?? null, query: res.query, box }
  }

  // walk forward to the end (including a no-op press at the end)
  expect(down()).toEqual({ id: 'deep', box: '#p/a/deep ' })
  expect(down()).toEqual({ id: 'a', box: '#p/a ' })
  expect(down()).toEqual({ id: 'b', box: '#p/b ' })
  expect(down()).toEqual({ id: null, box: '#p/b ' })

  // step back from each place to the start (preserving start item's cased query '#P ')
  expect(up()).toEqual({ id: 'a', query: '#p/a ', box: '#p/a ' })
  expect(up()).toEqual({ id: 'deep', query: '#p/a/deep ', box: '#p/a/deep ' })
  expect(up()).toEqual({ id: 'p', query: '#P ', box: '#P ' })

  // at the start: stops quietly, keeping the walk on
  const walkAtStart = walk
  expect(up()).toEqual({ id: null, query: null, box: '#P ' })
  expect(walk).toBe(walkAtStart)

  // forward again from the start visits the same items in the same order
  expect(down()).toEqual({ id: 'deep', box: '#p/a/deep ' })
  expect(down()).toEqual({ id: 'a', box: '#p/a ' })
  // partial step back, then forward again resumes the remaining items in order
  expect(up()).toEqual({ id: 'deep', query: '#p/a/deep ', box: '#p/a/deep ' })
  expect(down()).toEqual({ id: 'a', box: '#p/a ' })
  expect(down()).toEqual({ id: 'b', box: '#p/b ' })
  expect(down()).toEqual({ id: null, box: '#p/b ' })

  // if an item's time changes while stepped back, forward reflects the new live order among unvisited items
  expect(up()).toEqual({ id: 'a', query: '#p/a ', box: '#p/a ' })
  expect(up()).toEqual({ id: 'deep', query: '#p/a/deep ', box: '#p/a/deep ' })
  const reordered = items.map(i => (i.id == 'b' ? { ...i, time: 250 } : i))
  const afterTimeChange = stepRecentWalk(reordered, box, walk, i => i.query, unique, selects)
  expect(afterTimeChange.item?.id).toBe('b')

  // without selectedId, stepping back to the start falls back to `${walk.start} `
  const wNoSel = stepRecentWalk(items, '#p ', null, i => i.query, unique).walk
  expect(stepRecentWalkBack(items, '#p/a/deep ', wNoSel, i => i.query, unique)).toMatchObject({
    item: null,
    query: '#p ',
    walk: { start: '#p', startId: null, visited: [], query: '#p ' },
  })
})

test('Option+Up steps back through a global walk to the empty box, stops there, and goes forward again', () => {
  const items: Item[] = [
    item('pinned', 900, [], { pinned: true, query: '#pin ' }),
    item('u1', 800, [], { query: 'id:u1' }),
    item('mid', 700, [], { query: '#mid ' }),
    item('u2', 600, [], { query: 'id:u2' }),
  ]
  const labelOf = (i: Item) => i.query.trim().toLowerCase()
  const unique = (label: string) => items.filter(i => labelOf(i) == label).length == 1
  const selects = (box: string) => {
    const name = box.trim().toLowerCase()
    if (!name) return null
    if (name.startsWith('id:')) return items.find(i => i.id == name.slice(3))?.id ?? null
    const named = items.filter(i => labelOf(i) == name)
    return named.length == 1 ? named[0].id : null
  }

  let walk: RecentWalk | null = null
  let box = ''
  const down = () => {
    const res = stepRecentWalk(items, box, walk, i => i.query, unique, selects)
    walk = res.walk
    if (res.item && res.walk) box = res.walk.query
    return { id: res.item?.id ?? null, box }
  }
  const up = () => {
    const res = stepRecentWalkBack(items, box, walk, i => i.query, unique, selects)
    walk = res.walk
    if (res.query !== null) box = res.query
    return { id: res.item?.id ?? null, query: res.query, box }
  }

  expect(down()).toEqual({ id: 'u1', box: 'id:u1' })
  expect(down()).toEqual({ id: 'mid', box: '#mid ' })
  expect(down()).toEqual({ id: 'u2', box: 'id:u2' })

  expect(up()).toEqual({ id: 'mid', query: '#mid ', box: '#mid ' })
  expect(up()).toEqual({ id: 'u1', query: 'id:u1', box: 'id:u1' })
  expect(up()).toEqual({ id: null, query: '', box: '' })

  // at the global start: stops quietly, keeping the walk on
  const walkAtStart = walk
  expect(up()).toEqual({ id: null, query: null, box: '' })
  expect(walk).toBe(walkAtStart)

  // forward again from the global start repeats the same items
  expect(down()).toEqual({ id: 'u1', box: 'id:u1' })
  expect(down()).toEqual({ id: 'mid', box: '#mid ' })
})

test('Option+Up with no walk (or a drifted box) is taken by the key predicate and changes nothing', () => {
  const items: Item[] = [
    item('p', 50, [], { query: '#p ' }),
    item('a', 300, ['#p'], { query: '#p/a ' }),
    item('b', 200, ['#p'], { query: '#p/b ' }),
  ]
  const unique = (label: string) => ['#p', '#p/a', '#p/b'].includes(label)

  // key is taken (Alt+ArrowUp alone), and with no walk active changes nothing across labelled box, empty box, or search
  expect(isRecentUpKey('ArrowUp', { altKey: true })).toBe(true)
  for (const box of ['#p/a ', '#p ', '', 'search', '#p extra', 'id:p', '#log']) {
    expect(stepRecentWalkBack(items, box, null, i => i.query, unique), box).toEqual({
      item: null,
      query: null,
      walk: null,
    })
  }

  // walk active, then the box changed (typed text, missing trailing space, or another item): clears walk and changes nothing
  const first = stepRecentWalk(items, '#p ', null, i => i.query, unique)
  for (const drifted of ['#p/a', '#p/b ', '#p ', '']) {
    expect(stepRecentWalkBack(items, drifted, first.walk, i => i.query, unique), drifted).toEqual({
      item: null,
      query: null,
      walk: null,
    })
  }
})

test('Option+Up ends a walk when the current or start item is renamed or deleted, keeps case-only changes, and passes over a gone earlier step', () => {
  const p = item('p', 100, [], { query: '#p ' })
  const a = item('a', 300, ['#p'], { query: '#p/a ' })
  const b = item('b', 200, ['#p'], { query: '#p/b ' })
  const c = item('c', 150, ['#p'], { query: '#p/c ' })
  const labelOf = (i: Item) => i.query.trim().toLowerCase()
  const unique = (list: Item[]) => (label: string) => list.filter(i => labelOf(i) == label).length == 1
  const selects = (list: Item[]) => (box: string) => {
    const name = box.trim().toLowerCase()
    if (!name) return null
    if (name.startsWith('id:')) return list.find(i => i.id == name.slice(3))?.id ?? null
    const named = list.filter(i => labelOf(i) == name)
    return named.length == 1 ? named[0].id : null
  }
  const down = (list: Item[], box: string, walk: RecentWalk | null) =>
    stepRecentWalk(list, box, walk, i => i.query, unique(list), selects(list))
  const up = (list: Item[], box: string, walk: RecentWalk | null) =>
    stepRecentWalkBack(list, box, walk, i => i.query, unique(list), selects(list))

  const s1 = down([p, a, b, c], '#p ', null)
  const s2 = down([p, a, b, c], '#p/a ', s1.walk)
  const s3 = down([p, a, b, c], '#p/b ', s2.walk)
  expect(s3.item?.id).toBe('c')

  // current item deleted / renamed / label taken by another -> walk ends and changes nothing
  const taker = item('x', 50, ['#p'], { query: '#p/c ' })
  const endedCases: [string, Item[]][] = [
    ['current item deleted', [p, a, b]],
    ['current item renamed in place', [p, a, b, { ...c, query: '#p/z ' }]],
    ['current item renamed out of tree', [p, a, b, { ...c, ancestors: [], query: '#z ' }]],
    ['current item label taken by another', [p, a, b, { ...c, query: '#p/z ' }, taker]],
    ['current item label duplicated', [p, a, b, c, taker]],
    ['start item deleted', [a, b, c]],
    ['start item renamed away', [{ ...p, query: '#q ' }, a, b, c]],
    ['start item label duplicated', [p, item('p2', 40, [], { query: '#p ' }), a, b, c]],
    ['start item label taken by another', [{ ...p, query: '#q ' }, item('p2', 40, [], { query: '#p ' }), a, b, c]],
  ]
  for (const [name, list] of endedCases) {
    expect(up(list, '#p/c ', s3.walk), name).toEqual({ item: null, query: null, walk: null })
  }

  // case-only rename of current item or start item still continues the walk
  expect(up([p, a, b, { ...c, query: '#p/C ' }], '#p/c ', s3.walk)).toMatchObject({ item: b, query: '#p/b ' })
  expect(up([{ ...p, query: '#P ' }, a, b, c], '#p/c ', s3.walk)).toMatchObject({ item: b, query: '#p/b ' })

  // earlier visited item deleted or moved out of the start is passed over symmetrically with forward
  expect(up([p, a, c], '#p/c ', s3.walk)).toMatchObject({ item: a, query: '#p/a ' })
  expect(up([p, a, { ...b, ancestors: [], query: '#elsewhere ' }, c], '#p/c ', s3.walk)).toMatchObject({
    item: a,
    query: '#p/a ',
  })
  // all earlier visited items deleted -> steps back to the start
  expect(up([p, c], '#p/c ', s3.walk)).toMatchObject({ item: p, query: '#p ' })

  // at the start itself, if the start item is renamed away or taken by another, Option+Up ends the walk
  const atStart = up([p, a], '#p/a ', s1.walk)
  expect(atStart).toMatchObject({ item: p, query: '#p ' })
  expect(up([{ ...p, query: '#q ' }, a], '#p ', atStart.walk)).toEqual({ item: null, query: null, walk: null })
  expect(up([{ ...p, query: '#q ' }, item('p2', 40, [], { query: '#p ' }), a], '#p ', atStart.walk)).toEqual({
    item: null,
    query: null,
    walk: null,
  })

  // global walk: first label given to unnamed item selected by id keeps the walk; deletion ends it
  const u = item('u', 300, [], { query: 'id:u' })
  const n = item('n', 200, [], { query: '#n ' })
  const g1 = down([u, n], '', null)
  expect(up([{ ...u, query: '#named ' }, n], 'id:u', g1.walk)).toMatchObject({ item: null, query: '' })
  expect(up([n], 'id:u', g1.walk)).toEqual({ item: null, query: null, walk: null })
})

test('forward after Option+Up prefers the previously visited item among equal-time ties even when items reorder, while genuinely newer wins and fresh walks keep array order', () => {
  // reviewer's global-walk sequence: #apple is newest; #birch/c and its parent #birch tie in time,
  // initially [#apple, #birch/c, #birch]. Selecting #birch/c ranks its parent #birch ahead of it.
  // Down, Down, Up, Down must revisit #birch/c on the fourth press rather than flipping to #birch.
  const apple = item('apple', 300, [], { query: '#apple ' })
  const birchChild = item('birch_c', 200, ['#birch'], { query: '#birch/c ' })
  const birch = item('birch', 200, [], { query: '#birch ' })
  const order1 = [apple, birchChild, birch]
  const order2 = [apple, birch, birchChild]

  const labelOf = (i: Item) => i.query.trim().toLowerCase()
  const unique = (list: Item[]) => (label: string) => list.filter(i => labelOf(i) == label).length == 1
  const selects = (list: Item[]) => (box: string) => {
    const name = box.trim().toLowerCase()
    if (!name) return null
    const named = list.filter(i => labelOf(i) == name)
    return named.length == 1 ? named[0].id : null
  }
  const down = (list: Item[], box: string, walk: RecentWalk | null) =>
    stepRecentWalk(list, box, walk, i => i.query, unique(list), selects(list))
  const up = (list: Item[], box: string, walk: RecentWalk | null) =>
    stepRecentWalkBack(list, box, walk, i => i.query, unique(list), selects(list))

  const p1 = down(order1, '', null)
  expect(p1.item?.id).toBe('apple')
  const p2 = down(order1, p1.walk!.query, p1.walk)
  expect(p2.item?.id).toBe('birch_c')
  // selecting #birch/c reordered items so #birch now precedes #birch/c (order2)
  const p3 = up(order2, p2.walk!.query, p2.walk)
  expect(p3.item?.id).toBe('apple')
  const p4 = down(order2, p3.walk!.query, p3.walk)
  expect(p4.item?.id, '4th keypress revisits #birch/c despite order2 putting #birch first').toBe('birch_c')
  const p5 = down(order2, p4.walk!.query, p4.walk)
  expect(p5.item?.id).toBe('birch')

  // stepping back multiple steps all the way to the start (plus a stop press) still replays the same tie order
  const b1 = up(order2, p5.walk!.query, p5.walk)
  expect(b1.item?.id).toBe('birch_c')
  const b2 = up(order2, b1.walk!.query, b1.walk)
  expect(b2.item?.id).toBe('apple')
  const b3 = up(order2, b2.walk!.query, b2.walk)
  expect(b3.query).toBe('')
  const stop = up(order2, '', b3.walk)
  expect(stop.query).toBeNull()
  const r1 = down(order2, '', stop.walk)
  expect(r1.item?.id).toBe('apple')
  const r2 = down(order2, r1.walk!.query, r1.walk)
  expect(r2.item?.id, 'replay from start preserves #birch/c preference across multi-step back').toBe('birch_c')
  const r3 = down(order2, r2.walk!.query, r2.walk)
  expect(r3.item?.id).toBe('birch')

  // a genuinely newer candidate still wins over the stepped-back preference
  const backToApple = up(order2, r2.walk!.query, r2.walk)
  expect(backToApple.item?.id).toBe('apple')
  const orderNewer = [apple, { ...birch, time: 250 }, birchChild]
  const newerWins = down(orderNewer, backToApple.walk!.query, backToApple.walk)
  expect(newerWins.item?.id, 'strictly newer #birch beats stepped-back #birch/c').toBe('birch')

  // an ineligible stepped-back item (pinned in global walk) is skipped
  const orderPinned = [apple, birch, { ...birchChild, pinned: true }]
  const skippedPinned = down(orderPinned, backToApple.walk!.query, backToApple.walk)
  expect(skippedPinned.item?.id, 'pinned #birch/c is ineligible so #birch wins').toBe('birch')

  // a fresh walk (no active walk) keeps today's items-array tie order
  const f1 = down(order2, '', null)
  expect(f1.item?.id).toBe('apple')
  const f2 = down(order2, f1.walk!.query, f1.walk)
  expect(f2.item?.id, 'fresh walk on order2 picks #birch first').toBe('birch')
})
