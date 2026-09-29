// the label tree's facts, derived from the items' own facts alone: for every item its TAG PARENT (a hidden
// tag naming a chat item under the item's own root: the item's place in the tree without the nested
// label), its ANCESTRY (the textual levels with such overrides spliced in at any uniquely labeled level),
// whether it ADOPTS a parent as its first dependency (#_autodep carried by any unique item among its
// ancestors), its first dependency, its ordered dependency closure (the runtime's itemDeps) and its chat
// classification (the closure begins with #chat's closure and #chat, chat.js's is_chat_item). The design
// (notes/design/mind_page_parent_tag.md in the vault) and the same derivation in the vault's
// lib/mindpage_lineage.py. Every result is a total, order-independent function of the corpus: a hidden
// tag target in a DEPENDENCY-OR-NESTING CYCLE with the item (the same strongly connected component of
// the graph whose edges are the unique targets of an item's hidden tags and its unique label-prefix
// ancestors) blocks the override (the transcript may be ambiguous through it, and the tree never
// decides what the transcript cannot), an item whose label is not unique takes none (its levels are
// no place in the tree), so every accepted override points from a unique item strictly down the
// component order; the ancestries, adoptions and closures that follow it need no visited sets to
// terminate (a guard throws should the argument ever fail, rather than answer differently per walk),
// and the items are evaluated in that order (a component after every component it reaches), so no
// decision recurses through another's. The chat classification needs #chat's own closure first: the
// items of that closure and their label ancestors can take no override (a chat target of theirs would
// close a cycle with them), so while that closure is being computed every classification is false,
// which is what it turns out to be.

export type Facts = {
  id: string
  label: string // the lowercased label, '' when unlabeled
  tagsHidden: string[] // the exact hidden tags, resolved relative to the label (item.tagsHidden)
  tagsHiddenAlt: string[] // the dependency view: the hidden tags with their special-tag aliases (item.tagsHiddenAlt)
  carrier: boolean // the raw tags include #_autodep (the tag applies to the descendants, never to the carrier)
}

export type Derived = {
  tagParent: string | null // the accepted override's target (an item id)
  ancestors: string[] // the levels above the item, nearest first (labels; a level need not be an item)
  adopts: boolean // a unique item among the ancestors carries #_autodep
  parent: string | null // the first dependency: the tag parent, else the adopted immediate textual parent
  deps: string[] // the ordered dependency closure, the item itself excluded
  chat: boolean // the closure begins with #chat's closure followed by #chat
}

export const rootOf = (label: string) => (label.includes('/') ? label.slice(0, label.indexOf('/')) : label)
export const prefixOf = (label: string) => (label.includes('/') ? label.slice(0, label.lastIndexOf('/')) : '')

// a tag resolved relative to an item's label (the runtime's resolveTag): #/x nests under the label, #//x
// replaces its last segment, #///x its last two; undefined when the label is too short for the form
export function resolveTag(label: string, tag: string): string | undefined {
  let resolved = tag
  if (tag == label) resolved = tag
  else if (tag.startsWith('#///') && label.match(/\/[^\/]*?\/[^\/]*$/))
    resolved = label.replace(/\/[^\/]*?\/[^\/]*$/, '') + tag.substring(3)
  else if (tag.startsWith('#///') && label.match(/^#[^\/]*?\/[^\/]*$/)) resolved = '#' + tag.substring(4)
  else if (tag.startsWith('#//') && label.match(/\/[^\/]*$/))
    resolved = label.replace(/\/[^\/]*$/, '') + tag.substring(2)
  else if (tag.startsWith('#//') && label.match(/^#[^\/]*$/)) resolved = '#' + tag.substring(3)
  else if (tag.startsWith('#/')) resolved = label + tag.substring(1)
  if (resolved.startsWith('#/')) return undefined
  return resolved
}

type Kind = 'override' | 'ancestors' | 'adopts' | 'parent' | 'deps' | 'chat'

export class Lineage {
  private facts = new Map<string, Facts>()
  private uniqueIds = new Map<string, string>()
  private comp = new Map<string, number>()
  private memo = new Map<string, unknown>()
  private busy = new Set<string>()
  private chatPrefix: string[] | null | undefined
  private chatPrefixBusy = false

  constructor(items: Facts[]) {
    const counts = new Map<string, number>()
    for (const f of items) {
      if (this.facts.has(f.id)) throw new Error(`lineage: duplicate item id ${f.id}`)
      this.facts.set(f.id, f)
      if (f.label) counts.set(f.label, (counts.get(f.label) ?? 0) + 1)
    }
    for (const f of items) if (f.label && counts.get(f.label) == 1) this.uniqueIds.set(f.label, f.id)
    const ids = items.map(f => f.id)
    this.components(ids)
    // every item evaluated once, a component after the components it reaches (Tarjan numbers them
    // so), so a long chain of renames costs no deep recursion whatever the input order
    for (const id of ids.slice().sort((a, b) => this.comp.get(a)! - this.comp.get(b)!)) this.get(id)
  }

  // the unique item of a label, if any (a label held by two items resolves nowhere)
  unique(label: string): string | undefined {
    return this.uniqueIds.get(label)
  }

  ids(): string[] {
    return Array.from(this.facts.keys())
  }

  get(id: string): Derived {
    if (!this.facts.has(id)) throw new Error(`lineage: unknown item ${id}`)
    return {
      tagParent: this.override(id),
      ancestors: this.ancestors(id),
      adopts: this.adopts(id),
      parent: this.parent(id),
      deps: this.deps(id),
      chat: this.chat(id),
    }
  }

  // the tree's children of an item: the unique labels one segment below its label whose items take no
  // override (an overridden child sits under its tag parent), then the items whose tag parent it is, each
  // group in label order (the corpus keeps no creation time)
  children(id: string): string[] {
    const label = this.facts.get(id)!.label
    if (!label) return []
    const nested: string[] = []
    const tagged: string[] = []
    for (const [other, f] of this.facts) {
      if (other == id) continue
      if (this.override(other) == id) tagged.push(other)
      else if (
        f.label.startsWith(label + '/') &&
        !f.label.includes('/', label.length + 1) &&
        this.unique(f.label) == other &&
        this.override(other) === null
      )
        nested.push(other)
    }
    const byLabel = (a: string, b: string) => (this.facts.get(a)!.label < this.facts.get(b)!.label ? -1 : 1)
    return nested.sort(byLabel).concat(tagged.sort(byLabel))
  }

  // the levels above a LABEL (a query's, which may name no item or two): the textual levels with the
  // overrides of uniquely labeled levels spliced in; an ambiguous or missing label splices nothing of
  // its own
  ancestorsOfLabel(label: string): string[] {
    return this.walk(label, this.unique(label) ?? null)
  }

  // the accepted override: the one chat item among the unique targets of the item's EXACT hidden tags,
  // itself excluded, when its label shares the item's root segment and is not the item's immediate
  // textual parent (that override would change nothing); a root label and a non-unique label take
  // none, and a target in the item's cycle component blocks the override
  private override(id: string): string | null {
    return this.memoize('override', id, () => {
      const f = this.facts.get(id)!
      if (!f.label.includes('/') || this.unique(f.label) != id) return null
      const pool: string[] = []
      for (const tag of f.tagsHidden) {
        const y = this.unique(tag)
        if (y === undefined || y == id || pool.includes(y)) continue
        if (this.comp.get(y) == this.comp.get(id)) return null
        pool.push(y)
      }
      const chats = pool.filter(y => this.chat(y))
      if (chats.length != 1) return null
      const y = chats[0]
      const yl = this.facts.get(y)!.label
      if (rootOf(yl) != rootOf(f.label) || yl == prefixOf(f.label)) return null
      return y
    })
  }

  private ancestors(id: string): string[] {
    return this.memoize('ancestors', id, () => this.walk(this.facts.get(id)!.label, id))
  }

  private walk(label: string, cur: string | null): string[] {
    const levels: string[] = []
    const seen = new Set<string>([label])
    while (true) {
      const ov = cur !== null ? this.override(cur) : null
      if (ov !== null) {
        label = this.facts.get(ov)!.label
        cur = ov
      } else {
        const p = prefixOf(label)
        if (!p) break
        label = p
        cur = this.unique(p) ?? null
      }
      if (seen.has(label)) throw new Error(`lineage: the ancestry of ${levels[0] ?? label} revisits ${label}`)
      seen.add(label)
      levels.push(label)
    }
    return levels
  }

  private adopts(id: string): boolean {
    return this.memoize('adopts', id, () =>
      this.ancestors(id).some(level => {
        const u = this.unique(level)
        return u !== undefined && this.facts.get(u)!.carrier
      }),
    )
  }

  private parent(id: string): string | null {
    return this.memoize('parent', id, () => {
      const ov = this.override(id)
      if (ov !== null) return ov
      if (!this.adopts(id)) return null
      return this.unique(prefixOf(this.facts.get(id)!.label)) ?? null
    })
  }

  // itemDeps: a depth-first walk, the parent first, then the hidden tags' unique targets in tag order
  // (aliases included), each item once, an item's own id at the back of its subtree (never at the root)
  private deps(id: string): string[] {
    return this.memoize('deps', id, () => {
      const acc: string[] = []
      this.closure(id, acc, new Set(), true)
      return acc
    })
  }

  private closure(id: string, acc: string[], inAcc: Set<string>, root: boolean) {
    if (inAcc.has(id)) return
    const at = acc.length
    acc.push(id)
    inAcc.add(id)
    const p = this.parent(id)
    if (p !== null) this.closure(p, acc, inAcc, false)
    for (const tag of this.facts.get(id)!.tagsHiddenAlt) {
      const t = this.unique(tag)
      if (t !== undefined) this.closure(t, acc, inAcc, false)
    }
    acc.splice(at, 1)
    if (root) inAcc.delete(id)
    else acc.push(id)
  }

  private chat(id: string): boolean {
    if (this.chatPrefixBusy) return false // asked from inside #chat's own closure: never a chat (see the header)
    if (this.chatPrefix === undefined) {
      const chatId = this.unique('#chat')
      this.chatPrefixBusy = true
      try {
        this.chatPrefix = chatId === undefined ? null : [...this.deps(chatId), chatId]
      } finally {
        this.chatPrefixBusy = false
      }
    }
    return this.memoize('chat', id, () => {
      const prefix = this.chatPrefix!
      if (prefix === null) return false
      const d = this.deps(id)
      return d.length >= prefix.length && prefix.every((x, i) => d[i] == x)
    })
  }

  private memoize<T>(kind: Kind, id: string, compute: () => T): T {
    const key = kind + ':' + id
    if (this.memo.has(key)) return this.memo.get(key) as T
    if (this.busy.has(key)) throw new Error(`lineage: cyclic derivation of ${kind} at ${id}`)
    this.busy.add(key)
    try {
      const value = compute()
      this.memo.set(key, value)
      return value
    } finally {
      this.busy.delete(key)
    }
  }

  // the strongly connected components (an iterative Tarjan) of the graph of an item's unique hidden-tag
  // targets and unique label-prefix ancestors
  private components(ids: string[]) {
    const succ = (id: string) => {
      const f = this.facts.get(id)!
      const out: string[] = []
      const add = (t: string | undefined) => {
        if (t !== undefined && t != id && !out.includes(t)) out.push(t)
      }
      for (const tag of f.tagsHiddenAlt) add(this.unique(tag))
      for (const tag of f.tagsHidden) add(this.unique(tag))
      for (let p = prefixOf(f.label); p; p = prefixOf(p)) add(this.unique(p))
      return out
    }
    let index = 0
    let next = 0
    const idx = new Map<string, number>()
    const low = new Map<string, number>()
    const stack: string[] = []
    const onStack = new Set<string>()
    const visit = (v: string) => {
      idx.set(v, index)
      low.set(v, index)
      index++
      stack.push(v)
      onStack.add(v)
    }
    for (const root of ids) {
      if (idx.has(root)) continue
      visit(root)
      const work: [string, string[], number][] = [[root, succ(root), 0]]
      while (work.length) {
        const frame = work[work.length - 1]
        const [v, s] = frame
        if (frame[2] < s.length) {
          const w = s[frame[2]++]
          if (!idx.has(w)) {
            visit(w)
            work.push([w, succ(w), 0])
          } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!))
          continue
        }
        work.pop()
        if (work.length) {
          const u = work[work.length - 1][0]
          low.set(u, Math.min(low.get(u)!, low.get(v)!))
        }
        if (low.get(v) == idx.get(v)) {
          let w: string
          do {
            w = stack.pop()!
            onStack.delete(w)
            this.comp.set(w, next)
          } while (w != v)
          next++
        }
      }
    }
  }
}

// whether a tag term of a query matches an item by its levels: one of them starts with the term,
// as the runtime's tag search matches an item's own tags (a prefix, not the shortening's segment
// boundary), so a renamed node's tag-free descendants match their tree ancestors' queries as
// nested labels match them by their text
export function levelsMatch(levels: string[], term: string): boolean {
  return levels.some(level => level.startsWith(term))
}

// every item's derived facts
export function derive(items: Facts[]): Map<string, Derived> {
  const lineage = new Lineage(items)
  return new Map(lineage.ids().map(id => [id, lineage.get(id)]))
}
