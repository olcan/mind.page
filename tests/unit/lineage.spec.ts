import { expect, test } from '@playwright/test'
import {
  Lineage,
  derive,
  levelsMatch,
  prefixOf,
  resolveTag,
  rootOf,
  type Derived,
  type Facts,
} from '../../src/lineage.js'

// tables for the pure derivation of the label tree (src/lineage.ts; the design in the vault's
// notes/design/mind_page_parent_tag.md): the tag parent, the ancestry, the adoption, the ordered
// closure and the chat classification from the items' facts alone, order-independent and consistent
// with each other. The fixtures are first lines: the first visible tag is the label, `#_x` a hidden tag
// (resolved relative to the label like the runtime's), `#_autodep` the carrier tag; the fixed aliases
// of the runtime's altTags that matter here are applied. Every table also runs the consistency checks
// of `consistent` over its whole corpus and derives it again from the reversed input order.

const ALIASES: Record<string, string> = {
  '#init': '#features/_init',
  '#autodep': '#features/_autodep',
}

function facts(line: string, id?: string): Facts {
  const raw = (line.toLowerCase().match(/#[^\s#]+/g) ?? []).filter(t => t != '#')
  const label = raw.find(t => !t.startsWith('#_')) ?? ''
  const hidden = raw.filter(t => t.startsWith('#_')).map(t => '#' + t.slice(2))
  const resolved = (tags: string[]) => tags.map(t => resolveTag(label, t)).filter((t): t is string => t !== undefined)
  const tagsHidden = resolved(hidden)
  // the runtime appends the aliases of the UNRESOLVED hidden tags after all of them, then resolves
  // the relative forms (reviews 3 and 4): a relative `#//init` is no alias
  const tagsHiddenAlt = Array.from(
    new Set(resolved(hidden.concat(hidden.flatMap(t => (ALIASES[t] ? [ALIASES[t]] : []))))),
  )
  return { id: id ?? label, label, tagsHidden, tagsHiddenAlt, carrier: raw.includes('#_autodep') }
}

const corpus = (...lines: (string | [string, string])[]) =>
  lines.map(l => (typeof l == 'string' ? facts(l) : facts(l[0], l[1])))

// the checks every corpus must pass, whatever its shape
function consistent(items: Facts[]): Map<string, Derived> {
  const lineage = new Lineage(items)
  const byId = new Map(items.map(f => [f.id, f]))
  const out = new Map<string, Derived>()
  for (const f of items) {
    const d = lineage.get(f.id)
    out.set(f.id, d)
    // the ancestry begins with the tag parent's label, else the textual prefix (when there is one)
    const first = d.tagParent !== null ? byId.get(d.tagParent)!.label : prefixOf(f.label)
    expect(d.ancestors[0] ?? '', `${f.id}: first level`).toBe(first)
    expect(d.ancestors, `${f.id}: never its own ancestor`).not.toContain(f.label)
    // an accepted override names a chat item under the item's root that is not its textual parent
    if (d.tagParent !== null) {
      const t = byId.get(d.tagParent)!
      expect(lineage.get(t.id).chat, `${f.id}: the tag parent ${t.id} is a chat item`).toBe(true)
      expect(rootOf(t.label)).toBe(rootOf(f.label))
      expect(t.label).not.toBe(prefixOf(f.label))
      expect(f.tagsHidden).toContain(t.label)
      expect(d.parent, `${f.id}: the tag parent is the first dependency`).toBe(d.tagParent)
    }
    // adoption reads the carriers among the ancestry's unique items
    const carried = d.ancestors.some(level => {
      const u = lineage.unique(level)
      return u !== undefined && byId.get(u)!.carrier
    })
    expect(d.adopts, `${f.id}: adopts`).toBe(carried)
    if (d.tagParent === null) expect(d.parent).toBe(d.adopts ? (lineage.unique(prefixOf(f.label)) ?? null) : null)
    // the closure begins with the parent's closure and the parent (unless the parent's own closure
    // holds the item: a dependency cycle through the adoption, where the item's closure has the
    // parent without itself)
    if (d.parent !== null && !lineage.get(d.parent).deps.includes(f.id))
      expect(d.deps.slice(0, lineage.get(d.parent).deps.length + 1)).toEqual([...lineage.get(d.parent).deps, d.parent])
    expect(d.deps, `${f.id}: excluded from its own closure`).not.toContain(f.id)
    expect(new Set(d.deps).size).toBe(d.deps.length)
    // chat classification is the closure prefix rule
    const chatId = lineage.unique('#chat')
    const prefix = chatId === undefined ? null : [...lineage.get(chatId).deps, chatId]
    expect(d.chat).toBe(prefix !== null && d.deps.length >= prefix.length && prefix.every((x, i) => d.deps[i] == x))
  }
  // the same facts in the reverse order derive the same facts
  const reversed = derive(items.slice().reverse())
  for (const [id, d] of out) expect(reversed.get(id), `${id}: order-independent`).toEqual(d)
  return out
}

const CHAT = ['#chat #_autodep', '#chat/vault', '#p', '#p/0 #_chat/vault #_autodep', '#p/0/0', '#p/0/0/0']

test('a nested chain derives the facts of today: adoption by the carrier, the closures, the chat prefix', () => {
  const d = consistent(corpus(...CHAT))
  expect(d.get('#chat')).toEqual({
    tagParent: null,
    ancestors: [],
    adopts: false,
    parent: null,
    deps: [],
    chat: false,
  })
  expect(d.get('#chat/vault')).toEqual({
    tagParent: null,
    ancestors: ['#chat'],
    adopts: true,
    parent: '#chat',
    deps: ['#chat'],
    chat: true,
  })
  expect(d.get('#p/0')).toEqual({
    tagParent: null,
    ancestors: ['#p'],
    adopts: false,
    parent: null,
    deps: ['#chat', '#chat/vault'],
    chat: true,
  })
  expect(d.get('#p/0/0/0')).toEqual({
    tagParent: null,
    ancestors: ['#p/0/0', '#p/0', '#p'],
    adopts: true,
    parent: '#p/0/0',
    deps: ['#chat', '#chat/vault', '#p/0', '#p/0/0'],
    chat: true,
  })
})

test("a renamed node sits under its tag parent, and its tag-free children follow it (the owner's shape)", () => {
  const d = consistent(corpus(...CHAT, '#p/plan-b #_p/0/0', '#p/plan-b/0', '#p/plan-b/0/0'))
  expect(d.get('#p/plan-b')).toEqual({
    tagParent: '#p/0/0',
    ancestors: ['#p/0/0', '#p/0', '#p'],
    adopts: true,
    parent: '#p/0/0',
    deps: ['#chat', '#chat/vault', '#p/0', '#p/0/0'],
    chat: true,
  })
  expect(d.get('#p/plan-b/0')).toEqual({
    tagParent: null,
    ancestors: ['#p/plan-b', '#p/0/0', '#p/0', '#p'],
    adopts: true,
    parent: '#p/plan-b',
    deps: ['#chat', '#chat/vault', '#p/0', '#p/0/0', '#p/plan-b'],
    chat: true,
  })
  expect(d.get('#p/plan-b/0/0')!.ancestors).toEqual(['#p/plan-b/0', '#p/plan-b', '#p/0/0', '#p/0', '#p'])
  const lineage = new Lineage(corpus(...CHAT, '#p/plan-b #_p/0/0', '#p/plan-b/0'))
  expect(lineage.children('#p')).toEqual(['#p/0']) // the renamed node is no child of its textual parent
  expect(lineage.children('#p/0/0')).toEqual(['#p/0/0/0', '#p/plan-b']) // nested first, then the tag children
  expect(lineage.children('#p/plan-b')).toEqual(['#p/plan-b/0'])
})

test('renames compose: a rename under a rename, and a rename onto a tag-free child of one', () => {
  const d = consistent(
    corpus(...CHAT, '#p/plan-b #_p/0/0', '#p/plan-b/0', '#p/plan-c #_p/plan-b', '#p/plan-d #_p/plan-b/0'),
  )
  expect(d.get('#p/plan-c')!.ancestors).toEqual(['#p/plan-b', '#p/0/0', '#p/0', '#p'])
  expect(d.get('#p/plan-d')!.tagParent).toBe('#p/plan-b/0') // a chat item only through the spliced adoption
  expect(d.get('#p/plan-d')!.ancestors).toEqual(['#p/plan-b/0', '#p/plan-b', '#p/0/0', '#p/0', '#p'])
  expect(d.get('#p/plan-d')!.deps).toEqual(['#chat', '#chat/vault', '#p/0', '#p/0/0', '#p/plan-b', '#p/plan-b/0'])
})

test('a missing level is a level without an item: the walk crosses it, the parent edge needs a unique item', () => {
  const d = consistent(corpus('#a #_autodep', '#a/b/c', '#a/b/c/d'))
  expect(d.get('#a/b/c')).toMatchObject({
    ancestors: ['#a/b', '#a'],
    adopts: true,
    parent: null,
    deps: [],
  })
  expect(d.get('#a/b/c/d')).toMatchObject({
    ancestors: ['#a/b/c', '#a/b', '#a'],
    adopts: true,
    parent: '#a/b/c',
    deps: ['#a/b/c'],
  })
  const without = consistent(corpus('#a', '#a/b/c', '#a/b/c/d'))
  expect(without.get('#a/b/c/d')).toMatchObject({ adopts: false, parent: null, deps: [] })
})

test('a duplicated level resolves nowhere: no splice, no parent edge, no carrier through it', () => {
  const d = consistent(corpus('#a #_autodep', ['#a/b', 'b1'], ['#a/b #_autodep', 'b2'], '#a/b/c'))
  expect(d.get('#a/b/c')).toMatchObject({
    ancestors: ['#a/b', '#a'],
    adopts: true,
    parent: null,
    deps: [],
  })
  expect(new Lineage(corpus(...CHAT, ['#p/x #_p/0/0', 'x1'], ['#p/x #_p/0', 'x2'])).ancestorsOfLabel('#p/x')).toEqual([
    '#p',
  ])
})

test('a target in a dependency-or-nesting cycle with the item is no candidate (review 2 C1)', () => {
  // a valid transcript today: A continues B, B nests under A; the tree keeps both in their textual
  // places while the closure and the chat classification stay as they are
  const d = consistent(corpus('#chat #_autodep', '#p', '#p/a #_p/a/b', '#p/a/b #_chat'))
  expect(d.get('#p/a')).toEqual({
    tagParent: null,
    ancestors: ['#p'],
    adopts: false,
    parent: null,
    deps: ['#chat', '#p/a/b'],
    chat: true,
  })
  expect(d.get('#p/a/b')).toEqual({
    tagParent: null,
    ancestors: ['#p/a', '#p'],
    adopts: false,
    parent: null,
    deps: ['#chat'],
    chat: true,
  })
  // reciprocal tags among chats under a carrier: no overrides, both adopt the carrier, both chats
  const r = consistent(corpus(...CHAT, '#p/0/x #_p/0/y', '#p/0/y #_p/0/x'))
  expect(r.get('#p/0/x')).toEqual({
    tagParent: null,
    ancestors: ['#p/0', '#p'],
    adopts: true,
    parent: '#p/0',
    deps: ['#chat', '#chat/vault', '#p/0', '#p/0/y'],
    chat: true,
  })
  expect(r.get('#p/0/y')!.deps).toEqual(['#chat', '#chat/vault', '#p/0', '#p/0/x'])
  // a tag naming the item's own nested child, and a self-tag
  const own = consistent(corpus(...CHAT, '#p/n #_p/n/c', '#p/n/c #_chat/vault', '#chat/a #_chat/a'))
  expect(own.get('#p/n')).toMatchObject({
    tagParent: null,
    ancestors: ['#p'],
    deps: ['#chat', '#chat/vault', '#p/n/c'],
    chat: true,
  })
  expect(own.get('#chat/a')).toMatchObject({
    tagParent: null,
    parent: '#chat',
    deps: ['#chat'],
    chat: true,
  })
})

test('the shipped utility cycle derives as today and stays out of every chat prefix', () => {
  // util/core imports its types item, which imports util/core back through a relative form; #chat
  // imports util/core: a real dependency cycle inside every chat closure (review 2 C1)
  const d = consistent(
    corpus(
      '#util',
      '#util/core #_util/core/types',
      '#util/core/types #_///core',
      '#chat #_util/core #_autodep',
      '#chat/vault',
      '#p',
      '#p/0 #_chat/vault #_autodep',
      '#p/0/0',
    ),
  )
  expect(d.get('#chat')!.deps).toEqual(['#util/core/types', '#util/core'])
  expect(d.get('#util/core')).toMatchObject({
    tagParent: null,
    deps: ['#util/core/types'],
    chat: false,
  })
  expect(d.get('#util/core/types')).toMatchObject({
    tagParent: null,
    deps: ['#util/core'],
    chat: false,
  })
  expect(d.get('#p/0/0')).toMatchObject({
    deps: ['#util/core/types', '#util/core', '#chat', '#chat/vault', '#p/0'],
    chat: true,
  })
})

test('candidates are the exact hidden tags: an alias-expanded dependency is no tag parent (review 2 C4)', () => {
  const d = consistent(corpus('#chat #_autodep', '#features', '#features/_init #_chat', '#features/x #_init'))
  // the dependency view reaches the aliased item, so x IS a chat item, with no transcript parent and no override
  expect(d.get('#features/x')).toEqual({
    tagParent: null,
    ancestors: ['#features'],
    adopts: false,
    parent: null,
    deps: ['#chat', '#features/_init'],
    chat: true,
  })
})

test("the override needs one chat candidate under the item's root that is not its textual parent", () => {
  const d = consistent(
    corpus(
      ...CHAT,
      '#p/x #_chat/vault #_p/0/0', // two chat candidates: none (the transcript is ambiguous too)
      '#p/y #_p/0/0 #_//0/0', // two spellings of one candidate: one
      '#elsewhere #_p/0/0', // a root label: none, a continuation for the transcript
      '#q/z #_p/0/0', // another root: none
      '#p/0/1 #_p/0', // the textual parent: none (nothing would change)
      '#util/math #_util/core', // no chat named: none
      '#util/core',
    ),
  )
  expect(d.get('#p/x')).toMatchObject({
    tagParent: null,
    ancestors: ['#p'],
    deps: ['#chat', '#chat/vault', '#p/0', '#p/0/0'],
    chat: true,
  })
  expect(d.get('#p/y')).toMatchObject({ tagParent: '#p/0/0', ancestors: ['#p/0/0', '#p/0', '#p'] })
  expect(d.get('#elsewhere')).toMatchObject({ tagParent: null, ancestors: [], chat: true })
  expect(d.get('#q/z')).toMatchObject({ tagParent: null, ancestors: ['#q'], chat: true })
  expect(d.get('#p/0/1')).toMatchObject({
    tagParent: null,
    ancestors: ['#p/0', '#p'],
    parent: '#p/0',
    deps: ['#chat', '#chat/vault', '#p/0'],
    chat: true,
  })
  expect(d.get('#util/math')).toMatchObject({
    tagParent: null,
    ancestors: ['#util'],
    deps: ['#util/core'],
    chat: false,
  })
})

test('an item naming a chat under its root is its continuation whatever its other tags or textual carrier', () => {
  // review 1's example: a non-chat carrier above, a chat named by the tag (review 2: decided, not preserved)
  const a = consistent(
    corpus('#chat #_autodep', '#p', '#p/a #_autodep', '#p/known #_chat #_autodep', '#p/a/x #_p/known'),
  )
  expect(a.get('#p/a/x')).toEqual({
    tagParent: '#p/known',
    ancestors: ['#p/known', '#p'],
    adopts: true,
    parent: '#p/known',
    deps: ['#chat', '#p/known'],
    chat: true,
  })
  // the order-sensitive row: the tag parent's closure comes first wherever its tag sits
  const o = consistent(corpus(...CHAT, '#util/core', '#p/x #_util/core #_p/0/0'))
  expect(o.get('#p/x')).toMatchObject({
    tagParent: '#p/0/0',
    deps: ['#chat', '#chat/vault', '#p/0', '#p/0/0', '#util/core'],
    chat: true,
  })
  // a tag-free child under the overridden node loses its textual carrier when the new ancestry has none
  const l = consistent(
    corpus('#chat #_autodep', '#p', '#p/c #_chat #_autodep', '#p/known #_chat', '#p/c/y #_p/known', '#p/c/y/z'),
  )
  expect(l.get('#p/c/y')).toMatchObject({
    tagParent: '#p/known',
    ancestors: ['#p/known', '#p'],
    deps: ['#chat', '#p/known'],
    chat: true,
  })
  expect(l.get('#p/c/y/z')).toMatchObject({
    tagParent: null,
    ancestors: ['#p/c/y', '#p/known', '#p'],
    adopts: false,
    parent: null,
    deps: [],
    chat: false,
  })
})

test('the task chat and the route: an out-of-root chat parent leaves the tree alone', () => {
  const d = consistent(corpus('#chat #_autodep', '#chat/vault', '#p', '#p/a #_chat/vault', '#p/a/b'))
  expect(d.get('#p/a')).toMatchObject({
    tagParent: null,
    ancestors: ['#p'],
    deps: ['#chat', '#chat/vault'],
    chat: true,
  })
  expect(d.get('#p/a/b')).toMatchObject({
    tagParent: null,
    ancestors: ['#p/a', '#p'],
    adopts: false,
    parent: null,
    deps: [],
    chat: false,
  })
})

test("the levels above a query label: a missing label's textual levels, a unique label's ancestry", () => {
  const lineage = new Lineage(corpus(...CHAT, '#p/plan-b #_p/0/0'))
  expect(lineage.ancestorsOfLabel('#p/0/0/9')).toEqual(['#p/0/0', '#p/0', '#p'])
  expect(lineage.ancestorsOfLabel('#p/plan-b/7')).toEqual(['#p/plan-b', '#p/0/0', '#p/0', '#p'])
  expect(lineage.ancestorsOfLabel('#p/plan-b')).toEqual(['#p/0/0', '#p/0', '#p'])
  expect(lineage.ancestorsOfLabel('#nowhere')).toEqual([])
})

test('resolveTag matches the runtime and the vault port', () => {
  expect(resolveTag('#chat/other', '#//topic')).toBe('#chat/topic')
  expect(resolveTag('#a/b/c', '#///x')).toBe('#a/x')
  expect(resolveTag('#a/b', '#///x')).toBe('#x')
  expect(resolveTag('#a', '#//x')).toBe('#x')
  expect(resolveTag('#a', '#/x')).toBe('#a/x')
  expect(resolveTag('#a', '#///x')).toBe(undefined) // too short a label for the form
  expect(resolveTag('#a', '#b')).toBe('#b')
})

test('the derivation over a representative corpus costs milliseconds', () => {
  // 40 todos with 40-turn chains (1,600 chat items), a rename every tenth turn with two tag-free turns
  // below it, the shipped utility cycle inside every chat closure, 300 ordinary items importing
  // utilities: about the owner's account in items, deeper in chains
  const items = corpus(
    '#util',
    '#util/core #_util/core/types',
    '#util/core/types #_///core',
    '#chat #_util/core #_autodep',
    '#chat/vault',
  )
  for (let t = 0; t < 40; t++) {
    items.push(facts(`#t${t}`), facts(`#t${t}/0 #_chat/vault #_autodep`))
    let label = `#t${t}/0`
    for (let turn = 1; turn < 40; turn++) {
      if (turn % 10 == 0) {
        items.push(facts(`#t${t}/plan-${turn} #_${label.slice(1)}`))
        label = `#t${t}/plan-${turn}`
      } else {
        items.push(facts(`${label}/0`))
        label = `${label}/0`
      }
    }
  }
  for (let i = 0; i < 300; i++) items.push(facts(`#lib/item${i} #_util/core #_lib/item${(i + 1) % 300}`))
  const started = performance.now()
  const derived = derive(items)
  const elapsed = performance.now() - started
  console.log(`lineage: ${items.length} items derived in ${elapsed.toFixed(1)} ms`)
  expect(derived.size).toBe(items.length)
  expect(derived.get('#t3/plan-30/0/0')).toMatchObject({
    adopts: true,
    chat: true,
    ancestors: expect.arrayContaining(['#t3/plan-30', '#t3/plan-20/0/0/0/0/0/0/0/0/0']),
  })
  expect(derived.get('#t3/plan-30/0/0')!.deps.length).toBe(36) // the chat prefix (4) and the 32 turns above it
  expect(elapsed).toBeLessThan(1000) // a loose bound against a loaded machine; the log carries the measurement
})

test("#chat's own closure bootstraps the classification: its items take no override (review 3 B1)", () => {
  // an ordinary acyclic corpus: #chat imports a utility that imports a helper; classifying the
  // helper (the utility's exact target) needs #chat's closure, which is being computed
  const d = consistent(corpus('#chat #_util/core #_autodep', '#util/core #_util/helper', '#util/helper'))
  expect(d.get('#chat')).toMatchObject({ deps: ['#util/helper', '#util/core'], chat: false })
  expect(d.get('#util/core')).toMatchObject({ tagParent: null, deps: ['#util/helper'], chat: false })
  expect(d.get('#util/helper')).toMatchObject({ tagParent: null, deps: [], chat: false })
})

test('an item whose label is not unique takes no override (review 3 B2)', () => {
  const d = consistent(corpus('#chat #_autodep', '#p', ['#p/a #_p/a/b', 'a1'], ['#p/a', 'a2'], '#p/a/b #_chat'))
  expect(d.get('a1')).toMatchObject({ tagParent: null, ancestors: ['#p'], deps: ['#chat', '#p/a/b'], chat: true })
  expect(d.get('#p/a/b')).toMatchObject({ tagParent: null, ancestors: ['#p/a', '#p'], adopts: false, parent: null })
})

test('a long chain of renames derives in either input order (review 3 B3)', () => {
  const items = corpus('#chat #_autodep', '#p', '#p/t0 #_chat #_autodep')
  for (let i = 1; i < 300; i++) items.push(facts(`#p/t${i} #_p/t${i - 1}`))
  const d = consistent(items)
  expect(d.get('#p/t299')!.deps.length).toBe(300) // #chat and the 299 turns above it
  expect(d.get('#p/t299')!.ancestors.slice(0, 2)).toEqual(['#p/t298', '#p/t297'])
  expect(d.get('#p/t299')!.chat).toBe(true)
})

test("a target in the item's cycle component blocks the override, whatever the other targets (review 3)", () => {
  // A names B (which names A back) and C: the transcript is ambiguous, the tree takes no override
  const m = consistent(corpus('#chat #_autodep', '#p', '#p/a #_p/b #_p/c', '#p/b #_chat #_p/a', '#p/c #_chat'))
  expect(m.get('#p/a')).toMatchObject({
    tagParent: null,
    ancestors: ['#p'],
    deps: ['#chat', '#p/b', '#p/c'],
    chat: true,
  })
  // a renamed node importing its own nested child: the transcript continues #p/0/0, the tree stays textual
  const n = consistent(corpus(...CHAT, '#p/plan-b #_p/0/0 #_p/plan-b/notes', '#p/plan-b/notes'))
  expect(n.get('#p/plan-b')).toMatchObject({
    tagParent: null,
    ancestors: ['#p'],
    deps: ['#chat', '#chat/vault', '#p/0', '#p/0/0', '#p/plan-b/notes'],
    chat: true,
  })
})

test('the aliases come after every exact hidden tag, as the runtime orders them (review 3)', () => {
  const d = consistent(corpus('#chat #_autodep', '#features', '#features/_init', '#x #_init #_chat'))
  expect(d.get('#x')).toMatchObject({ deps: ['#chat', '#features/_init'], chat: true })
})

test('a dependency cycle through the adoption keeps its closures (review 3)', () => {
  const d = consistent(corpus('#p #_autodep #_p/a', '#p/a'))
  expect(d.get('#p')).toMatchObject({ parent: null, deps: ['#p/a'] })
  expect(d.get('#p/a')).toMatchObject({ adopts: true, parent: '#p', deps: ['#p'] })
})

test('a relative form that resolves to a special tag is no alias (review 4)', () => {
  const f = facts('#root #_//init')
  expect(f.tagsHidden).toEqual(['#init'])
  expect(f.tagsHiddenAlt).toEqual(['#init'])
  const d = consistent(corpus('#chat #_autodep', '#features', '#features/_init #_chat', '#root #_//init'))
  expect(d.get('#root')).toMatchObject({ deps: [], chat: false })
})

test("a query for a tree ancestor matches a renamed node's descendants by their levels, duplicates included (review 5 B1)", () => {
  // the tag-free children of the renamed node, a unique one and two sharing a label, all have the
  // ancestry the renamed node gives them (a duplicated label takes no override of its own, but its
  // unique levels splice), and match the query #p/0/0 as a nested label would by its text
  const lineage = new Lineage(
    corpus(...CHAT, '#p/plan-b #_p/0/0', '#p/plan-b/0', ['#p/plan-b/1', 'd1'], ['#p/plan-b/1', 'd2'], '#q/z'),
  )
  for (const id of ['#p/plan-b/0', 'd1', 'd2']) {
    expect(lineage.get(id).ancestors, id).toEqual(['#p/plan-b', '#p/0/0', '#p/0', '#p'])
    expect(levelsMatch(lineage.get(id).ancestors, '#p/0/0'), `${id} under #p/0/0`).toBe(true)
    expect(levelsMatch(lineage.get(id).ancestors, '#p/0'), `${id} under #p/0 (a prefix of a level)`).toBe(true)
  }
  expect(lineage.get('d1').tagParent).toBe(null) // no override of their own
  expect(levelsMatch(lineage.get('#q/z').ancestors, '#p/0/0'), 'an unrelated item').toBe(false)
  expect(levelsMatch(lineage.get('#p/plan-b/0').ancestors, '#p/plan-b/0'), 'its own label is not among its levels (the text search matches it)').toBe(false)
})
