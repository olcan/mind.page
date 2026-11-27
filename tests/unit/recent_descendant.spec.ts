import { expect, test } from '@playwright/test'

import {
  isRecentDownKey,
  isRecentPageDownKey,
  isRecentPageUpKey,
  isRecentUpKey,
  isRecentWalkEndKey,
  jumpRecentWalkOldest,
  jumpRecentWalkStart,
  nextRecentItem,
  recentStart,
  stepRecentWalk,
  stepRecentWalkBack,
  type RecentItem,
  type RecentWalk,
} from '../../src/recent_descendant.js'

// pure choice and walk state for Option+Down / Option+Up / Option+PageDown / Option+PageUp
// (src/recent_descendant.ts); the browser rows are in tests/e2e/editor.spec.ts

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

test('walk-end key predicate matches either Option key once no Option remains held, and ignores other keys or a second held Option', () => {
  // either Option key (left, right, bare Alt, or AltGraph) ends the walk once altKey is false
  for (const key of ['AltLeft', 'AltRight', 'Alt', 'AltGraph']) {
    expect(isRecentWalkEndKey(key, { altKey: false }), `${key} with altKey: false`).toBe(true)
    expect(isRecentWalkEndKey(key, {}), `${key} with omitted altKey`).toBe(true)
    // other modifiers still held do not block Option release from ending the walk
    expect(isRecentWalkEndKey(key, { altKey: false, shiftKey: true, ctrlKey: true, metaKey: true }), `${key} with other modifiers`).toBe(true)
    // releasing a second Option key while the first is still held reports altKey: true -> keep the walk on
    expect(isRecentWalkEndKey(key, { altKey: true }), `${key} with another Option still held`).toBe(false)
  }
  // non-Option keys (arrows, other modifiers, characters) never end the walk
  for (const key of ['ArrowDown', 'ArrowUp', 'ShiftLeft', 'ControlLeft', 'MetaLeft', 'KeyA', '']) {
    expect(isRecentWalkEndKey(key, { altKey: false }), `${key} with altKey: false`).toBe(false)
    expect(isRecentWalkEndKey(key, { altKey: true }), `${key} with altKey: true`).toBe(false)
  }
})

test('ending a walk mid-way makes the next hold start from the item stopped on, stops Option+Up there, and leaves a fresh Option+Up a no-op', () => {
  const items: Item[] = [
    item('p', 50, [], { query: '#p ' }),
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
  const down = (box: string, walk: RecentWalk | null) => stepRecentWalk(items, box, walk, i => i.query, unique, selects)
  const up = (box: string, walk: RecentWalk | null) => stepRecentWalkBack(items, box, walk, i => i.query, unique, selects)

  // first hold: walk two steps from #p -> #p/a/deep -> #p/a
  const s1 = down('#p ', null)
  expect(s1.item?.id).toBe('deep')
  const s2 = down(s1.walk!.query, s1.walk)
  expect(s2.item?.id).toBe('a')

  // Option released -> caller clears walk to null while box still holds '#p/a '
  // fresh Option+Up does nothing (does not step back to #p/a/deep or #p)
  expect(up('#p/a ', null)).toEqual({ item: null, query: null, walk: null })

  // next hold: Option+Down starts a new walk under #p/a (-> #p/a/deep, not #p/b)
  const n1 = down('#p/a ', null)
  expect(n1.item?.id).toBe('deep')
  expect(n1.walk?.start).toBe('#p/a')
  // Option+Up steps back to #p/a and stops there (does not climb to #p)
  const nBack = up(n1.walk!.query, n1.walk)
  expect(nBack.item?.id).toBe('a')
  expect(nBack.query).toBe('#p/a ')
  const nStop = up('#p/a ', nBack.walk)
  expect(nStop.query).toBeNull()
  expect(nStop.walk).toBe(nBack.walk)

  // stopped on a leaf (#p/a/deep) after release: new hold does nothing
  expect(down('#p/a/deep ', null)).toEqual({ item: null, walk: null })
  expect(up('#p/a/deep ', null)).toEqual({ item: null, query: null, walk: null })
})

test('jump key predicates match Alt+PageDown and Alt+PageUp alone, reject other keys or modifiers, and do not end the walk', () => {
  expect(isRecentPageDownKey('PageDown', { altKey: true })).toBe(true)
  expect(isRecentPageDownKey('PageDown', { altKey: true, shiftKey: false, ctrlKey: false, metaKey: false })).toBe(true)
  expect(isRecentPageDownKey('PageDown', { altKey: true, shiftKey: true })).toBe(false)
  expect(isRecentPageDownKey('PageDown', { altKey: true, ctrlKey: true })).toBe(false)
  expect(isRecentPageDownKey('PageDown', { altKey: true, metaKey: true })).toBe(false)
  expect(isRecentPageDownKey('PageDown', {})).toBe(false)
  for (const key of ['PageUp', 'ArrowDown', 'ArrowUp', 'End', 'Home']) {
    expect(isRecentPageDownKey(key, { altKey: true }), key).toBe(false)
  }

  expect(isRecentPageUpKey('PageUp', { altKey: true })).toBe(true)
  expect(isRecentPageUpKey('PageUp', { altKey: true, shiftKey: false, ctrlKey: false, metaKey: false })).toBe(true)
  expect(isRecentPageUpKey('PageUp', { altKey: true, shiftKey: true })).toBe(false)
  expect(isRecentPageUpKey('PageUp', { altKey: true, ctrlKey: true })).toBe(false)
  expect(isRecentPageUpKey('PageUp', { altKey: true, metaKey: true })).toBe(false)
  expect(isRecentPageUpKey('PageUp', {})).toBe(false)
  for (const key of ['PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
    expect(isRecentPageUpKey(key, { altKey: true }), key).toBe(false)
  }

  // PageDown and PageUp never end an active Option hold
  for (const key of ['PageDown', 'PageUp']) {
    expect(isRecentWalkEndKey(key, { altKey: true }), `${key} altKey: true`).toBe(false)
    expect(isRecentWalkEndKey(key, { altKey: false }), `${key} altKey: false`).toBe(false)
  }
})

test('jumpRecentWalkOldest matches single steps to the end (equal times, stepped-back items, first key of hold, global), and Option+Up replays in reverse', () => {
  const p = item('p', 50, [], { query: '#P ' })
  const newest = item('newest', 400, ['#p/t1', '#p'], { query: '#p/t1/newest ' })
  const t1 = item('t1', 200, ['#p'], { query: '#p/t1 ' })
  const t2 = item('t2', 200, ['#p'], { query: '#p/t2 ' })
  const t3 = item('t3', 200, ['#p'], { query: '#p/t3 ' })
  const o1 = item('o1', 100, ['#p'], { query: '#p/o1 ' })
  const o2 = item('o2', 100, ['#p'], { query: '#p/o2 ' })
  const bad1 = item('bad1', Number.NaN, ['#p'], { query: '#p/bad1 ' })
  const bad2 = item('bad2', Number.NEGATIVE_INFINITY, ['#p'], { query: '#p/bad2 ' })
  const unrelated = item('other', 900, [], { query: '#other ' })
  const list = [unrelated, p, newest, t1, t2, t3, o1, o2, bad1, bad2]

  const labelOf = (i: Item) => i.query.trim().toLowerCase()
  const unique = (items: Item[]) => (label: string) => items.filter(i => labelOf(i) == label).length == 1
  const selects = (items: Item[]) => (box: string) => {
    const name = box.trim().toLowerCase()
    if (!name) return null
    if (name.startsWith('id:')) return items.find(i => i.id == name.slice(3))?.id ?? null
    const named = items.filter(i => labelOf(i) == name)
    return named.length == 1 ? named[0].id : null
  }
  const stepToEnd = (items: Item[], startBox: string, startWalk: RecentWalk | null) => {
    let walk = startWalk
    let box = startBox
    let lastItem: Item | null = null
    for (;;) {
      const res = stepRecentWalk(items, box, walk, i => i.query, unique(items), selects(items))
      walk = res.walk
      if (!res.item) return { item: lastItem, walk }
      lastItem = res.item
      box = walk!.query
    }
  }

  // 1. First key of a hold on #p: jump equals stepping one by one to the end
  const jumpedFresh = jumpRecentWalkOldest(list, '#p', null, i => i.query, unique(list), selects(list))
  const steppedFresh = stepToEnd(list, '#p', null)
  expect(jumpedFresh).toEqual(steppedFresh)
  expect(jumpedFresh.item?.id).toBe('bad2')
  expect(jumpedFresh.walk?.visited).toEqual(['newest', 't1', 't2', 't3', 'o1', 'o2', 'bad1', 'bad2'])

  // Already at the oldest item: both Option+PageDown and Option+Down do nothing and keep the walk
  expect(
    jumpRecentWalkOldest(list, jumpedFresh.walk!.query, jumpedFresh.walk, i => i.query, unique(list), selects(list)),
  ).toEqual({ item: null, walk: jumpedFresh.walk })
  expect(
    stepRecentWalk(list, jumpedFresh.walk!.query, jumpedFresh.walk, i => i.query, unique(list), selects(list)),
  ).toEqual({ item: null, walk: jumpedFresh.walk })

  // From the jumped-to-oldest position, Option+Up steps back through every visited item in exact reverse, then to #P
  let backWalk = jumpedFresh.walk
  let backBox = jumpedFresh.walk!.query
  const reversed: (string | null)[] = []
  for (;;) {
    const res = stepRecentWalkBack(list, backBox, backWalk, i => i.query, unique(list), selects(list))
    backWalk = res.walk
    if (res.query === null) break
    reversed.push(res.item?.id ?? null)
    backBox = res.query
  }
  expect(reversed).toEqual(['bad1', 'o2', 'o1', 't3', 't2', 't1', 'newest', 'p'])
  expect(backBox).toBe('#P ')

  // 2. Mid-walk with stepped-back items (`ahead` non-empty) and reordered items (plus a gone ahead id):
  // jump leaves the exact same item, visited order, and remaining ahead as repeated single steps
  const s1 = stepRecentWalk(list, '#p ', null, i => i.query, unique(list), selects(list)) // newest
  const s2 = stepRecentWalk(list, s1.walk!.query, s1.walk, i => i.query, unique(list), selects(list)) // t1
  const s3 = stepRecentWalk(list, s2.walk!.query, s2.walk, i => i.query, unique(list), selects(list)) // t2
  const s4 = stepRecentWalk(list, s3.walk!.query, s3.walk, i => i.query, unique(list), selects(list)) // t3
  // step back to t1 -> ahead is ['t2', 't3']
  const b1 = stepRecentWalkBack(list, s4.walk!.query, s4.walk, i => i.query, unique(list), selects(list))
  const b2 = stepRecentWalkBack(list, b1.walk!.query, b1.walk, i => i.query, unique(list), selects(list))
  expect(b2.walk?.visited).toEqual(['newest', 't1'])
  expect(b2.walk?.ahead).toEqual(['t2', 't3'])
  // reorder ties in items so t3 precedes t2 and o2/bad2 precede o1/bad1: the walk keeps its
  // starting tie order across the hold (o1 before o2, bad1 before bad2) in both jump and steps
  const reordered = [unrelated, p, newest, t3, t2, t1, o2, o1, bad2, bad1]
  const jumpedMid = jumpRecentWalkOldest(reordered, b2.walk!.query, b2.walk, i => i.query, unique(reordered), selects(reordered))
  const steppedMid = stepToEnd(reordered, b2.walk!.query, b2.walk)
  expect(jumpedMid).toEqual(steppedMid)
  expect(jumpedMid.walk?.visited).toEqual(['newest', 't1', 't2', 't3', 'o1', 'o2', 'bad1', 'bad2'])
  expect(jumpedMid.item?.id).toBe('bad2')

  // ahead item moved out of #p stays in ahead symmetrically with repeated single steps
  const movedT2 = reordered.map(i => (i.id == 't2' ? { ...i, ancestors: [] } : i))
  expect(
    jumpRecentWalkOldest(movedT2, b2.walk!.query, b2.walk, i => i.query, unique(movedT2), selects(movedT2)),
  ).toEqual(stepToEnd(movedT2, b2.walk!.query, b2.walk))

  // 3. Stepped all the way back to the start (`visited: []`, `ahead` non-empty) on reordered items:
  // jump still honours `ahead` tie preferences identically to single steps
  const jumpedFromStart = jumpRecentWalkOldest(reordered, backBox, backWalk, i => i.query, unique(reordered), selects(reordered))
  const steppedFromStart = stepToEnd(reordered, backBox, backWalk)
  expect(jumpedFromStart).toEqual(steppedFromStart)
  expect(jumpedFromStart.walk?.visited).toEqual(['newest', 't1', 't2', 't3', 'o1', 'o2', 'bad1', 'bad2'])

  // 4. Global walk (empty box): skips pinned, includes unnamed by id:, matches single steps to the end
  const globalItems: Item[] = [
    item('pin', 900, [], { pinned: true, query: '#pin ' }),
    item('u1', 700, [], { query: 'id:u1' }),
    item('tieA', 500, [], { query: '#tieA ' }),
    item('tieB', 500, [], { query: '#tieB ' }),
    item('u2', 300, [], { query: 'id:u2' }),
  ]
  const gJump = jumpRecentWalkOldest(globalItems, '', null, i => i.query, unique(globalItems), selects(globalItems))
  const gStep = stepToEnd(globalItems, '', null)
  expect(gJump).toEqual(gStep)
  expect(gJump.item?.id).toBe('u2')
  expect(gJump.walk?.visited).toEqual(['u1', 'tieA', 'tieB', 'u2'])
})

test('jumpRecentWalkOldest and repeated stepRecentWalk stay identical when selection reorders tied descendants between steps, and newly arrived ties come after starting ones', () => {
  // review 0 of walk_release: start at #p with #p/a newest and #p/b + #p/a/c tied at an older time.
  // Selecting #p/a moves its child #p/a/c ahead of sibling #p/b in the route's page order. Keeping
  // the starting tie order for the whole hold makes PageDown and repeated Down land on the same
  // item (#p/a/c) with the same visited history and reverse steps (#p/b -> #p/a -> #p).
  const p = item('p', 50, [], { query: '#p ' })
  const a = item('a', 300, ['#p'], { query: '#p/a ' })
  const b = item('b', 200, ['#p'], { query: '#p/b ' })
  const c = item('c', 200, ['#p/a', '#p'], { query: '#p/a/c ' })
  const all = [p, a, b, c]

  const labelOf = (i: Item) => i.query.trim().toLowerCase()
  const unique = (list: Item[]) => (label: string) => list.filter(i => labelOf(i) == label).length == 1
  const selects = (list: Item[]) => (box: string) => {
    const name = box.trim().toLowerCase()
    const named = list.filter(i => labelOf(i) == name)
    return named.length == 1 ? named[0].id : null
  }
  // route nesting order: target (0), then direct children (-1) ahead of deeper descendants (-2)
  // ahead of non-descendants (-Infinity), then time descending
  const routeOrder = (list: readonly Item[], box: string): Item[] => {
    const target = box.trim().toLowerCase()
    const nestingOf = (i: Item) => {
      if (labelOf(i) == target) return 0
      const depth = (i.ancestors ?? []).indexOf(target)
      return depth >= 0 ? -(depth + 1) : -Infinity
    }
    return [...list].sort((x, y) => nestingOf(y) - nestingOf(x) || y.time - x.time)
  }

  const atStart = routeOrder(all, '#p ')
  expect(atStart.map(i => i.id)).toEqual(['p', 'a', 'b', 'c'])
  // after selecting #p/a, the route ranks #p/a/c ahead of #p/b
  const atA = routeOrder(all, '#p/a ')
  expect(atA.map(i => i.id).indexOf('c')).toBeLessThan(atA.map(i => i.id).indexOf('b'))

  // 1. Fresh jump vs repeated steps when the route re-orders items after every selection
  const jumped = jumpRecentWalkOldest(atStart, '#p ', null, i => i.query, unique(atStart), selects(atStart))
  expect(jumped.item?.id).toBe('c')
  expect(jumped.walk?.visited).toEqual(['a', 'b', 'c'])

  let walk: RecentWalk | null = null
  let box = '#p '
  let lastItem: Item | null = null
  const visitedBySteps: string[] = []
  for (;;) {
    const ranked = routeOrder(all, box)
    const res: { item: Item | null; walk: RecentWalk | null } = stepRecentWalk(
      ranked,
      box,
      walk,
      i => i.query,
      unique(ranked),
      selects(ranked),
    )
    walk = res.walk
    if (!res.item) break
    lastItem = res.item
    visitedBySteps.push(res.item.id)
    box = walk!.query
  }
  expect(visitedBySteps, 'repeated steps match jump order across route re-ranking').toEqual(['a', 'b', 'c'])
  expect(lastItem?.id, 'repeated steps land on the same item as PageDown').toBe(jumped.item?.id)
  expect(walk, 'repeated steps end with the same walk state as PageDown').toEqual(jumped.walk)

  // Mid-walk PageDown after step 1 (on #p/a, where c now precedes b in the route's array) also matches
  const step1 = stepRecentWalk(atStart, '#p ', null, i => i.query, unique(atStart), selects(atStart))
  const midJump = jumpRecentWalkOldest(atA, step1.walk!.query, step1.walk, i => i.query, unique(atA), selects(atA))
  expect(midJump, 'mid-walk jump after route reorder matches fresh jump').toEqual(jumped)

  // 2. Step back (Option+Up) from both the jumped and stepped ends replays in identical reverse order
  const stepBackAll = (startWalk: RecentWalk) => {
    let curWalk: RecentWalk | null = startWalk
    let curBox = startWalk.query
    const backIds: (string | null)[] = []
    for (;;) {
      const ranked = routeOrder(all, curBox)
      const res: ReturnType<typeof stepRecentWalkBack<Item>> = stepRecentWalkBack(
        ranked,
        curBox,
        curWalk,
        i => i.query,
        unique(ranked),
        selects(ranked),
      )
      curWalk = res.walk
      if (res.query === null) break
      backIds.push(res.item?.id ?? null)
      curBox = res.query
    }
    return backIds
  }
  expect(stepBackAll(jumped.walk!)).toEqual(['b', 'a', 'p'])
  expect(stepBackAll(walk!)).toEqual(['b', 'a', 'p'])

  // 3. Items absent at walk start come after items present at start when tied in time (and break
  //    ties among themselves by live array order); live time and eligibility are still read anew;
  //    and `ahead` still takes precedence over starting tieOrder
  const d = item('d', 200, ['#p'], { query: '#p/d ' })
  const e = item('e', 200, ['#p'], { query: '#p/e ' })
  const withNewTies = [d, e, ...atA] // d, e precede b and c in live items array
  const jumpWithNew = jumpRecentWalkOldest(withNewTies, step1.walk!.query, step1.walk, i => i.query, unique(withNewTies), selects(withNewTies))
  let wNew: RecentWalk | null = step1.walk
  let bNew = step1.walk!.query
  const stepsWithNew: string[] = ['a']
  for (;;) {
    const res = stepRecentWalk(withNewTies, bNew, wNew, i => i.query, unique(withNewTies), selects(withNewTies))
    wNew = res.walk
    if (!res.item) break
    stepsWithNew.push(res.item.id)
    bNew = wNew!.query
  }
  expect(jumpWithNew.walk?.visited, 'newly arrived ties come after starting ties in jump').toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(stepsWithNew, 'newly arrived ties come after starting ties in repeated steps').toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(nextRecentItem([d, c, b], '#p', ['a'], [], step1.walk!.tieOrder)?.id).toBe('b')

  // Live time still wins over starting tieOrder, and live eligibility still skips moved items
  const newerD = [ { ...d, time: 250 }, ...atA ]
  expect(stepRecentWalk(newerD, step1.walk!.query, step1.walk, i => i.query, unique(newerD), selects(newerD)).item?.id).toBe('d')
  const movedB = atA.map(i => (i.id == 'b' ? { ...i, ancestors: [] } : i))
  expect(stepRecentWalk(movedB, step1.walk!.query, step1.walk, i => i.query, unique(movedB), selects(movedB)).item?.id).toBe('c')

  // `ahead` beats starting `tieOrder`: bump c to 250 so step 2 visits c, step back to a (ahead: ['c']),
  // drop c back to 200 (tied with b), and replay -> c still beats b despite tieOrder having b < c
  const bumpedC = atA.map(i => (i.id == 'c' ? { ...i, time: 250 } : i))
  const sC = stepRecentWalk(bumpedC, step1.walk!.query, step1.walk, i => i.query, unique(bumpedC), selects(bumpedC))
  expect(sC.item?.id).toBe('c')
  const backToA = stepRecentWalkBack(atA, sC.walk!.query, sC.walk, i => i.query, unique(atA), selects(atA))
  expect(backToA.walk?.ahead).toEqual(['c'])
  const replay = stepRecentWalk(atStart, backToA.walk!.query, backToA.walk, i => i.query, unique(atStart), selects(atStart))
  expect(replay.item?.id, 'ahead preference beats starting tieOrder on equal-time replay').toBe('c')
  const replayJump = jumpRecentWalkOldest(atStart, backToA.walk!.query, backToA.walk, i => i.query, unique(atStart), selects(atStart))
  expect(replayJump.walk?.visited, 'mid-walk jump also lets ahead beat starting tieOrder').toEqual(['a', 'c', 'b'])

  // Fresh hold starting from atA (where c already precedes b) captures the new starting tie order
  const freshFromAtA = jumpRecentWalkOldest(atA, '#p ', null, i => i.query, unique(atA), selects(atA))
  expect(freshFromAtA.walk?.visited).toEqual(['a', 'c', 'b'])
})

test('jumpRecentWalkStart matches single steps back to the start (labelled, empty box, already at start, first key of hold, gone start or item)', () => {
  const p = item('p', 50, [], { query: '#P ' })
  const a = item('a', 300, ['#p'], { query: '#p/a ' })
  const b = item('b', 200, ['#p'], { query: '#p/b ' })
  const c = item('c', 200, ['#p'], { query: '#p/c ' })
  const items = [p, a, b, c]

  const labelOf = (i: Item) => i.query.trim().toLowerCase()
  const unique = (list: Item[]) => (label: string) => list.filter(i => labelOf(i) == label).length == 1
  const selects = (list: Item[]) => (box: string) => {
    const name = box.trim().toLowerCase()
    if (!name) return null
    if (name.startsWith('id:')) return list.find(i => i.id == name.slice(3))?.id ?? null
    const named = list.filter(i => labelOf(i) == name)
    return named.length == 1 ? named[0].id : null
  }
  const stepBackToStart = (list: Item[], startBox: string, startWalk: RecentWalk | null) => {
    let walk = startWalk
    let box = startBox
    let last = stepRecentWalkBack(list, box, walk, i => i.query, unique(list), selects(list))
    walk = last.walk
    while (last.query !== null && walk && walk.visited.length > 0) {
      box = last.query
      last = stepRecentWalkBack(list, box, walk, i => i.query, unique(list), selects(list))
      walk = last.walk
    }
    return last
  }

  // 1. Labelled walk from oldest: jump back equals stepping back one by one to the start
  const oldest = jumpRecentWalkOldest(items, '#p ', null, i => i.query, unique(items), selects(items))
  const jumped = jumpRecentWalkStart(items, oldest.walk!.query, oldest.walk, i => i.query, unique(items), selects(items))
  const stepped = stepBackToStart(items, oldest.walk!.query, oldest.walk)
  expect(jumped).toEqual(stepped)
  expect(jumped).toMatchObject({
    item: p,
    query: '#P ',
    walk: { start: '#p', startId: 'p', visited: [], ahead: ['a', 'b', 'c'], query: '#P ' },
  })

  // At start already: no-op keeping the walk; Option+Down goes to newest again (honouring ahead on reordered ties)
  expect(jumpRecentWalkStart(items, '#P ', jumped.walk, i => i.query, unique(items), selects(items))).toEqual({
    item: null,
    query: null,
    walk: jumped.walk,
  })
  const reordered = [p, a, c, b]
  const r1 = stepRecentWalk(reordered, '#P ', jumped.walk, i => i.query, unique(reordered), selects(reordered))
  const r2 = stepRecentWalk(reordered, r1.walk!.query, r1.walk, i => i.query, unique(reordered), selects(reordered))
  expect([r1.item?.id, r2.item?.id]).toEqual(['a', 'b'])

  // Mid-walk with non-empty ahead (stepped back from c to b, then jump to start) matches single steps back
  const midBack = stepRecentWalkBack(items, oldest.walk!.query, oldest.walk, i => i.query, unique(items), selects(items))
  expect(
    jumpRecentWalkStart(items, midBack.walk!.query, midBack.walk, i => i.query, unique(items), selects(items)),
  ).toEqual(stepBackToStart(items, midBack.walk!.query, midBack.walk))

  // Without selectedId, jumping back to start falls back to `${walk.start} `
  const wNoSel = jumpRecentWalkOldest(items, '#p ', null, i => i.query, unique(items)).walk
  expect(jumpRecentWalkStart(items, '#p/c ', wNoSel, i => i.query, unique(items))).toMatchObject({
    item: null,
    query: '#p ',
    walk: { start: '#p', startId: null, visited: [], ahead: ['a', 'b', 'c'], query: '#p ' },
  })

  // 2. Global walk (empty box): jump back equals stepping back one by one to ''
  const gItems = [
    item('pin', 900, [], { pinned: true, query: '#pin ' }),
    item('u1', 700, [], { query: 'id:u1' }),
    item('mid', 500, [], { query: '#mid ' }),
    item('u2', 300, [], { query: 'id:u2' }),
  ]
  const gOldest = jumpRecentWalkOldest(gItems, '', null, i => i.query, unique(gItems), selects(gItems))
  const gJumped = jumpRecentWalkStart(gItems, gOldest.walk!.query, gOldest.walk, i => i.query, unique(gItems), selects(gItems))
  const gStepped = stepBackToStart(gItems, gOldest.walk!.query, gOldest.walk)
  expect(gJumped).toEqual(gStepped)
  expect(gJumped).toMatchObject({
    item: null,
    query: '',
    walk: { start: null, startId: null, visited: [], ahead: ['u1', 'mid', 'u2'], query: '' },
  })
  // Already at global start: no-op keeping walk, and Option+Down goes to newest again
  expect(jumpRecentWalkStart(gItems, '', gJumped.walk, i => i.query, unique(gItems), selects(gItems))).toEqual({
    item: null,
    query: null,
    walk: gJumped.walk,
  })
  expect(stepRecentWalk(gItems, '', gJumped.walk, i => i.query, unique(gItems), selects(gItems)).item?.id).toBe('u1')

  // 3. Start or current item gone (deleted, renamed, duplicated, label taken): same handling as Option+Up
  const goneCases: [string, Item[]][] = [
    ['start item deleted', [a, b, c]],
    ['start item renamed away', [{ ...p, query: '#q ' }, a, b, c]],
    ['start item label duplicated', [p, item('p2', 40, [], { query: '#p ' }), a, b, c]],
    ['start item label taken by another', [{ ...p, query: '#q ' }, item('p2', 40, [], { query: '#p ' }), a, b, c]],
    ['current item deleted', [p, a, b]],
    ['current item renamed away', [p, a, b, { ...c, query: '#p/z ' }]],
  ]
  for (const [name, list] of goneCases) {
    expect(jumpRecentWalkStart(list, '#p/c ', oldest.walk, i => i.query, unique(list), selects(list)), name).toEqual({
      item: null,
      query: null,
      walk: null,
    })
  }
  // Start missing from items even when unique/selects are omitted (startId present)
  expect(jumpRecentWalkStart([a, b, c], '#p/c ', oldest.walk, i => i.query)).toEqual({
    item: null,
    query: null,
    walk: null,
  })

  // Case-only rename of start item keeps the walk and writes the new casing
  expect(
    jumpRecentWalkStart(
      [{ ...p, query: '#p ' }, a, b, c],
      '#p/c ',
      oldest.walk,
      i => i.query,
      unique(items),
      selects(items),
    ),
  ).toMatchObject({ item: { id: 'p' }, query: '#p ' })

  // 4. First key of a hold (walk === null) or drifted box: does nothing
  for (const box of ['#p/c ', '#p ', '', 'search', '#p extra', 'id:p', '#log']) {
    expect(jumpRecentWalkStart(items, box, null, i => i.query, unique(items), selects(items)), box).toEqual({
      item: null,
      query: null,
      walk: null,
    })
  }
  for (const drifted of ['#p/c', '#p/b ', '#p ', '']) {
    expect(jumpRecentWalkStart(items, drifted, oldest.walk, i => i.query, unique(items), selects(items)), drifted).toEqual({
      item: null,
      query: null,
      walk: null,
    })
  }
})

test('jumpRecentWalkOldest does nothing where nothing is under the start or the start is invalid', () => {
  const items: Item[] = [
    item('p', 500, [], { query: '#p ' }),
    item('leaf', 400, ['#p'], { query: '#p/leaf ' }),
    item('dup1', 300, [], { query: 'id:dup1' }),
    item('dup_child', 350, ['#dup'], { query: '#dup/child ' }),
    item('log_item', 360, [], { query: '#log ' }),
    item('log_child', 370, ['#log'], { query: '#log/child ' }),
  ]
  const unique = (label: string) =>
    label == '#p' || label == '#p/leaf' || label == '#dup/child' || label == '#log' || label == '#log/child'

  // Leaf and invalid starts do nothing and start no walk
  for (const box of ['#p/leaf ', 'id:p', 'id:unnamed123', '#log', '#dup', '#missing', '#p extra', 'search', '/cmd']) {
    expect(jumpRecentWalkOldest(items, box, null, i => i.query, unique), box).toEqual({ item: null, walk: null })
  }
  // Empty and all-pinned global corpora do nothing
  expect(jumpRecentWalkOldest([] as Item[], '', null, i => i.query)).toEqual({ item: null, walk: null })
  expect(
    jumpRecentWalkOldest([item('pin', 500, [], { pinned: true, query: '#pin ' })], '', null, i => i.query),
  ).toEqual({ item: null, walk: null })

  // Single-descendant walk: fresh jump lands on the only item; jumping after already stepping onto it is a no-op
  const freshSingle = jumpRecentWalkOldest(items, '#p ', null, i => i.query, unique)
  expect(freshSingle.item?.id).toBe('leaf')
  expect(freshSingle.walk?.visited).toEqual(['leaf'])
  const steppedSingle = stepRecentWalk(items, '#p ', null, i => i.query, unique)
  expect(jumpRecentWalkOldest(items, steppedSingle.walk!.query, steppedSingle.walk, i => i.query, unique)).toEqual({
    item: null,
    walk: steppedSingle.walk,
  })
})

test('jumpRecentWalkOldest and jumpRecentWalkStart handle 20,000 items within a second', () => {
  const N = 20_000
  const items: Item[] = []
  for (let i = 0; i < N; i++) {
    // non-monotonic times with ties so sorting does real work, with known unique newest and oldest
    const time = i === 12_345 ? 1_000_000 : i === 6_789 ? -1 : (i * 7919) % 5_000
    items.push(item(`i${i}`, time, [], { query: `id:i${i}` }))
  }

  const t0 = performance.now()
  const jumped = jumpRecentWalkOldest(items, '', null, i => i.query)
  const jumpMs = performance.now() - t0
  expect(jumped.item?.id).toBe('i6789')
  expect(jumped.walk?.visited.length).toBe(N)
  expect(jumped.walk?.visited[0]).toBe('i12345')
  expect(jumped.walk?.visited[N - 1]).toBe('i6789')
  expect(jumpMs, `jumpRecentWalkOldest on ${N} items took ${jumpMs.toFixed(1)} ms`).toBeLessThan(1000)

  // stepping back one item from the oldest lands on the second-oldest item
  const prev = stepRecentWalkBack(items, jumped.walk!.query, jumped.walk, i => i.query)
  expect(prev.item?.id).toBe(jumped.walk!.visited[N - 2])

  // jumping back to the start also completes well within a second
  const t1 = performance.now()
  const back = jumpRecentWalkStart(items, jumped.walk!.query, jumped.walk, i => i.query)
  const backMs = performance.now() - t1
  expect(back.item).toBeNull()
  expect(back.query).toBe('')
  expect(back.walk?.visited).toEqual([])
  expect(back.walk?.ahead.length).toBe(N)
  expect(backMs, `jumpRecentWalkStart on ${N} items took ${backMs.toFixed(1)} ms`).toBeLessThan(1000)
})
